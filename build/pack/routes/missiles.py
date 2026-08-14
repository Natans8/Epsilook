"""Projectiles: the second path out of a spell visual.

`SpellVisual` names a missile set (plus a raid variant), the set groups
`SpellVisualMissile` rows, and each row carries a model, a flight path and
sometimes a launch sound and an anim kit.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .attachments import DEFAULT_MISSILE_SOURCE
from .columns import to_int
from .models import ModelSources, file_for_effect_name

# (file id, motion, source attachment, destination attachment)
Missile = tuple[int, int, int, int]


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


def read_missile_motions(tables: Tables) -> dict[int, str]:
    """Missile motion id -> its name: the arc a projectile flies.

    Name only; the table's other real column is a script nothing renders.
    """
    return {to_int(motion_id): name
            for motion_id, name in tables.rows("SpellMissileMotion", ["ID", "Name"])
            if name}


def read_missiles(tables: Tables, models: ModelSources) -> dict[int, VisualMissiles]:
    """Read each visual's projectiles, attachments resolved.

    The row's attachments win over its visual's, which fills in what the row
    leaves unset. The precedence was settled in game.
    """
    visual_columns = ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID",
                      "MissileAttachment", "MissileDestinationAttachment"]
    visuals: dict[int, tuple[int, int, int, int]] = {}
    for visual_id, *values in tables.rows("SpellVisual", visual_columns):
        first, raid, source, destination = (to_int(value) for value in values)
        visuals[to_int(visual_id)] = (first, raid, source, destination)

    # The motion rides the same row as the model, so a (set, effect name) pair
    # naming several motions becomes several rows.
    sets: dict[int, VisualMissiles] = {}
    for row in tables.rows(
            "SpellVisualMissile",
            ["SpellVisualMissileSetID", "SpellVisualEffectNameID", "SoundEntriesID",
             "AnimKitID", "SpellMissileMotionID", "Attachment", "DestinationAttachment"]):
        set_id, name_id, sound, animkit, motion, source, destination = (
            to_int(value) for value in row)
        if not set_id:
            continue
        into = sets.setdefault(set_id, VisualMissiles())
        # A weapon type with no file resolves to the caster's own weapon,
        # thrown as the projectile.
        if file := file_for_effect_name(models, name_id):
            into.models.add((file, motion, source, destination))
        if sound:
            into.soundkits.add(sound)
        if animkit:
            into.animkits.add(animkit)

    missiles: dict[int, VisualMissiles] = {}
    for visual, (first, raid, visual_source, visual_destination) in visuals.items():
        merged = VisualMissiles()
        for set_id in (first, raid):
            found = sets.get(set_id)
            if found is None:
                continue
            merged.models.update(
                (file, motion,
                 source if source >= 0
                 else (visual_source if visual_source >= 0 else DEFAULT_MISSILE_SOURCE),
                 destination if destination >= 0 else visual_destination)
                for file, motion, source, destination in found.models)
            merged.soundkits.update(found.soundkits)
            merged.animkits.update(found.animkits)
        if merged:
            missiles[visual] = merged
    return missiles
