"""A spell's reach is a band it names, and self is the complement.

Every case here is one way of saying which of `SpellRange`'s four distance
columns ship, what is left out of the section entirely, and which of the row's
flag bits survive as a fact about the reach.
"""

from __future__ import annotations

from pack.routes.reach import MELEE, UNLIMITED, WEAPON, read_spell_reach
from pack.routes.spells import SpellProperties
from pack.tables import CsvTables
from support import BuildTables

BANDS = (
    "ID,Flags,RangeMin_0,RangeMin_1,RangeMax_0,RangeMax_1\n"
    # Self only: both edges at nought, which is the band over half the game
    # names.
    "1,0,0,0,0,0\n"
    # Long range, and the commonest shape: a far edge and no near one.
    "5,0,0,0,40,40\n"
    # Charge: a band a target can stand too close for.
    "95,0,8,8,25,25\n"
    # Combat range, whose distance the client replaces with the two bodies'.
    "2,1,0,0,5,5\n"
    # The hunter's, replaced by the equipped ranged weapon's reach.
    "114,2,0,0,35,35\n"
    # Anywhere, stored as the client's own marker rather than a distance.
    "13,0,0,0,50000,50000\n"
    # Hostile and friendly disagree: 20 yards at an enemy, 40 at an ally.
    "161,0,0,0,20,40\n"
    # Float32 noise, which the source carries on any fractional distance.
    "470,0,0,0,0.10000000149011612,0.10000000149011612\n"
)


def properties(bands: dict[int, int]) -> SpellProperties:
    """A `SpellProperties` holding just what reach reads.

    Args:
        bands: spell id to the `SpellRange` id it names.

    Returns:
        The bundle a real `SpellMisc` read would have produced.
    """
    built = SpellProperties()
    for spell, band in bands.items():
        built.range_index[spell] = band
    return built


def source(tables: BuildTables) -> CsvTables:
    """The one table reach reads."""
    return tables(SpellRange=BANDS)


def test_a_band_ships_its_far_edge_in_yards(tables: BuildTables) -> None:
    rows = read_spell_reach(source(tables), properties({100: 5}))
    assert len(rows) == 1
    assert (rows[0].spell, rows[0].max_yards, rows[0].min_yards) == (100, 40, 0)


def test_a_near_edge_ships_beside_it(tables: BuildTables) -> None:
    """Charge is the shape: a target can stand too close to be reached."""
    rows = read_spell_reach(source(tables), properties({100: 95}))
    assert (rows[0].min_yards, rows[0].max_yards) == (8, 25)


def test_a_self_only_band_is_left_out(tables: BuildTables) -> None:
    """Self is the complement worked out at load rather than a shipped list,
    which is what makes the section affordable at all."""
    assert read_spell_reach(source(tables), properties({100: 1})) == []


def test_a_spell_naming_no_band_is_left_out(tables: BuildTables) -> None:
    """A band id nothing answers is the same answer as no reach, and it is
    what the spells with no `SpellMisc` row of their own get."""
    assert read_spell_reach(source(tables), properties({100: 0})) == []
    assert read_spell_reach(source(tables), properties({100: 999})) == []


def test_the_unlimited_marker_is_kept_as_the_distance(
        tables: BuildTables) -> None:
    """It is a quantity in the table and a word everywhere else, so the route
    ships it verbatim and leaves the naming to the catalogue."""
    rows = read_spell_reach(source(tables), properties({100: 13}))
    assert rows[0].max_yards == UNLIMITED


def test_a_combat_band_says_the_reach_is_the_caster_s(
        tables: BuildTables) -> None:
    rows = read_spell_reach(source(tables), properties({100: 2}))
    assert rows[0].flags == MELEE


def test_a_weapon_band_says_the_reach_is_the_weapon_s(
        tables: BuildTables) -> None:
    rows = read_spell_reach(source(tables), properties({100: 114}))
    assert rows[0].flags == WEAPON


def test_only_the_two_declared_bits_of_the_flag_column_survive(
        tables: BuildTables) -> None:
    """Anything else the column carries is dropped rather than passed on under
    a name nothing can give it."""
    rows = read_spell_reach(
        tables(SpellRange="ID,Flags,RangeMin_0,RangeMin_1,RangeMax_0,RangeMax_1\n"
                          "7,255,0,0,10,10\n"),
        properties({100: 7}))
    assert rows[0].flags == MELEE | WEAPON


def test_the_hostile_band_is_the_one_that_ships(tables: BuildTables) -> None:
    """The two disagree on a few hundred spells a build, and the hostile pair
    is what the cooked descriptions read, so the printed sentence and the
    searchable number stay the same distance."""
    rows = read_spell_reach(source(tables), properties({100: 161}))
    assert rows[0].max_yards == 20


def test_a_fractional_distance_is_rounded_to_what_it_means(
        tables: BuildTables) -> None:
    """The source is float32, so a tenth of a yard arrives with a tail long
    enough to make every value distinct and the band table useless."""
    rows = read_spell_reach(source(tables), properties({100: 470}))
    assert rows[0].max_yards == 0.1


def test_the_rows_come_back_sorted(tables: BuildTables) -> None:
    rows = read_spell_reach(source(tables), properties({300: 5, 100: 5}))
    assert [row.spell for row in rows] == [100, 300]
