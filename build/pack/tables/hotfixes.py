"""The one overlay that exists: TrinityCore's hotfixes over the client's db2.

Blizzard changes data server-side after a client ships, and TrinityCore
publishes those rows. They are the same rows the client holds, revised -- so
they are an overlay in the exact sense `OverlaidTables` composes, and this is
the declaration that says which table revises which and under what spelling.

The two sides do not agree on names, and that is the whole reason this file
is a mapping rather than a list. The client's `SpellVisual` is the server's
`spell_visual`; the client's `EffectMiscValue_0` is the server's
`EffectMiscValue1`. Every reader used to carry both spellings itself, which is
how a reader could quietly overlay the wrong column or none at all.

A second overlay source -- another server build, a live feed -- would be
another map beside this one, composed the same way. Nothing here is reached by
`OverlaidTables`, which knows only base, source and mapping.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..sources.tdb import STAMP_COLUMN, TDB_LOSSY_COLUMNS, TDB_TABLES
from ..targets import VISUAL_REDIRECTS
from .overlay import Overlay


def _hotfix(table: str, columns: Mapping[str, str]) -> Overlay:
    """One hotfix overlay, stamped.

    TrinityCore stamps every hotfix row with the client build it was verified
    against, on every table -- measured across all six cached releases -- so
    the stamp is supplied here rather than repeated on nine rows.
    """
    return Overlay(table, columns, stamp=STAMP_COLUMN)

SPELL_EFFECT_COLUMNS = {
    "ID": "ID",
    "SpellID": "SpellID",
    "Effect": "Effect",
    "EffectAura": "EffectAura",
    # The array columns are the spelling disagreement in its purest form: the
    # client exports a db2 array field as `X_0`, the server names the same
    # column `X1`. Zero-based against one-based, on the same data.
    "EffectMiscValue_0": "EffectMiscValue1",
    "EffectMiscValue_1": "EffectMiscValue2",
    "ImplicitTarget_0": "ImplicitTarget1",
    "ImplicitTarget_1": "ImplicitTarget2",
    # Spelled the same on both sides, verified against TDB927's hotfix schema.
    "EffectTriggerSpell": "EffectTriggerSpell",
    # EffectBasePoints is deliberately ABSENT. The dump types it FLOAT and
    # MySQL prints a FLOAT at six significant digits, so the server's copy is a
    # rounding of the client's. Leaving it unmapped is what a per-column merge
    # buys: the client's precise value stands, and nothing has to remember why.
    # `check_lossy_declaration` fails the distill if that ever stops being true.
}

HOTFIX_OVERLAYS = {
    "SpellName": _hotfix("spell_name", {"ID": "ID", "Name_lang": "Name"}),
    "SpellXSpellVisual": _hotfix("spell_x_spell_visual", {
        "ID": "ID", "SpellID": "SpellID", "SpellVisualID": "SpellVisualID"}),
    "SpellVisual": _hotfix("spell_visual", {
        "ID": "ID",
        "SpellVisualMissileSetID": "SpellVisualMissileSetID",
        "RaidSpellVisualMissileSetID": "RaidSpellVisualMissileSetID",
        "MissileAttachment": "MissileAttachment",
        "MissileDestinationAttachment": "MissileDestinationAttachment",
        "AnimEventSoundID": "AnimEventSoundID",
        **{column: column for column in VISUAL_REDIRECTS},
    }),
    "SpellVisualMissile": _hotfix("spell_visual_missile", {
        "ID": "ID",
        "SpellVisualMissileSetID": "SpellVisualMissileSetID",
        "SpellVisualEffectNameID": "SpellVisualEffectNameID",
        "SoundEntriesID": "SoundEntriesID",
        "AnimKitID": "AnimKitID",
        "SpellMissileMotionID": "SpellMissileMotionID",
        "Attachment": "Attachment",
        "DestinationAttachment": "DestinationAttachment",
    }),
    "SpellVisualEffectName": _hotfix("spell_visual_effect_name", {
        "ID": "ID", "ModelFileDataID": "ModelFileDataID"}),
    "SpellEffect": _hotfix("spell_effect", SPELL_EFFECT_COLUMNS),
    "SpellMisc": _hotfix("spell_misc", {
        "ID": "ID", "SpellID": "SpellID", "DifficultyID": "DifficultyID",
        "SpellIconFileDataID": "SpellIconFileDataID"}),
    "CreatureDisplayInfo": _hotfix("creature_display_info", {
        "ID": "ID", "ModelID": "ModelID"}),
    "CreatureModelData": _hotfix("creature_model_data", {
        "ID": "ID", "FileDataID": "FileDataID"}),
}
"""Client table -> how the server's hotfixes revise it."""


def check_overlay_declaration() -> list[str]:
    """Ways this map and the distiller's could have drifted apart, named.

    Two declarations describe the same overlay from opposite ends -- the
    distiller says which server columns to KEEP, this says which client column
    each one revises -- and neither can be derived from the other, because only
    one of them knows the client's spelling. So they are checked against each
    other instead, and `overlay_test.py` is where that check runs.

    Returns an empty list when they agree.
    """
    problems: list[str] = []
    kept = TDB_TABLES["hotfixes"]
    for base, overlay in HOTFIX_OVERLAYS.items():
        if overlay.table not in kept:
            problems.append(f"{base} is overlaid from {overlay.table}, which the "
                            f"distiller does not keep")
            continue
        available = set(kept[overlay.table])
        for column, spelling in overlay.columns.items():
            if spelling not in available:
                problems.append(f"{base}.{column} reads {overlay.table}.{spelling}, "
                                f"which the distiller does not keep")
        for spelling in available - {STAMP_COLUMN} - set(overlay.columns.values()):
            if (overlay.table, spelling) in TDB_LOSSY_COLUMNS:
                continue
            problems.append(f"{overlay.table}.{spelling} is distilled but no client "
                            f"column reads it, and it is not declared lossy")
    for table in set(kept) - {o.table for o in HOTFIX_OVERLAYS.values()}:
        problems.append(f"{table} is distilled but overlays nothing")
    return problems
