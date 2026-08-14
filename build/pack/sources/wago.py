"""The game client tables, downloaded from wago.tools as CSV.

One file per db2 table per build. The roster below is what gets fetched; which
of them a given build may legitimately lack is declared separately, in
``drift``.
"""

from __future__ import annotations

from pathlib import Path

from ..drift import OPTIONAL_TABLES
from ..progress import log
from .cache import CACHE_DIR, download

WAGO_CSV_URL = "https://wago.tools/db2/{table}/csv?build={version}"
# The one cross-version source: no shipped build carries sound-kit names.
# 8.3.0.32218 is the last build to contain `SoundKitName` at all, and kit ids
# are stable across builds. Full record: docs/DECISIONS.md -> "Sound kit
# names — BfA 8.3.0 is the source".
SOUNDKITNAME_BUILD = "8.3.0.32218"

TABLES = [
    "SpellName",
    "Spell",
    "SpellXSpellVisual",
    "SpellVisual",
    "SpellVisualMissile",
    # The arc a projectile travels, named: "Parabola (High)", "Boomerang". Only
    # ID and Name are kept; nothing renders the Lua-ish ScriptBody.
    "SpellMissileMotion",
    "SpellVisualEvent",
    "SpellVisualKitEffect",
    "SpellVisualKitModelAttach",
    "SpellVisualEffectName",
    "SpellVisualAnim",
    "AnimKitSegment",
    # Which body region an AnimKit segment animates, through its
    # AnimKitConfigID -> AnimKitConfigBoneSet -> AnimKitBoneSet.Name.
    "AnimKitBoneSet",
    "AnimKitConfigBoneSet",
    # Aura 312's (Src -> Dst AnimationData) swaps, keyed by
    # ParentAnimReplacementSetID.
    "AnimReplacement",
    "SoundKitEntry",
    "SpellEffect",
    "SummonProperties",
    "SpellMisc",
    # SpellMisc.CastingTimeIndex -> Base (ms); Base 0 is what makes a spell
    # instant.
    "SpellCastTimes",
    # SpellMisc.DurationIndex -> Duration (ms), how long a channel holds. A
    # negative duration, and the INT_MAX-ish rows, mean no limit.
    "SpellDuration",
    # What breaks a cast, an aura or a channel. The three columns do not share
    # an enum: InterruptFlags is SpellInterrupts::InterruptFlags (bit 0
    # Movement), the other two are SpellInterruptFlags (bit 3 MovingCancels).
    "SpellInterrupts",
    # Where a spell may be cast. Only RequiredAreasID is read: it is one of two
    # gates Epsilon enforces on `.cast`, and the rest gate nothing or need a
    # table that is not fetched (docs/DECISIONS.md).
    "SpellCastingRequirements",
    "AreaGroupMember",
    "AreaTable",
    # The area pill's map button. This list decides what gets downloaded;
    # OPTIONAL_TABLES only says a 404 is allowed.
    "UiMap",
    "UiMapAssignment",
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
    # Mount.db2 is keyed by the mount-granting spell (SourceSpellID);
    # MountXDisplay maps it to CreatureDisplayIDs.
    "Mount",
    "MountXDisplay",
    # Resolves a gameobject_template displayId, from the TDB world dump, to a
    # model FileDataID.
    "GameObjectDisplayInfo",
    # Aura 406 (KEYBOUND_OVERRIDE): which key casts which spell.
    "SpellKeyboundOverride",
    # The item route (SpellVisualEffectName Type 1): ItemSearchName carries the
    # display name and OverallQualityID, then the appearance chain resolves the
    # model and the inventory icon.
    "ItemSearchName",
    "ItemModifiedAppearance",
    "ItemAppearance",
    "ItemDisplayInfo",
    "ModelFileData",
    # The description route: Spell.Description_lang is a template and these fill
    # it in. None of their values ship — build/spelltext.py substitutes them and
    # the pack carries the cooked prose. SpellRadius and SpellRange are index
    # tables ($A1 yards, $r yards); SpellXDescriptionVariables is the only
    # bridge from a spell to a named `$<var>` body.
    "SpellRadius",
    "SpellRange",
    "SpellDescriptionVariables",
    "SpellXDescriptionVariables",
    "SpellTargetRestrictions",
    # Supplies $u (stack cap), $n (charges) and $h (proc chance).
    "SpellAuraOptions",
    # The dungeon journal's note on a boss ability: a second body of text per
    # spell, searched under the same `desc` keyword. Few spells carry one.
    "JournalEncounterSection",
]


def fetch_tables(version: str, refresh: bool) -> tuple[Path, Path]:
    """Download this build's table CSVs, and the pinned sound-kit names.

    Returns:
        The build's own table directory and the pinned build's, kept apart so
        the pinned build's other tables cannot shadow the ones being packed.
    """
    table_dir = CACHE_DIR / version
    log(f"Tables (wago.tools, build {version}):")
    for table in TABLES:
        download(WAGO_CSV_URL.format(table=table, version=version),
                 table_dir / f"{table}.csv", refresh,
                 optional=table in OPTIONAL_TABLES)

    pinned_dir = CACHE_DIR / SOUNDKITNAME_BUILD
    log(f"Sound-kit names (wago.tools, pinned build {SOUNDKITNAME_BUILD}):")
    download(WAGO_CSV_URL.format(table="SoundKitName", version=SOUNDKITNAME_BUILD),
             pinned_dir / "SoundKitName.csv", refresh)
    return table_dir, pinned_dir
