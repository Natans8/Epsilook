"""The contract every ``Tables`` implementation must satisfy.

Parametrised over the implementations; each case is a semantic some route
depends on.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

import pytest

from pack.tables.csv_tables import CsvTables
from pack.tables.overlay import OverlaidTables
from pack.tables.provider import Tables
from pack.tables.sql_tables import SqlTables

# Every implementation, as a factory taking the directory to serve and whatever
# drift declarations a case wants to stand in for the build-wide ones.
#
# Each `OverlaidTables` appears with nothing to overlay: a route is handed it
# blindly, so it must not change the contract when it has no revisions to
# apply. What it does with revisions is `overlay_test.py`.
Factory = Callable[..., Tables]

PROVIDERS: list[tuple[str, Factory]] = [
    ("CsvTables", CsvTables),
    ("SqlTables", SqlTables),
    ("OverlaidCsvTables", lambda directory, **drift: OverlaidTables(CsvTables(directory, **drift))),
    ("OverlaidSqlTables", lambda directory, **drift: OverlaidTables(SqlTables(directory, **drift))),
]

TABLE = """\
ID,Name,Amount,Empty
3,Fireball,50,
1,"Comma, Inc",-2,
2,  padded  ,0,
"""


@pytest.fixture(name="source")
def _source(tmp_path: Path) -> Path:
    (tmp_path / "Spell.csv").write_text(TABLE, encoding="utf-8", newline="")
    return tmp_path


@pytest.fixture(name="make", params=[p for _, p in PROVIDERS], ids=[n for n, _ in PROVIDERS])
def _make(request: pytest.FixtureRequest, source: Path) -> Factory:
    """This case's implementation, already pointed at the source directory.

    Handed as a factory rather than an instance because the drift cases stand
    their own declarations in, and every implementation owes those too.
    """

    def build(**drift: Any) -> Tables:
        # What the fixture was parametrised with is known to the decorator and
        # invisible to the checker, which types `param` as Any for everyone.
        return cast(Tables, request.param(source, **drift))

    return build


@pytest.fixture(name="tables")
def _tables(make: Factory) -> Tables:
    return make()


def test_a_present_table_is_available(tables: Tables) -> None:
    assert tables.available("Spell")


def test_an_absent_table_is_not(tables: Tables) -> None:
    assert not tables.available("SpellVisual")


def test_the_header_is_the_source_order(tables: Tables) -> None:
    """Order, not membership: array_columns reads positions out of it."""
    assert tables.header("Spell") == ["ID", "Name", "Amount", "Empty"]


def test_rows_arrive_in_file_order(tables: Tables) -> None:
    """Routes resolve collisions by last-write-wins, so order decides which
    value survives."""
    assert [row[0] for row in tables.rows("Spell", ["ID"])] == ["3", "1", "2"]


def test_values_are_text_exactly_as_written(tables: Tables) -> None:
    """Typing here would move a float's low-order digits between providers."""
    assert list(tables.rows("Spell", ["Amount"])) == [("50",), ("-2",), ("0",)]


def test_a_quoted_value_keeps_its_comma_and_its_spaces(tables: Tables) -> None:
    assert list(tables.rows("Spell", ["Name"])) == [("Fireball",), ("Comma, Inc",), ("  padded  ",)]


def test_an_empty_field_is_the_empty_string(tables: Tables) -> None:
    """Never None: a route testing truthiness would branch differently."""
    assert list(tables.rows("Spell", ["Empty"])) == [("",), ("",), ("",)]


def test_columns_come_back_in_the_order_asked_for(tables: Tables) -> None:
    """The caller unpacks the tuple positionally."""
    assert next(iter(tables.rows("Spell", ["Amount", "ID"]))) == ("50", "3")


def test_a_column_may_be_asked_for_twice(tables: Tables) -> None:
    assert next(iter(tables.rows("Spell", ["ID", "ID"]))) == ("3", "3")


def test_a_declared_absent_table_yields_nothing(make: Factory) -> None:
    """How a build that predates a table reports it, with no per-version
    branch: the section comes out empty."""
    tables = make(absent_tables={"SpellVisual": "the visual route"})
    assert list(tables.rows("SpellVisual", ["ID"])) == []


def test_a_declared_optional_column_yields_its_stand_in(make: Factory) -> None:
    tables = make(defaults={("Spell", "Missing"): "-1"})
    assert list(tables.rows("Spell", ["ID", "Missing"])) == [("3", "-1"), ("1", "-1"), ("2", "-1")]


def test_a_request_of_nothing_but_stand_ins_still_yields_every_row(make: Factory) -> None:
    """One row per row of the source, not one row of stand-ins.

    A build old enough to lack every column a route asked for still has the
    rows, and the route counts them. An implementation that works out what to
    read from the columns alone loses the table here.
    """
    tables = make(defaults={("Spell", "Gone"): "-1", ("Spell", "Also"): "0"})
    assert list(tables.rows("Spell", ["Gone", "Also"])) == [("-1", "0"), ("-1", "0"), ("-1", "0")]


def test_an_undeclared_missing_column_is_fatal(tables: Tables) -> None:
    """The one outcome worth crashing over: silently dropping data."""
    with pytest.raises(SystemExit):
        list(tables.rows("Spell", ["NoSuchColumn"]))


def test_an_undeclared_missing_table_is_fatal(tables: Tables) -> None:
    with pytest.raises(SystemExit):
        list(tables.rows("SpellVisual", ["ID"]))


def test_the_header_of_an_absent_table_is_empty(tables: Tables) -> None:
    """Empty rather than fatal, because array_columns asks before it knows."""
    assert tables.header("SpellVisual") == []


def test_a_source_with_no_header_at_all_is_fatal(source: Path, tables: Tables) -> None:
    """A build that predates a table leaves no file, so a file that exists and
    says nothing is a broken cache."""
    (source / "SpellVisual.csv").write_text("", encoding="utf-8", newline="")
    with pytest.raises(SystemExit):
        list(tables.rows("SpellVisual", ["ID"]))


def test_a_truncated_row_is_fatal(source: Path, tables: Tables) -> None:
    """A row narrower than its header is a broken cache, not missing data.

    Indexing it raises naming neither the table nor the directory it came
    from, which is the one thing an operator needs with sixty tables and
    twelve builds to choose between.
    """
    (source / "Spell.csv").write_text("ID,Name,Amount,Empty\n3,Fireball\n", encoding="utf-8", newline="")
    with pytest.raises(SystemExit):
        list(tables.rows("Spell", ["ID", "Amount"]))
