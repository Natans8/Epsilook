"""Where a spell may be cast: the area gate.

`SpellCastingRequirements.RequiredAreasID` names an area group,
`AreaGroupMember` lists the group's areas, and `AreaTable` names each one. Two
flat hops, no decoder, and most gated spells resolve to a single area, which is
why most pills print one word.

The area's own name is what ships. Rolling a group up to its parent zone is
tempting because it collapses most multi-area groups to one pretty word, but it
is false: of the groups that share a single parent, almost all cover only part
of that zone, so "only in Suramar" would be wrong on nearly every pill it
appeared on. The parent is used for the two links and nothing else, where
pointing at the containing zone is exactly right.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import NamedTuple


class GateRow(NamedTuple):
    """One spell gated to one named area."""

    spell: int
    area: int
    name: str


UI_MAP_TYPE_ZONE = 3
"""`UiMap.Type` for a zone map, the only type worth opening.

An area also resolves to continent maps and, through neighbouring assignments,
to another zone's map entirely. Opening the wrong map is worse than offering no
button, so the match below stays strict and the pill drops the segment when
nothing qualifies.
"""


@dataclass(frozen=True)
class Area:
    """One area a spell can be gated to."""

    name: str
    """The area's own name, as the game spells it."""

    root: int
    """The top-level ancestor, which is what the external links point at.

    Only root areas have pages to link to; a subzone's id resolves to nothing.
    """

    ui_map: int
    """The zone map to open, or zero when the area has no usable one."""


@dataclass
class AreaGates:
    """Every area gate in a build, and the areas those gates name."""

    gates: list[tuple[int, int]] = field(default_factory=list)
    """Sorted `(spell, area)` pairs, one per area a spell is gated to."""

    areas: dict[int, Area] = field(default_factory=dict)
    """Area id to its description, for the areas some gate actually names."""

    @classmethod
    def assemble(cls, rows: Iterable[GateRow], parents: Mapping[int, int], maps: Mapping[int, int]) -> AreaGates:
        """The sorted gate pairs, and one `Area` per area some gate names.

        Args:
            rows: every spell paired with a named area of its group.
            parents: area id to its parent, zero at the top.
            maps: each area's zone map, one answer for the build whatever
                language this read is in.
        """
        gates = cls()
        for row in sorted(set(rows)):
            gates.gates.append((row.spell, row.area))
            if row.area not in gates.areas:
                root = _root_of(row.area, parents)
                gates.areas[row.area] = Area(row.name, root, maps.get(root, 0))
        return gates


def _root_of(area: int, parents: Mapping[int, int]) -> int:
    """One area's top-level ancestor.

    Asked per gated area rather than precomputed for the table, which is
    thousands of walks rather than tens of thousands: only the areas some spell
    is actually gated to ever need one.

    The walk carries a seen-set as a cycle guard rather than as decoration:
    this data is not ours, and one self-parenting row would hang the build.

    Args:
        area: the area to resolve.
        parents: area id to its parent, zero where it is already top level.

    Returns:
        The ancestor this area's links should point at.
    """
    seen: set[int] = set()
    while parents.get(area) and area not in seen:
        seen.add(area)
        area = parents[area]
    return area
