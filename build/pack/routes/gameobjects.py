"""Game objects a spell spawns: the name, the model and the object type.

All of it depends on the server dump: the display id the model needs is itself
server-side, so a build without one keeps nothing here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .columns import to_int


@dataclass
class GameObjectData:
    """What a spawnable object resolves to."""

    name: dict[int, str] = field(default_factory=dict)
    """Entry -> the object's name."""

    fid: dict[int, int] = field(default_factory=dict)
    """Entry -> its model file, 0 where it does not resolve."""

    type: dict[int, int] = field(default_factory=dict)
    """Entry -> its object type, which decides whether the web has a page for
    it to link to."""


def read_gameobjects(tables: Tables, world: Tables | None) -> GameObjectData:
    """Read each spawnable object's name, model and type.

    `world` is the server dump, None for builds that have none.
    """
    objects = GameObjectData()
    if world is None:
        return objects
    displays: dict[int, int] = {}
    for entry_id, name, display_id, type_id in world.rows(
        "gameobject_template", ["entry", "name", "displayId", "type"]
    ):
        entry = to_int(entry_id)
        objects.name[entry] = (name or "").strip()
        objects.type[entry] = to_int(type_id)
        displays[entry] = to_int(display_id)

    files: dict[int, int] = {}
    for display_id, file_id in tables.rows("GameObjectDisplayInfo", ["ID", "FileDataID"]):
        files[to_int(display_id)] = to_int(file_id)
    objects.fid = {entry: files.get(display, 0) for entry, display in displays.items()}
    return objects
