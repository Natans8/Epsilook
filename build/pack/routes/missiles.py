"""Projectiles: the second path out of a spell visual, and the only one that
reaches a model in flight.

`SpellVisual` names a missile set (plus a raid variant), the set groups
`SpellVisualMissile` rows, and each row carries a model, a flight path, and
sometimes a launch sound and an anim kit. Nothing else in the graph reaches
this content: a spell's missile model is typically referenced from here and
nowhere else.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .attachments import DEFAULT_MISSILE_SOURCE
from .columns import to_int
from .models import EFFECT_NAME_TYPE_WEAPON

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

    Name only. The table's other real column is a motion script, which is the
    bulk of its bytes and which nothing renders.
    """
    return {to_int(motion_id): name
            for motion_id, name in tables.rows("SpellMissileMotion", ["ID", "Name"])
            if name}


def read_missiles(tables: Tables, effect_name_fid: dict[int, int],
                  effect_name_type: dict[int, int]) -> dict[int, VisualMissiles]:
    """Read each visual's projectiles, attachments resolved.

    ⛔ THE ROW'S ATTACHMENTS WIN OVER ITS VISUAL'S, and the two are
    COMPLEMENTARY rather than redundant: over the missile rows reachable from a
    visual, the visual alone carries a launch point for 16.4%, the missile row
    alone for 50.7%, and either for 52.7%. So the row is read first and the
    visual fills in what it leaves unset.

    The row winning is not a guess. The two disagree on 24% of rows, and the
    case was settled in game: Glacial Blast's visual says Chest and its row says
    Base, and the missile launched from the BASE.
    """
    visual_columns = ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID",
                      "MissileAttachment", "MissileDestinationAttachment"]
    visuals: dict[int, tuple[int, int, int, int]] = {}
    for visual_id, *values in tables.rows("SpellVisual", visual_columns):
        first, raid, source, destination = (to_int(value) for value in values)
        visuals[to_int(visual_id)] = (first, raid, source, destination)

    # The motion rides the SAME row as the model, so a flight path pairs with
    # the projectile it belongs to rather than with the whole set. 99.4% of
    # (set, effect name) pairs name exactly one motion and the handful that name
    # several become several rows -- the rule the attachment pair follows too.
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
        file = effect_name_fid.get(name_id, 0)
        if not file:
            # A weapon type with no file: the caster's own weapon THROWN as the
            # projectile. The sentinel renders as a per-slot marker.
            file = EFFECT_NAME_TYPE_WEAPON.get(effect_name_type.get(name_id, 0), 0)
        if file:
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
