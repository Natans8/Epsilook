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
}

# (table, column) -> the value to use on builds that lack the column
OPTIONAL_COLUMNS = {
    # the raid missile-set variant arrived after Legion; 0 = "no raid set",
    # which is exactly how a present-but-unset row already reads
    ("SpellVisual", "RaidSpellVisualMissileSetID"): "0",
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
        "spell_visual": ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID"],
        "spell_visual_missile": ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                                 "SoundEntriesID", "AnimKitID"],
        "spell_visual_effect_name": ["ID", "ModelFileDataID"],
        "spell_effect": ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1",
                         "EffectMiscValue2"],
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
ENUM_FILES = ["SpellEffect", "SpellEffectAura"]

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

# SpellEffect.Effect value that summons a creature: EffectMiscValue_0 is the
# creature id (server-side NPC entry, same space as morphs), EffectMiscValue_1
# the SummonProperties row governing how the summon behaves
EFFECT_SUMMON = 28

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
TARGET_BITS = {1: 1, 2: 2, 3: 4, 4: 8, 5: 16}  # caster, target, area, not-caster, missile-dest
NO_TARGET = 0

# The search word each mask bit answers to. Two pairs of bits deliberately
# share a word: "target, never caster" is still a target (it keeps its own bit,
# and its own icon color, but nobody would search for it by another name), and
# a missile's destination is an area on the ground like any other. The app
# derives "both" from bits 1|2 rather than it being a bit of its own.
TARGET_NAMES = {1: "caster", 2: "target", 4: "area", 8: "target", 16: "area"}

# The pack's shape version — bump it whenever a section is added, removed or
# reshaped, so a stale cached pack is recognisable app-side.
PACK_FORMAT = 22  # 22: per-row target masks (SpellVisualEvent.TargetType)

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


def read_visual_graph(
    table_dir: Path, tdb_dir: Path | None
) -> tuple[dict[int, set[int]], dict[int, dict[int, int]]]:
    """Read the spell -> visual -> kit edges of the visual graph.

    Both hops are many-to-many. SpellXSpellVisual rows are keyed by row ID
    first so a hotfixed row replaces its wago original before the edges are
    derived (a hotfix can re-point a spell at a different visual).

    The visual -> kit edge carries the event's TargetType as a bit mask (see
    TARGET_BITS): one visual can reach the same kit through several event
    rows, so the mask is unioned per edge. Everything the kit contributes
    inherits that mask during the walk.
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
    spell_visuals: dict[int, set[int]] = defaultdict(set)
    for s, v in sxv_rows.values():
        if s and v:
            spell_visuals[s].add(v)

    visual_kits: dict[int, dict[int, int]] = defaultdict(dict)
    for visual_id, kit_id, target_type in read_table(
        table_dir, "SpellVisualEvent", ["SpellVisualID", "SpellVisualKitID", "TargetType"]
    ):
        v, k = to_int(visual_id), to_int(kit_id)
        if v and k:
            bit = TARGET_BITS.get(to_int(target_type), NO_TARGET)
            visual_kits[v][k] = visual_kits[v].get(k, NO_TARGET) | bit
    return spell_visuals, visual_kits


@dataclass
class ModelSources:
    """Every route that ends in a model FileDataID, keyed by its own row id.

    Five routes, one per model category. The attach models are already
    resolved per kit here; the rest are resolved when the kit walk (or a proc
    row) references them.
    """
    effect_name_fid: dict[int, int]   # SpellVisualEffectName.ID -> model fid
    area_model_fid: dict[int, int]    # SpellVisualKitAreaModel.ID -> model fid
    emission_fid: dict[int, int]      # SpellEffectEmission.ID -> model fid (ET 8)
    barrage_fid: dict[int, int]       # BarrageEffect.ID -> model fid (ET 17)
    weapontrail_fid: dict[int, int]   # WeaponTrail.ID -> model fid (proc Type 27)
    attach_models: dict[int, set[tuple[int, int]]]  # kit -> {(fid, category)}


def read_model_sources(table_dir: Path, tdb_dir: Path | None) -> ModelSources:
    """Read the model-bearing tables (see ModelSources for the five routes)."""
    effect_name_fid: dict[int, int] = {}
    for en_id, model_fid in read_table(table_dir, "SpellVisualEffectName", ["ID", "ModelFileDataID"]):
        effect_name_fid[to_int(en_id)] = to_int(model_fid)
    for en_id, model_fid in hotfix_rows(tdb_dir, "spell_visual_effect_name", ["ID", "ModelFileDataID"]):
        effect_name_fid[to_int(en_id)] = to_int(model_fid)

    # the plain case: a kit attaches a model to the caster/target
    attach_models: dict[int, set[tuple[int, int]]] = defaultdict(set)
    for kit_id, en_id in read_table(
        table_dir, "SpellVisualKitModelAttach", ["ParentSpellVisualKitID", "SpellVisualEffectNameID"]
    ):
        fid = effect_name_fid.get(to_int(en_id), 0)
        k = to_int(kit_id)
        if k and fid:
            attach_models[k].add((fid, MODEL_CAT_ATTACH))

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

    return ModelSources(effect_name_fid, area_model_fid, emission_fid,
                        barrage_fid, weapontrail_fid, attach_models)


# what a visual with no missiles contributes: (model fids, soundkits, animkits)
NO_MISSILES: tuple = (frozenset(), frozenset(), frozenset())


def read_missiles(
    table_dir: Path, tdb_dir: Path | None, effect_name_fid: dict[int, int]
) -> dict[int, tuple]:
    """Read visual -> (missile models, soundkits, animkits).

    Missiles are the second path out of SpellVisual, and the only one that
    reaches projectile models: SpellVisual.SpellVisualMissileSetID (plus the
    raid variant) groups SpellVisualMissile rows, each carrying a model and
    sometimes a flight/launch SoundKit and an AnimKit. Arcane Missiles'
    cfx_mage_arcanemissiles_missile.m2 exists nowhere else in the graph.
    """
    sv_rows: dict[int, tuple[int, int]] = {}  # visual ID -> (set, raid set)
    for rid, ms, rms in read_table(
        table_dir, "SpellVisual", ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID"]
    ):
        sv_rows[to_int(rid)] = (to_int(ms), to_int(rms))
    for rid, ms, rms in hotfix_rows(
        tdb_dir, "spell_visual", ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID"]
    ):
        sv_rows[to_int(rid)] = (to_int(ms), to_int(rms))

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
        if sk:
            set_soundkits[set_id].add(sk)
        if ak:
            set_animkits[set_id].add(ak)

    visual_missiles: dict[int, tuple] = {}
    for v, (set_id, raid_set_id) in sv_rows.items():
        parts = tuple(
            d.get(set_id, set()) | d.get(raid_set_id, set())
            for d in (set_models, set_soundkits, set_animkits)
        )
        if any(parts):
            visual_missiles[v] = parts
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
    models: dict[int, tuple[int, int]]  # proc ID -> (model fid, category) (Types 9, 27)
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
                procs.models[p] = (fid, MODEL_CAT_AREA)
        elif pt == PROC_TYPE_WEAPONTRAIL:
            fid = models.weapontrail_fid.get(to_int_from_float(v0), 0)
            if fid:
                procs.models[p] = (fid, MODEL_CAT_TRAIL)
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
    beam_chain: dict[int, int]         # BeamEffect.ID -> chain ID
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

    beam_chain: dict[int, int] = {}
    for bid, chain_id in read_table(table_dir, "BeamEffect", ["ID", "BeamID"]):
        beam_chain[to_int(bid)] = to_int(chain_id)

    return FxPayloads(chains, beam_chain, dissolves, glows, glow_alphas,
                      shadowies, screens, svse_screen)


def expand_chain(chains: dict[int, tuple], cid: int, out: set[int]) -> None:
    """Add a chain and every chain it nests (SpellChainEffectID_0..10) to out."""
    if cid in out or cid not in chains:
        return
    out.add(cid)
    for sub in chains[cid][5]:
        expand_chain(chains, sub, out)


@dataclass
class KitEffects:
    """What each SpellVisualKit contributes, bucketed by fx category.

    Every field maps kit id -> the payload row ids it references (freezes and
    camos are valueless, so kit membership is the whole payload). This is
    where the SpellVisualKitEffect dispatch lands; the per-spell walk then
    just unions these over the kits a spell reaches.
    """
    models: dict[int, set[tuple[int, int]]]  # (model fid, category)
    soundkits: dict[int, set[int]]
    animkits: dict[int, set[int]]
    anims: dict[int, set[int]]        # direct AnimationData ids (proc Type 7)
    visual_anims: dict[int, set[int]]  # AnimationData ids (SpellVisualAnim, ET 6)
    chains: dict[int, set[int]]
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
        soundkits=defaultdict(set), animkits=defaultdict(set), anims=defaultdict(set),
        visual_anims=defaultdict(set),
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
            expand_chain(fx.chains, procs.chain.get(e, 0), kits.chains[k])
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
            expand_chain(fx.chains, fx.beam_chain.get(e, 0), kits.chains[k])
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
                kits.models[k].add((fid, MODEL_CAT_AREA))
        elif et == EFFECT_TYPE_BARRAGE:
            fid = models.barrage_fid.get(e, 0)
            if fid:
                kits.models[k].add((fid, MODEL_CAT_BARRAGE))
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


def read_spell_effect_rows(
    table_dir: Path, tdb_dir: Path | None, spell_names: dict[int, str],
    screens: dict[int, ScreenRow]
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
    se_cols = ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue_0", "EffectMiscValue_1"]
    se_hotfix_cols = ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1", "EffectMiscValue2"]
    se_rows: dict[int, tuple[int, int, int, int, int]] = {}
    for rid, spell_id, effect, aura, misc0, misc1 in read_table(table_dir, "SpellEffect", se_cols):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                to_int_from_float(misc0), to_int_from_float(misc1))
    for rid, spell_id, effect, aura, misc0, misc1 in hotfix_rows(tdb_dir, "spell_effect", se_hotfix_cols):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                to_int_from_float(misc0), to_int_from_float(misc1))

    # SummonProperties: only Control matters (guardian/pet/possessed/...)
    summon_control: dict[int, int] = {}
    for pid, ctrl in read_table(table_dir, "SummonProperties", ["ID", "Control"]):
        summon_control[to_int(pid)] = to_int(ctrl)

    out = SpellEffectRows(defaultdict(set), defaultdict(set), defaultdict(set),
                          defaultdict(set), defaultdict(set), defaultdict(set),
                          defaultdict(set))
    for s, effect_id, aura_id, m0, m1 in se_rows.values():
        if s not in spell_names:
            continue
        if effect_id:
            out.effects[s].add(effect_id)
        if aura_id:
            out.auras[s].add(aura_id)
        if aura_id == AURA_TRANSFORM and m0 > 0:
            out.morphs[s].add(m0)
        if effect_id == EFFECT_SUMMON and m0 > 0:
            out.summons[s].add((m0, summon_control.get(m1, 0)))
        # SCREEN_EFFECT auras carry the ScreenEffect ID in misc0 — the main
        # route (the kit route adds only a handful of rows on top)
        if aura_id == AURA_SCREEN_EFFECT and m0 > 0 and m0 in screens:
            out.screens[s].add(m0)
        if aura_id == AURA_SHAPESHIFT and m0 > 0:
            out.forms[s].add(m0)
        if aura_id == AURA_OVERRIDE_NAME and m0 > 0:
            out.altnames[s].add(m0)
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
    models: dict[int, dict[tuple[int, int], int]]   # (model fid, category)
    sounds: dict[int, dict[tuple[int, int], int]]   # (soundkit, sound fid)
    animkits: dict[int, dict[int, int]]
    anims: dict[int, dict[int, int]]                # direct AnimationData ids (stance)
    visual_anims: dict[int, dict[int, int]]         # AnimationData ids (SpellVisualAnim)
    chains: dict[int, dict[int, int]]
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
    spell_visuals: dict[int, set[int]],
    visual_kits: dict[int, dict[int, int]],
    visual_missiles: dict[int, tuple],
    kits: KitEffects,
    soundkit_files: dict[int, set[int]],
    fx: FxPayloads,
    spell_screens: dict[int, set[int]],
) -> SpellVisuals:
    """Walk spell -> visual -> kit once, unioning every payload per spell.

    Screen effects are the one payload that also arrives from outside the
    graph (SCREEN_EFFECT auras), so spell_screens comes in already populated
    and this extends it with the kit route.
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
        for v in visuals:
            # missile-set content has no SpellVisualEvent row, so no target type
            m_fids, m_sks, m_aks = visual_missiles.get(v, NO_MISSILES)
            merge_masked(vis.models[spell_id],
                         ((f, MODEL_CAT_MISSILE) for f in m_fids), NO_TARGET)
            merge_masked(vis.animkits[spell_id], m_aks, NO_TARGET)
            for sk in m_sks:
                merge_masked(vis.sounds[spell_id],
                             ((sk, f) for f in soundkit_files.get(sk, ())), NO_TARGET)
            for k, mask in visual_kits.get(v, {}).items():
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
            sk = fx.chains[c][3]
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
    spell_visuals, visual_kits = read_visual_graph(table_dir, tdb_dir)
    models = read_model_sources(table_dir, tdb_dir)
    visual_missiles = read_missiles(table_dir, tdb_dir, models.effect_name_fid)
    procs = read_proc_effects(table_dir, models)
    fx = read_fx_payloads(table_dir)
    kits = read_kit_effects(table_dir, models, procs, fx)
    soundkit_files = read_soundkit_files(table_dir)
    anim_names = read_anim_names()
    animkit_anims = read_animkit_anims(table_dir, anim_names)

    se = read_spell_effect_rows(table_dir, tdb_dir, spell_names, fx.screens)
    creatures = read_creature_models(table_dir, tdb_dir)
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
                      kits, soundkit_files, fx, se.screens)

    # --- file names from the listfile -------------------------------------
    used_chains = {c for chains in vis.chains.values() for c in chains}
    used_dissolves = {e for effs in vis.dissolves.values() for e in effs}
    used_screens = {sc for scs in se.screens.values() for sc in scs}

    referenced_fids: set[int] = set()
    for pairs in vis.models.values():
        referenced_fids.update(f for f, _ in pairs)
    for pairs in vis.sounds.values():
        referenced_fids.update(f for _, f in pairs)
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
    files = {
        "fids": file_ids,
        "paths": [fid_path.get(f, "") for f in file_ids],
    }

    # every kit-derived row carries its target mask as the last element (see
    # TARGET_BITS); the pack emits it as a parallel "targets" array
    model_rows = sorted(
        (s, f, c, m) for s, pairs in vis.models.items() for (f, c), m in pairs.items())
    sound_rows = sorted(
        (s, sk, f, m) for s, pairs in vis.sounds.items() for (sk, f), m in pairs.items())
    anim_rows = sorted(
        (s, a, m) for s, aks in vis.animkits.items() for a, m in aks.items())
    fx_rows = sorted(
        (s, c, m) for s, chains in vis.chains.items() for c, m in chains.items())

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

    # only animkits that spells actually use
    used_animkits = {a for aks in vis.animkits.values() for a in aks}
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
        "spellModels": {
            "spellIds": [r[0] for r in model_rows],
            "fids": [r[1] for r in model_rows],
            "cats": [r[2] for r in model_rows],
            "targets": [r[3] for r in model_rows],
        },
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
        },
        "summons": {
            "creatureIds": summon_creature_ids,
            "names": [creatures.names.get(c, "") for c in summon_creature_ids],
        },
        "summonControlNames": SUMMON_CONTROL_NAMES,
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
        f"({len(summon_creature_ids):,} creatures)  icons={len(icon_names):,}  "
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
