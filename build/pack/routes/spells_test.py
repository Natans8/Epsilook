"""The base-difficulty rule, and the one column where zero is not an answer."""

from __future__ import annotations

from .conftest import BuildTables
from .spells import read_spell_properties

SPELLS = frozenset({100, 200})


def test_the_base_difficulty_row_wins(tables: BuildTables) -> None:
    """A player's tooltip shows the base row, so a mythic row must not stand in
    for it however the rows happen to be ordered."""
    spells = read_spell_properties(tables(SpellMisc="""\
SpellID,DifficultyID,SpellIconFileDataID,SchoolMask,Attributes_0
100,23,700,32,4
100,0,701,4,8
200,0,702,2,16
200,23,703,64,32
"""), SPELLS)
    assert spells.icon_fid == {100: 701, 200: 702}
    assert spells.school == {100: 4, 200: 2}
    assert spells.attribute_words == {100: (8,), 200: (16,)}


def test_a_spell_with_no_base_row_keeps_the_first_it_has(
        tables: BuildTables) -> None:
    spells = read_spell_properties(tables(SpellMisc="""\
SpellID,DifficultyID,SpellIconFileDataID,SchoolMask,Attributes_0
100,23,700,32,4
100,24,701,64,8
"""), SPELLS)
    assert spells.icon_fid == {100: 700}
    assert spells.school == {100: 32}


def test_an_icon_of_zero_never_displaces_one(tables: BuildTables) -> None:
    """No icon is not an icon, so it cannot win the base-difficulty contest the
    way a school of zero legitimately does."""
    spells = read_spell_properties(tables(SpellMisc="""\
SpellID,DifficultyID,SpellIconFileDataID,SchoolMask,Attributes_0
100,23,700,32,0
100,0,0,0,0
"""), SPELLS)
    assert spells.icon_fid == {100: 700}
    assert spells.school == {100: 0}


def test_a_schoolless_spell_is_recorded_as_such(tables: BuildTables) -> None:
    """Zero is a school mask, not a missing one, so the spell must appear."""
    spells = read_spell_properties(tables(SpellMisc="""\
SpellID,DifficultyID,SpellIconFileDataID,SchoolMask,Attributes_0
100,0,700,0,0
"""), SPELLS)
    assert spells.school == {100: 0}


def test_a_spell_the_build_does_not_list_is_skipped(tables: BuildTables) -> None:
    spells = read_spell_properties(tables(SpellMisc="""\
SpellID,DifficultyID,SpellIconFileDataID,SchoolMask,Attributes_0
999,0,700,4,8
"""), SPELLS)
    assert spells.icon_fid == {}
    assert spells.attribute_words == {}


def test_every_attribute_column_the_build_exports_is_read(
        tables: BuildTables) -> None:
    """The array width varies between builds, so the header decides it."""
    spells = read_spell_properties(tables(SpellMisc="""\
SpellID,DifficultyID,SpellIconFileDataID,SchoolMask,Attributes_0,Attributes_1,Attributes_2
100,0,700,4,1,2,3
"""), SPELLS)
    assert spells.attribute_words == {100: (1, 2, 3)}
