"""The game client tables, downloaded from wago.tools as CSV.

One file per db2 table per build. The roster below is what gets fetched; which
of them a given build may legitimately lack is declared separately, in
``drift``, because "we want this table" and "this build predates it" are
different facts and a table usually needs both.
"""

from __future__ import annotations

from pathlib import Path

from ..drift import OPTIONAL_TABLES
from ..progress import log
from .cache import CACHE_DIR, download

WAGO_CSV_URL = "https://wago.tools/db2/{table}/csv?build={version}"
# THE ONE CROSS-VERSION SOURCE: sound-kit names come from a build that is not
# the one being packed, because no build we ship has them.
#
# `SoundKitName` shipped 7.3.0 -> 8.3.0 and in the Classic re-releases, and
# 8.3.0.32218 is the LAST build that contains the file at all — verified at the
# CASC level (dbfilesclient/soundkitname.db2, fid 1665033, is 5,263,340 bytes
# there and 0 bytes in every later build, against a working soundkit.db2
# control). It did not move to another table: it is one of only five tables
# defined for 8.3 and for no 9.x build. So a modern pack can only be named by
# joining an old table, which is sound because kit IDs are stable across builds
# (99.65% of kits present on two builds play a byte-identical file set).
#
# 8.3.0 strictly contains the Legion, Wrath and Epsilon-addon name sets, so it
# is the only one worth fetching. Full record: docs/DECISIONS.md ->
# "Sound kit names — BfA 8.3.0 is the source".
SOUNDKITNAME_BUILD = "8.3.0.32218"

TABLES = [
    "SpellName",
    "Spell",
    "SpellXSpellVisual",
    "SpellVisual",
    "SpellVisualMissile",
    # missile flight paths (§3, Models column): SpellVisualMissile.SpellMissileMotionID
    # names the arc a projectile travels — "Parabola (High)", "Boomerang",
    # "Mage - Fire - Fireball". Only ID + Name are kept; the Lua-ish ScriptBody
    # is the bulk of the table and nothing renders it. Present on every build.
    "SpellMissileMotion",
    "SpellVisualEvent",
    "SpellVisualKitEffect",
    "SpellVisualKitModelAttach",
    "SpellVisualEffectName",
    "SpellVisualAnim",
    "AnimKitSegment",
    # bonesets (§3): which body region an AnimKit segment animates. A segment's
    # AnimKitConfigID -> AnimKitConfigBoneSet -> AnimKitBoneSet.Name ("Upper
    # Body", "Head", "Right Hand", ...). Present on every build.
    "AnimKitBoneSet",
    "AnimKitConfigBoneSet",
    # anim-replacement sets (aura 312, §3): AnimReplacement holds the
    # (Src -> Dst AnimationData) swaps, keyed by ParentAnimReplacementSetID
    "AnimReplacement",
    "SoundKitEntry",
    "SpellEffect",
    "SummonProperties",
    "SpellMisc",
    # SpellMisc.CastingTimeIndex -> Base (ms). Base 0 is what makes a spell
    # instant, which is half of the delivery question (§3s-bis); the other half
    # is the IsChannelled bit. Ships on every build back to Vanilla.
    "SpellCastTimes",
    # SpellMisc.DurationIndex -> Duration (ms), the OTHER half of the delivery
    # line: how long a channel holds. A 314-row index table. Duration < 0 (and
    # the INT_MAX-ish rows) mean NO LIMIT — 5,717 of 9.2.7's 14,223 channels,
    # which is the case a roleplayer actually wants ("a beam that holds").
    "SpellDuration",
    # What breaks a cast / an aura / a channel. Its own table, which is why the
    # 449-bit attribute sweep never surfaced it. THE THREE COLUMNS DO NOT SHARE
    # AN ENUM: InterruptFlags uses SpellInterrupts::InterruptFlags (bit 0 =
    # Movement), while AuraInterruptFlags and ChannelInterruptFlags use
    # SpellInterruptFlags, where movement is bit 3 (MovingCancels). Assuming
    # they matched put two wrong numbers in the queue once already.
    "SpellInterrupts",
    # WHERE a spell may be cast (§3t). RequiredAreasID is one of only TWO gates
    # Epsilon enforces on `.cast` — verified in game 2026-08-05, against five
    # families that it does NOT enforce (see docs/DECISIONS.md). The rule that
    # picked it: its check has no bypass guard. 12,381 spells on 9.2.7, 65% of
    # them gated to a single area.
    #
    # The other columns of this table are deliberately unused. RequiresSpellFocus
    # also binds but needs SpellFocusObject to be legible; RequiredAuraVision,
    # MinFactionID and MinReputation have ZERO references in TrinityCore's spell
    # code, so they gate nothing; FacingCasterFlags is a range check.
    "SpellCastingRequirements",
    "AreaGroupMember",
    "AreaTable",
    # The area pill's map button. BOTH LISTS ARE REQUIRED and they do different
    # jobs: this one is what gets DOWNLOADED, OPTIONAL_TABLES only says a 404 is
    # allowed. Declaring them optional alone left them un-fetched on every build,
    # and 9.2.7 kept working purely because an exploration run had left its CSVs
    # in the cache — so the button worked here and nowhere else, and would have
    # died here too on a clean checkout.
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
    # mounts (§3, Models column): Mount.db2 is keyed by the mount-granting spell
    # (SourceSpellID); MountXDisplay maps the mount to its CreatureDisplayID(s),
    # which resolve to a model through the same creature chain morphs use.
    "Mount",
    "MountXDisplay",
    # gameobject spawners (§3, Effects column): resolves a gameobject_template
    # displayId (from the TDB world dump) to a model FileDataID -> listfile name
    "GameObjectDisplayInfo",
    # aura 406 (KEYBOUND_OVERRIDE, §3i): which key casts which spell
    "SpellKeyboundOverride",
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
    # ---- the description route (§3x). Spell.Description_lang is a TEMPLATE,
    # not text, and these are the tables that fill it in. None of their values
    # ship: build/spelltext.py substitutes them and the pack carries only the
    # cooked prose.
    #
    # SpellRadius and SpellRange are index tables the effect/misc rows point at
    # ($A1 yards, $r yards); SpellDescriptionVariables holds the named `$<var>`
    # bodies and SpellXDescriptionVariables is the only bridge from a spell to
    # one. SpellAuraOptions, SpellTargetRestrictions, SpellEffect, SpellMisc and
    # SpellDuration were already downloaded for other routes.
    "SpellRadius",
    "SpellRange",
    "SpellDescriptionVariables",
    "SpellXDescriptionVariables",
    "SpellTargetRestrictions",
    # ⚠ SpellAuraOptions was in build/cache/9.2.7.45745/ ALREADY — left there by
    # an exploration run — so the first build of this route worked here and
    # crashed on Vanilla. Same shape as the UiMap mistake at format 40, caught
    # this time only because a missing table is a hard error. It supplies $u
    # (stack cap), $n (charges) and $h (proc chance).
    "SpellAuraOptions",
    # the dungeon journal's own note on a boss ability — a SECOND body of text
    # per spell, searched under the same `desc` keyword. Only 389 spells on
    # 9.2.7 carry one (a spell-linked section usually ships an EMPTY body and
    # the client renders the spell's own description in its place), so this is
    # a small, distinct signal rather than a second corpus.
    "JournalEncounterSection",
]


def fetch_tables(version: str, refresh: bool) -> tuple[Path, Path]:
    """Download this build's table CSVs, and the pinned sound-kit names.

    Returns the two directories they land in: the build's own, and the pinned
    build's. They are separate sources rather than one merged directory, which
    is what lets a route ask for sound-kit names without the pinned build's
    other tables shadowing the ones being packed.
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
