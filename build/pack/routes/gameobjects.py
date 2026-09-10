"""Game objects a spell spawns: the name, the model and the object type.

All of it depends on the server dump: the display id the model needs is itself
server-side, so a build without one keeps nothing here.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import NamedTuple


class GameObjectRow(NamedTuple):
    """One spawnable object's row, its display resolved to a file."""

    entry: int
    name: str
    type: int
    file: int


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

    @classmethod
    def assemble(cls, rows: Iterable[GameObjectRow]) -> GameObjectData:
        """The bundle from the rows; empty on a build with no server dump."""
        objects = cls()
        for row in rows:
            objects.name[row.entry] = row.name
            objects.type[row.entry] = row.type
            objects.fid[row.entry] = row.file
        return objects
