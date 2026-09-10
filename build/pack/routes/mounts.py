"""Mounts: the display a mount-granting spell puts you on.

Reached from the mount table by the spell that grants it, then out to the
displays it can wear -- faction and gender variants, so several per mount. Both
halves are client data, so this needs no server dump.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import NamedTuple

from .creatures import CreatureModels


class MountRow(NamedTuple):
    """One mount joined to one of its displays, or to none."""

    mount: int
    name: str
    spell: int
    flavour: str
    display: int


@dataclass
class MountData:
    """Which spell puts you on which display, and what that display is."""

    links: list[tuple[int, int]] = field(default_factory=list)
    """(spell, display) pairs, sorted so the pack is stable across builds."""

    name: dict[int, str] = field(default_factory=dict)
    """Display -> the mount's name, empty where it has none."""

    fid: dict[int, int] = field(default_factory=dict)
    """Display -> its model file, 0 where it does not resolve."""

    flavour: dict[int, str] = field(default_factory=dict)
    """Granting spell -> the mount's own flavour text, for the spells that carry one.

    Prose about the mount rather than about the spell, which is why it joins
    the description corpus instead of becoming an axis: nearly every mount
    spell's own description is one line of boilerplate.
    """

    @classmethod
    def assemble(cls, rows: Iterable[MountRow], creatures: CreatureModels) -> MountData:
        """The bundle from the joined rows: the first mount to claim a display
        names it, a mount with no display still carries its flavour."""
        mounts = cls()
        links: set[tuple[int, int]] = set()
        for row in rows:
            if row.flavour and row.spell not in mounts.flavour:
                mounts.flavour[row.spell] = row.flavour
            if row.display:
                links.add((row.spell, row.display))
                mounts.name.setdefault(row.display, row.name)
                mounts.fid.setdefault(row.display, creatures.fid_for_display(row.display))
        mounts.links = sorted(links)
        return mounts
