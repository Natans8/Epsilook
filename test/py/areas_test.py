"""The area gate: which areas a spell resolves to, and where they link.

The map match is the part worth pinning. Both halves of it are load-bearing,
and each one alone opens the wrong map for a real spell.
"""

from __future__ import annotations

from pack.routes.areas import AreaGates, read_area_gates, read_zone_maps
from pack.tables import Tables
from support import BuildTables

AREAS = """\
ID,AreaName_lang,ParentAreaID
10,Suramar,0
11,The Drift,10
12,Ironforge,0
"""

MAPS = """\
ID,Name_lang,Type
80,Suramar,3
81,The Drift,3
82,Suramar,2
"""

ASSIGNMENTS = """\
AreaID,UiMapID
10,80
11,81
"""


def gated(source: Tables) -> AreaGates:
    """Both halves the build wires: the zone maps resolved once, then the gates.

    Kept together here because the split exists for the language axis, and a
    test of what a gate IS should not have to know about that.
    """
    return read_area_gates(source, read_zone_maps(source))



def test_a_spell_resolves_to_every_area_of_its_group(
        tables: BuildTables) -> None:
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,11\n5,10\n",
        AreaTable=AREAS, UiMap=MAPS, UiMapAssignment=ASSIGNMENTS,
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.gates == [(700, 10), (700, 11)]
    assert gates.areas[11].name == "The Drift"


def test_a_subzone_links_through_its_root(tables: BuildTables) -> None:
    """Only root areas have pages to link to, so the subzone carries its
    ancestor rather than its own id."""
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,11\n",
        AreaTable=AREAS, UiMap=MAPS, UiMapAssignment=ASSIGNMENTS,
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.areas[11].root == 10
    # The map is the ROOT's, which is the one a reader can actually open.
    assert gates.areas[11].ui_map == 80


def test_a_map_of_the_wrong_type_is_not_offered(tables: BuildTables) -> None:
    """A continent map carries the zone's name too, and opening it is worse
    than offering no button."""
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,10\n",
        AreaTable=AREAS, UiMap="ID,Name_lang,Type\n82,Suramar,2\n",
        UiMapAssignment="AreaID,UiMapID\n10,82\n",
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.areas[10].ui_map == 0


def test_a_neighbours_map_is_not_offered(tables: BuildTables) -> None:
    """An area can be assigned a zone map named after somewhere else; the name
    match is what rejects it."""
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,12\n",
        AreaTable=AREAS, UiMap=MAPS,
        UiMapAssignment="AreaID,UiMapID\n12,80\n",
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.areas[12].ui_map == 0


def test_the_lowest_matching_map_wins(tables: BuildTables) -> None:
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,10\n",
        AreaTable=AREAS,
        UiMap="ID,Name_lang,Type\n80,Suramar,3\n79,Suramar,3\n",
        UiMapAssignment="AreaID,UiMapID\n10,80\n10,79\n",
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.areas[10].ui_map == 79


def test_a_group_naming_a_missing_area_is_skipped(tables: BuildTables) -> None:
    """A handful of spells name a group holding an area the build has no row
    for; shipping it nameless would put an empty word on the pill."""
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,10\n5,99\n",
        AreaTable=AREAS, UiMap=MAPS, UiMapAssignment=ASSIGNMENTS,
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.gates == [(700, 10)]
    assert 99 not in gates.areas


def test_a_spell_gated_to_nothing_is_absent(tables: BuildTables) -> None:
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,10\n",
        AreaTable=AREAS, UiMap=MAPS, UiMapAssignment=ASSIGNMENTS,
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,0\n"))
    assert gates.gates == []


def test_a_self_parenting_area_does_not_hang_the_build(
        tables: BuildTables) -> None:
    """The source is not ours, so the ancestor walk guards against a cycle
    rather than trusting the data to be a tree."""
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,20\n",
        AreaTable="ID,AreaName_lang,ParentAreaID\n20,Loop,21\n21,Other,20\n",
        UiMap=MAPS, UiMapAssignment=ASSIGNMENTS,
        SpellCastingRequirements="SpellID,RequiredAreasID\n700,5\n"))
    assert gates.areas[20].root in (20, 21)


def test_the_gates_come_back_sorted(tables: BuildTables) -> None:
    gates = gated(tables(
        AreaGroupMember="AreaGroupID,AreaID\n5,10\n6,12\n",
        AreaTable=AREAS, UiMap=MAPS, UiMapAssignment=ASSIGNMENTS,
        SpellCastingRequirements="SpellID,RequiredAreasID\n800,5\n700,6\n"))
    assert gates.gates == [(700, 12), (800, 10)]
