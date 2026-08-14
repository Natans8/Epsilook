"""What the merge must get right when one source revises another."""

from __future__ import annotations

from pathlib import Path

import pytest

from pack.drift import SPELL_NAME_SOURCES
from pack.supplements import above, at_least
from pack.tables.csv_tables import CsvTables
from pack.tables.hotfixes import check_overlay_declaration, hotfix_overlays
from pack.tables.overlay import OverlaidTables, Overlay

BASE = """\
ID,Name,Amount,Note
10,Fireball,50,client
11,Frostbolt,7,client
12,Blink,3,client
"""

# Spelled differently on purpose: the two sources never agree on a name.
REVISIONS = """\
Id,Label,Verified
11,Frostbolt Rank 2,900
12,Blink Revised,700
99,Added Server-Side,900
"""

BUILD = 900

STAMPED = Overlay("spell", {"ID": "Id", "Name": "Label"},
                  judged_on="Verified", admits=at_least(BUILD))
"""The hotfix shape: judged on the build a row was verified against."""


def written(tmp_path: Path, base_text: str | None = BASE,
            revisions: str | None = REVISIONS) -> tuple[Path, Path]:
    """The two source directories, written. `None` leaves that side absent."""
    base, source = tmp_path / "base", tmp_path / "source"
    base.mkdir()
    source.mkdir()
    if base_text is not None:
        (base / "Spell.csv").write_text(base_text, encoding="utf-8", newline="")
    if revisions is not None:
        (source / "spell.csv").write_text(revisions, encoding="utf-8", newline="")
    return base, source


@pytest.fixture(name="tables")
def _tables(tmp_path: Path) -> OverlaidTables:
    base, source = written(tmp_path)
    return OverlaidTables(base=CsvTables(base), overlays={"Spell": STAMPED},
                          source=CsvTables(source))


def rows(tables: OverlaidTables, *columns: str) -> list[tuple[str, ...]]:
    return list(tables.rows("Spell", list(columns)))


def by_id(tables: OverlaidTables, column: str) -> dict[str, str]:
    """One column keyed by row id, which is the shape most of these assert."""
    return {row[0]: row[1] for row in tables.rows("Spell", ["ID", column])}


def test_a_revision_replaces_the_column_it_supplies(tables: OverlaidTables) -> None:
    assert by_id(tables, "Name") == {
        "10": "Fireball",            # unrevised
        "11": "Frostbolt Rank 2",    # revised
        "12": "Blink",               # revised, but its stamp is too old
        "99": "Added Server-Side",   # added
    }


def test_a_column_the_overlay_does_not_supply_survives(tables: OverlaidTables) -> None:
    """The reason the merge is per column: a row replace would blank it."""
    assert by_id(tables, "Amount") == {
        "10": "50", "11": "7", "12": "3", "99": ""}


def test_a_stamp_at_or_beyond_the_build_applies(tables: OverlaidTables) -> None:
    assert by_id(tables, "Name")["11"] == "Frostbolt Rank 2"


def test_a_stamp_below_the_build_does_not(tables: OverlaidTables) -> None:
    """A row verified against an older client would put stale data over
    current data."""
    assert by_id(tables, "Name")["12"] == "Blink"


def test_an_unreadable_stamp_does_not_apply(tmp_path: Path) -> None:
    """A source that stamps its rows stamps all of them, so a missing value is
    a malformed row rather than one that means "always"."""
    base, source = written(tmp_path,
                           revisions="Id,Label,Verified\n11,Revised,\n")
    tables = OverlaidTables(CsvTables(base), {"Spell": STAMPED}, CsvTables(source))
    assert by_id(tables, "Name")["11"] == "Frostbolt"


def test_a_row_the_base_lacks_is_added_not_dropped(tables: OverlaidTables) -> None:
    """Revision rows naming ids the client never carried are real server-side
    additions, so dropping them loses data."""
    assert ("99", "Added Server-Side") in rows(tables, "ID", "Name")


def test_added_rows_come_after_the_base_in_file_order(tables: OverlaidTables) -> None:
    """Routes resolve collisions by last-write-wins, so file order is part of
    the contract."""
    assert [row[0] for row in rows(tables, "ID")] == ["10", "11", "12", "99"]


def test_the_key_need_not_be_among_the_columns_asked_for(tables: OverlaidTables) -> None:
    """A route asks for what it needs, not for what the merge needs."""
    assert rows(tables, "Name") == [("Fireball",), ("Frostbolt Rank 2",),
                                    ("Blink",), ("Added Server-Side",)]


def test_a_table_with_no_overlay_passes_straight_through(tables: OverlaidTables) -> None:
    assert list(tables.rows("Spell", ["Note"])) == [("client",), ("client",),
                                                    ("client",), ("",)]


def test_availability_and_header_follow_the_base(tables: OverlaidTables) -> None:
    """An overlay revises a table; it never introduces one."""
    assert tables.available("Spell")
    assert tables.header("Spell") == ["ID", "Name", "Amount", "Note"]


def test_a_build_without_a_source_reads_the_base_alone(tmp_path: Path) -> None:
    """Ordinary rather than exceptional: some builds have no server release."""
    base, _source = written(tmp_path, revisions=None)
    tables = OverlaidTables(CsvTables(base), hotfix_overlays(BUILD), None)
    assert by_id(tables, "Name")["11"] == "Frostbolt"


def test_a_table_the_build_predates_stays_empty(tmp_path: Path) -> None:
    """A build that predates a table reads it as empty, and without this every
    revision row would surface as an addition."""
    base, source = written(tmp_path, base_text=None)
    tables = OverlaidTables(
        CsvTables(base, absent_tables={"Spell": "the spell list"}),
        {"Spell": STAMPED}, CsvTables(source))
    assert rows(tables, "ID", "Name") == []


def test_two_spellings_of_one_id_are_one_row(tmp_path: Path) -> None:
    """Values travel as text, but `11` and `11.0` must still be one row."""
    base, source = written(
        tmp_path, revisions="Id,Label,Verified\n11.0,Revised,900\n")
    tables = OverlaidTables(CsvTables(base), {"Spell": STAMPED}, CsvTables(source))
    assert by_id(tables, "Name") == {"10": "Fireball", "11": "Revised",
                                     "12": "Blink"}


def test_the_key_must_be_mapped() -> None:
    """Without it a typo would silently make every row an addition."""
    with pytest.raises(ValueError):
        Overlay("spell", {"Name": "Label"})


def test_an_overlay_with_no_rule_admits_every_row(tmp_path: Path) -> None:
    """A supplement whose rows are all in scope declares nothing and gets them
    all, which is why the default rule is the permissive one."""
    base, source = written(tmp_path)
    tables = OverlaidTables(CsvTables(base),
                            {"Spell": Overlay("spell", {"ID": "Id", "Name": "Label"})},
                            CsvTables(source))
    assert by_id(tables, "Name")["12"] == "Blink Revised"


def test_a_rule_can_judge_the_key_rather_than_a_column(tmp_path: Path) -> None:
    """The case that makes the merge shared rather than hotfix-shaped: a
    supplement confined to a range of ids the base cannot reach is judged on the
    id itself, so it can extend the base without ever shadowing it.

    The admitted id is spelled `5000.0` on purpose: the two sides are different
    exporters, so the rule reads the key through the same normalisation the join
    uses. Reading it strictly would refuse the row the rule exists to admit, and
    a refused row is indistinguishable from an absent one."""
    base, source = written(
        tmp_path,
        revisions="Id,Label\n11,Must Not Win\n5000.0,Beyond The Base\n")
    tables = OverlaidTables(
        CsvTables(base),
        {"Spell": Overlay("spell", {"ID": "Id", "Name": "Label"},
                          admits=above(1000))},
        CsvTables(source))
    assert by_id(tables, "Name") == {
        "10": "Fireball",
        "11": "Frostbolt",             # refused: inside the base's own range
        "12": "Blink",
        # Admitted, and spelled as its own source spelled it: an added row keeps
        # the overlay's text rather than the normalised form the rule compared,
        # which is why a reader turning these back into numbers parses
        # defensively rather than assuming a bare integer.
        "5000.0": "Beyond The Base",
    }


def test_naming_the_key_column_means_what_omitting_it_means(tmp_path: Path) -> None:
    """The rule resolves what it judges by what the field IS, not by whether it
    was named, so the two spellings of "judge the id" cannot disagree about
    normalisation."""
    base, source = written(
        tmp_path, revisions="Id,Label\n5000.0,Beyond The Base\n")
    named = OverlaidTables(
        CsvTables(base),
        {"Spell": Overlay("spell", {"ID": "Id", "Name": "Label"},
                          judged_on="Id", admits=above(1000))},
        CsvTables(source))
    assert by_id(named, "Name")["5000.0"] == "Beyond The Base"


def test_a_build_of_zero_is_refused_rather_than_obeyed() -> None:
    """A floor at zero admits every hotfix row on every table, and it does so
    without an error or a log line."""
    with pytest.raises(ValueError):
        hotfix_overlays(0)


def test_the_two_declarations_of_the_hotfix_overlay_agree() -> None:
    """Neither declaration can be derived from the other, so they are compared
    against each other."""
    assert check_overlay_declaration() == []


def test_every_table_a_spell_name_is_read_from_is_overlaid() -> None:
    """`SpellName.db2` was split out of `Spell.db2` in BfA, and Legion, which
    reads the name from `Spell`, has a server release."""
    for table, columns in SPELL_NAME_SOURCES:
        overlay = hotfix_overlays(BUILD).get(table)
        assert overlay is not None, f"{table} carries spell names but is not overlaid"
        assert columns[1] in overlay.columns, \
            f"{table}.{columns[1]} is the name column but the overlay does not revise it"
