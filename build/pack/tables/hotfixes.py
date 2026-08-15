"""TrinityCore's hotfixes over the client's db2: which table revises which.

The two sides agree on almost no name, so this mapping is the only place either
spelling appears.

What a hotfix table revises is a fact about the two schemas and never changes;
whether one of its rows counts depends on the build being packed. So the
declaration below carries the mapping with no rule on it, and
`hotfix_overlays` fills the rule in once the build is known. The declaration is
module-private because an overlay carrying no rule admits every hotfix row,
which is not something any caller should be able to reach for by accident.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace

from ..drift import SPELL_NAME_SOURCES
from ..sources.tdb import STAMP_COLUMN, TDB_LOSSY_COLUMNS, TDB_TABLES
from ..supplements import at_least
from ..targets import VISUAL_REDIRECTS
from .overlay import Overlay, reconcile

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


def _hotfix(table: str, columns: Mapping[str, str]) -> Overlay:
    """One hotfix mapping, with no rule on it yet: every hotfix row names the
    client build it was verified against, on every table."""
    return Overlay(table, columns, judged_on=STAMP_COLUMN)


_SPELL_NAMES = {
    table: _hotfix("spell_name", {"ID": "ID", columns[1]: "Name"})
    for table, columns in SPELL_NAME_SOURCES
}
"""The name mapping, once per table the name is ever read from: naming one
table would overlay some builds and silently not others."""

_HOTFIXES: Mapping[str, Overlay] = {
    **_SPELL_NAMES,
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
"""Client table -> how the server's hotfixes revise it, before a build is known."""


def hotfix_overlays(build: int) -> dict[str, Overlay]:
    """The hotfix overlays for one client build.

    Every hotfix row names the build it was verified against, and a row
    verified against an older client describes something that client already
    shipped -- so the rule is a floor at the build being packed.

    Args:
        build: the client build being packed.

    Returns:
        Client table name -> how the server's hotfixes revise it.

    Raises:
        ValueError: if the build is not a real one. Refused rather than obeyed
            because a floor at zero admits every hotfix row on every table, and
            it does so without an error or a log line -- the same omission the
            merge used to refuse before the rule carried its own bound.
    """
    if build <= 0:
        raise ValueError(f"hotfix_overlays: {build} is not a client build; a "
                         f"floor at or below zero admits every hotfix row")
    admits = at_least(build)
    return {base: replace(overlay, admits=admits)
            for base, overlay in _HOTFIXES.items()}


def check_overlay_declaration() -> list[str]:
    """Ways this map and the distiller's column list could have drifted apart.

    Neither can be derived from the other: only this one knows the client's
    spelling. A lossy column is excused from the unread half -- it is kept so
    the overlay can refuse it, which is the one reason to distil a column
    nothing goes on to read.

    Returns:
        One message per disagreement; empty when the two agree.
    """
    return reconcile(_HOTFIXES, TDB_TABLES["hotfixes"], TDB_LOSSY_COLUMNS)
