#!/usr/bin/env python3
"""Build the Epsilook data pack for one WoW game version.

Data sources (hybrid, in priority order):
  1. TrinityCore TDB (github.com/TrinityCore/TrinityCore releases) — the
     server-side world database for this exact game build. Two roles:
     a) world tables (creature_template, creature_template_model) are the
        ONLY source for creature -> display id mapping (server-side data
        the client never ships), used for morphs;
     b) hotfixes tables carry the rows Blizzard hotfixed over the wire
        after the client shipped — they override wago rows by row ID.
  2. wago.tools CSV exports — the client db2 tables (visual/sound/anim
     chains exist nowhere else).
  3. The community listfile (github.com/wowdev/wow-listfile) for file names.

The build runs as a pipeline, and the code is ordered the same way:

  fetch_sources()   download (or reuse) every CSV, the listfile and the TDB
  read_*()          one reader per domain, each returning a small bundle of
                    lookup tables (see the dataclasses below)
  walk_spells()     the one graph walk: spell -> visual -> kit -> payloads
  resolve_paths()   turn the referenced FileDataIDs into listfile names
  build_pack()      orchestrates the above, then assembles the JSON pack
  write_pack()      gzip it, hash it, update versions.json

A rebuild is deterministic: given the same cached sources it writes a
byte-identical pack, which makes "rebuild and diff" a usable regression test
for any change in here.

Stdlib only, plus 7-Zip (7z on PATH or in Program Files) to extract the TDB
archive once. Downloads are cached under build/cache/ ; pass --refresh to
force re-download of the wago/listfile sources.

Usage:
    python build_data.py --version 9.2.7.45745 --label "Shadowlands 9.2.7"
"""

from __future__ import annotations

import argparse
import colorsys
import csv
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import TypeVar

T = TypeVar("T")

BUILD_DIR = Path(__file__).resolve().parent
ROOT_DIR = BUILD_DIR.parent
CACHE_DIR = BUILD_DIR / "cache"
DATA_DIR = ROOT_DIR / "docs" / "data"

WAGO_CSV_URL = "https://wago.tools/db2/{table}/csv?build={version}"
LISTFILE_RELEASE_API = "https://api.github.com/repos/wowdev/wow-listfile/releases/latest"

TABLES = [
    "SpellName",
    "Spell",
    "SpellXSpellVisual",
    "SpellVisual",
    "SpellVisualMissile",
    "SpellVisualEvent",
    "SpellVisualKitEffect",
    "SpellVisualKitModelAttach",
    "SpellVisualEffectName",
    "SpellVisualAnim",
    "AnimKitSegment",
    "SoundKitEntry",
    "SpellEffect",
    "SummonProperties",
    "SpellMisc",
    "SpellChainEffects",
    "SpellProceduralEffect",
    "BeamEffect",
    "SpellEffectEmission",
    "SpellVisualKitAreaModel",
    "WeaponTrail",
    "BarrageEffect",
    "DissolveEffect",
    "TextureBlendSet",
    "EdgeGlowEffect",
    "ShadowyEffect",
    "SpellVisualScreenEffect",
    "ScreenEffect",
    "FullScreenEffect",
    "CreatureDisplayInfo",
    "CreatureModelData",
    "SpellShapeshiftForm",
    "SpellOverrideName",
    "Vehicle",
    "VehicleSeat",
    # the item route (SpellVisualEffectName Type 1, §3c). ItemSearchName carries
    # the display name AND OverallQualityID; the appearance chain resolves the
    # model and the inventory icon. ItemSparse is deliberately NOT here: it is
    # 36 MB against ItemSearchName's 6 MB and was measured to add exactly zero
    # names over it for the items this route reaches.
    "ItemSearchName",
    "ItemModifiedAppearance",
    "ItemAppearance",
    "ItemDisplayInfo",
    "ModelFileData",
]

# ------------------------------------------------------- per-build source map
#
# Building an OLDER game version is mostly a story of things that do not exist
# yet: db2 tables get introduced, split and renamed as the game evolves, so a
# reader written against 9.2.7 asks for columns Legion never had and tables
# WotLK never had. Rather than branch per version inside the readers, the three
# kinds of difference are DECLARED here:
#
#   OPTIONAL_TABLES   the table postdates the build. It 404s on wago, its
#                     reader yields nothing, its pack section comes out empty
#                     and the feature it powers quietly switches off (the
#                     frontend already guards every section).
#   OPTIONAL_COLUMNS  the table exists but one column postdates the build —
#                     a default value stands in.
#   SPELL_NAME_SOURCES  the data exists but MOVED between tables.
#
# Anything not declared here is still a hard error: an unexpected schema change
# must fail the build loudly rather than silently losing data. To add a game
# version, run the build and let it tell you what is missing — then decide,
# per item, whether it belongs here or is a genuine bug.

# table -> the user-facing feature that switches off when the build predates it
OPTIONAL_TABLES = {
    "SpellName":               "spell names (pre-BfA they live on Spell itself)",
    "BeamEffect":              "the BeamEffect route into chain/beam fx",
    "SpellEffectEmission":     "area-emitter models",
    "SpellVisualKitAreaModel": "area models",
    "WeaponTrail":             "weapon-trail models",
    "BarrageEffect":           "barrage models",
    "DissolveEffect":          "the dissolve fx category",
    "TextureBlendSet":         "dissolve materials + screen mask textures",
    "EdgeGlowEffect":          "the glow fx category",
    "ShadowyEffect":           "the ghost/shadowy fx category",
    "SpellVisualScreenEffect": "the kit route into screen fx",
    "ScreenEffect":            "the screen fx category",
    "FullScreenEffect":        "screen fx colour grading + overlay textures",
    "SpellShapeshiftForm":     "the shapeshift fx category",
    "SpellOverrideName":       "override names in the search corpus",
    "SummonProperties":        "summon control words (guardian/pet/...)",
    "Vehicle":                 "the vehicle fx category",
    "VehicleSeat":             "vehicle seat attachments and passenger animations",
}

# (table, column) -> the value to use on builds that lack the column
OPTIONAL_COLUMNS = {
    # the raid missile-set variant arrived after Legion; 0 = "no raid set",
    # which is exactly how a present-but-unset row already reads
    ("SpellVisual", "RaidSpellVisualMissileSetID"): "0",
    # the reduced-camera-movement variant is missing on Legion and BfA only
    # (present either side of them); 0 = "no variant", same as an unset row
    ("SpellVisual", "ReducedUnexpectedCameraMovementSpellVisualID"): "0",
    # Legion's FullScreenEffect has the colour grade but no overlay art yet
    ("FullScreenEffect", "OverlayTextureFileDataID"): "0",
}

# Spell names moved: SpellName.db2 was split out of Spell.db2 in BfA, so Legion
# and earlier carry the name on Spell itself. First candidate whose table this
# build actually has wins. (Both spellings are "ID" + a localised name column,
# so the reader downstream is identical.)
SPELL_NAME_SOURCES = [
    ("SpellName", ["ID", "Name_lang"]),
    ("Spell", ["ID", "Name_lang"]),
]

# TrinityCore TDB release per game version (server-side world DB + hotfixes).
# "hotfixes" is optional — the 3.3.5 branch ships a world-only dump, and
# hotfixes are a modern-client concept anyway.
TDB_RELEASES = {
    "9.2.7.45745": {
        "tag": "TDB927.22111",
        "asset": "TDB_full_927.22111_2022_11_20.7z",
        "world": "TDB_full_world_927.22111_2022_11_20.sql",
        "hotfixes": "TDB_full_hotfixes_927.22111_2022_11_20.sql",
    },
    "10.2.7.55664": {
        "tag": "TDB1027.24051",
        "asset": "TDB_full_1027.24051_2024_05_11.7z",
        "world": "TDB_full_world_1027.24051_2024_05_11.sql",
        "hotfixes": "TDB_full_hotfixes_1027.24051_2024_05_11.sql",
    },
    "11.2.7.65299": {
        "tag": "TDB1127.26011",
        "asset": "TDB_full_1127.26011_2026_01_14.7z",
        "world": "TDB_full_world_1127.26011_2026_01_14.sql",
        "hotfixes": "TDB_full_hotfixes_1127.26011_2026_01_14.sql",
    },
    "8.3.7.35662": {
        "tag": "TDB837.20101",
        "asset": "TDB_full_837.20101_2020_10_20.7z",
        "world": "TDB_full_world_837.20101_2020_10_20.sql",
        "hotfixes": "TDB_full_hotfixes_837.20101_2020_10_20.sql",
    },
    # Legion: the 2018 archive nests both dumps in a folder and drops the
    # "full_" infix from the inner file names.
    "7.3.5.26972": {
        "tag": "TDB735.00",
        "asset": "TDB_full_735.00_2018_02_19.7z",
        "world": "TDB_full_735.00_2018_02_19/TDB_world_735.00_2018_02_19.sql",
        "hotfixes": "TDB_full_735.00_2018_02_19/TDB_hotfixes_735.00_2018_02_19.sql",
    },
    # WotLK Classic: TrinityCore's 3.3.5 branch ships a WORLD-ONLY dump (no
    # hotfixes key). It targets original 3.3.5a rather than the 3.4.x Classic
    # client, but it is the only source of creature name/display data for the
    # era and the creature entries are overwhelmingly shared.
    "3.4.3.58936": {
        "tag": "TDB335.25101",
        "asset": "TDB_full_world_335.25101_2025_10_21.7z",
        "world": "TDB_full_world_335.25101_2025_10_21.sql",
    },
}
TDB_ASSET_URL = "https://github.com/TrinityCore/TrinityCore/releases/download/{tag}/{asset}"

# The bits a target mask can carry. Named up here because VISUAL_REDIRECTS
# (below) needs them before TARGET_BITS — which maps SpellVisualEvent.TargetType
# onto these same bits, and is where the scheme is explained in full.
NO_TARGET = 0
TARGET_CASTER, TARGET_TARGET, TARGET_AREA = 1, 2, 4
TARGET_NOT_CASTER, TARGET_MISSILE_DEST = 8, 16

# SpellVisual columns that point at ANOTHER SpellVisual the client swaps in for
# this one -> the extra target bit everything reached through that redirect
# carries. The redirected-to visual is usually reachable no other way (on 9.2.7
# only 37 of 228 caster targets and 30 of 257 hostile targets also appear in
# SpellXSpellVisual), so following these is what makes that content visible at
# all — it is not a re-labelling of rows we already show.
#
# Only the first two carry a "who sees this" meaning. Low-violence and
# reduced-camera-movement are CLIENT SETTING variants — nobody casts them at
# anyone — so they declare NO_TARGET rather than being forced into a bit.
# Adding a future redirect column is one line here and nothing else.
VISUAL_REDIRECTS = {
    "CasterSpellVisualID": TARGET_CASTER,    # what the caster themself sees
    "HostileSpellVisualID": TARGET_TARGET,   # what a hostile target sees
    "LowViolenceSpellVisualID": NO_TARGET,
    "ReducedUnexpectedCameraMovementSpellVisualID": NO_TARGET,
}

# Tables distilled out of the TDB SQL dumps into cached CSVs, with the
# columns we keep. world tables are complete (server-only data); hotfixes
# tables hold ONLY the rows Blizzard hotfixed post-ship — applied on top of
# the wago rows by row ID (TDB is preferred wherever it has data).
#
# NOTE widening a column list here does NOT invalidate the distilled CSV (the
# cache check is existence-only) — delete build/cache/tdb-*/ to re-distill.
TDB_TABLES = {
    "world": {
        "creature_template": ["entry", "name",
                              "modelid1", "modelid2", "modelid3", "modelid4"],
        "creature_template_model": ["CreatureID", "Idx", "CreatureDisplayID", "Probability"],
    },
    "hotfixes": {
        "spell_name": ["ID", "Name"],
        "spell_x_spell_visual": ["ID", "SpellID", "SpellVisualID"],
        # MissileAttachment/MissileDestinationAttachment must be overlaid too:
        # a hotfixed row replaces the wago row wholesale, so omitting them
        # would silently blank the launch/impact attachments on those visuals.
        # The redirect columns (VISUAL_REDIRECTS) and AnimEventSoundID are here
        # for exactly the same reason.
        "spell_visual": ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID",
                         "MissileAttachment", "MissileDestinationAttachment",
                         "AnimEventSoundID", *VISUAL_REDIRECTS],
        "spell_visual_missile": ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                                 "SoundEntriesID", "AnimKitID"],
        "spell_visual_effect_name": ["ID", "ModelFileDataID"],
        "spell_effect": ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1",
                         "EffectMiscValue2", "ImplicitTarget1", "ImplicitTarget2"],
        "spell_misc": ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"],
        "creature_display_info": ["ID", "ModelID"],
        "creature_model_data": ["ID", "FileDataID"],
    },
}

# The same three kinds of drift exist on the TrinityCore side, since a TDB
# release tracks the server schema of its era. Declared separately from the
# wago-side maps above because the table names live in a different namespace.
TDB_OPTIONAL_TABLES = {
    # split out of creature_template's modelid1..4 columns after the Legion era
    "creature_template_model": "creature displays (legacy dumps keep them on creature_template)",
}
TDB_OPTIONAL_COLUMNS = {
    # the legacy spelling: present on Legion-era dumps, gone once the
    # creature_template_model table took over
    ("creature_template", "modelid1"): "0",
    ("creature_template", "modelid2"): "0",
    ("creature_template", "modelid3"): "0",
    ("creature_template", "modelid4"): "0",
}

# Creature -> display id moved on the TrinityCore side too: Legion-era world
# dumps keep up to four display ids as modelid1..4 ON creature_template, later
# releases split them into their own table. Whichever the release has wins.
CREATURE_DISPLAY_SOURCES = [
    ("creature_template_model", ["CreatureID", "Idx", "CreatureDisplayID"]),
    ("creature_template", ["entry", "modelid1", "modelid2", "modelid3", "modelid4"]),
]

# Animation names indexed by AnimID (Stand=0, ...), maintained by wow.tools
ANIMS_JS_URL = "https://raw.githubusercontent.com/Marlamin/wow.tools.local/main/wwwroot/js/anims.js"

# Enum value names from WoWDBDefs meta/enums — the authority on what db2
# enum values mean ("ID NAME" lines; see read_enum_names for the format).
# SpellEffect = names for SpellEffect.Effect (SPELL_EFFECT_* without the
# prefix), SpellEffectAura = names for SpellEffect.EffectAura (SPELL_AURA_*).
WOWDBDEFS_ENUM_URL = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/meta/enums/{name}.dbde"
ENUM_FILES = ["SpellEffect", "SpellEffectAura", "Target"]

# SpellVisualKitEffect.EffectType values (what the kit effect points at) —
# the full enum is documented in WoWDBDefs definitions/SpellVisualKitEffect.dbd
EFFECT_TYPE_PROC = 1      # Effect = SpellProceduralEffect.ID
EFFECT_TYPE_SOUND = 5     # Effect = SoundKitID
EFFECT_TYPE_ANIM = 6      # Effect = SpellVisualAnim.ID
EFFECT_TYPE_SHADOWY = 7   # Effect = ShadowyEffect.ID
EFFECT_TYPE_EMISSION = 8  # Effect = SpellEffectEmission.ID (area-model emitter)
EFFECT_TYPE_DISSOLVE = 11 # Effect = DissolveEffect.ID
EFFECT_TYPE_EDGE_GLOW = 12 # Effect = EdgeGlowEffect.ID
EFFECT_TYPE_BEAM = 13     # Effect = BeamEffect.ID
EFFECT_TYPE_BARRAGE = 17  # Effect = BarrageEffect.ID (multi-model volley)
EFFECT_TYPE_SCREEN = 19   # Effect = SpellVisualScreenEffect.ID (verified:
                          # all 18 ET-19 rows in 9.2.7 resolve there)
# Of the remaining SpellVisualKitEffectType values (survey 2026-07-18):
# 2 (SpellVisualKitModelAttach) is 100% redundant with the
# ParentSpellVisualKitID walk; 10 (UnitSoundType) plays the TARGET unit's
# own sound — no concrete file; 15/20 are absent; the rest carry no
# model/sound columns.

# SpellEffect.EffectAura value whose EffectMiscValue_0 is a ScreenEffect ID —
# the main road to screen effects (~2.3k spells; the kit route via
# SpellVisualScreenEffect adds only 18 rows in 9.2.7)
AURA_SCREEN_EFFECT = 260

# SpellProceduralEffect.Type values. Type IS the client character-procedure
# index (m_characterProcedure) — see the "Proc type decode" section in
# CLAUDE.md. Which value column carries the payload differs per type.
PROC_TYPE_TINT = 1          # Value_0 = packed-RGB model tint (multiply)
PROC_TYPES_CHAIN = {0, 12, 26}  # Value_0 = SpellChainEffects ID (beams)
PROC_TYPE_STANDWALK = 7     # Value_0..3 = AnimationData IDs (stand/walk anim)
PROC_TYPE_AREAMODEL = 9     # Value_0 = SpellVisualKitAreaModel ID (model)
PROC_TYPE_FREEZE = 11       # valueless freeze/petrify state
PROC_TYPE_TRANSPARENCY = 14 # Value_0 = alpha 0..1 (SetAlphaMod)
PROC_TYPE_CAMO = 18         # valueless camouflage/cloak state
PROC_TYPE_DESATURATE = 21   # Value_2 = desaturation strength 0..1 (no color)
PROC_TYPE_GHOST_MAT = 22    # Value_3 = packed-RGB material recolor -> ghost
PROC_TYPE_TINT_MAT = 23     # Value_3 = packed-RGB material recolor -> tint
PROC_TYPE_WEAPONTRAIL = 27  # Value_0 = WeaponTrail.db2 ID (trail model)

# model categories: every (spell, model) row is tagged with how the model is
# used — the Models column groups by these short user-facing words
MODEL_CAT_ATTACH = 0   # SpellVisualKitModelAttach (model attached to the caster/target)
MODEL_CAT_MISSILE = 1  # SpellVisualMissile (projectile in flight)
MODEL_CAT_AREA = 2     # SpellVisualKitAreaModel (ground/area model: emission ET 8, proc Type 9)
MODEL_CAT_TRAIL = 3    # WeaponTrail (proc Type 27)
MODEL_CAT_BARRAGE = 4  # BarrageEffect (volley of models, ET 17)
MODEL_CAT_DISPLAY = 5  # SpellVisualEffectName Type 2 (a CreatureDisplayID's model)
MODEL_CAT_ITEM = 6     # SpellVisualEffectName Type 1 (an Item::ID's model)

# SpellVisualEffectName.Type: how its GenericID/ModelFileDataID resolves to a
# model (SpellVisualEffectNameType.dbde). 0 = FileDataID (ModelFileDataID),
# 1 = Item (GenericID = Item::ID), 2 = CreatureDisplayInfo (GenericID = display).
EFFECT_NAME_TYPE_DISPLAY = 2
EFFECT_NAME_TYPE_ITEM = 1

# Item.OverallQualityID -> the quality word its pill label is coloured by
# (ItemQuality; the classic poor/common/uncommon/rare/epic/legendary ramp). The
# word rides the pack so the frontend can map it to a colour without hardcoding
# the enum, and so an unknown future tier degrades to no colour rather than a
# wrong one. Read from ItemSearchName, which carries it for 100% of the items
# this route reaches — no Wowhead lookup, and it is the quality for the build
# being packed rather than for current retail.
ITEM_QUALITY_NAMES = {
    0: "poor", 1: "common", 2: "uncommon", 3: "rare", 4: "epic",
    5: "legendary", 6: "artifact", 7: "heirloom", 8: "token",
}
# SpellVisualEffectName.Type 3-10 are undocumented in the enum, but every one of
# them carries NO model in the data — ModelFileDataID AND GenericID are both 0 —
# while attaching to weapon/hand M2 points and being reused as missiles.
# Investigation (Task D) found they all mean the same thing: "the caster's own
# equipped weapon", resolved client-side at cast, with the Type picking the
# weapon slot/class (3/4 = thrown mainhand/offhand, 5/10 = ranged, 8/9 = held
# mainhand/offhand). There is no file to name, so these rows carry a sentinel
# fid (WEAPON_FID) and render as one "equipped weapon" marker pill — no
# 3D/texture/Wowhead — keeping their category (attached vs thrown-as-missile)
# and attachment point. A rare Type-3/5 row DOES carry a real ModelFileDataID
# (a hardcoded weapon, e.g. Sylvanas's bow); that wins and renders as a normal
# model, so only the fileless rows become the marker.
#
# ...except that "fileless" is not always spelled 0: the Classic re-release
# clients backfill these rows with an UNNAMED PLACEHOLDER fid. Cata 4.4.2 points
# all seven of its weapon rows at fid 1255628, and WotLK one — the very same
# effect-name IDs (8905-8909, 9007, 50201) that are fid 0 on Vanilla, TBC, MoP,
# Legion, BfA, SL, DF and TWW. One fid shared across six different weapon slots
# is not a per-weapon model, and taken literally it renders a junk "file #1255628"
# pill. So a weapon row's fid is trusted only when the listfile can NAME it,
# which keeps the genuinely hardcoded weapons (Sylvanas's bow, fid 3597252 on
# 9.2.7+) as real models while placeholders fall through to the marker. That
# rule needs no per-version branch and no hardcoded fid list.
EFFECT_NAME_TYPE_WEAPON = frozenset(range(3, 11))
WEAPON_FID = -1  # sentinel model fid: the caster's equipped weapon (no real file)
# Fileless model sentinels get a synthetic files-table entry: it names the pill
# and makes it searchable (model:weapon / model:equipped) through the normal
# file-name path, so no search/export route needs to special-case the sentinel.
# The frontend drops the fid buttons (3D/copy) for a negative fid.
SYNTHETIC_MODEL_FILES = {WEAPON_FID: "equipped weapon"}
MODEL_CAT_NAMES = {
    # Attach models have no category word: they are the plain "this model plays
    # on a unit" case, and which unit is now said by the target icon instead
    # (a group head reading "attached" told the user nothing the icon doesn't).
    # An empty name is the frontend's signal to render the category as loose
    # pills with no head — see modelsCell in app.js.
    MODEL_CAT_ATTACH: "",
    MODEL_CAT_MISSILE: "missile",
    # "ground", not "area": the target words added in format 22 include
    # "area", and the two mean different things — only 42% of this category's
    # rows carry an area TARGET bit, and only 2.6% of the rows that DO carry
    # one are in this category (the rest are ordinary attach models playing at
    # a location). Sharing the word made model:area silently mean the target.
    MODEL_CAT_AREA: "ground",
    MODEL_CAT_TRAIL: "trail",
    MODEL_CAT_BARRAGE: "barrage",
    # "display", not "creature": a creature-display model resolves to a file
    # under creature/..., so "creature" collides with ~21% of the model-file
    # corpus by the filename-substring rule (model:creature would drown this
    # category in filename noise). "display" collides with ~0 and matches how
    # Epsilon users think of a CreatureDisplayID.
    MODEL_CAT_DISPLAY: "display",
    # "item" collides with ~4.3% of the model-file corpus (item/objectcomponents/
    # ...) by the filename-substring rule — well under the ~21% that ruled out
    # "creature" for the display category, and coherent rather than confusing:
    # the files it also matches ARE item models.
    MODEL_CAT_ITEM: "item",
}

# SpellEffectAura value whose EffectMiscValue_0 is a CreatureDisplayID
AURA_TRANSFORM = 56

# SpellEffectAura value whose EffectMiscValue_0 is a SpellShapeshiftForm ID.
# The form carries a name and up to four CreatureDisplayIDs; plenty of forms
# (Battle Stance, Shadowform, Stealth, Moonkin) have no display at all and
# are a name only.
AURA_SHAPESHIFT = 36
# SpellEffectAura whose EffectMiscValue_0 is a SpellOverrideName ID — the
# name the spell renames its target/pet to. "GROUP" in the enum name is
# because one spell may carry several rows and pick among them (spell 323463
# "Infused" -> Bola / Apa / Deka). Search corpus only, never displayed.
AURA_OVERRIDE_NAME = 370

# SpellEffectAura (SET_VEHICLE_ID) whose EffectMiscValue_0 is a Vehicle.db2 ID.
# The vehicle's payload we surface is its seat count (nonzero Vehicle.SeatID_n
# slots); who can occupy those seats is deferred (needs VehicleSeat flags + the
# server-side TDB accessory tables — see the handoff note).
AURA_SET_VEHICLE_ID = 296

# The invisibility-channel aura pair. EffectMiscValue_0 is the invisibility
# TYPE — a shared channel/slot id, NOT a display or creature. A MOD_INVISIBILITY
# spell hides its target in channel T; any MOD_INVISIBILITY_DETECT spell on the
# SAME T reveals it. So the type is the pairing key linking "hide" spells to the
# "reveal" spells that counter them (verified 29/29 against the "Quest Invis N" /
# "See Quest Invis N" name families). Pure client SpellEffect — no TDB, present
# on every build. Type 0 is general invisibility (Vanish etc.); the quest zones
# spread across the higher types. A single spell may carry both auras (it both
# hides and detects), so the two are read independently.
AURA_MOD_INVISIBILITY = 18
AURA_MOD_INVISIBILITY_DETECT = 19

# VehicleSeat.AttachmentID is NOT an M2 attachment id: it is an index into a
# table hardcoded in the client binary (it exists in no db2, so it cannot be
# derived from data and has to live here). wowdev.wiki/DB/VehicleSeat quotes
# the array but hedges it with a "?", so it was verified rather than trusted:
# 138 vehicle M2s were fetched and their attachment arrays read, then each
# seat was checked against the model of its own vehicle. The decoded id is
# present on the model 91.2% of the time vs 42.4% for the raw value, and the
# indices where the two hypotheses disagree most are decisive — index 14
# decodes to VehicleSeat2, present on 100% of the models that use it, while
# raw 14 (ShoulderFlapLeft) is present on 0%. The array's own shape agrees:
# indices 13..20 come out as VehicleSeat1..VehicleSeat8, in order.
# (Full method and per-index table: CLAUDE.md, VehicleSeat research.)
#
# The array is 6.0.1-era and modern data has indices past its end (26, 27) —
# those stay unmapped on purpose and surface as a raw "idx N" label rather
# than a guess.
VEHICLE_GEO_COMPONENT_LINKS = [
    20, 34, 19, 21, 22, 17, 23, 24, 25, 15, 16, 37, 38,
    39, 40, 41, 42, 43, 44, 45, 46, 0, 47, 48, 6, 5,
]

# M2 attachment id -> name (wowdev.wiki/M2 §8.5). The whole enum, because
# these names label model, missile and beam attach points as well as vehicle
# seats. Names are the game's own; on seats they read oddly ("Breath",
# "ChestBloodBack") because artists reuse generic attachment slots as seat
# anchors — that is the data, not a decode error.
#
# NOTE the only *indexed* consumer is VehicleSeat (via the link array above).
# Every other attachment column in the game data is a RAW id into this table:
# SpellVisualKitModelAttach.AttachmentID, SpellVisualMissile.Attachment /
# .DestinationAttachment and BeamEffect.SourceAttachID / .DestAttachID.
# (`SpellVisualKitModelAttach.LowDefModelAttachID` is a FileDataID despite
# its name — max 430259 — and is NOT an attachment.)
M2_ATTACHMENT_NAMES = {
    0: "MountMain", 1: "HandRight", 2: "HandLeft", 3: "ElbowRight",
    4: "ElbowLeft", 5: "ShoulderRight", 6: "ShoulderLeft", 7: "KneeRight",
    8: "KneeLeft", 9: "HipRight", 10: "HipLeft", 11: "Helm", 12: "Back",
    13: "ShoulderFlapRight", 14: "ShoulderFlapLeft", 15: "ChestBloodFront",
    16: "ChestBloodBack", 17: "Breath", 18: "PlayerName", 19: "Base",
    20: "Head", 21: "SpellLeftHand", 22: "SpellRightHand", 23: "Special1",
    24: "Special2", 25: "Special3", 26: "SheathMainHand", 27: "SheathOffHand",
    28: "SheathShield", 29: "PlayerNameMounted", 30: "LargeWeaponLeft",
    31: "LargeWeaponRight", 32: "HipWeaponLeft", 33: "HipWeaponRight",
    34: "Chest", 35: "HandArrow", 36: "Bullet", 37: "SpellHandOmni",
    38: "SpellHandDirected", 39: "VehicleSeat1", 40: "VehicleSeat2",
    41: "VehicleSeat3", 42: "VehicleSeat4", 43: "VehicleSeat5",
    44: "VehicleSeat6", 45: "VehicleSeat7", 46: "VehicleSeat8",
    47: "LeftFoot", 48: "RightFoot", 49: "ShieldNoGlove", 50: "SpineLow",
    51: "AlteredShoulderR", 52: "AlteredShoulderL", 53: "BeltBuckle",
    54: "SheathCrossbow", 55: "HeadTop", 56: "VirtualSpellDirected",
    57: "Backpack",
}

# attachment columns use -1 for "unset"; missile columns also use -2
NO_ATTACHMENT = -1


def attachment_name(attachment: int) -> str:
    """Raw M2 attachment id -> name, or "" when unset or unknown."""
    if attachment < 0:
        return ""
    return M2_ATTACHMENT_NAMES.get(attachment, f"attachment {attachment}")


def seat_attachment_name(index: int) -> str:
    """Seat AttachmentID (an index) -> M2 attachment name, or "" when unset.

    Out-of-range indices are labeled "idx N" rather than guessed at: the
    link table is 6.0.1-era and modern data has grown past it.
    """
    if index < 0:
        return ""
    if index >= len(VEHICLE_GEO_COMPONENT_LINKS):
        return f"idx {index}"
    return attachment_name(VEHICLE_GEO_COMPONENT_LINKS[index])

# SpellEffect.Effect value that summons a creature: EffectMiscValue_0 is the
# creature id (server-side NPC entry, same space as morphs), EffectMiscValue_1
# the SummonProperties row governing how the summon behaves
EFFECT_SUMMON = 28

# SpellEffect.Effect value that applies an aura. Its ImplicitTarget says WHO
# ends up carrying the aura, which is what resolve_target_mask needs to read an
# aura-phase visual's "Target" correctly (see there).
EFFECT_APPLY_AURA = 6

# SummonProperties.Control values (meta/enums/SummonPropertiesControl.dbde —
# too few and too free-form for read_enum_names). 0 = uncontrolled; shown as
# no word, like untinted beams.
SUMMON_CONTROL_NAMES = {
    0: "", 1: "guardian", 2: "pet", 3: "possessed",
    4: "possessed vehicle", 5: "vehicle",
}

# ScreenEffect.Effect value whose Param_0 carries a fog tint (swirling fog).
SCREEN_EFFECT_FOG = 3

# Roles a texture plays in a screen effect. The two FullScreenEffect texture
# columns are NOT interchangeable, and the difference is what the app's hover
# preview has to honour: TextureBlendSet textures are MASKS
# (mask_fullscreen_01, white_64, black64, tileset/generic/grey, alphamask_*,
# flare_invert, *_desat_* — flat grey/white, meaningless untinted) that the
# mul/add colors paint; OverlayTextureFileDataID is finished art
# (fullscreeneffect_*.blp, the lava/caustic sheets, even a "Tailoring
# Emporium" title card) drawn on top in its own colors.
TEX_OVERLAY, TEX_MASK = 0, 1

# SpellVisualEvent.TargetType -> the bit it contributes to a row's target mask
# (meta/enums/SpellVisualEventTargetType.dbde). The mask answers "who does this
# content play on", unioned over every kit a spell reaches it through, so a
# row that plays on caster AND target carries both bits — that is genuine data,
# not a build artifact: impact kits carry duplicate event rows differing only
# in TargetType. Value 0 (None) is not in the map: it is effectively unused
# (one row in 207,241 on 9.2.7) and contributes no bit, same as content that
# arrives from outside the event graph (missile sets carry no event row).
# (the bits themselves are named above TDB_TABLES, where VISUAL_REDIRECTS needs them)
TARGET_BITS = {1: TARGET_CASTER, 2: TARGET_TARGET, 3: TARGET_AREA,
               4: TARGET_NOT_CASTER, 5: TARGET_MISSILE_DEST}

# `TargetType` is relative to the CAST — "the caster" vs "the unit being cast
# at" — and NOT a claim about which unit owns the visual. When a spell is cast
# on the caster themself the two are the SAME unit, and the client still writes
# `Target`: 29,886 spells on 9.2.7 (Divine Shield's bubble, Ice Barrier,
# Invisibility, every self-buff's aura visual) would otherwise render a "target"
# icon for content that plays on you. `SpellEffect.ImplicitTarget` is what tells
# a self-cast from a real one, so the two tables have to be read together.
#
# Which effect row to believe depends on WHEN the visual plays
# (SpellVisualEvent.StartEvent, meta/enums/SpellVisualEventEvent.dbde:
# 1/2 precast, 3 cast, 4/5 travel, 6 impact, 7/8 aura, 9/10 area trigger,
# 11/12 channel, 13 one-shot):
#
#   * AURA phase — the visual belongs to the aura, so it plays on whoever
#     CARRIES the aura: believe the APPLY_AURA effects' implicit target. This is
#     the only phase that can disagree with the rest of the spell, which is why
#     it is the one phase split out here. It rescues mixed spells like Vanish
#     and Blink, whose self-aura rides alongside effects aimed at others.
#   * every other phase shares the cast's frame, so "Target" only means the
#     caster when the WHOLE spell is self-cast: believe every effect's implicit
#     target. This catches self-cast impact visuals (Healing Potion, Eye of
#     Kilrogg) that the aura test alone would miss.
#
# Only the plain TARGET_TARGET bit is rewritten. TARGET_NOT_CASTER stays put —
# it says "not the caster" outright, so it can never mean the caster. The full
# phase axis (surfacing cast/aura/impact per pill) is deliberately NOT built
# here; this reads StartEvent only far enough to get the icons right.
AURA_PHASE_EVENTS = frozenset({7, 8})   # Aura Start / Aura End


def resolve_target_mask(aura_mask: int, other_mask: int,
                        aura_bits: int, cast_bits: int) -> int:
    """Fold a kit's aura-phase and other-phase target masks into one.

    `aura_bits` is the OR of the spell's APPLY_AURA implicit-target bits,
    `cast_bits` the OR over all of its effects. A `TARGET_TARGET` bit becomes
    `TARGET_CASTER` when the matching test says the spell targets only the
    caster — i.e. when "the target" IS the caster.
    """
    if aura_mask & TARGET_TARGET and aura_bits == TARGET_CASTER:
        aura_mask = (aura_mask & ~TARGET_TARGET) | TARGET_CASTER
    if other_mask & TARGET_TARGET and cast_bits == TARGET_CASTER:
        other_mask = (other_mask & ~TARGET_TARGET) | TARGET_CASTER
    return aura_mask | other_mask

# The search word each mask bit answers to. Two pairs of bits deliberately
# share a word: "target, never caster" is still a target (it keeps its own bit,
# and its own icon color, but nobody would search for it by another name), and
# a missile's destination is an area on the ground like any other. The app
# derives "both" from bits 1|2 rather than it being a bit of its own.
TARGET_NAMES = {1: "caster", 2: "target", 4: "area", 8: "target", 16: "area"}

# SpellEffect.ImplicitTarget_0/_1 -> the SAME caster/target/area bits the
# visual-event mask uses, so effect-driven fx (morphs, summons, vehicles,
# shapeshifts, screens) can say WHO the effect lands on — content that never
# passes through the SpellVisualEvent graph and so has no TargetType. The prime
# case: a polymorph's morph is applied to the TARGET, not the caster.
#
# The enum (meta/enums/Target.dbde) has ~150 values; every name starts with
# "TARGET_", and the token AFTER that prefix names what the effect is anchored
# to. We classify by that — the result is the rough "who does it hit" the pill
# icon wants, not the exact targeting rule.
IMPLICIT_CASTER, IMPLICIT_TARGET, IMPLICIT_AREA = 1, 2, 4

# Substrings tested in order against the name with "TARGET_" stripped. Area
# beats the rest (a spread/ground/positional destination is a place, whoever it
# is anchored to); then the SELECTED unit; then the caster's own sphere.
_IMPLICIT_AREA_HINTS = ("AREA", "CONE", "CLUMP", "RECT", "TRAJ", "DYNOBJ",
                        "_LINE_", "GROUND", "RANDOM", "RADIUS", "FRONT", "BACK",
                        "_LEFT", "_RIGHT", "MOVEMENT", "CENTROID")
_IMPLICIT_TARGET_HINTS = ("TARGET", "NEARBY", "CHANNEL_TARGET", "LASTTARGET",
                          "CHAINHEAL", "BATTLE_PET")
_IMPLICIT_CASTER_HINTS = ("CASTER", "SRC", "PET", "MASTER", "SUMMONER",
                          "VEHICLE", "PASSENGER", "OWN_CRITTER", "MINIPET", "HOME")


def implicit_target_bit(name: str) -> int:
    """Map one SpellImplicitTarget enum NAME to a caster/target/area bit (0 = none)."""
    n = (name or "").upper()
    if not n.startswith("TARGET_"):
        return 0
    body = n[len("TARGET_"):]
    if any(h in body for h in _IMPLICIT_AREA_HINTS):
        return IMPLICIT_AREA
    if any(h in body for h in _IMPLICIT_TARGET_HINTS):
        return IMPLICIT_TARGET
    if any(h in body for h in _IMPLICIT_CASTER_HINTS):
        return IMPLICIT_CASTER
    if "DEST" in body:  # a bare destination point (DEST_DEST, DEST_DB) is a place
        return IMPLICIT_AREA
    return 0


def implicit_target_bits(version: str) -> dict[int, int]:
    """{SpellImplicitTarget id -> caster/target/area bit} for this build's enum."""
    return {tid: b for tid, name in read_enum_names("Target", version).items()
            if (b := implicit_target_bit(name))}

# The pack's shape version — bump it whenever a section is added, removed or
# reshaped, so a stale cached pack is recognisable app-side.
PACK_FORMAT = 28  # 28: SpellVisualEffectName Type 1 -> item model pills (items
                  #     section, itemIconNames, spellModels.displayIds -> refIds)
# 27: SpellVisualEffectName Type 2 -> creature-display model pills
# 26: invis/detect channels (MOD_INVISIBILITY[_DETECT] auras)
# 25: target masks on effect-driven fx (SpellEffect.ImplicitTarget)
# 24: M2 attachment points on model, missile and beam rows
# 23: vehicles (SET_VEHICLE_ID aura -> Vehicle seat count)
# 22: per-row target masks (SpellVisualEvent.TargetType)

csv.field_size_limit(10_000_000)


def log(msg: str) -> None:
    """Print a build progress line (unbuffered — builds are watched live)."""
    print(msg, flush=True)


# ---------------------------------------------------------------- downloads

def download(url: str, dest: Path, refresh: bool, headers: dict | None = None,
             optional: bool = False) -> bool:
    """Download url to dest unless it is already cached (or refresh is set).

    Returns False when an `optional` source is absent (HTTP 404) — that is how
    a build that predates a db2 table reports it, and the caller treats the
    corresponding feature as switched off. Any other error still raises.
    """
    if dest.exists() and dest.stat().st_size > 0 and not refresh:
        log(f"  cached   {dest.name} ({dest.stat().st_size:,} bytes)")
        return True
    log(f"  fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "epsilook-build", **(headers or {})})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp, open(tmp, "wb") as out:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
    except urllib.error.HTTPError as e:
        tmp.unlink(missing_ok=True)
        if optional and e.code == 404:
            dest.unlink(missing_ok=True)  # a stale pack's table must not linger
            log(f"  absent   {dest.name} (this build predates the table)")
            return False
        raise
    tmp.replace(dest)
    log(f"  saved    {dest.name} ({dest.stat().st_size:,} bytes)")
    return True


def find_7z() -> str:
    """Locate the 7-Zip executable, or exit with an actionable message."""
    for cand in (shutil.which("7z"), r"C:\Program Files\7-Zip\7z.exe", "/usr/bin/7z"):
        if cand and Path(cand).exists():
            return cand
    sys.exit("error: 7-Zip (7z) is required to extract the TDB archive — install it "
             "or place the extracted .sql files in the cache tdb dir yourself")


def iter_insert_rows(line: str) -> Iterator[list[str]]:
    """Yield value tuples (lists of raw strings) from one INSERT ... VALUES line."""
    i = line.find("VALUES")
    if i < 0:
        return
    i += len("VALUES")
    n = len(line)
    while i < n:
        while i < n and line[i] != "(":
            i += 1
        if i >= n:
            return
        i += 1
        row, val, in_str = [], [], False
        while i < n:
            c = line[i]
            if in_str:
                if c == "\\":
                    val.append(line[i + 1]); i += 2; continue
                if c == "'":
                    if i + 1 < n and line[i + 1] == "'":
                        val.append("'"); i += 2; continue
                    in_str = False; i += 1; continue
                val.append(c); i += 1; continue
            if c == "'":
                in_str = True; i += 1; continue
            if c == ",":
                row.append("".join(val).strip()); val = []; i += 1; continue
            if c == ")":
                row.append("".join(val).strip()); i += 1
                yield row
                break
            val.append(c); i += 1


def tdb_column_index(table: str, column: str, schema: list[str]) -> int | None:
    """Position of a column in a TDB table, or None if it is a legacy spelling.

    None means "declared in TDB_OPTIONAL_COLUMNS and not in this release" —
    the distiller writes the declared default instead.
    """
    if column in schema:
        return schema.index(column)
    if (table, column) in TDB_OPTIONAL_COLUMNS:
        return None
    sys.exit(f"error: TDB table {table} has no column {column!r} and it is not "
             f"declared in TDB_OPTIONAL_COLUMNS; schema = {schema}")


def distill_tdb_dump(sql_path: Path, want: dict[str, list[str]], out_dir: Path,
                     required: bool = True) -> None:
    """Extract the wanted tables/columns from a TDB SQL dump into CSVs.

    A table may legitimately have no INSERT (hotfixes only carry hotfixed
    rows) — it still gets a header-only CSV so readers can stream it. With
    `required` false a table missing from the dump entirely is tolerated too:
    older hotfix dumps predate some of the tables we overlay.
    """
    schemas: dict[str, list[str]] = {}
    writers: dict[str, tuple] = {}
    handles = []
    with open(sql_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("CREATE TABLE `"):
                table = line.split("`")[1]
                if table not in want:
                    continue
                cols = []
                for defline in f:
                    defline = defline.strip()
                    if defline.startswith("`"):
                        cols.append(defline.split("`")[1])
                    else:
                        break
                schemas[table] = cols
            elif line.startswith("INSERT INTO `"):
                table = line.split("`")[1]
                if table not in want:
                    continue
                if table not in writers:
                    keep = want[table]
                    idx = [tdb_column_index(table, c, schemas[table]) for c in keep]
                    fh = open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8")
                    handles.append(fh)
                    w = csv.writer(fh)
                    w.writerow(keep)
                    writers[table] = (w, idx, len(schemas[table]))
                w, idx, ncols = writers[table]
                for row in iter_insert_rows(line):
                    if len(row) != ncols:
                        sys.exit(f"error: {table} row has {len(row)} values, schema has {ncols}")
                    w.writerow([row[i] if i is not None
                                else TDB_OPTIONAL_COLUMNS[(table, c)]
                                for i, c in zip(idx, want[table])])
    for fh in handles:
        fh.close()
    for table, keep in want.items():
        if table not in schemas:
            if required and table not in TDB_OPTIONAL_TABLES:
                sys.exit(f"error: table {table} not found in {sql_path.name}")
            why = TDB_OPTIONAL_TABLES.get(table, "no overrides")
            log(f"    {table}: absent from this dump — {why}")
            continue
        if table not in writers:  # zero hotfixed rows — emit header only
            with open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8") as fh:
                csv.writer(fh).writerow(keep)


def fetch_tdb(version: str) -> Path | None:
    """Ensure the TDB tables for this version are distilled; return their dir.

    The 117 MB archive is downloaded and the 700 MB SQL dumps parsed exactly
    once — afterwards only the small distilled CSVs (and the archive) stay
    in the cache. Returns None when no TDB release maps to this version.
    """
    rel = TDB_RELEASES.get(version)
    if rel is None:
        log(f"TDB: no release mapped for {version} — morphs will not resolve, "
            f"hotfixes will not apply")
        return None
    tdb_dir = CACHE_DIR / f"tdb-{rel['tag']}"
    # a release may ship world only (the 3.3.5 branch does), so only the kinds
    # this release actually has count towards "already distilled"
    kinds = [k for k in ("world", "hotfixes") if k in rel]
    wanted_csvs = [t for k in kinds for t in TDB_TABLES[k]]
    if all((tdb_dir / f"{t}.csv").exists() for t in wanted_csvs):
        log(f"TDB ({rel['tag']}): cached ({len(wanted_csvs)} distilled tables)")
        return tdb_dir
    if "hotfixes" not in rel:
        log(f"TDB ({rel['tag']}): world-only release — no hotfix overrides for this build")
    tdb_dir.mkdir(parents=True, exist_ok=True)
    archive = tdb_dir / rel["asset"]
    download(TDB_ASSET_URL.format(**rel), archive, refresh=False)
    dumps = {kind: tdb_dir / rel[kind] for kind in kinds}
    if not all(p.exists() for p in dumps.values()):
        log(f"  extracting {archive.name} ...")
        r = subprocess.run([find_7z(), "x", "-y", f"-o{tdb_dir}", str(archive)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"error: 7z extraction failed: {r.stderr[-500:]}")
    for kind, sql_path in dumps.items():
        log(f"  distilling {sql_path.name} ...")
        # world tables are the only source of creature names/displays, so a
        # missing one is fatal; hotfixes are an overlay, and older dumps
        # legitimately predate some of the tables we look for
        distill_tdb_dump(sql_path, TDB_TABLES[kind], tdb_dir, required=(kind == "world"))
        sql_path.unlink()  # the archive stays; the 460 MB text does not
    return tdb_dir


def fetch_sources(version: str, refresh: bool) -> tuple[Path, Path, Path | None]:
    """Ensure all table CSVs and the listfile are cached; return their dirs."""
    table_dir = CACHE_DIR / version
    log(f"Tables (wago.tools, build {version}):")
    for table in TABLES:
        download(WAGO_CSV_URL.format(table=table, version=version),
                 table_dir / f"{table}.csv", refresh,
                 optional=table in OPTIONAL_TABLES)

    log("Animation names (wow.tools):")
    download(ANIMS_JS_URL, CACHE_DIR / "anims.js", refresh)

    log("Enum names (wowdev/WoWDBDefs):")
    for name in ENUM_FILES:
        download(WOWDBDEFS_ENUM_URL.format(name=name), CACHE_DIR / "enums" / f"{name}.dbde", refresh)

    listfile_dir = CACHE_DIR / "listfile"
    listfile = listfile_dir / "community-listfile.csv"
    log("Listfile (wowdev/wow-listfile):")
    if listfile.exists() and not refresh:
        log(f"  cached   {listfile.name} ({listfile.stat().st_size:,} bytes)")
    else:
        with urllib.request.urlopen(
            urllib.request.Request(LISTFILE_RELEASE_API, headers={"User-Agent": "epsilook-build"}), timeout=60
        ) as resp:
            release = json.load(resp)
        asset = next(a for a in release["assets"] if a["name"] == "community-listfile.csv")
        download(asset["browser_download_url"], listfile, refresh=True)
        (listfile_dir / "release-tag.txt").write_text(release["tag_name"])

    tdb_dir = fetch_tdb(version)
    return table_dir, listfile, tdb_dir


# ------------------------------------------------------------------ parsing

def table_available(table_dir: Path, table: str) -> bool:
    """Whether this build actually has the table (see OPTIONAL_TABLES)."""
    return (table_dir / f"{table}.csv").exists()


def read_table(table_dir: Path, table: str, columns: list[str]) -> Iterator[tuple[str, ...]]:
    """Yield tuples of the requested columns for each row of a cached CSV.

    Absent OPTIONAL_TABLES yield nothing and absent OPTIONAL_COLUMNS fall back
    to their declared default, so one reader serves every game version. A
    column that is missing without being declared optional is a hard error —
    silently dropping data is the one outcome worth crashing over.
    """
    path = table_dir / f"{table}.csv"
    if not path.exists() and table in OPTIONAL_TABLES:
        return  # this build predates the table; its feature switches off
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx: list[int | None] = []
        for c in columns:
            if c in header:
                idx.append(header.index(c))
            elif (table, c) in OPTIONAL_COLUMNS:
                idx.append(None)
            else:
                sys.exit(f"error: {table}.csv is missing column {c!r} and it is not "
                         f"declared in OPTIONAL_COLUMNS; header = {header}")
        defaults = [OPTIONAL_COLUMNS.get((table, c), "") for c in columns]
        for row in reader:
            yield tuple(row[i] if i is not None else d for i, d in zip(idx, defaults))


def table_header(table_dir: Path, table: str) -> list[str]:
    """The column names of a cached CSV."""
    with open(table_dir / f"{table}.csv", newline="", encoding="utf-8") as f:
        return next(csv.reader(f), [])


def array_columns(table_dir: Path, table: str, base: str, count: int) -> list[str]:
    """Column names for a db2 array field, tolerating an array->scalar collapse.

    wago exports an array field `X[n]` as `X_0 .. X_{n-1}`, but Blizzard
    sometimes narrows an array to a plain scalar between builds, and then the
    export is a bare `X`. This returns whichever spelling the build at hand
    actually uses, so one reader serves both.

    Worked example (the reason this exists): SpellShapeshiftForm's
    CreatureDisplayID is `[4]` through 10.1.x — 9.2.7 included — and a scalar
    from 10.2.0 on (WoWDBDefs definitions/SpellShapeshiftForm.dbd). Nothing is
    lost: in 9.2.7 slots 1..3 are empty in all 64 rows.
    """
    header = set(table_header(table_dir, table))
    indexed = [f"{base}_{i}" for i in range(count)]
    if indexed[0] in header:
        return [c for c in indexed if c in header]
    if base in header:
        return [base]
    sys.exit(f"error: {table}.csv has neither {indexed[0]} nor a scalar {base}; "
             f"header = {sorted(header)}")


def hotfix_rows(tdb_dir: Path | None, table: str, columns: list[str]) -> Iterator[tuple[str, ...]]:
    """Yield TDB hotfix rows for a db2 table (nothing when TDB is absent).

    Hotfixes are the rows Blizzard changed server-side after the client
    shipped — each replaces the wago row with the same row ID. A TDB release
    may ship no hotfixes dump at all (the 3.3.5 branch is world-only), and an
    older dump may predate a table; both simply mean "no overrides".
    """
    if tdb_dir is None or not (tdb_dir / f"{table}.csv").exists():
        return
    yield from read_table(tdb_dir, table, columns)


def to_int(s: str) -> int:
    """Parse an integer column ("" -> 0)."""
    return int(s) if s else 0


def to_int_from_float(s: str) -> int:
    """Parse a numeric column that may export in float form ("2.0" -> 2)."""
    return int(float(s)) if s else 0


def to_channel(v: str) -> int:
    """Convert a 0..1 float color column to a 0..255 channel byte."""
    return max(0, min(255, round(float(v or 0) * 255)))


def pack_rgb(r: int, g: int, b: int) -> int:
    """Pack three 0..255 channels into one 0xRRGGBB int (the pack's color form)."""
    return (r << 16) | (g << 8) | b


def unpack_rgb(c: int) -> tuple[int, int, int]:
    """Split a packed 0xRRGGBB color back into (r, g, b)."""
    return (c >> 16) & 255, (c >> 8) & 255, c & 255


def hue_word(r: int, g: int, b: int) -> str:
    """Coarse hue word for the search corpus ("" for white/grey/near-black).

    Baking the word is what makes `fx:"chain red"` find a red-tinted
    greyscale texture — for ~46% of fx spells the tint is the only color
    signal there is. app.js replicates these buckets in hueWordOf() so the
    hover panel's caption says the same word that searches.
    """
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    if s < 0.15 or v < 0.08:
        return ""  # white / grey / near-black tints carry no hue
    deg = h * 360
    for limit, name in ((15, "red"), (45, "orange"), (70, "yellow"), (160, "green"),
                        (200, "cyan"), (255, "blue"), (290, "purple"), (330, "pink"),
                        (361, "red")):
        if deg < limit:
            return name
    return ""


def hue_words(colors: tuple[int, ...]) -> str:
    """Join the distinct hue words of several packed colors (order kept)."""
    words = dict.fromkeys(w for c in colors if c >= 0 for w in (hue_word(*unpack_rgb(c)),) if w)
    return " ".join(words)


def merge_masked(dst: dict[T, int], items: Iterable[T], mask: int) -> None:
    """Union `items` into `dst`, OR-ing `mask` into each one's target mask.

    The single primitive behind the whole graph walk: every payload bucket is
    a {content item -> target mask} map, so adding a kit's contribution is the
    same operation whatever the payload is.
    """
    for item in items:
        dst[item] = dst.get(item, NO_TARGET) | mask


def color_rows(
    spell_map: dict[int, dict[int, int]], colors_of: Callable[[int], tuple[int, ...]]
) -> tuple[list[tuple[int, int, int]], list[int], list[str]]:
    """Flatten one color-only fx source into the three columns its pack sections need.

    Every color-only category (glow, tint, shadowy, ghost material) bakes the
    same shape: the spell->row pairs (each with its target mask), the sorted
    distinct row ids, and one hue word string per id. `colors_of` maps a row id
    to its packed colors, since each source stores them differently (shadowy
    rows carry two).
    """
    pairs = sorted((s, r, m) for s, rs in spell_map.items() for r, m in rs.items())
    ids = sorted({r for rs in spell_map.values() for r in rs})
    return pairs, ids, [hue_words(colors_of(r)) for r in ids]


def read_anim_names() -> list[str]:
    """Parse the animationNames JS array (index = AnimID)."""
    src = (CACHE_DIR / "anims.js").read_text(encoding="utf-8")
    names = re.findall(r'"([^"]*)"', src)
    if len(names) < 1000 or names[0] != "Stand":
        sys.exit("error: anims.js did not parse as expected")
    return names


def read_enum_names(name: str, version: str) -> dict[int, str]:
    """Parse a WoWDBDefs meta/enums .dbde file into {value: NAME}.

    Format: one "ID NAME" per line, optionally "// comment" suffixed. Some
    lines carry a "(BUILD a-b, c-d)" guard restricting which game builds the
    name applies to. Lines with no name (or junk like "==") are skipped —
    the app falls back to showing the raw id.
    """
    ver = tuple(int(p) for p in version.split("."))
    names: dict[int, str] = {}
    for line in (CACHE_DIR / "enums" / f"{name}.dbde").read_text(encoding="utf-8").splitlines():
        line = line.split("//", 1)[0].strip()
        if line.startswith("(BUILD "):
            guard, _, line = line[len("(BUILD "):].partition(")")
            line = line.strip()
            def in_range(rng: str) -> bool:
                lo, _, hi = rng.strip().partition("-")
                lo_t = tuple(int(p) for p in lo.split("."))
                hi_t = tuple(int(p) for p in hi.split(".")) if hi else lo_t
                return lo_t <= ver <= hi_t
            if not any(in_range(r) for r in guard.split(",")):
                continue
        m = re.fullmatch(r"(\d+) ([A-Z][A-Z0-9_]*)", line)
        if m:
            names[int(m.group(1))] = m.group(2)
    if len(names) < 100:
        sys.exit(f"error: enums/{name}.dbde did not parse as expected ({len(names)} names)")
    return names


# ----------------------------------------------------------------- readers
#
# One reader per domain. Each takes the cached CSVs and returns lookup
# tables only — no reader walks the spell graph, and none of them know what
# the pack looks like. The small dataclasses below exist so that a reader
# can return a named bundle instead of a nine-tuple.


def read_spell_names(table_dir: Path, tdb_dir: Path | None) -> tuple[dict[int, str], dict[int, str]]:
    """Read spell id -> name, and (where present) subtext.

    The name table is the spell list: a spell exists for us only if it has a
    name row, and everything downstream filters against it. Which table that
    is depends on the build — see SPELL_NAME_SOURCES.
    """
    source = next(((t, cols) for t, cols in SPELL_NAME_SOURCES
                   if table_available(table_dir, t)), None)
    if source is None:
        sys.exit("error: no spell-name source for this build; tried "
                 + ", ".join(t for t, _ in SPELL_NAME_SOURCES))
    name_table, name_cols = source
    log(f"  spell names from {name_table}.{name_cols[1]}")
    spell_names: dict[int, str] = {}
    for sid, name in read_table(table_dir, name_table, name_cols):
        spell_names[to_int(sid)] = name
    for sid, name in hotfix_rows(tdb_dir, "spell_name", ["ID", "Name"]):
        spell_names[to_int(sid)] = name

    subtexts: dict[int, str] = {}
    for sid, sub in read_table(table_dir, "Spell", ["ID", "NameSubtext_lang"]):
        i = to_int(sid)
        if i in spell_names and sub:
            subtexts[i] = sub
    return spell_names, subtexts


def expand_redirects(
    seeds: set[int], redirects: dict[int, list[tuple[int, int]]]
) -> dict[int, int]:
    """Expand a spell's visuals to include the ones its visuals redirect to.

    Returns {visual -> extra target mask}: the seeds themselves carry
    NO_TARGET (their rows are already masked by their own event TargetType),
    and anything reached through a redirect carries the bits of the columns
    it was reached through (VISUAL_REDIRECTS).

    **The redirect graph contains cycles** — on 9.2.7 one visual names itself
    and one pair names each other — so this is a worklist keyed on the mask
    already recorded, not a recursion. A visual is re-queued only while its
    mask still grows; masks are a 5-bit union and only ever gain bits, so that
    is a fixpoint and it terminates regardless of how the data is shaped.
    Chains longer than one hop are real (3 targets redirect again), which is
    why this cannot be flattened into a single lookup.
    """
    out: dict[int, int] = {}
    queue = [(v, NO_TARGET) for v in seeds]
    while queue:
        v, mask = queue.pop()
        prev = out.get(v)
        merged = mask if prev is None else prev | mask
        if prev is not None and merged == prev:
            continue  # nothing new to say about this visual — and the cycle stop
        out[v] = merged
        for target, bit in redirects.get(v, ()):
            # the bit of the hop is added to the mask of the path taken to get
            # here, so a redirect reached through a redirect carries both
            queue.append((target, mask | bit))
    return out


def read_visual_graph(
    table_dir: Path, tdb_dir: Path | None
) -> tuple[dict[int, dict[int, int]],
           dict[int, dict[int, tuple[int, int]]],
           dict[int, int]]:
    """Read the spell -> visual -> kit edges of the visual graph.

    Both hops are many-to-many. SpellXSpellVisual rows are keyed by row ID
    first so a hotfixed row replaces its wago original before the edges are
    derived (a hotfix can re-point a spell at a different visual).

    The visual -> kit edge carries the event's TargetType as a bit mask (see
    TARGET_BITS): one visual can reach the same kit through several event
    rows, so the mask is unioned per edge. Everything the kit contributes
    inherits that mask during the walk.

    Returns (spell -> {visual -> extra mask}, visual -> {kit -> mask},
    visual -> AnimEventSoundID). The spell->visual edge carries a mask of its
    own because a visual can be reached through a REDIRECT column
    (VISUAL_REDIRECTS) rather than from SpellXSpellVisual, and which column it
    came through is what says whether that content is the caster's view or a
    hostile target's.
    """
    sxv_rows: dict[int, tuple[int, int]] = {}
    for rid, spell_id, visual_id in read_table(
        table_dir, "SpellXSpellVisual", ["ID", "SpellID", "SpellVisualID"]
    ):
        sxv_rows[to_int(rid)] = (to_int(spell_id), to_int(visual_id))
    for rid, spell_id, visual_id in hotfix_rows(
        tdb_dir, "spell_x_spell_visual", ["ID", "SpellID", "SpellVisualID"]
    ):
        sxv_rows[to_int(rid)] = (to_int(spell_id), to_int(visual_id))
    direct: dict[int, set[int]] = defaultdict(set)
    for s, v in sxv_rows.values():
        if s and v:
            direct[s].add(v)

    # SpellVisual's own row: the redirect columns and the anim-event sound. Read
    # by row ID first so a hotfix replaces the wago row wholesale, exactly as
    # the missile columns are (see TDB_TABLES["hotfixes"]["spell_visual"]).
    sv_cols = ["ID", "AnimEventSoundID", *VISUAL_REDIRECTS]
    sv_rows: dict[int, tuple[int, ...]] = {}
    for rid, *vals in read_table(table_dir, "SpellVisual", sv_cols):
        sv_rows[to_int(rid)] = tuple(to_int(v) for v in vals)
    for rid, *vals in hotfix_rows(tdb_dir, "spell_visual", sv_cols):
        sv_rows[to_int(rid)] = tuple(to_int(v) for v in vals)

    bits = list(VISUAL_REDIRECTS.values())
    redirects: dict[int, list[tuple[int, int]]] = {}
    visual_sounds: dict[int, int] = {}
    for vid, (sound, *targets) in sv_rows.items():
        if sound:
            visual_sounds[vid] = sound
        # a visual naming ITSELF is dropped here rather than in the expansion:
        # it is a no-op redirect, and one exists on 9.2.7
        hops = [(t, b) for t, b in zip(targets, bits) if t and t != vid]
        if hops:
            redirects[vid] = hops

    spell_visuals: dict[int, dict[int, int]] = {
        s: expand_redirects(vs, redirects) for s, vs in direct.items()
    }

    # Each (visual, kit) edge keeps its target mask split by PHASE — aura-phase
    # events in one half, everything else in the other — because "Target" means
    # different units in the two (see resolve_target_mask, which folds them back
    # into one mask once the spell is known). Within a half the bits still union:
    # impact kits carry duplicate event rows differing only in TargetType.
    visual_kits: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
    for visual_id, kit_id, target_type, start_event in read_table(
        table_dir, "SpellVisualEvent",
        ["SpellVisualID", "SpellVisualKitID", "TargetType", "StartEvent"]
    ):
        v, k = to_int(visual_id), to_int(kit_id)
        if v and k:
            bit = TARGET_BITS.get(to_int(target_type), NO_TARGET)
            aura_mask, other_mask = visual_kits[v].get(k, (NO_TARGET, NO_TARGET))
            if to_int(start_event) in AURA_PHASE_EVENTS:
                visual_kits[v][k] = (aura_mask | bit, other_mask)
            else:
                visual_kits[v][k] = (aura_mask, other_mask | bit)
    return spell_visuals, visual_kits, visual_sounds


@dataclass
class ModelSources:
    """Every route that ends in a model FileDataID, keyed by its own row id.

    Five routes, one per model category. The attach models are already
    resolved per kit here; the rest are resolved when the kit walk (or a proc
    row) references them.
    """
    effect_name_fid: dict[int, int]   # SpellVisualEffectName.ID -> model fid
    effect_name_type: dict[int, int]  # SpellVisualEffectName.ID -> Type (0 file, 1 item, 2 display, 3-10 weapon)
    area_model_fid: dict[int, int]    # SpellVisualKitAreaModel.ID -> model fid
    emission_fid: dict[int, int]      # SpellEffectEmission.ID -> model fid (ET 8)
    barrage_fid: dict[int, int]       # BarrageEffect.ID -> model fid (ET 17)
    weapontrail_fid: dict[int, int]   # WeaponTrail.ID -> model fid (proc Type 27)
    # kit -> {(fid, category, source attachment, destination attachment, ref)}.
    # Routes with a single attach point put it in `source` and leave
    # `destination` NO_ATTACHMENT; routes with none use NO_ATTACHMENT for both.
    # `ref` is the id of the game entity the model came FROM, and the category
    # says which id space it is in: a CreatureDisplayID on MODEL_CAT_DISPLAY, an
    # Item::ID on MODEL_CAT_ITEM, 0 everywhere else. A row can only ever come
    # from one such entity, so the categories share the field rather than each
    # adding its own — that is the extension point for the next Type-N route.
    attach_models: dict[int, set[tuple[int, int, int, int, int]]]
    # animations carried on the SAME SpellVisualKitModelAttach rows — the
    # attached model's start/loop/end AnimationData ids and its AnimKit. Keyed
    # by kit, they union straight into the existing visual-anim / animkit
    # buckets, so they need no pack section of their own.
    attach_anims: dict[int, set[int]]     # kit -> AnimationData ids (Start/Anim/End)
    attach_animkits: dict[int, set[int]]  # kit -> AnimKit ids


def read_model_sources(
    table_dir: Path, tdb_dir: Path | None, creatures: "CreatureModels",
    items: "ItemModels", listfile_path: Path
) -> ModelSources:
    """Read the model-bearing tables (see ModelSources for the routes)."""
    # SpellVisualEffectName.Type says how to reach the model: 0 = ModelFileDataID
    # (the plain case, all the routes below), 1 = Item (GenericID = Item::ID —
    # not read yet), 2 = CreatureDisplayInfo (GenericID = CreatureDisplayID,
    # resolved here to a model fid). Only the attach route below consults the
    # Type: a Type-2 row there yields a display pill instead of the file its
    # ModelFileDataID happens to still name. Missiles/barrage keep resolving
    # through effect_name_fid unchanged (they carry no CreatureDisplay content).
    effect_name_fid: dict[int, int] = {}
    effect_name_type: dict[int, int] = {}
    effect_name_generic: dict[int, int] = {}
    for en_id, model_fid, etype, generic in read_table(
        table_dir, "SpellVisualEffectName",
        ["ID", "ModelFileDataID", "Type", "GenericID"]
    ):
        e = to_int(en_id)
        effect_name_fid[e] = to_int(model_fid)
        effect_name_type[e] = to_int(etype)
        effect_name_generic[e] = to_int(generic)
    for en_id, model_fid in hotfix_rows(tdb_dir, "spell_visual_effect_name", ["ID", "ModelFileDataID"]):
        effect_name_fid[to_int(en_id)] = to_int(model_fid)

    # Drop the Classic clients' unnamed placeholder fid off the weapon rows (see
    # EFFECT_NAME_TYPE_WEAPON). Rewriting it to 0 here — at the one place the
    # column is read, and after the hotfix overlay so a hotfix cannot reintroduce
    # it — leaves every downstream route (attach models, missiles) to take the
    # plain "no file -> sentinel" branch it already has. Only weapon rows are
    # touched: a Type-0 row naming the same fid keeps its normal model pill.
    weapon_fids = {f for e, f in effect_name_fid.items()
                   if f and effect_name_type.get(e, 0) in EFFECT_NAME_TYPE_WEAPON}
    if weapon_fids:
        placeholders = weapon_fids - set(resolve_paths(listfile_path, weapon_fids))
        for e, f in list(effect_name_fid.items()):
            if f in placeholders and effect_name_type.get(e, 0) in EFFECT_NAME_TYPE_WEAPON:
                effect_name_fid[e] = 0

    # the plain case: a kit attaches a model to the caster/target, at a named
    # M2 attachment point. The attachment is part of the key, so the same
    # model at two different points stays two rows (and renders as two pills)
    # instead of merging — 10.5% of (kit, effect name) pairs on 9.2.7 carry
    # more than one distinct attachment.
    attach_models: dict[int, set[tuple[int, int, int, int, int]]] = defaultdict(set)
    attach_anims: dict[int, set[int]] = defaultdict(set)
    attach_animkits: dict[int, set[int]] = defaultdict(set)
    for kit_id, en_id, attach, start_a, anim_a, end_a, animkit in read_table(
        table_dir, "SpellVisualKitModelAttach",
        ["ParentSpellVisualKitID", "SpellVisualEffectNameID", "AttachmentID",
         "StartAnimID", "AnimID", "EndAnimID", "AnimKitID"]
    ):
        k = to_int(kit_id)
        if not k:
            continue
        e = to_int(en_id)
        at = to_int(attach)
        en_type = effect_name_type.get(e, 0)
        if en_type == EFFECT_NAME_TYPE_DISPLAY:
            # Type 2: the effect-name names a CreatureDisplayID, not a file.
            # Resolve it to that creature model's fid (pure client data, so it
            # works on TDB-less packs) and carry the displayId for the pill.
            disp = effect_name_generic.get(e, 0)
            fid = creatures.fid_for_display(disp)
            if fid:
                attach_models[k].add((fid, MODEL_CAT_DISPLAY, at, NO_ATTACHMENT, disp))
        elif en_type == EFFECT_NAME_TYPE_ITEM:
            # Type 1: the effect-name names an Item::ID. The item carries its own
            # model through the appearance chain, plus the name/quality/icon the
            # pill is built from. The row keeps the ITEM id as its ref even when
            # the item has no name — a nameless item still renders, just without
            # the Wowhead half of the pill (see itemTag in app.js).
            item = effect_name_generic.get(e, 0)
            fid = items.model_fid.get(item, 0)
            if fid:
                attach_models[k].add((fid, MODEL_CAT_ITEM, at, NO_ATTACHMENT, item))
        else:
            fid = effect_name_fid.get(e, 0)
            if fid:
                attach_models[k].add((fid, MODEL_CAT_ATTACH, at, NO_ATTACHMENT, 0))
            elif effect_name_type.get(e, 0) in EFFECT_NAME_TYPE_WEAPON:
                # Type 3-10 with no file: the caster's equipped weapon, held at
                # this attachment point. Sentinel fid -> "equipped weapon" pill.
                attach_models[k].add((WEAPON_FID, MODEL_CAT_ATTACH, at, NO_ATTACHMENT, 0))
        # the start/loop/end anims animate the attached model, but they are
        # AnimationData / AnimKit ids the spell's kit plays — index them even
        # when the model fid is unresolved (a Type 1/2 effect-name). 0 = Stand
        # and -1 = unset are both skipped, matching the SpellVisualAnim rule.
        for a in (to_int(start_a), to_int(anim_a), to_int(end_a)):
            if a > 0:
                attach_anims[k].add(a)
        if to_int(animkit) > 0:
            attach_animkits[k].add(to_int(animkit))

    # SpellVisualKitAreaModel carries the model fid directly (no
    # SpellVisualEffectName hop) and is reached two ways: kit EffectType 8 ->
    # SpellEffectEmission (a particle-style emitter spawning copies of the
    # area model) and proc Type 9.
    area_model_fid: dict[int, int] = {}
    for am_id, model_fid_s in read_table(
        table_dir, "SpellVisualKitAreaModel", ["ID", "ModelFileDataID"]
    ):
        area_model_fid[to_int(am_id)] = to_int(model_fid_s)

    emission_fid: dict[int, int] = {}
    for em_id, am_id in read_table(table_dir, "SpellEffectEmission", ["ID", "AreaModelID"]):
        emission_fid[to_int(em_id)] = area_model_fid.get(to_int(am_id), 0)

    # kit EffectType 17 -> BarrageEffect (volley of N models) -> model via
    # the usual SpellVisualEffectName hop (count/cone columns skipped)
    barrage_fid: dict[int, int] = {}
    for b_id, en_id in read_table(
        table_dir, "BarrageEffect", ["ID", "SpellVisualEffectNameID"]
    ):
        barrage_fid[to_int(b_id)] = effect_name_fid.get(to_int(en_id), 0)

    # WeaponTrail.db2 rows carry a trail model directly in FileDataID —
    # referenced by SpellProceduralEffect Type 27 (Value_0 = WeaponTrail.ID).
    weapontrail_fid: dict[int, int] = {}
    for wt_id, wt_fid in read_table(table_dir, "WeaponTrail", ["ID", "FileDataID"]):
        weapontrail_fid[to_int(wt_id)] = to_int(wt_fid)

    return ModelSources(effect_name_fid, effect_name_type, area_model_fid,
                        emission_fid, barrage_fid, weapontrail_fid, attach_models,
                        attach_anims, attach_animkits)


# what a visual with no missiles contributes: (model fids, soundkits, animkits)
NO_MISSILES: tuple = (frozenset(), frozenset(), frozenset(),
                      (NO_ATTACHMENT, NO_ATTACHMENT))


def read_missiles(
    table_dir: Path, tdb_dir: Path | None, effect_name_fid: dict[int, int],
    effect_name_type: dict[int, int]
) -> dict[int, tuple]:
    """Read visual -> (missile models, soundkits, animkits).

    Missiles are the second path out of SpellVisual, and the only one that
    reaches projectile models: SpellVisual.SpellVisualMissileSetID (plus the
    raid variant) groups SpellVisualMissile rows, each carrying a model and
    sometimes a flight/launch SoundKit and an AnimKit. Arcane Missiles'
    cfx_mage_arcanemissiles_missile.m2 exists nowhere else in the graph.
    """
    # The launch/impact attachment points come from SpellVisual, not from the
    # individual SpellVisualMissile rows: the missile route is per-visual (a
    # whole set is unioned into one bucket), and SpellVisual is also where the
    # data actually lives — 105.6k rows carry a destination on 9.2.7 versus
    # 14.9k on SpellVisualMissile.
    sv_cols = ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID",
               "MissileAttachment", "MissileDestinationAttachment"]
    sv_rows: dict[int, tuple[int, int, int, int]] = {}  # visual -> (set, raid set, src, dst)
    for rid, ms, rms, a, b in read_table(table_dir, "SpellVisual", sv_cols):
        sv_rows[to_int(rid)] = (to_int(ms), to_int(rms), to_int(a), to_int(b))
    for rid, ms, rms, a, b in hotfix_rows(tdb_dir, "spell_visual", sv_cols):
        sv_rows[to_int(rid)] = (to_int(ms), to_int(rms), to_int(a), to_int(b))

    svm_cols = ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                "SoundEntriesID", "AnimKitID"]
    svm_rows: dict[int, tuple[int, ...]] = {}  # missile ID -> (set, en, soundkit, animkit)
    for rid, *vals in read_table(table_dir, "SpellVisualMissile", svm_cols):
        svm_rows[to_int(rid)] = tuple(to_int(v) for v in vals)
    for rid, *vals in hotfix_rows(tdb_dir, "spell_visual_missile", svm_cols):
        svm_rows[to_int(rid)] = tuple(to_int(v) for v in vals)

    set_models: dict[int, set[int]] = defaultdict(set)
    set_soundkits: dict[int, set[int]] = defaultdict(set)
    set_animkits: dict[int, set[int]] = defaultdict(set)
    for set_id, en_id, sk, ak in svm_rows.values():
        if not set_id:
            continue
        fid = effect_name_fid.get(en_id, 0)
        if fid:
            set_models[set_id].add(fid)
        elif effect_name_type.get(en_id, 0) in EFFECT_NAME_TYPE_WEAPON:
            # Type 3-10 with no file: the caster's equipped weapon THROWN as the
            # projectile. Sentinel fid -> "equipped weapon" missile pill.
            set_models[set_id].add(WEAPON_FID)
        if sk:
            set_soundkits[set_id].add(sk)
        if ak:
            set_animkits[set_id].add(ak)

    visual_missiles: dict[int, tuple] = {}
    for v, (set_id, raid_set_id, src, dst) in sv_rows.items():
        parts = tuple(
            d.get(set_id, set()) | d.get(raid_set_id, set())
            for d in (set_models, set_soundkits, set_animkits)
        )
        if any(parts):
            # the attachment pair rides along as a 4th element so the walk can
            # key missile models by where they launch from and land on
            visual_missiles[v] = (*parts, (src, dst))
    return visual_missiles


@dataclass
class ProcEffects:
    """SpellProceduralEffect rows bucketed by what their Type means.

    Type IS the client character-procedure index, so it selects both the
    handler and which Value column carries the payload — the full decode
    lives in the "Proc type decode" section of CLAUDE.md. Each proc id lands
    in the bucket its type feeds, and the kit walk dispatches a kit's proc
    references by looking the id up in each.
    """
    chain: dict[int, int]               # proc ID -> SpellChainEffects ID (Types 0/12/26)
    tints: dict[int, int]               # proc ID -> packed RGB (Types 1 and 23)
    ghost_mats: dict[int, int]          # proc ID -> packed RGB (Type 22)
    desats: dict[int, int]              # proc ID -> desaturation percent (Type 21)
    transps: dict[int, int]             # proc ID -> transparency percent (Type 14)
    freezes: set[int]                   # proc IDs of freeze (Type 11)
    camos: set[int]                     # proc IDs of camo (Type 18)
    models: dict[int, tuple[int, int, int, int, int]]  # proc ID -> model tuple (Types 9, 27)
    anims: dict[int, tuple[int, ...]]   # proc ID -> AnimationData IDs (Type 7)


def read_proc_effects(table_dir: Path, models: ModelSources) -> ProcEffects:
    """Read SpellProceduralEffect and bucket every row by its Type."""
    procs = ProcEffects({}, {}, {}, {}, {}, set(), set(), {}, {})
    proc_cols = ["ID", "Type", "Value_0", "Value_1", "Value_2", "Value_3"]
    for pid, ptype, v0, v1, v2, v3 in read_table(table_dir, "SpellProceduralEffect", proc_cols):
        p, pt = to_int(pid), to_int(ptype)
        if pt in PROC_TYPES_CHAIN:
            procs.chain[p] = to_int_from_float(v0)
        elif pt == PROC_TYPE_TINT:
            procs.tints[p] = to_int_from_float(v0) & 0xFFFFFF
        elif pt == PROC_TYPE_TINT_MAT:
            # material recolor -> tint; colorless (Value_3=0) folds in as black
            procs.tints[p] = to_int_from_float(v3) & 0xFFFFFF
        elif pt == PROC_TYPE_GHOST_MAT:
            c = to_int_from_float(v3)
            if c:  # drop the colorless rows (nothing to show)
                procs.ghost_mats[p] = c & 0xFFFFFF
        elif pt == PROC_TYPE_DESATURATE:
            pct = round(float(v2 or 0) * 100)
            if pct > 0:  # 0% = no desaturation, nothing to show
                procs.desats[p] = pct
        elif pt == PROC_TYPE_TRANSPARENCY:
            pct = round(float(v0 or 0) * 100)
            if pct > 0:
                procs.transps[p] = pct
        elif pt == PROC_TYPE_FREEZE:
            procs.freezes.add(p)
        elif pt == PROC_TYPE_CAMO:
            procs.camos.add(p)
        elif pt == PROC_TYPE_AREAMODEL:
            fid = models.area_model_fid.get(to_int_from_float(v0), 0)
            if fid:
                procs.models[p] = (fid, MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT, 0)
        elif pt == PROC_TYPE_WEAPONTRAIL:
            fid = models.weapontrail_fid.get(to_int_from_float(v0), 0)
            if fid:
                procs.models[p] = (fid, MODEL_CAT_TRAIL, NO_ATTACHMENT, NO_ATTACHMENT, 0)
        elif pt == PROC_TYPE_STANDWALK:
            # Value_0..3 are direct AnimationData IDs (stand/walk/run/...);
            # keep the meaningful ones (>0 skips the ubiquitous Stand=0 default)
            anims = tuple(dict.fromkeys(
                a for a in (to_int_from_float(v0), to_int_from_float(v1),
                            to_int_from_float(v2), to_int_from_float(v3)) if a > 0))
            if anims:
                procs.anims[p] = anims
    return procs


@dataclass
class ScreenRow:
    """One ScreenEffect row's payload (-1 on a color = the row has none).

    A screen effect tints/grades the whole frame while its aura holds. What
    is kept: the row's internal Name (readable, e.g. "Shaman - Hex"), a fog
    tint for Effect=3 rows, and — via FullScreenEffectID, which every
    Effect=8 row has — the screen grade colors, the radial vignette shaping
    where the grade applies, and the overlay/blend-set textures. Gamma,
    saturation, blur, fades and LightParams/SoundAmbience/ZoneMusic are
    skipped for now.
    """
    name: str
    fog: int          # packed RGB, -1 = not a fog row
    fog_alpha: int    # fog opacity byte 0..255, -1 = none
    mul: int          # FullScreenEffect ColorMultiply, -1 = no FSE row
    add: int          # FullScreenEffect ColorAddition, -1 = no FSE row
    mask: tuple[float, float, float]       # vignette (offsetY, size, power); size 0 = no FSE
    textures: tuple[tuple[int, int], ...]  # ((fid, TEX_OVERLAY | TEX_MASK), ...)


@dataclass
class FxPayloads:
    """The per-row payload tables behind the Effects column, keyed by row id."""
    chains: dict[int, tuple]           # chain ID -> (r, g, b, soundkit, texfids, subchains)
    beam_chain: dict[int, tuple[int, int, int]]  # BeamEffect.ID -> (chain, src, dst)
    dissolves: dict[int, tuple[float, tuple[int, ...]]]  # ID -> (duration, tex fids)
    glows: dict[int, int]              # EdgeGlowEffect.ID -> packed RGB
    glow_alphas: dict[int, int]        # EdgeGlowEffect.ID -> alpha 0..255
    shadowies: dict[int, tuple[int, int]]  # ShadowyEffect.ID -> (primary, secondary)
    screens: dict[int, ScreenRow]      # ScreenEffect.ID -> payload
    svse_screen: dict[int, int]        # SpellVisualScreenEffect.ID -> ScreenEffect.ID


def read_fx_payloads(table_dir: Path) -> FxPayloads:
    """Read every fx payload table (chains, dissolves, glows, ghosts, screens)."""
    # TextureBlendSet feeds two consumers: dissolve materials and the screen
    # effects' mask layers
    blendset_tex: dict[int, tuple[int, ...]] = {}
    for row in read_table(
        table_dir, "TextureBlendSet", ["ID"] + [f"TextureFileDataID_{i}" for i in range(3)]
    ):
        fids = tuple(dict.fromkeys(f for f in (to_int(v) for v in row[1:4]) if f))
        blendset_tex[to_int(row[0])] = fids

    # dissolves: EffectType 11 -> DissolveEffect, whose TextureBlendSet
    # carries up to 3 texture fids (mask + material; names via the listfile).
    # The geometry columns (Ramp/Start/End/Fresnel/Curve) are renderer tuning.
    dissolves: dict[int, tuple[float, tuple[int, ...]]] = {}
    for did, tbs_id, duration in read_table(
        table_dir, "DissolveEffect", ["ID", "TextureBlendSetID", "Duration"]
    ):
        dissolves[to_int(did)] = (
            round(float(duration), 2) if duration else 0,
            blendset_tex.get(to_int(tbs_id), ()),
        )

    # FullScreenEffect: the grade colors, the vignette triplet and the two
    # kinds of texture (see TEX_OVERLAY / TEX_MASK). Skipping the Mask*
    # triplet as "renderer tuning" is what once made previews wrong: it is a
    # RADIAL VIGNETTE (MaskOffsetY shifts its centre, MaskSizeMultiplier /
    # MaskPower shape the falloff), and area-denial effects read as a
    # coloured rim around a clear centre because of it.
    # ID -> (mul, add, maskOffsetY, maskSize, maskPower, ((fid, role), ...))
    fse_rows: dict[
        int, tuple[int, int, float, float, float, tuple[tuple[int, int], ...]]
    ] = {}
    for row in read_table(
        table_dir, "FullScreenEffect",
        ["ID", "ColorMultiplyRed", "ColorMultiplyGreen", "ColorMultiplyBlue",
         "ColorAdditionRed", "ColorAdditionGreen", "ColorAdditionBlue",
         "OverlayTextureFileDataID", "TextureBlendSetID",
         "MaskOffsetY", "MaskSizeMultiplier", "MaskPower"]
    ):
        flds = row[1:]
        overlay = to_int(flds[6])
        # a fid carrying both roles in one row keeps the overlay role (it is
        # the finished art either way)
        roles: dict[int, int] = {}
        if overlay:
            roles[overlay] = TEX_OVERLAY
        for f in blendset_tex.get(to_int(flds[7]), ()):
            roles.setdefault(f, TEX_MASK)
        mask = tuple(round(float(v or 0), 3) for v in flds[8:11])
        fse_rows[to_int(row[0])] = (
            pack_rgb(*(to_channel(v) for v in flds[0:3])),
            pack_rgb(*(to_channel(v) for v in flds[3:6])),
            mask[0], mask[1], mask[2],
            tuple(roles.items()),
        )

    screens: dict[int, ScreenRow] = {}
    for sid, name, p0, eff, fse_id in read_table(
        table_dir, "ScreenEffect", ["ID", "Name", "Param_0", "Effect", "FullScreenEffectID"]
    ):
        is_fog = to_int(eff) == SCREEN_EFFECT_FOG
        # Param_0 is aarrggbb: the low 24 bits are the fog color and the top
        # byte is its opacity (spread across 0..255 in 9.2.7 — NOT the wiki's
        # "rrggbbxx" claim, verified against the Hex/jungle-green rows)
        fog = (to_int(p0) & 0xFFFFFF) if is_fog else -1
        fog_a = ((to_int(p0) & 0xFFFFFFFF) >> 24) & 0xFF if is_fog else -1
        # maskSize 0 = "no FullScreenEffect row", so no vignette to apply
        mul, add, m_off, m_size, m_pow, tex = fse_rows.get(
            to_int(fse_id), (-1, -1, 0.0, 0.0, 0.0, ()))
        screens[to_int(sid)] = ScreenRow(name, fog, fog_a, mul, add,
                                         (m_off, m_size, m_pow), tex)

    # kit route: EffectType 19 -> SpellVisualScreenEffect -> ScreenEffectID
    svse_screen: dict[int, int] = {}
    for rid, se_id, _type_id in read_table(
        table_dir, "SpellVisualScreenEffect", ["ID", "ScreenEffectID", "ScreenEffectTypeID"]
    ):
        svse_screen[to_int(rid)] = to_int(se_id)

    # edge glows: EffectType 12 -> EdgeGlowEffect. The color is float RGB
    # 0..1 (multiplier/fade/fresnel columns skipped — renderer tuning); the
    # color is the whole visible payload, packed like the chain tints.
    glows: dict[int, int] = {}
    glow_alphas: dict[int, int] = {}
    for gid, r, g, b, a in read_table(
        table_dir, "EdgeGlowEffect",
        ["ID", "GlowRed", "GlowGreen", "GlowBlue", "GlowAlpha"]
    ):
        glows[to_int(gid)] = pack_rgb(to_channel(r), to_channel(g), to_channel(b))
        # GlowAlpha is a real 0..1 spread (not a 0/1 unset flag like the
        # ShadowyEffect ARGB alpha byte), so it is worth showing
        glow_alphas[to_int(gid)] = to_channel(a)

    # shadowy effects: EffectType 7 -> ShadowyEffect, two packed colors
    # stored as signed int32 ARGB — the alpha byte is masked off
    shadowies: dict[int, tuple[int, int]] = {}
    for eid, primary, secondary in read_table(
        table_dir, "ShadowyEffect", ["ID", "PrimaryColor", "SecondaryColor"]
    ):
        shadowies[to_int(eid)] = (to_int(primary) & 0xFFFFFF,
                                  to_int(secondary) & 0xFFFFFF)

    # chain effects (beams). Two paths lead from a kit to SpellChainEffects:
    # EffectType 1 -> SpellProceduralEffect (Types 0/12/26, Value_0 = chain
    # id) and EffectType 13 -> BeamEffect.BeamID. Composite chains nest via
    # SpellChainEffectID_0..10; geometry/flicker/wave columns are skipped.
    chain_cols = (
        ["ID", "Red", "Green", "Blue", "SoundKitID"]
        + [f"TextureFileDataID_{i}" for i in range(3)]
        + [f"SpellChainEffectID_{i}" for i in range(11)]
    )
    chains: dict[int, tuple] = {}
    for row in read_table(table_dir, "SpellChainEffects", chain_cols):
        cid = to_int(row[0])
        red, green, blue, chain_sk = (to_int(v) for v in row[1:5])
        # dict.fromkeys: dedupe (a chain may repeat a fid) but keep slot order
        texfids = tuple(dict.fromkeys(f for f in (to_int(v) for v in row[5:8]) if f))
        subs = tuple(c for c in (to_int(v) for v in row[8:19]) if c)
        chains[cid] = (red, green, blue, chain_sk, texfids, subs)

    # a beam attaches at BOTH ends — source on the caster, destination on
    # whatever it connects to — so the pair rides with the chain it draws
    beam_chain: dict[int, tuple[int, int, int]] = {}
    for bid, chain_id, src, dst in read_table(
        table_dir, "BeamEffect", ["ID", "BeamID", "SourceAttachID", "DestAttachID"]
    ):
        beam_chain[to_int(bid)] = (to_int(chain_id), to_int(src), to_int(dst))

    return FxPayloads(chains, beam_chain, dissolves, glows, glow_alphas,
                      shadowies, screens, svse_screen)


def expand_chain(chains: dict[int, tuple], cid: int, out: set[int]) -> None:
    """Add a chain and every chain it nests (SpellChainEffectID_0..10) to out."""
    if cid in out or cid not in chains:
        return
    out.add(cid)
    for sub in chains[cid][5]:
        expand_chain(chains, sub, out)


def add_chains(chains: dict[int, tuple], cid: int, src: int, dst: int,
               out: set[tuple[int, int, int]]) -> None:
    """Add a chain (and its nested chains) tagged with an attachment pair.

    Nested chains inherit the attachments of the beam that drew the parent —
    they are segments of the same beam, not independently attached effects.
    """
    expanded: set[int] = set()
    expand_chain(chains, cid, expanded)
    out.update((c, src, dst) for c in expanded)


@dataclass
class KitEffects:
    """What each SpellVisualKit contributes, bucketed by fx category.

    Every field maps kit id -> the payload row ids it references (freezes and
    camos are valueless, so kit membership is the whole payload). This is
    where the SpellVisualKitEffect dispatch lands; the per-spell walk then
    just unions these over the kits a spell reaches.
    """
    models: dict[int, set[tuple[int, int, int, int, int]]]  # (fid, category, src, dst, display)
    soundkits: dict[int, set[int]]
    animkits: dict[int, set[int]]
    anims: dict[int, set[int]]        # direct AnimationData ids (proc Type 7)
    visual_anims: dict[int, set[int]]  # AnimationData ids (SpellVisualAnim, ET 6)
    chains: dict[int, set[tuple[int, int, int]]]  # (chain, src attach, dst attach)
    dissolves: dict[int, set[int]]
    glows: dict[int, set[int]]
    shadowies: dict[int, set[int]]
    ghost_mats: dict[int, set[int]]   # proc Type 22 material recolors
    tints: dict[int, set[int]]
    desats: dict[int, set[int]]       # proc ids (Type 21)
    transps: dict[int, set[int]]      # proc ids (Type 14)
    screens: dict[int, set[int]]      # ScreenEffect ids (ET 19)
    freezes: set[int] = field(default_factory=set)  # kit ids with a freeze proc
    camos: set[int] = field(default_factory=set)    # kit ids with a camo proc


def read_kit_effects(
    table_dir: Path, models: ModelSources, procs: ProcEffects, fx: FxPayloads
) -> KitEffects:
    """Dispatch every SpellVisualKitEffect row into its category bucket.

    EffectType says which table Effect points at; a proc reference (type 1)
    is dispatched further by which ProcEffects bucket its id landed in. Rows
    pointing at a payload row this build does not have are dropped — there
    would be nothing to show.
    """
    kits = KitEffects(
        models=defaultdict(set, {k: set(v) for k, v in models.attach_models.items()}),
        soundkits=defaultdict(set), anims=defaultdict(set),
        # the attach rows' AnimKit / start-loop-end anims seed the same buckets
        # the SpellVisualKitEffect walk fills below (it unions, so this is safe)
        animkits=defaultdict(set, {k: set(v) for k, v in models.attach_animkits.items()}),
        visual_anims=defaultdict(set, {k: set(v) for k, v in models.attach_anims.items()}),
        chains=defaultdict(set), dissolves=defaultdict(set), glows=defaultdict(set),
        shadowies=defaultdict(set), ghost_mats=defaultdict(set), tints=defaultdict(set),
        desats=defaultdict(set), transps=defaultdict(set), screens=defaultdict(set),
    )

    # kit EffectType 6 points at SpellVisualAnim: its AnimKitID feeds the
    # AnimKits group, and its Initial/LoopAnimID are AnimationData ids the kit
    # plays directly on the unit (-1 and 0 both mean unset — 0 would be Stand)
    sva_rows: dict[int, tuple[int, int, int]] = {}
    for sva_id, initial_id, loop_id, animkit_id in read_table(
        table_dir, "SpellVisualAnim", ["ID", "InitialAnimID", "LoopAnimID", "AnimKitID"]
    ):
        sva_rows[to_int(sva_id)] = (to_int(initial_id), to_int(loop_id), to_int(animkit_id))

    for kit_id, effect_type, effect in read_table(
        table_dir, "SpellVisualKitEffect", ["ParentSpellVisualKitID", "EffectType", "Effect"]
    ):
        k, et, e = to_int(kit_id), to_int(effect_type), to_int(effect)
        if not (k and e):
            continue
        if et == EFFECT_TYPE_SOUND:
            kits.soundkits[k].add(e)
        elif et == EFFECT_TYPE_ANIM:
            initial_anim, loop_anim, ak = sva_rows.get(e, (0, 0, 0))
            if ak:
                kits.animkits[k].add(ak)
            for a in (initial_anim, loop_anim):
                if a > 0:
                    kits.visual_anims[k].add(a)
        elif et == EFFECT_TYPE_PROC:
            # one proc reference — dispatch by which type-bucket it landed in
            # proc-route chains have no beam row, so no attachment pair
            add_chains(fx.chains, procs.chain.get(e, 0),
                       NO_ATTACHMENT, NO_ATTACHMENT, kits.chains[k])
            if e in procs.tints:
                kits.tints[k].add(e)
            if e in procs.ghost_mats:
                kits.ghost_mats[k].add(e)
            if e in procs.desats:
                kits.desats[k].add(e)
            if e in procs.transps:
                kits.transps[k].add(e)
            if e in procs.freezes:
                kits.freezes.add(k)
            if e in procs.camos:
                kits.camos.add(k)
            if e in procs.models:
                kits.models[k].add(procs.models[e])
            if e in procs.anims:
                kits.anims[k].update(procs.anims[e])
        elif et == EFFECT_TYPE_BEAM:
            chain_id, src, dst = fx.beam_chain.get(e, (0, NO_ATTACHMENT, NO_ATTACHMENT))
            add_chains(fx.chains, chain_id, src, dst, kits.chains[k])
        elif et == EFFECT_TYPE_DISSOLVE:
            if e in fx.dissolves:  # a missing row carries nothing to show
                kits.dissolves[k].add(e)
        elif et == EFFECT_TYPE_EDGE_GLOW:
            if e in fx.glows:
                kits.glows[k].add(e)
        elif et == EFFECT_TYPE_SHADOWY:
            if e in fx.shadowies:
                kits.shadowies[k].add(e)
        elif et == EFFECT_TYPE_EMISSION:
            fid = models.emission_fid.get(e, 0)
            if fid:
                kits.models[k].add((fid, MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT, 0))
        elif et == EFFECT_TYPE_BARRAGE:
            fid = models.barrage_fid.get(e, 0)
            if fid:
                kits.models[k].add((fid, MODEL_CAT_BARRAGE, NO_ATTACHMENT, NO_ATTACHMENT, 0))
        elif et == EFFECT_TYPE_SCREEN:
            se_id = fx.svse_screen.get(e, 0)
            if se_id in fx.screens:
                kits.screens[k].add(se_id)
    return kits


def read_soundkit_files(table_dir: Path) -> dict[int, set[int]]:
    """Read SoundKitID -> the sound FileDataIDs it plays."""
    soundkit_files: dict[int, set[int]] = defaultdict(set)
    for soundkit_id, fid in read_table(table_dir, "SoundKitEntry", ["SoundKitID", "FileDataID"]):
        sk, f = to_int(soundkit_id), to_int(fid)
        if sk and f:
            soundkit_files[sk].add(f)
    return soundkit_files


def read_animkit_anims(table_dir: Path, anim_names: list[str]) -> dict[int, set[int]]:
    """Read AnimKitID -> the AnimIDs it segments (names come from anims.js)."""
    animkit_anims: dict[int, set[int]] = defaultdict(set)
    for parent_kit, anim_id in read_table(table_dir, "AnimKitSegment", ["ParentAnimKitID", "AnimID"]):
        k, a = to_int(parent_kit), to_int(anim_id)
        if k and 0 <= a < len(anim_names):
            animkit_anims[k].add(a)
    return animkit_anims


@dataclass
class SpellEffectRows:
    """Per-spell data read out of SpellEffect (plus its TDB hotfixes).

    SpellEffect is where a spell's gameplay lives, and five of the fx
    categories start here rather than in the visual graph: the misc values of
    particular Effect/EffectAura enums are ids into other tables.
    """
    effects: dict[int, set[int]]                 # spell -> SpellEffect.Effect enum ids
    auras: dict[int, set[int]]                   # spell -> EffectAura enum ids
    morphs: dict[int, set[int]]                  # spell -> creature ids (aura 56)
    summons: dict[int, set[tuple[int, int]]]     # spell -> (creature, control) (effect 28)
    screens: dict[int, set[int]]                 # spell -> ScreenEffect ids (aura 260)
    forms: dict[int, set[int]]                   # spell -> shapeshift form ids (aura 36)
    altnames: dict[int, set[int]]                # spell -> SpellOverrideName ids (aura 370)
    vehicles: dict[int, set[int]]                # spell -> Vehicle.db2 ids (aura 296)
    invis: dict[int, set[int]]  # spell -> invisibility types (aura 18)
    detect: dict[int, set[int]]  # spell -> detect types (aura 19)
    # who each effect-driven fx lands on, from the producing SpellEffect row's
    # ImplicitTarget_0/_1 — keyed (spell, payload) so it rides the pack's
    # spell->payload link rows (payload = creature / form / screen / vehicle /
    # invis type). OR-accumulated when several rows produce the same pair.
    morph_targets: dict[tuple[int, int], int]
    summon_targets: dict[tuple[int, int], int]
    screen_targets: dict[tuple[int, int], int]
    form_targets: dict[tuple[int, int], int]
    vehicle_targets: dict[tuple[int, int], int]
    invis_targets: dict[tuple[int, int], int]
    detect_targets: dict[tuple[int, int], int]
    # Whole-spell implicit-target bits, used by resolve_target_mask to tell a
    # self-cast from a real one. `aura_target_bits` is OR-ed over the spell's
    # APPLY_AURA effects only (who ends up carrying the aura); `cast_target_bits`
    # over every effect it has (is the whole spell aimed at the caster?).
    aura_target_bits: dict[int, int]
    cast_target_bits: dict[int, int]


def read_spell_effect_rows(
    table_dir: Path, tdb_dir: Path | None, spell_names: dict[int, str],
    screens: dict[int, ScreenRow], target_bits: dict[int, int]
) -> SpellEffectRows:
    """Read SpellEffect and split it into the per-spell sets we ship.

    Any nonzero EffectAura is kept as a mechanic (it is meaningful mostly on
    the APPLY_AURA family, but area-aura effects carry them too). For
    transform auras misc0 is a CREATURE id (server-side NPC entry, per
    SpellAuraNames::SpecialMiscValue) and NOT a display id; for summon
    effects misc0 is likewise a creature id and misc1 a SummonProperties row.
    Note the hotfix CSV spells its misc columns differently (EffectMiscValue1
    vs EffectMiscValue_0) — same field, different source.
    """
    se_cols = ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue_0", "EffectMiscValue_1",
               "ImplicitTarget_0", "ImplicitTarget_1"]
    se_hotfix_cols = ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1", "EffectMiscValue2",
                      "ImplicitTarget1", "ImplicitTarget2"]
    se_rows: dict[int, tuple[int, int, int, int, int, int, int]] = {}
    for rid, spell_id, effect, aura, misc0, misc1, t0, t1 in read_table(table_dir, "SpellEffect", se_cols):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                to_int_from_float(misc0), to_int_from_float(misc1),
                                to_int(t0), to_int(t1))
    for rid, spell_id, effect, aura, misc0, misc1, t0, t1 in hotfix_rows(tdb_dir, "spell_effect", se_hotfix_cols):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                to_int_from_float(misc0), to_int_from_float(misc1),
                                to_int(t0), to_int(t1))

    # SummonProperties: only Control matters (guardian/pet/possessed/...)
    summon_control: dict[int, int] = {}
    for pid, ctrl in read_table(table_dir, "SummonProperties", ["ID", "Control"]):
        summon_control[to_int(pid)] = to_int(ctrl)

    out = SpellEffectRows(defaultdict(set), defaultdict(set), defaultdict(set),
                          defaultdict(set), defaultdict(set), defaultdict(set),
                          defaultdict(set), defaultdict(set), defaultdict(set),
                          defaultdict(set),
                          defaultdict(int), defaultdict(int), defaultdict(int),
                          defaultdict(int), defaultdict(int),
                          defaultdict(int), defaultdict(int),
                          defaultdict(int), defaultdict(int))
    for s, effect_id, aura_id, m0, m1, it0, it1 in se_rows.values():
        if s not in spell_names:
            continue
        mask = target_bits.get(it0, 0) | target_bits.get(it1, 0)
        # accumulate the whole-spell views resolve_target_mask reads: every
        # effect, and the APPLY_AURA effects on their own
        out.cast_target_bits[s] |= mask
        if effect_id == EFFECT_APPLY_AURA:
            out.aura_target_bits[s] |= mask
        if effect_id:
            out.effects[s].add(effect_id)
        if aura_id:
            out.auras[s].add(aura_id)
        if aura_id == AURA_TRANSFORM and m0 > 0:
            out.morphs[s].add(m0)
            out.morph_targets[(s, m0)] |= mask
        if effect_id == EFFECT_SUMMON and m0 > 0:
            out.summons[s].add((m0, summon_control.get(m1, 0)))
            out.summon_targets[(s, m0)] |= mask
        # SCREEN_EFFECT auras carry the ScreenEffect ID in misc0 — the main
        # route (the kit route adds only a handful of rows on top)
        if aura_id == AURA_SCREEN_EFFECT and m0 > 0 and m0 in screens:
            out.screens[s].add(m0)
            out.screen_targets[(s, m0)] |= mask
        if aura_id == AURA_SHAPESHIFT and m0 > 0:
            out.forms[s].add(m0)
            out.form_targets[(s, m0)] |= mask
        if aura_id == AURA_OVERRIDE_NAME and m0 > 0:
            out.altnames[s].add(m0)
        if aura_id == AURA_SET_VEHICLE_ID and m0 > 0:
            out.vehicles[s].add(m0)
            out.vehicle_targets[(s, m0)] |= mask
        # invisibility channels: misc0 is the invisibility TYPE (0 is valid —
        # general invisibility — so no > 0 guard, unlike the id-bearing auras)
        if aura_id == AURA_MOD_INVISIBILITY:
            out.invis[s].add(m0)
            out.invis_targets[(s, m0)] |= mask
        if aura_id == AURA_MOD_INVISIBILITY_DETECT:
            out.detect[s].add(m0)
            out.detect_targets[(s, m0)] |= mask
    return out


# VehicleSeat columns holding AnimationData ids for the PASSENGER — what the
# rider plays getting in, while seated, and getting out. ~99.8% of seats set
# at least one.
SEAT_PASSENGER_ANIM_COLUMNS = [
    "EnterAnimStart", "EnterAnimLoop",
    "RideAnimStart", "RideAnimLoop", "RideUpperAnimStart", "RideUpperAnimLoop",
    "ExitAnimStart", "ExitAnimLoop", "ExitAnimEnd",
]

# ...and for the VEHICLE itself. Kept apart from the passenger set on the
# user's call: it is the vehicle's behaviour, not the rider's, so it renders
# as loose animation pills instead of joining the "passenger" group.
SEAT_VEHICLE_ANIM_COLUMNS = [
    "VehicleEnterAnim", "VehicleExitAnim", "VehicleRideAnimLoop",
]

# AnimKit ids on the seat. These are AnimKit::IDs, so they join the existing
# animkit group rather than needing any new plumbing.
SEAT_ANIMKIT_COLUMNS = [
    "EnterAnimKitID", "RideAnimKitID", "ExitAnimKitID",
    "VehicleEnterAnimKitID", "VehicleRideAnimKitID", "VehicleExitAnimKitID",
]


@dataclass
class VehicleSeats:
    """Vehicle.db2 rows and the VehicleSeat payloads they reach.

    `seats` keeps seat order (SeatID_0..7) because the seat's slot position is
    meaningful; the rest are unioned per vehicle, since a spell surfaces the
    vehicle as a whole rather than one seat's animations.
    """
    seats: dict[int, list[str]]            # vehicle -> [attachment name per seat]
    passenger_anims: dict[int, set[int]]   # vehicle -> AnimationData ids (rider)
    vehicle_anims: dict[int, set[int]]     # vehicle -> AnimationData ids (vehicle)
    animkits: dict[int, set[int]]          # vehicle -> AnimKit ids


def read_vehicle_seats(table_dir: Path) -> VehicleSeats:
    """Walk Vehicle -> SeatID_0..7 -> VehicleSeat for every payload we surface.

    A vehicle references up to eight VehicleSeat rows; empty slots are
    dropped, so the seat list length IS the seat count. Both tables postdate
    the oldest clients (they are OPTIONAL_TABLES), so an absent table yields
    empty maps and the vehicle category simply never appears.
    """
    out = VehicleSeats({}, defaultdict(set), defaultdict(set), defaultdict(set))
    if not table_available(table_dir, "Vehicle"):
        return out
    seat_cols = sorted(
        (c for c in table_header(table_dir, "Vehicle") if c.startswith("SeatID_")),
        key=lambda c: int(c.split("_")[1]))
    slots: dict[int, list[int]] = {}
    for vid, *ids in read_table(table_dir, "Vehicle", ["ID"] + seat_cols):
        slots[to_int(vid)] = [s for s in (to_int(i) for i in ids) if s > 0]

    if not table_available(table_dir, "VehicleSeat"):
        # seat rows unavailable: keep the seat COUNT (slot positions alone
        # give it) and leave every payload empty
        out.seats = {v: [""] * len(ss) for v, ss in slots.items()}
        return out

    have = set(table_header(table_dir, "VehicleSeat"))
    anim_cols = [c for c in SEAT_PASSENGER_ANIM_COLUMNS if c in have]
    veh_cols = [c for c in SEAT_VEHICLE_ANIM_COLUMNS if c in have]
    kit_cols = [c for c in SEAT_ANIMKIT_COLUMNS if c in have]
    cols = ["ID", "AttachmentID"] + anim_cols + veh_cols + kit_cols
    n_anim, n_veh = len(anim_cols), len(veh_cols)
    seat_rows: dict[int, tuple[int, list[int], list[int], list[int]]] = {}
    for seat_row in read_table(table_dir, "VehicleSeat", cols):
        vals = [to_int(v) for v in seat_row]
        rest = vals[2:]
        seat_rows[vals[0]] = (vals[1], rest[:n_anim],
                              rest[n_anim:n_anim + n_veh], rest[n_anim + n_veh:])

    for vehicle_id, seat_ids in slots.items():
        names = []
        for seat_id in seat_ids:
            seat = seat_rows.get(seat_id)
            if seat is None:
                names.append("")
                continue
            attachment, anims, vanims, kits = seat
            names.append(seat_attachment_name(attachment))
            out.passenger_anims[vehicle_id].update(a for a in anims if a > 0)
            out.vehicle_anims[vehicle_id].update(a for a in vanims if a > 0)
            out.animkits[vehicle_id].update(a for a in kits if a > 0)
        out.seats[vehicle_id] = names
    return out


@dataclass
class CreatureModels:
    """Creature -> name/displays, and display -> model file.

    The first half is server-side data that only the TDB world tables have;
    without a TDB release for this build both stay empty and morph creatures
    render unresolved. The second half is client data (with hotfixes) and is
    shared by morphs and shapeshift forms.
    """
    names: dict[int, str]                         # creature entry -> NPC name
    displays: dict[int, list[tuple[int, int]]]    # creature -> [(idx, display id)]
    display_model: dict[int, int]                 # CreatureDisplayInfo.ID -> ModelID
    model_fid: dict[int, int]                     # CreatureModelData.ID -> model fid

    def fid_for_display(self, display_id: int) -> int:
        """Resolve a CreatureDisplayID to its model fid (0 = unknown)."""
        return self.model_fid.get(self.display_model.get(display_id, 0), 0)


def read_creature_models(table_dir: Path, tdb_dir: Path | None) -> CreatureModels:
    """Read the creature -> display -> model chain morphs and forms both use."""
    names: dict[int, str] = {}
    displays: dict[int, list[tuple[int, int]]] = defaultdict(list)
    if tdb_dir is not None:
        for entry, name in read_table(tdb_dir, "creature_template", ["entry", "name"]):
            names[to_int(entry)] = name
        # whichever shape this TDB release stores displays in — see
        # CREATURE_DISPLAY_SOURCES for why there are two
        source = next(((t, cols) for t, cols in CREATURE_DISPLAY_SOURCES
                       if (tdb_dir / f"{t}.csv").exists()), None)
        if source is None:
            log("  TDB: no creature-display source in this release — morphs stay unresolved")
        elif source[0] == "creature_template_model":
            for cid, idx, did in read_table(tdb_dir, *source):
                displays[to_int(cid)].append((to_int(idx), to_int(did)))
        else:
            # legacy: up to four display ids in columns on creature_template,
            # their position standing in for the Idx the modern table carries
            for creature, *legacy_ids in read_table(tdb_dir, *source):
                for slot, display in enumerate(to_int(x) for x in legacy_ids):
                    if display:
                        displays[to_int(creature)].append((slot, display))
        for rows in displays.values():
            rows.sort()

    display_model: dict[int, int] = {}
    for did, mid in read_table(table_dir, "CreatureDisplayInfo", ["ID", "ModelID"]):
        display_model[to_int(did)] = to_int(mid)
    for did, mid in hotfix_rows(tdb_dir, "creature_display_info", ["ID", "ModelID"]):
        display_model[to_int(did)] = to_int(mid)
    model_fid: dict[int, int] = {}
    for mid, fid in read_table(table_dir, "CreatureModelData", ["ID", "FileDataID"]):
        model_fid[to_int(mid)] = to_int(fid)
    for mid, fid in hotfix_rows(tdb_dir, "creature_model_data", ["ID", "FileDataID"]):
        model_fid[to_int(mid)] = to_int(fid)

    return CreatureModels(names, displays, display_model, model_fid)


@dataclass
class ItemModels:
    """Item -> its display name, quality, inventory icon and model file.

    Pure client data, so the route works on the TDB-less Classic packs. Only
    ItemSearchName carries a name, and only about two thirds of the items this
    route reaches appear there at all — the rest are internal props (unnamed
    potions, dynamite, gizmos) that exist purely to be held in a spell visual.
    Those still resolve to a model and an icon, which is why the nameless case
    is worth rendering rather than dropping.
    """
    name: dict[int, str]      # Item::ID -> ItemSearchName.Display_lang
    quality: dict[int, int]   # Item::ID -> OverallQualityID
    icon_fid: dict[int, int]  # Item::ID -> inventory icon FileDataID
    model_fid: dict[int, int] # Item::ID -> model fid (first that resolves)

    def resolved(self, item_id: int) -> bool:
        return bool(self.model_fid.get(item_id))


def read_item_models(table_dir: Path) -> ItemModels:
    """Read Item -> name/quality/icon/model (SpellVisualEffectName Type 1, §3c).

    The model hop is
    `ItemModifiedAppearance -> ItemAppearance -> ItemDisplayInfo
     -> ModelResourcesID -> ModelFileData.FileDataID`,
    which resolves 99.8% of the items this route reaches on 9.2.7. An item can
    have several appearances (transmog variants); they are walked in row order
    and the first that yields a file wins, so the pill shows the item's base
    look rather than an arbitrary recolour.
    """
    name: dict[int, str] = {}
    quality: dict[int, int] = {}
    for iid, disp, qual in read_table(
        table_dir, "ItemSearchName", ["ID", "Display_lang", "OverallQualityID"]
    ):
        i = to_int(iid)
        if disp:
            name[i] = disp
            quality[i] = to_int(qual)

    # ModelResourcesID -> a model file. One resources id can name several files
    # (LODs); the lowest fid is the base model.
    res_fid: dict[int, int] = {}
    for fid, res in read_table(table_dir, "ModelFileData", ["FileDataID", "ModelResourcesID"]):
        r, f = to_int(res), to_int(fid)
        if r and f and (r not in res_fid or f < res_fid[r]):
            res_fid[r] = f

    # ItemDisplayInfo.ID -> its model resources (slot 0 is the main model,
    # slot 1 the off-hand/second component of a paired item)
    display_res: dict[int, tuple[int, int]] = {}
    for did, r0, r1 in read_table(
        table_dir, "ItemDisplayInfo", ["ID", "ModelResourcesID_0", "ModelResourcesID_1"]
    ):
        display_res[to_int(did)] = (to_int(r0), to_int(r1))

    # ItemAppearance.ID -> (ItemDisplayInfoID, icon fid)
    appearance: dict[int, tuple[int, int]] = {}
    for aid, did, icon in read_table(
        table_dir, "ItemAppearance", ["ID", "ItemDisplayInfoID", "DefaultIconFileDataID"]
    ):
        appearance[to_int(aid)] = (to_int(did), to_int(icon))

    icon_fid: dict[int, int] = {}
    model_fid: dict[int, int] = {}
    for iid, aid in read_table(
        table_dir, "ItemModifiedAppearance", ["ItemID", "ItemAppearanceID"]
    ):
        i, a = to_int(iid), to_int(aid)
        if not i or a not in appearance:
            continue
        display_id, icon_file = appearance[a]
        if icon_file and i not in icon_fid:
            icon_fid[i] = icon_file
        if i not in model_fid:
            for res_id in display_res.get(display_id, (0, 0)):
                model_file = res_fid.get(res_id, 0)
                if model_file:
                    model_fid[i] = model_file
                    break

    return ItemModels(name, quality, icon_fid, model_fid)


def read_shapeshift_forms(table_dir: Path) -> tuple[dict[int, str], dict[int, list[int]]]:
    """Read SpellShapeshiftForm -> its name and its creature display(s).

    Plenty of forms (Battle Stance, Shadowform, Stealth, Moonkin) have no
    display at all — they keep their name and render as a name-only pill.

    The display field is an array of 4 up to 10.1.x and a scalar from 10.2.0
    on; array_columns hides the difference.
    """
    form_names: dict[int, str] = {}
    form_displays: dict[int, list[int]] = {}
    for fid_, name, *disp in read_table(
        table_dir, "SpellShapeshiftForm",
        ["ID", "Name_lang"] + array_columns(table_dir, "SpellShapeshiftForm", "CreatureDisplayID", 4)
    ):
        form_names[to_int(fid_)] = name
        form_displays[to_int(fid_)] = [d for d in (to_int(x) for x in disp) if d > 0]
    return form_names, form_displays


def read_override_names(table_dir: Path, spell_altnames: dict[int, set[int]]) -> dict[int, str]:
    """Resolve each spell's SpellOverrideName ids to one searchable string.

    Search corpus only — the row keeps showing the spell's real name, so all
    that is kept is the text (a spell may carry several).
    """
    override_names: dict[int, str] = {}
    for oid, name in read_table(table_dir, "SpellOverrideName", ["ID", "OverrideName_lang"]):
        override_names[to_int(oid)] = name
    spell_altname_text: dict[int, str] = {}
    for s, ids in spell_altnames.items():
        words = [override_names[i] for i in sorted(ids) if i in override_names]
        if words:
            spell_altname_text[s] = " ".join(words)
    return spell_altname_text


def read_spell_icons(
    table_dir: Path, tdb_dir: Path | None, spell_names: dict[int, str]
) -> dict[int, int]:
    """Read spell -> icon FileDataID from SpellMisc (base difficulty wins)."""
    sm_rows: dict[int, tuple[int, int, int]] = {}
    for rid, spell_id, diff, icon_fid in read_table(
        table_dir, "SpellMisc", ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"]
    ):
        sm_rows[to_int(rid)] = (to_int(spell_id), to_int(diff), to_int(icon_fid))
    for rid, spell_id, diff, icon_fid in hotfix_rows(
        tdb_dir, "spell_misc", ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"]
    ):
        sm_rows[to_int(rid)] = (to_int(spell_id), to_int(diff), to_int(icon_fid))
    spell_icon_fid: dict[int, int] = {}
    for s, d, f in sm_rows.values():
        if s in spell_names and f and (s not in spell_icon_fid or d == 0):
            spell_icon_fid[s] = f
    return spell_icon_fid


# -------------------------------------------------------------- the walk

@dataclass
class SpellVisuals:
    """Everything the graph walk attributes to a spell, keyed by spell id.

    Same buckets as KitEffects (a spell's payloads are the union over every
    kit it reaches, plus its missiles), which is what makes the walk a dozen
    identical merges rather than a dozen special cases.

    Each bucket maps spell id -> {content item -> target mask}: the union of
    the TargetType bits of every kit that spell reached the item through (see
    TARGET_BITS). Content that arrives from outside the event graph — missile
    sets, which have no event row — carries NO_TARGET. Every bucket carries a
    mask even where the pack does not currently emit one, so giving a category
    an icon later is a pack-section change, not a walk change.
    """
    models: dict[int, dict[tuple[int, int, int, int, int], int]]   # (fid, category, src, dst, display)
    sounds: dict[int, dict[tuple[int, int], int]]   # (soundkit, sound fid)
    animkits: dict[int, dict[int, int]]
    anims: dict[int, dict[int, int]]                # direct AnimationData ids (stance)
    visual_anims: dict[int, dict[int, int]]         # AnimationData ids (SpellVisualAnim)
    chains: dict[int, dict[tuple[int, int, int], int]]
    dissolves: dict[int, dict[int, int]]
    glows: dict[int, dict[int, int]]
    shadowies: dict[int, dict[int, int]]
    ghost_mats: dict[int, dict[int, int]]
    tints: dict[int, dict[int, int]]
    desats: dict[int, dict[int, int]]
    transps: dict[int, dict[int, int]]
    freezes: set[int]
    camos: set[int]
    orphans: int   # SpellXSpellVisual rows whose SpellID has no SpellName


def walk_spells(
    spell_names: dict[int, str],
    spell_visuals: dict[int, dict[int, int]],
    visual_kits: dict[int, dict[int, tuple[int, int]]],
    visual_missiles: dict[int, tuple],
    kits: KitEffects,
    soundkit_files: dict[int, set[int]],
    fx: FxPayloads,
    spell_screens: dict[int, set[int]],
    visual_sounds: dict[int, int],
    aura_target_bits: dict[int, int],
    cast_target_bits: dict[int, int],
) -> SpellVisuals:
    """Walk spell -> visual -> kit once, unioning every payload per spell.

    Screen effects are the one payload that also arrives from outside the
    graph (SCREEN_EFFECT auras), so spell_screens comes in already populated
    and this extends it with the kit route.

    Each spell->visual edge carries an extra target mask (see
    expand_redirects): everything a spell reaches through that visual is
    OR-ed with it, which is how a redirect-only visual's content ends up
    marked as the caster's or a hostile target's view.
    """
    vis = SpellVisuals(
        models=defaultdict(dict), sounds=defaultdict(dict), animkits=defaultdict(dict),
        anims=defaultdict(dict), visual_anims=defaultdict(dict),
        chains=defaultdict(dict), dissolves=defaultdict(dict),
        glows=defaultdict(dict), shadowies=defaultdict(dict), ghost_mats=defaultdict(dict),
        tints=defaultdict(dict), desats=defaultdict(dict), transps=defaultdict(dict),
        freezes=set(), camos=set(), orphans=0,
    )

    for spell_id, visuals in spell_visuals.items():
        if spell_id not in spell_names:
            vis.orphans += 1
            continue
        for v, extra in visuals.items():
            # `extra` is NO_TARGET for a visual the spell names directly, and the
            # caster/target bit for one it only reaches through a redirect column
            # (VISUAL_REDIRECTS) — so redirect-only content says whose view it is
            # even though it never passed through a SpellVisualEvent row.
            # missile-set content has no SpellVisualEvent row, so no target type
            m_fids, m_sks, m_aks, (m_src, m_dst) = visual_missiles.get(v, NO_MISSILES)
            merge_masked(vis.models[spell_id],
                         ((f, MODEL_CAT_MISSILE, m_src, m_dst, 0) for f in m_fids), extra)
            merge_masked(vis.animkits[spell_id], m_aks, extra)
            for sk in m_sks:
                merge_masked(vis.sounds[spell_id],
                             ((sk, f) for f in soundkit_files.get(sk, ())), extra)
            # the visual's own anim-event sound: a SoundKit like any other, but
            # hanging off SpellVisual rather than off a kit or a missile
            ae_sk = visual_sounds.get(v, 0)
            if ae_sk:
                merge_masked(vis.sounds[spell_id],
                             ((ae_sk, f) for f in soundkit_files.get(ae_sk, ())), extra)
            for k, (aura_mask, other_mask) in visual_kits.get(v, {}).items():
                # "Target" means the caster on a self-cast spell, and the aura
                # phase judges that by its own effects — see resolve_target_mask
                mask = resolve_target_mask(aura_mask, other_mask,
                                           aura_target_bits.get(spell_id, 0),
                                           cast_target_bits.get(spell_id, 0)) | extra
                merge_masked(vis.models[spell_id], kits.models.get(k, ()), mask)
                merge_masked(vis.animkits[spell_id], kits.animkits.get(k, ()), mask)
                merge_masked(vis.anims[spell_id], kits.anims.get(k, ()), mask)
                merge_masked(vis.visual_anims[spell_id], kits.visual_anims.get(k, ()), mask)
                merge_masked(vis.chains[spell_id], kits.chains.get(k, ()), mask)
                merge_masked(vis.dissolves[spell_id], kits.dissolves.get(k, ()), mask)
                merge_masked(vis.glows[spell_id], kits.glows.get(k, ()), mask)
                merge_masked(vis.shadowies[spell_id], kits.shadowies.get(k, ()), mask)
                merge_masked(vis.ghost_mats[spell_id], kits.ghost_mats.get(k, ()), mask)
                merge_masked(vis.tints[spell_id], kits.tints.get(k, ()), mask)
                merge_masked(vis.desats[spell_id], kits.desats.get(k, ()), mask)
                merge_masked(vis.transps[spell_id], kits.transps.get(k, ()), mask)
                if k in kits.freezes:
                    vis.freezes.add(spell_id)
                if k in kits.camos:
                    vis.camos.add(spell_id)
                spell_screens[spell_id].update(kits.screens.get(k, ()))
                for sk in kits.soundkits.get(k, ()):
                    merge_masked(vis.sounds[spell_id],
                                 ((sk, f) for f in soundkit_files.get(sk, ())), mask)

    # a chain effect's own SoundKit folds into the spell's Sounds column, and
    # inherits the mask the chain itself carries
    for spell_id, chains in vis.chains.items():
        for c, mask in chains.items():
            sk = fx.chains[c[0]][3]
            merge_masked(vis.sounds[spell_id],
                         ((sk, f) for f in soundkit_files.get(sk, ())), mask)
    return vis


def resolve_paths(listfile_path: Path, wanted: set[int]) -> dict[int, str]:
    """Stream the community listfile, keeping the paths of the wanted fids.

    The listfile is ~150 MB of "fid;path" lines for the whole game, so it is
    read once and filtered rather than loaded.
    """
    fid_path: dict[int, str] = {}
    with open(listfile_path, newline="", encoding="utf-8", errors="replace") as f:
        for line in f:
            fid_str, sep, path = line.partition(";")
            if not sep:
                continue
            try:
                fid = int(fid_str)
            except ValueError:
                continue
            if fid in wanted:
                fid_path[fid] = path.strip()
    return fid_path


def build_icon_index(
    spell_ids: list[int], spell_icon_fid: dict[int, int], fid_path: dict[int, str]
) -> tuple[list[str], list[int]]:
    """Build the deduped icon-name table and each spell's 1-based index into it.

    "interface/icons/xxx.blp" -> "xxx", which is the key Wowhead's CDN serves
    icons under (wow.zamimg.com/images/wow/icons/<size>/<xxx>.jpg). Index 0
    means the spell has no icon.
    """
    icon_names: list[str] = []
    icon_index: dict[str, int] = {}
    spell_icons: list[int] = []
    for s in spell_ids:
        path = fid_path.get(spell_icon_fid.get(s, 0), "")
        name = (path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
                if path.lower().startswith("interface/icons/") else "")
        if not name:
            spell_icons.append(0)
            continue
        i = icon_index.get(name)
        if i is None:
            i = icon_index[name] = len(icon_names)
            icon_names.append(name)
        spell_icons.append(i + 1)
    return icon_names, spell_icons


# ------------------------------------------------------------- the pack

def build_pack(version: str, label: str, table_dir: Path, listfile_path: Path,
               tdb_dir: Path | None) -> dict:
    """Run the whole pipeline and return the pack as a JSON-ready dict.

    The pack is column-oriented: a section like {spellIds, fids} is a pair of
    parallel arrays where row i links spellIds[i] to fids[i]. That form
    gzips far better than a list of objects and is what data.js indexes.
    """
    t0 = time.time()

    # what this build simply does not have — reported up front so a thin pack
    # reads as "the game had no such table yet" rather than "the build broke"
    absent = sorted(t for t in OPTIONAL_TABLES if not table_available(table_dir, t))
    if absent:
        log(f"Absent in {version} ({len(absent)} tables) — these features switch off:")
        for t in absent:
            log(f"  - {t}: {OPTIONAL_TABLES[t]}")

    # --- read the sources -------------------------------------------------
    log("Reading spell names ...")
    spell_names, subtexts = read_spell_names(table_dir, tdb_dir)

    log("Reading spell visual chain tables ...")
    spell_visuals, visual_kits, visual_sounds = read_visual_graph(table_dir, tdb_dir)
    # creature-display chain first: read_model_sources needs it to resolve
    # SpellVisualEffectName Type 2 (GenericID = CreatureDisplayID) to a model fid
    creatures = read_creature_models(table_dir, tdb_dir)
    # SpellVisualEffectName Type 1 (GenericID = Item::ID) -> the item's model,
    # name, quality and icon; read ahead of the model sources that consume it
    items = read_item_models(table_dir)
    models = read_model_sources(table_dir, tdb_dir, creatures, items, listfile_path)
    visual_missiles = read_missiles(table_dir, tdb_dir, models.effect_name_fid,
                                    models.effect_name_type)
    procs = read_proc_effects(table_dir, models)
    fx = read_fx_payloads(table_dir)
    kits = read_kit_effects(table_dir, models, procs, fx)
    soundkit_files = read_soundkit_files(table_dir)
    anim_names = read_anim_names()
    animkit_anims = read_animkit_anims(table_dir, anim_names)

    se = read_spell_effect_rows(table_dir, tdb_dir, spell_names, fx.screens,
                                implicit_target_bits(version))
    spell_altname_text = read_override_names(table_dir, se.altnames)
    spell_icon_fid = read_spell_icons(table_dir, tdb_dir, spell_names)

    # --- resolve the creature-display payloads ----------------------------
    # morphs: flatten to (creature, display, model fid) rows
    used_creatures = {c for cs in se.morphs.values() for c in cs}
    morph_display_rows = [
        (c, did, creatures.fid_for_display(did))
        for c in sorted(used_creatures)
        for _idx, did in creatures.displays.get(c, ())
    ]

    # shapeshift forms: a form referenced by a spell but missing from the
    # table is dropped (same as dissolves/screens); a form with no display
    # keeps its name and renders as a name-only pill
    form_names, form_displays = read_shapeshift_forms(table_dir)
    for s in list(se.forms):
        se.forms[s] = {f for f in se.forms[s] if f in form_names}
        if not se.forms[s]:
            del se.forms[s]
    used_forms = {f for fs in se.forms.values() for f in fs}
    # (form, display, model fid) — fid 0 = display resolves to no model
    form_display_rows = [
        (f, did, creatures.fid_for_display(did))
        for f in sorted(used_forms)
        for did in form_displays.get(f, ())
    ]

    # --- walk the chains per spell ----------------------------------------
    log("Walking spell -> model/sound/animkit/chain chains ...")
    vis = walk_spells(spell_names, spell_visuals, visual_kits, visual_missiles,
                      kits, soundkit_files, fx, se.screens, visual_sounds,
                      se.aura_target_bits, se.cast_target_bits)

    # --- file names from the listfile -------------------------------------
    used_chains = {c[0] for chains in vis.chains.values() for c in chains}
    used_dissolves = {e for effs in vis.dissolves.values() for e in effs}
    used_screens = {sc for scs in se.screens.values() for sc in scs}

    referenced_fids: set[int] = set()
    for pairs in vis.models.values():
        referenced_fids.update(f for f, *_ in pairs if f > 0)  # skip fileless sentinels
    for sound_pairs in vis.sounds.values():
        referenced_fids.update(f for _, f in sound_pairs)
    for c in used_chains:
        referenced_fids.update(fx.chains[c][4])
    for e in used_dissolves:
        referenced_fids.update(fx.dissolves[e][1])
    for sc in used_screens:
        referenced_fids.update(f for f, _role in fx.screens[sc].textures)
    referenced_fids.update(f for _, _, f in morph_display_rows if f)
    referenced_fids.update(f for _, _, f in form_display_rows if f)

    # icon fids resolve through the same listfile pass but stay out of the
    # pack's files table (they become iconNames instead)
    icon_fids = set(spell_icon_fid.values())
    # item inventory icons resolve the same way (an item pill shows the icon the
    # game shows in the bag), so they join the one listfile pass
    icon_fids |= {items.icon_fid.get(ref, 0)
                  for pairs in vis.models.values()
                  for (_f, c, _s, _d, ref) in pairs
                  if c == MODEL_CAT_ITEM and ref}
    icon_fids.discard(0)
    lookup_fids = referenced_fids | icon_fids

    log(f"Resolving {len(lookup_fids):,} referenced file ids against the listfile ...")
    fid_path = resolve_paths(listfile_path, lookup_fids)
    unnamed = sum(1 for f in referenced_fids if f not in fid_path)

    # --- assemble the pack ------------------------------------------------
    log("Assembling pack ...")
    spell_ids = sorted(spell_names)
    icon_names, spell_icons = build_icon_index(spell_ids, spell_icon_fid, fid_path)

    spells = {
        "ids": spell_ids,
        "names": [spell_names[s] for s in spell_ids],
        "subtexts": [subtexts.get(s, "") for s in spell_ids],
        # SpellOverrideName text, folded into the name search corpus only —
        # never rendered (the row keeps showing its real name)
        "altNames": [spell_altname_text.get(s, "") for s in spell_ids],
        "icons": spell_icons,
    }

    file_ids = sorted(referenced_fids)
    file_paths = [fid_path.get(f, "") for f in file_ids]
    # name any fileless model sentinel this pack actually uses (see WEAPON_FID) —
    # a synthetic files entry so the pill has a label and is searchable
    used_fids = {f for pairs in vis.models.values() for f, *_ in pairs}
    for fid, name in SYNTHETIC_MODEL_FILES.items():
        if fid in used_fids:
            file_ids.append(fid)
            file_paths.append(name)
    files = {
        "fids": file_ids,
        "paths": file_paths,
    }

    # every kit-derived row carries its target mask as the last element (see
    # TARGET_BITS); the pack emits it as a parallel "targets" array
    model_rows = sorted(
        (s, f, c, m, src, dst, ref)
        for s, pairs in vis.models.items() for (f, c, src, dst, ref), m in pairs.items())

    # items reached by a MODEL_CAT_ITEM row: ship the name, quality word and
    # icon each pill needs. An item with no ItemSearchName row still ships (with
    # an empty name) — it renders as a model pill and its icon still reads.
    used_items = sorted({r[6] for r in model_rows if r[2] == MODEL_CAT_ITEM and r[6]})
    item_icon_names: list[str] = []
    item_icon_index: dict[str, int] = {}
    item_icons: list[int] = []
    for i in used_items:
        path = fid_path.get(items.icon_fid.get(i, 0), "")
        nm = (path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
              if path.lower().startswith("interface/icons/") else "")
        if not nm:
            item_icons.append(0)
            continue
        idx = item_icon_index.get(nm)
        if idx is None:
            idx = item_icon_index[nm] = len(item_icon_names)
            item_icon_names.append(nm)
        item_icons.append(idx + 1)   # 1-based; 0 = no icon
    sound_rows = sorted(
        (s, sk, f, m) for s, pairs in vis.sounds.items() for (sk, f), m in pairs.items())
    anim_rows = sorted(
        (s, a, m) for s, aks in vis.animkits.items() for a, m in aks.items())
    fx_rows = sorted(
        (s, c, m, src, dst)
        for s, chains in vis.chains.items() for (c, src, dst), m in chains.items())

    # per used chain: packed RGB tint (0xFFFFFF = untinted — "the texture's
    # own color") plus the hue word its corpus searches by
    fx_chain_ids = sorted(used_chains)
    fx_colors, fx_hues = [], []
    for c in fx_chain_ids:
        r, g, b = fx.chains[c][:3]
        fx_colors.append(pack_rgb(r, g, b))
        fx_hues.append(hue_word(r, g, b))
    fx_tex_rows = sorted((c, f) for c in used_chains for f in fx.chains[c][4])

    dissolve_row_pairs = sorted(
        (s, e, m) for s, effs in vis.dissolves.items() for e, m in effs.items())
    dissolve_ids = sorted(used_dissolves)
    dissolve_tex_rows = sorted((e, f) for e in used_dissolves for f in fx.dissolves[e][1])

    # edge glows / tints / ghost materials: color-only rows — same packed RGB
    # plus hue word treatment as the chain tints (hex search happens app-side).
    # Shadowy rows carry two colors, so their corpus word list joins both.
    glow_row_pairs, glow_ids, glow_hues = color_rows(
        vis.glows, lambda gid: (fx.glows[gid],))
    tint_row_pairs, tint_ids, tint_hues = color_rows(
        vis.tints, lambda tid: (procs.tints[tid],))
    shadowy_row_pairs, shadowy_ids, shadowy_hues = color_rows(
        vis.shadowies, lambda sid: fx.shadowies[sid])
    ghost_mat_pairs, ghost_mat_ids, ghost_mat_hues = color_rows(
        vis.ghost_mats, lambda mid: (procs.ghost_mats[mid],))

    # screen effects: one row per used ScreenEffect — its hue words come from
    # whichever of the three colors the row actually has
    screen_pairs = sorted((s, sc) for s, scs in se.screens.items() for sc in scs)
    screen_ids = sorted(used_screens)
    screen_hues = [
        hue_words((fx.screens[sc].fog, fx.screens[sc].mul, fx.screens[sc].add))
        for sc in screen_ids
    ]
    # overlays sort before masks per screen (TEX_OVERLAY = 0), so the pill
    # previews the finished art when a screen has both
    screen_tex_rows = sorted(
        (sc, role, f) for sc in used_screens for f, role in fx.screens[sc].textures)

    # desaturate (Type 21) / transparency (Type 14): percent-only pills — the
    # percent IS the pill id. Dedupe equal percents on the same spell.
    desat_pairs = sorted({(s, procs.desats[d]) for s, ds in vis.desats.items() for d in ds})
    transp_pairs = sorted({(s, procs.transps[t]) for s, ts in vis.transps.items() for t in ts})
    # freeze (11) / camo (18): valueless — just the spell id set
    freeze_ids = sorted(vis.freezes)
    camo_ids = sorted(vis.camos)

    # vehicles (SET_VEHICLE_ID auras): keep only vehicles with at least one
    # seat — a 0-seat vehicle carries no pill. Computed before the animkit
    # rows below because a seat's AnimKit ids join the animkit group, so they
    # have to count as "used" too.
    vehicle_seats = read_vehicle_seats(table_dir)
    vehicle_rows = sorted(
        (s, v) for s, vs in se.vehicles.items() for v in vs
        if vehicle_seats.seats.get(v))
    vehicle_ids = sorted({v for _, v in vehicle_rows})
    # one row per SEAT, in slot order, carrying its attachment name
    vehicle_seat_rows = [(v, name) for v in vehicle_ids
                         for name in vehicle_seats.seats[v]]
    # a spell reaches its vehicle's animations through the vehicle; flatten
    # to spell -> anim id so the runtime needs no second hop
    def _spell_rows(per_vehicle: dict[int, set[int]],
                    limit: int | None = None) -> list[tuple[int, int]]:
        return sorted({(s, x) for s, v in vehicle_rows
                       for x in per_vehicle.get(v, ())
                       if limit is None or x < limit})

    passenger_anim_rows = _spell_rows(vehicle_seats.passenger_anims, len(anim_names))
    vehicle_anim_rows = _spell_rows(vehicle_seats.vehicle_anims, len(anim_names))
    vehicle_animkit_rows = _spell_rows(vehicle_seats.animkits)

    # only animkits that spells actually use — via visual kits, or via a
    # vehicle seat the spell reaches
    used_animkits = {a for aks in vis.animkits.values() for a in aks}
    used_animkits |= {k for _, k in vehicle_animkit_rows}
    kit_anim_rows = sorted(
        (k, a) for k, anims in animkit_anims.items() if k in used_animkits for a in anims)
    # direct stand/walk anim ids (proc Type 7) — index into animNames, like
    # animKitAnims; guard against ids past the anim-name table
    anim_direct_rows = sorted(
        {(s, a) for s, aset in vis.anims.items() for a in aset if a < len(anim_names)})
    # animations the visual kits play directly (SpellVisualAnim initial/loop,
    # kit EffectType 6) — the largest animation source, same id space
    visual_anim_rows = sorted(
        (s, a, m) for s, aset in vis.visual_anims.items()
        for a, m in aset.items() if a < len(anim_names))
    effect_rows = sorted((s, e) for s, effs in se.effects.items() for e in effs)
    aura_rows = sorted((s, a) for s, auras in se.auras.items() for a in auras)
    morph_rows = sorted((s, c) for s, cs in se.morphs.items() for c in cs)
    shapeshift_rows = sorted((s, f) for s, fs in se.forms.items() for f in fs)
    shapeshift_form_ids = sorted(used_forms)
    morph_creature_ids = sorted(used_creatures)
    summon_rows = sorted((s, c, ctrl) for s, cs in se.summons.items() for c, ctrl in cs)
    summon_creature_ids = sorted({c for cs in se.summons.values() for c, _ in cs})
    # invisibility channels. A channel is materialized only when it has an
    # INVIS side — that single rule implements the asymmetric display rule:
    #  - an invis spell always shows a pill (its detect count may be 0 — the
    #    priceless "nothing can reveal it" case), and
    #  - a detect spell shows a pill only when its type has ≥1 invis spell (a
    #    detect that reveals nothing is dropped: its type has no invis side, so
    #    no channel exists and its row is omitted below).
    invis_types = {t for ts in se.invis.values() for t in ts}
    invis_rows = sorted((s, t) for s, ts in se.invis.items() for t in ts)
    detect_rows = sorted((s, t) for s, ts in se.detect.items() for t in ts
                         if t in invis_types)
    effect_names = read_enum_names("SpellEffect", version)
    aura_names = read_enum_names("SpellEffectAura", version)

    pack = {
        "meta": {
            "format": PACK_FORMAT,
            "version": version,
            "label": label,
            "built": time.strftime("%Y-%m-%d"),
            "listfileTag": (CACHE_DIR / "listfile" / "release-tag.txt").read_text().strip()
            if (CACHE_DIR / "listfile" / "release-tag.txt").exists() else "",
            "tdbTag": TDB_RELEASES.get(version, {}).get("tag", "") if tdb_dir else "",
            # db2 tables this build predates; their pack sections are empty and
            # the features they power are unavailable for this version
            "absentTables": absent,
            "counts": {
                "spells": len(spell_ids),
                "files": len(file_ids),
                "spellModels": len(model_rows),
                "spellDisplayModels": sum(1 for r in model_rows if r[2] == MODEL_CAT_DISPLAY),
                "spellItemModels": sum(1 for r in model_rows if r[2] == MODEL_CAT_ITEM),
                "items": len(used_items),
                "namedItems": sum(1 for i in used_items if items.name.get(i)),
                # equipped-weapon marker rows (SpellVisualEffectName Type 3-10,
                # WEAPON_FID sentinel) — attach + thrown-missile, see §3
                "spellWeaponModels": sum(1 for r in model_rows if r[1] == WEAPON_FID),
                "spellSounds": len(sound_rows),
                "spellAnimKits": len(anim_rows),
                "animKitAnims": len(kit_anim_rows),
                "spellEffects": len(effect_rows),
                "spellAuras": len(aura_rows),
                "spellFx": len(fx_rows),
                "spellMorphs": len(morph_rows),
                "morphs": len(morph_creature_ids),
                "morphDisplays": len(morph_display_rows),
                "spellShapeshifts": len(shapeshift_rows),
                "shapeshiftDisplays": len(form_display_rows),
                "spellSummons": len(summon_rows),
                "summons": len(summon_creature_ids),
                "spellVehicles": len(vehicle_rows),
                "vehicles": len(vehicle_ids),
                "vehicleSeats": len(vehicle_seat_rows),
                "spellInvis": len(invis_rows),
                "spellDetects": len(detect_rows),
                "invisChannels": len(invis_types),
                "spellPassengerAnims": len(passenger_anim_rows),
                "spellVehicleAnims": len(vehicle_anim_rows),
                "spellVehicleAnimKits": len(vehicle_animkit_rows),
                "fxChains": len(fx_chain_ids),
                "spellDissolves": len(dissolve_row_pairs),
                "dissolves": len(dissolve_ids),
                "spellGlows": len(glow_row_pairs),
                "glows": len(glow_ids),
                "spellShadowies": len(shadowy_row_pairs),
                "shadowies": len(shadowy_ids),
                "spellGhostMats": len(ghost_mat_pairs),
                "ghostMats": len(ghost_mat_ids),
                "spellTints": len(tint_row_pairs),
                "tints": len(tint_ids),
                "spellDesaturates": len(desat_pairs),
                "spellTransparencies": len(transp_pairs),
                "spellFreezes": len(freeze_ids),
                "spellCamos": len(camo_ids),
                "spellAnims": len(anim_direct_rows),
                "spellVisualAnims": len(visual_anim_rows),
                "spellScreens": len(screen_pairs),
                "screens": len(screen_ids),
                "icons": len(icon_names),
            },
        },
        "spells": spells,
        "iconNames": icon_names,
        "files": files,
        # cats tag how each model is used (attach/missile/area/trail/barrage);
        # the same (spell, fid) can appear once per category it serves
        # srcAttach/dstAttach are RAW M2 attachment ids (-1 = unset), named
        # via attachmentNames. Attach models put their single point in src;
        # missiles use both (launch -> impact). They are part of the row key,
        # so the same model at two points is two rows and renders as two pills.
        "spellModels": {
            "spellIds": [r[0] for r in model_rows],
            "fids": [r[1] for r in model_rows],
            "cats": [r[2] for r in model_rows],
            "targets": [r[3] for r in model_rows],
            "srcAttach": [r[4] for r in model_rows],
            "dstAttach": [r[5] for r in model_rows],
            # the id of the entity the model came FROM, in whichever id space
            # the row's category names: a CreatureDisplayID on MODEL_CAT_DISPLAY,
            # an Item::ID on MODEL_CAT_ITEM, 0 elsewhere. One field rather than
            # one per category — a row only ever comes from one such entity.
            "refIds": [r[6] for r in model_rows],
        },
        # the items MODEL_CAT_ITEM rows point at (parallel arrays, by item id).
        # `names` is "" for an item with no ItemSearchName row — about a third of
        # them, internal props that exist only to be held in a spell visual. Those
        # render as a plain model pill: no Wowhead, no .add, and .lookup item
        # falls back to the model's base filename.
        "items": {
            "ids": used_items,
            "names": [items.name.get(i, "") for i in used_items],
            "qualities": [items.quality.get(i, -1) for i in used_items],
            "icons": item_icons,          # 1-based index into itemIconNames, 0 = none
        },
        "itemIconNames": item_icon_names,
        "itemQualityNames": ITEM_QUALITY_NAMES,
        "attachmentNames": M2_ATTACHMENT_NAMES,
        "modelCatNames": MODEL_CAT_NAMES,
        "targetNames": TARGET_NAMES,
        "spellSounds": {
            "spellIds": [r[0] for r in sound_rows],
            "soundKitIds": [r[1] for r in sound_rows],
            "fids": [r[2] for r in sound_rows],
            "targets": [r[3] for r in sound_rows],
        },
        "spellAnimKits": {
            "spellIds": [r[0] for r in anim_rows],
            "animKitIds": [r[1] for r in anim_rows],
            "targets": [r[2] for r in anim_rows],
        },
        "animKitAnims": {
            "animKitIds": [r[0] for r in kit_anim_rows],
            "animIds": [r[1] for r in kit_anim_rows],
        },
        # direct stand/walk animation ids (SpellProceduralEffect Type 7) — a
        # second source for the Animations column; animIds index into animNames
        "spellAnims": {
            "spellIds": [r[0] for r in anim_direct_rows],
            "animIds": [r[1] for r in anim_direct_rows],
        },
        # animations a spell's kits play directly (SpellVisualAnim initial/loop
        # anims, kit EffectType 6) — the third and largest animation source;
        # no kit to group under, so these render as loose pills
        "spellVisualAnims": {
            "spellIds": [r[0] for r in visual_anim_rows],
            "animIds": [r[1] for r in visual_anim_rows],
            "targets": [r[2] for r in visual_anim_rows],
        },
        "animNames": anim_names,
        "spellEffects": {
            "spellIds": [r[0] for r in effect_rows],
            "effects": [r[1] for r in effect_rows],
        },
        "effectNames": effect_names,
        # aura mechanics: SpellEffect.EffectAura values (SPELL_AURA_* names)
        "spellAuras": {
            "spellIds": [r[0] for r in aura_rows],
            "auras": [r[1] for r in aura_rows],
        },
        "auraNames": aura_names,
        # visual FX: chain/beam effects (SpellChainEffects). spellFx links
        # spells to chains; fxChains carries each chain's tint + hue word;
        # fxTextures its texture fids (paths resolve via "files")
        "spellFx": {
            "spellIds": [r[0] for r in fx_rows],
            "chainIds": [r[1] for r in fx_rows],
            "targets": [r[2] for r in fx_rows],
            # the drawing beam's attach points (BeamEffect source/dest, -1 =
            # unset or a proc-route chain with no beam row)
            "srcAttach": [r[3] for r in fx_rows],
            "dstAttach": [r[4] for r in fx_rows],
        },
        "fxChains": {
            "ids": fx_chain_ids,
            "colors": fx_colors,
            "hues": fx_hues,
        },
        "fxTextures": {
            "chainIds": [r[0] for r in fx_tex_rows],
            "fids": [r[1] for r in fx_tex_rows],
        },
        # dissolves (DissolveEffect via kit EffectType 11): spellDissolves
        # links spells to dissolve rows; dissolves carries each row's
        # duration (seconds, 0 = unspecified); dissolveTextures its
        # TextureBlendSet texture fids (paths resolve via "files")
        "spellDissolves": {
            "spellIds": [r[0] for r in dissolve_row_pairs],
            "dissolveIds": [r[1] for r in dissolve_row_pairs],
            "targets": [r[2] for r in dissolve_row_pairs],
        },
        "dissolves": {
            "ids": dissolve_ids,
            "durations": [fx.dissolves[e][0] for e in dissolve_ids],
        },
        "dissolveTextures": {
            "dissolveIds": [r[0] for r in dissolve_tex_rows],
            "fids": [r[1] for r in dissolve_tex_rows],
        },
        # edge glows (EdgeGlowEffect via kit EffectType 12): color-only —
        # no texture or model, the packed RGB is the whole payload
        "spellGlows": {
            "spellIds": [r[0] for r in glow_row_pairs],
            "glowIds": [r[1] for r in glow_row_pairs],
            "targets": [r[2] for r in glow_row_pairs],
        },
        "glows": {
            "ids": glow_ids,
            "colors": [fx.glows[g] for g in glow_ids],
            "alphas": [fx.glow_alphas[g] for g in glow_ids],
            "hues": glow_hues,
        },
        # shadowy effects (ShadowyEffect via kit EffectType 7): two packed
        # colors per row; hues joins both colors' hue words
        "spellShadowies": {
            "spellIds": [r[0] for r in shadowy_row_pairs],
            "shadowyIds": [r[1] for r in shadowy_row_pairs],
            "targets": [r[2] for r in shadowy_row_pairs],
        },
        "shadowies": {
            "ids": shadowy_ids,
            "primaryColors": [fx.shadowies[e][0] for e in shadowy_ids],
            "secondaryColors": [fx.shadowies[e][1] for e in shadowy_ids],
            "hues": shadowy_hues,
        },
        # ghost materials (SpellProceduralEffect Type 22): single-color
        # material recolors that render under the same "ghost" category as the
        # ShadowyEffect rows — color-only, one packed RGB each
        "spellGhostMats": {
            "spellIds": [r[0] for r in ghost_mat_pairs],
            "ghostIds": [r[1] for r in ghost_mat_pairs],
            "targets": [r[2] for r in ghost_mat_pairs],
        },
        "ghostMats": {
            "ids": ghost_mat_ids,
            "colors": [procs.ghost_mats[g] for g in ghost_mat_ids],
            "hues": ghost_mat_hues,
        },
        # model tints (SpellProceduralEffect Type 1 & 23 via kit EffectType 1):
        # color-only like glows — the packed RGB is the whole payload. Type 1
        # multiply-tints; Type 23 material-recolors (colorless folds in as black)
        "spellTints": {
            "spellIds": [r[0] for r in tint_row_pairs],
            "tintIds": [r[1] for r in tint_row_pairs],
        },
        "tints": {
            "ids": tint_ids,
            "colors": [procs.tints[t] for t in tint_ids],
            "hues": tint_hues,
        },
        # desaturate (Type 21) / transparency (Type 14): percent-only pills —
        # spellIds parallel to percents (0..100), no color, no id table
        "spellDesaturates": {
            "spellIds": [r[0] for r in desat_pairs],
            "percents": [r[1] for r in desat_pairs],
        },
        "spellTransparencies": {
            "spellIds": [r[0] for r in transp_pairs],
            "percents": [r[1] for r in transp_pairs],
        },
        # freeze (Type 11) / camo (Type 18): valueless standalone pills
        "spellFreezes": {"spellIds": freeze_ids},
        "spellCamos": {"spellIds": camo_ids},
        # screen effects (ScreenEffect via SCREEN_EFFECT auras + kit ET 19):
        # per row an internal name, a fog tint (-1 = none), FullScreenEffect
        # multiply/addition screen colors (-1 = none) and texture fids
        # (overlay + TextureBlendSet; paths resolve via "files")
        "spellScreens": {
            "spellIds": [r[0] for r in screen_pairs],
            "screenIds": [r[1] for r in screen_pairs],
            # who the SCREEN_EFFECT aura lands on (ImplicitTarget) — usually the
            # caster's own view, but kept honest per row
            "targets": [se.screen_targets.get(r, 0) for r in screen_pairs],
        },
        "screens": {
            "ids": screen_ids,
            "names": [fx.screens[sc].name for sc in screen_ids],
            "fogColors": [fx.screens[sc].fog for sc in screen_ids],
            "fogAlphas": [fx.screens[sc].fog_alpha for sc in screen_ids],
            "mulColors": [fx.screens[sc].mul for sc in screen_ids],
            "addColors": [fx.screens[sc].add for sc in screen_ids],
            # radial vignette shaping the coverage (size 0 = no FSE row)
            "maskOffsetY": [fx.screens[sc].mask[0] for sc in screen_ids],
            "maskSize": [fx.screens[sc].mask[1] for sc in screen_ids],
            "maskPower": [fx.screens[sc].mask[2] for sc in screen_ids],
            "hues": screen_hues,
        },
        # roles: 0 = overlay (finished art, drawn in its own colors), 1 = mask
        # (flat blend-set texture the mul/add colors paint)
        "screenTextures": {
            "screenIds": [r[0] for r in screen_tex_rows],
            "roles": [r[1] for r in screen_tex_rows],
            "fids": [r[2] for r in screen_tex_rows],
        },
        # morphs: transform auras reference a CREATURE (NPC entry); its
        # display ids come from TDB's creature_template_model, each display
        # resolving to a creature model file (fid 0 = unknown model)
        "spellMorphs": {
            "spellIds": [r[0] for r in morph_rows],
            "creatureIds": [r[1] for r in morph_rows],
            # who the transform aura morphs — the target for polymorph, the
            # caster for self-transforms (ImplicitTarget of the aura's effect)
            "targets": [se.morph_targets.get(r, 0) for r in morph_rows],
        },
        "morphs": {
            "creatureIds": morph_creature_ids,
            "names": [creatures.names.get(c, "") for c in morph_creature_ids],
        },
        "morphDisplays": {
            "creatureIds": [r[0] for r in morph_display_rows],
            "displayIds": [r[1] for r in morph_display_rows],
            "fids": [r[2] for r in morph_display_rows],
        },
        # shapeshift forms (MOD_SHAPESHIFT auras): a form name plus up to four
        # creature displays; forms with no display are a name-only pill
        "spellShapeshifts": {
            "spellIds": [r[0] for r in shapeshift_rows],
            "formIds": [r[1] for r in shapeshift_rows],
            "targets": [se.form_targets.get(r, 0) for r in shapeshift_rows],
        },
        "shapeshifts": {
            "ids": shapeshift_form_ids,
            "names": [form_names.get(f, "") for f in shapeshift_form_ids],
        },
        "shapeshiftDisplays": {
            "formIds": [r[0] for r in form_display_rows],
            "displayIds": [r[1] for r in form_display_rows],
            "fids": [r[2] for r in form_display_rows],
        },
        # summons (SpellEffect SUMMON): the spell summons a CREATURE (NPC
        # entry, names via TDB creature_template like morphs); control is
        # per spell-effect row, from its SummonProperties
        "spellSummons": {
            "spellIds": [r[0] for r in summon_rows],
            "creatureIds": [r[1] for r in summon_rows],
            "controls": [r[2] for r in summon_rows],
            # where the summon lands — mostly a ground point near the caster
            "targets": [se.summon_targets.get((r[0], r[1]), 0) for r in summon_rows],
        },
        "summons": {
            "creatureIds": summon_creature_ids,
            "names": [creatures.names.get(c, "") for c in summon_creature_ids],
        },
        "summonControlNames": SUMMON_CONTROL_NAMES,
        # vehicles (SET_VEHICLE_ID auras): the aura's misc value is a Vehicle.db2
        # id; the payload is its seat count. Link section (spell -> vehicle) plus
        # a vehicle -> seat-count payload, mirroring morphs/summons.
        "spellVehicles": {
            "spellIds": [r[0] for r in vehicle_rows],
            "vehicleIds": [r[1] for r in vehicle_rows],
            # SET_VEHICLE_ID makes the caster the vehicle, so this is caster
            "targets": [se.vehicle_targets.get(r, 0) for r in vehicle_rows],
        },
        # invisibility / detection channels (MOD_INVISIBILITY[_DETECT] auras).
        # `types` is the invisibility TYPE — the pairing key: an invis pill
        # links to the detect spells on the same type and vice versa. The
        # frontend groups these by type to get counterpart counts and to power
        # fx:invis / fx:detect searches. Only channels with an invis side are
        # emitted, so every detect row here has ≥1 counterpart (see above).
        "spellInvis": {
            "spellIds": [r[0] for r in invis_rows],
            "types": [r[1] for r in invis_rows],
            # who the invisibility is applied to (ImplicitTarget) — usually self
            "targets": [se.invis_targets.get(r, 0) for r in invis_rows],
        },
        "spellDetects": {
            "spellIds": [r[0] for r in detect_rows],
            "types": [r[1] for r in detect_rows],
            "targets": [se.detect_targets.get(r, 0) for r in detect_rows],
        },
        # one row per seat, in SeatID_0..7 order; `seats` on a vehicle is the
        # count, and `attachments` names where on the model that seat sits
        # (decoded via VEHICLE_GEO_COMPONENT_LINKS — see its comment for the
        # verification). An empty name means the seat row was missing or the
        # attachment unset.
        "vehicles": {
            "vehicleIds": vehicle_ids,
            "seats": [len(vehicle_seats.seats[v]) for v in vehicle_ids],
        },
        "vehicleSeats": {
            "vehicleIds": [r[0] for r in vehicle_seat_rows],
            "attachments": [r[1] for r in vehicle_seat_rows],
        },
        # the rider's own animations while entering/seated/exiting — their own
        # "passenger" group in the Animations column. animIds index animNames.
        "spellPassengerAnims": {
            "spellIds": [r[0] for r in passenger_anim_rows],
            "animIds": [r[1] for r in passenger_anim_rows],
        },
        # the VEHICLE's animations (not the rider's) — loose animation pills,
        # deliberately not under "passenger"
        "spellVehicleAnims": {
            "spellIds": [r[0] for r in vehicle_anim_rows],
            "animIds": [r[1] for r in vehicle_anim_rows],
        },
        # seat AnimKit ids — they are AnimKit::IDs, so they join the existing
        # animkit groups and resolve through animKitAnims like any other kit
        "spellVehicleAnimKits": {
            "spellIds": [r[0] for r in vehicle_animkit_rows],
            "animKitIds": [r[1] for r in vehicle_animkit_rows],
        },
    }

    log(
        f"  spells={len(spell_ids):,}  files={len(file_ids):,} ({unnamed:,} unnamed)  "
        f"models={len(model_rows):,}  sounds={len(sound_rows):,}  animkits={len(anim_rows):,}  "
        f"kitAnims={len(kit_anim_rows):,}  visualAnims={len(visual_anim_rows):,}  "
        f"effects={len(effect_rows):,}  auras={len(aura_rows):,}  fx={len(fx_rows):,}  "
        f"fxChains={len(fx_chain_ids):,}  dissolves={len(dissolve_row_pairs):,} "
        f"({len(dissolve_ids):,} rows)  glows={len(glow_row_pairs):,} "
        f"({len(glow_ids):,} rows)  shadowies={len(shadowy_row_pairs):,} "
        f"({len(shadowy_ids):,} rows)  tints={len(tint_row_pairs):,} "
        f"({len(tint_ids):,} rows)  screens={len(screen_pairs):,} "
        f"({len(screen_ids):,} rows)  morphs={len(morph_rows):,} "
        f"({len(morph_display_rows):,} displays)  "
        f"shapeshifts={len(shapeshift_rows):,} "
        f"({len(shapeshift_form_ids):,} forms, {len(form_display_rows):,} displays)  "
        f"altNames={len(spell_altname_text):,}  summons={len(summon_rows):,} "
        f"({len(summon_creature_ids):,} creatures)  "
        f"vehicles={len(vehicle_rows):,} ({len(vehicle_ids):,} distinct, "
        f"{len(vehicle_seat_rows):,} seats, {len(passenger_anim_rows):,} passenger anims)  "
        f"icons={len(icon_names):,}  "
        f"orphan visual spells={vis.orphans:,}  [{time.time() - t0:.1f}s]"
    )
    return pack


def version_key(version: str) -> tuple[int, ...]:
    """Sort key for a build id — numeric per part, so 10.2.7 follows 9.2.7.

    Sorting the ids as plain strings puts "10.x" *before* "9.x", which would
    silently hand the app the wrong newest-version default.
    """
    return tuple(int(p) if p.isdigit() else 0 for p in version.split("."))


def write_pack(pack: dict, version: str, label: str, hidden: bool = False,
               is_default: bool = False) -> None:
    """Write the gzipped pack and refresh the versions.json manifest.

    `hidden` marks the entry as reachable only by an explicit ?v= URL: the app
    keeps it out of the version dropdown and never treats it as the default,
    so nobody downloads the pack unless they asked for it by name.

    `is_default` marks the pack the app loads when the URL names no version.
    Without it the app falls back to the newest visible pack — which is why
    the flag exists: the newest build is not necessarily the one to serve
    first. Marking one entry clears the flag on all the others.
    """
    out_dir = DATA_DIR / version
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "spelldata.json.gz"

    raw = json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    # mtime=0 keeps rebuilds byte-identical when the data hasn't changed
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(raw)
    out_path.write_bytes(buf.getvalue())
    log(f"Wrote {out_path}  ({len(raw):,} raw -> {out_path.stat().st_size:,} gzipped)")

    # content hash for cache busting: the app appends it to the pack URL
    # (?v=<hash>), so browsers refetch exactly when the data changed
    pack_hash = hashlib.sha256(buf.getvalue()).hexdigest()[:10]

    manifest_path = DATA_DIR / "versions.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else []
    entry = {
        "id": version,
        "label": label,
        "file": f"data/{version}/spelldata.json.gz",
        "built": pack["meta"]["built"],
        "hash": pack_hash,
    }
    if hidden:
        entry["hidden"] = True
    manifest = [e for e in manifest if e["id"] != version]
    if is_default:
        entry["default"] = True
        for e in manifest:  # exactly one entry may carry the flag
            e.pop("default", None)
    manifest = manifest + [entry]
    manifest.sort(key=lambda e: version_key(e["id"]))
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"Updated {manifest_path}")


def main() -> None:
    """Fetch the sources for one game version, build its pack, write it out."""
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", required=True, help="game build, e.g. 9.2.7.45745")
    ap.add_argument("--label", help='display label, e.g. "Shadowlands 9.2.7" (default: the version)')
    ap.add_argument("--refresh", action="store_true", help="re-download sources even if cached")
    ap.add_argument("--hidden", action="store_true",
                    help="reachable only via ?v= in the URL: kept out of the version "
                         "dropdown and never used as the default")
    ap.add_argument("--default", action="store_true", dest="is_default",
                    help="serve this pack when the URL names no version (clears the "
                         "flag on every other entry; otherwise the newest visible wins)")
    args = ap.parse_args()

    label = args.label or args.version
    table_dir, listfile, tdb_dir = fetch_sources(args.version, args.refresh)
    pack = build_pack(args.version, label, table_dir, listfile, tdb_dir)
    write_pack(pack, args.version, label, hidden=args.hidden, is_default=args.is_default)


if __name__ == "__main__":
    main()
