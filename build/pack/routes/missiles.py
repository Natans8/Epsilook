"""Projectiles: the second path out of a spell visual.

`SpellVisual` names a missile set (plus a raid variant), the set groups
`SpellVisualMissile` rows, and each row carries a model, a flight path and
sometimes a launch sound and an anim kit.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from .attachments import DEFAULT_MISSILE_SOURCE
from .models import EffectName, file_for_effect_name


class Missile(NamedTuple):
    """One projectile a visual launches, and where it flies between.

    Named for the same reason the attached model is: four numbers in a row, so a
    swapped pair is accepted rather than raised.
    """

    file: int
    """The projectile's model."""
    motion: int
    """The flight path it follows."""
    source: int
    """Where on the caster it launches from."""
    destination: int
    """Where on the target it arrives."""
    effect: int = 0
    """The `SpellVisualEffectName` row it was reached through, or zero.

    Zero where the projectile is the caster's own weapon rather than a model
    the effect-name table named.
    """


@dataclass
class VisualMissiles:
    """What one spell visual's missile sets contribute."""

    models: set[Missile] = field(default_factory=set)
    """The projectiles, each with its flight path and its two attach points."""
    soundkits: set[int] = field(default_factory=set)
    """The sounds a launch plays."""
    animkits: set[int] = field(default_factory=set)
    """The anim kits a launch plays."""

    def __bool__(self) -> bool:
        return bool(self.models or self.soundkits or self.animkits)


@dataclass(frozen=True)
class MissileMotion:
    """One flight path: what it is called, and how many projectiles fly it."""

    name: str
    """The arc's name, as the client spells it."""
    projectiles: int
    """How many projectiles the path is written for.

    The path's own script reads this as an input and spaces the volley by it
    (`Spiral Vortex` fans seven with `(missileIndex / missileCount) * 360`), so
    it is the count the arc was authored around rather than a label beside it.
    """


class MissileRow(NamedTuple):
    """One `SpellVisualMissile` row joined to the visual that reaches its set.

    The motion rides the same row as the model, so a set naming several
    motions is several rows here; the visual's two attachments ride along
    to fill in what the row leaves unset.
    """

    visual: int
    name: int
    """The `SpellVisualEffectName` the projectile's model comes through."""
    sound: int
    animkit: int
    motion: int
    source: int
    destination: int
    visual_source: int
    visual_destination: int


def assemble_missiles(rows: Iterable[MissileRow], names: Mapping[int, EffectName]) -> dict[int, VisualMissiles]:
    """Each visual's projectiles, attachments resolved.

    The row's attachments win over its visual's, which fills in what the row
    leaves unset. The precedence was settled in game. A weapon type with no
    file resolves to the caster's own weapon, thrown as the projectile.
    """
    missiles: dict[int, VisualMissiles] = {}
    for row in rows:
        into = missiles.setdefault(row.visual, VisualMissiles())
        if file := file_for_effect_name(names, row.name):
            source = row.source if row.source >= 0 else row.visual_source
            into.models.add(
                Missile(
                    file,
                    row.motion,
                    source if source >= 0 else DEFAULT_MISSILE_SOURCE,
                    row.destination if row.destination >= 0 else row.visual_destination,
                    row.name,
                )
            )
        if row.sound:
            into.soundkits.add(row.sound)
        if row.animkit:
            into.animkits.add(row.animkit)
    return {visual: found for visual, found in missiles.items() if found}
