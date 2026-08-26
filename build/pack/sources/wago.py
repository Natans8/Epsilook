"""The game client tables, downloaded from wago.tools as CSV.

One file per db2 table per build. The roster below is what gets fetched; which
of them a given build may legitimately lack is declared separately, in
``drift``.

An export cannot change under a build already released, so every one of these
is pinned: fetched once, then read out of the cache forever.

A table whose text the game translates can be asked for in another language,
which is the same export with its ``_lang`` columns written differently. Those
land in a directory of their own per language, and only the tables that carry
translated text are fetched again -- everything else the reader needs is the
build's own copy, which says the same thing whoever is reading it.
"""

from __future__ import annotations

from pathlib import Path

from ..drift import OPTIONAL_TABLES
from .cache import CACHE_DIR, Pinned
from .source import Gathered, Origin, Part, Source

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
    # it in. None of their values ship — the cooker substitutes them and
    # the pack carries the cooked prose. SpellRadius and SpellRange are index
    # tables ($A1 yards, $r yards); SpellXDescriptionVariables is the only
    # bridge from a spell to a named `$<var>` body.
    "SpellRadius",
    "SpellRange",
    # The scaling window: how far up and down the game table an effect's own
    # level is clamped before its amount is read.
    "SpellScaling",
    "SpellDescriptionVariables",
    "SpellXDescriptionVariables",
    "SpellTargetRestrictions",
    # Supplies $u (stack cap), $n (charges) and $h (proc chance).
    "SpellAuraOptions",
    # The dungeon journal's note on a boss ability: a second body of text per
    # spell, searched under the same `desc` keyword. Few spells carry one.
    "JournalEncounterSection",
]


LOCALIZED_TABLES = [
    "SpellName",
    "Spell",
    "SpellOverrideName",
    "AreaTable",
    "ItemSearchName",
    "Mount",
    "SpellShapeshiftForm",
    "JournalEncounterSection",
]
"""The tables above a route reads a translated column from.

That is the whole rule, and it is not "the tables whose text the pack ships":
a name can decide something without being shipped. `check_localized_tables`
holds the two together by finding every ``_lang`` column the routes read.

The rest of ``TABLES`` says the same thing in every language -- ids, file ids,
flags, the hops between them -- so a language costs these downloads rather than
sixty. ``MountXDisplay`` and ``SpellXDescriptionVariables`` are read beside two
of these and carry no text at all, so a reader gets the build's own copy of
them and nothing is fetched twice.
"""

READ_IN_ONE_LANGUAGE = {
    # The area's map button is the map NAMED THE SAME as the area, so resolving
    # it compares two translated strings -- but what it produces is an id, and
    # an id is not language. It is resolved once for the build and every
    # language is handed the answer, so no language ever opens this table's
    # translated copy. See `routes.areas.read_zone_maps`.
    "UiMap": "the zone-map match is resolved once for the build",
}
"""Tables a route reads a translated column from in ONE language only.

Named so the roster and the routes can still be reconciled mechanically: the
rule is that a `_lang` column is read per language, and these are the declared
exceptions rather than omissions nobody noticed. Making one of these
per-language again means moving it into `LOCALIZED_TABLES` -- and the reason it
was here says what would break if that happened for the wrong reason.
"""


def _export(table: str, version: str, locale: str = "") -> Part:
    """One table's export, as a part of the directory it lands in.

    Optionality is per table rather than per build: a table the client
    predates answers 404, and which tables may is what ``OPTIONAL_TABLES``
    declares.

    Args:
        table: the db2 table to export.
        version: the build to export it from.
        locale: the language to write its text in; empty for the build's own.
    """
    url = WAGO_CSV_URL.format(table=table, version=version)
    return Part(
        origin=Origin(f"{url}&locale={locale}" if locale else url),
        name=f"{table}.csv",
        optional=table in OPTIONAL_TABLES,
    )


def locale_dir(version: str, locale: str) -> Path:
    """Where one language's copies of the translated tables land.

    Inside the build's own cache directory, so that everything one build
    downloaded is one directory: the cache rotation sweeps by build, and a
    language cached somewhere else would outlive the tables it belongs to.
    """
    return CACHE_DIR / version / f"locale-{locale}"


def tables_source(version: str) -> Source:
    """This build's table exports, as the one directory a provider reads."""
    return Gathered(
        name=f"tables (wago.tools, build {version})",
        into=CACHE_DIR / version,
        fetch=Pinned(),
        parts=[_export(table, version) for table in TABLES],
    )


def locale_tables_source(version: str, locale: str) -> Source:
    """The translated tables for one language, as their own directory.

    Read over the build's own tables rather than instead of them: a provider
    serves these where they exist and the build's copy everywhere else, so a
    route asks for a table and never learns which of the two answered.
    """
    return Gathered(
        name=f"tables (wago.tools, build {version}, locale {locale})",
        into=locale_dir(version, locale),
        fetch=Pinned(),
        parts=[_export(table, version, locale) for table in LOCALIZED_TABLES],
    )


def pinned_tables_source() -> Source:
    """The sound-kit names, from the last build that carries them.

    Its own directory, and never the one being packed: the pinned build has
    every other table too, and sharing a directory would let those shadow the
    ones this build is packing. That the directory holds one table is what
    this build needs of it, not a statement about the shape.
    """
    return Gathered(
        name=f"sound-kit names (wago.tools, pinned build {SOUNDKITNAME_BUILD})",
        into=CACHE_DIR / SOUNDKITNAME_BUILD,
        fetch=Pinned(),
        parts=[_export("SoundKitName", SOUNDKITNAME_BUILD)],
    )
