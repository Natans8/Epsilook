"""TrinityCore's hotfixes over the client's db2: which table revises which.

The two sides agree on almost no name, so this mapping is the only place either
spelling appears.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..drift import SPELL_NAME_SOURCES
from ..sources.tdb import STAMP_COLUMN, TDB_LOSSY_COLUMNS, TDB_TABLES
from ..targets import VISUAL_REDIRECTS
from .overlay import Overlay


def _hotfix(table: str, columns: Mapping[str, str]) -> Overlay:
    """One hotfix overlay; every hotfix row names the client build it was
    verified against, on every table."""
    return Overlay(table, columns, stamp=STAMP_COLUMN)


SPELL_NAME_OVERLAYS = {
    table: _hotfix("spell_name", {"ID": "ID", columns[1]: "Name"})
    for table, columns in SPELL_NAME_SOURCES
}
"""The name overlay, once per table the name is ever read from: naming one
table would overlay some builds and silently not others."""

SPELL_EFFECT_COLUMNS = {
    "ID": "ID",
    "SpellID": "SpellID",
    "Effect": "Effect",
    "EffectAura": "EffectAura",
    # The client exports a db2 array field as `X_0`, the server as `X1`.
    "EffectMiscValue_0": "EffectMiscValue1",
    "EffectMiscValue_1": "EffectMiscValue2",
    "ImplicitTarget_0": "ImplicitTarget1",
    "ImplicitTarget_1": "ImplicitTarget2",
    "EffectTriggerSpell": "EffectTriggerSpell",
    # EffectBasePoints is deliberately absent: the dump types it FLOAT, so the
    # server's copy is a rounding of the client's. `check_lossy_declaration`
    # fails the distill if that stops being true.
}

HOTFIX_OVERLAYS = {
    **SPELL_NAME_OVERLAYS,
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
    """Ways this map and the distiller's column list could have drifted apart.

    Neither can be derived from the other: only this one knows the client's
    spelling.

    Returns:
        One message per disagreement; empty when the two agree.
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
