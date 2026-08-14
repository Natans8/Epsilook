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

from dataclasses import dataclass, field

from ..tables import Tables
from .columns import to_int

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


def _roots(parents: dict[int, int]) -> dict[int, int]:
    """Every area's top-level ancestor.

    The walk carries a seen-set as a cycle guard rather than as decoration:
    this data is not ours, and one self-parenting row would hang the build.

    Args:
        parents: area id to its parent, zero where it is already top level.

    Returns:
        Area id to the ancestor its links should point at.
    """
    roots: dict[int, int] = {}
    for area in parents:
        seen: set[int] = set()
        walker = area
        while parents.get(walker) and walker not in seen:
            seen.add(walker)
            walker = parents[walker]
        roots[area] = walker
    return roots


def _zone_maps(tables: Tables, names: dict[int, str]) -> dict[int, int]:
    """Each area's zone map, where one names the same place the area does.

    Both filters are load-bearing. Matching on type alone reaches continent
    maps; matching on assignment alone reaches a neighbour's map. Requiring the
    map to be a zone map whose name equals the area's is what keeps the button
    pointing where the pill says.

    Args:
        tables: the source to read from.
        names: area id to name, used as the second half of the match.

    Returns:
        Area id to the lowest matching `UiMapID`.
    """
    zones = {to_int(uid): name for uid, name, kind
             in tables.rows("UiMap", ["ID", "Name_lang", "Type"])
             if to_int(kind) == UI_MAP_TYPE_ZONE}
    maps: dict[int, int] = {}
    for area_text, map_text in tables.rows("UiMapAssignment", ["AreaID", "UiMapID"]):
        area, ui_map = to_int(area_text), to_int(map_text)
        if area in names and zones.get(ui_map) == names[area]:
            maps[area] = min(ui_map, maps.get(area, ui_map))
    return maps


def read_area_gates(tables: Tables) -> AreaGates:
    """Read every spell's area gate, and describe the areas they name.

    Args:
        tables: the source to read from.

    Returns:
        The sorted gate pairs, and one `Area` per area some gate names. A group
        naming an area the build has no row for is skipped rather than shipped
        nameless, which a handful of spells do.
    """
    members: dict[int, list[int]] = {}
    for group_text, area_text in tables.rows(
            "AreaGroupMember", ["AreaGroupID", "AreaID"]):
        members.setdefault(to_int(group_text), []).append(to_int(area_text))

    names: dict[int, str] = {}
    parents: dict[int, int] = {}
    for area_text, name, parent_text in tables.rows(
            "AreaTable", ["ID", "AreaName_lang", "ParentAreaID"]):
        area = to_int(area_text)
        names[area] = name
        parents[area] = to_int(parent_text)

    roots = _roots(parents)
    maps = _zone_maps(tables, names)

    gates = AreaGates()
    for spell_text, group_text in tables.rows(
            "SpellCastingRequirements", ["SpellID", "RequiredAreasID"]):
        if not (group := to_int(group_text)):
            continue
        spell = to_int(spell_text)
        for area in sorted(set(members.get(group, ()))):
            if area not in names:
                continue
            gates.gates.append((spell, area))
            if area not in gates.areas:
                root = roots.get(area, area)
                gates.areas[area] = Area(names[area], root, maps.get(root, 0))
    gates.gates.sort()
    return gates
