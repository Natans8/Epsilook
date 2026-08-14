"""The contract every ``Tables`` implementation must satisfy.

Written once and parametrised over the implementations, so a second provider
is proved against the same suite rather than against a reading of it. The
points below are not style: each one is a semantic some route depends on, and
each is a way two providers could silently disagree about the same source.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from .csv_tables import CsvTables
from .overlay import OverlaidTables
from .provider import Tables

# Every implementation, as a factory taking the directory to serve. A new
# provider is one entry here and no new test.
#
# `OverlaidTables` is here with nothing to overlay on purpose. A composition
# that changes the contract when it has no revisions to apply would be a
# composition routes cannot be handed blindly, and being handed it blindly is
# the entire point. What it does WITH revisions is `overlay_test.py`.
PROVIDERS: list[tuple[str, Callable[[Path], Tables]]] = [
    ("CsvTables", CsvTables),
    ("OverlaidTables", lambda directory: OverlaidTables(CsvTables(directory))),
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


@pytest.fixture(name="tables", params=[p for _, p in PROVIDERS], ids=[n for n, _ in PROVIDERS])
def _tables(request: pytest.FixtureRequest, source: Path) -> Tables:
    return request.param(source)


def test_a_present_table_is_available(tables: Tables) -> None:
    assert tables.available("Spell")


def test_an_absent_table_is_not(tables: Tables) -> None:
    assert not tables.available("SpellVisual")


def test_the_header_is_the_source_order(tables: Tables) -> None:
    """Order, not membership: array_columns reads positions out of it."""
    assert tables.header("Spell") == ["ID", "Name", "Amount", "Empty"]


def test_rows_arrive_in_file_order(tables: Tables) -> None:
    """Not sorted. Routes resolve collisions by last-write-wins, so a provider
    that reordered rows would change which value survives."""
    assert [row[0] for row in tables.rows("Spell", ["ID"])] == ["3", "1", "2"]


def test_values_are_text_exactly_as_written(tables: Tables) -> None:
    """Text in, text out. Typing here would move a float's low-order digits
    and make two providers produce different packs from one source."""
    assert list(tables.rows("Spell", ["Amount"])) == [("50",), ("-2",), ("0",)]


def test_a_quoted_value_keeps_its_comma_and_its_spaces(tables: Tables) -> None:
    assert list(tables.rows("Spell", ["Name"])) == [
        ("Fireball",), ("Comma, Inc",), ("  padded  ",)]


def test_an_empty_field_is_the_empty_string(tables: Tables) -> None:
    """Never None, and never absent. A route testing truthiness would branch
    differently on a provider that handed back NULL."""
    assert list(tables.rows("Spell", ["Empty"])) == [("",), ("",), ("",)]


def test_columns_come_back_in_the_order_asked_for(tables: Tables) -> None:
    """The caller unpacks the tuple positionally, so this IS the interface."""
    assert next(iter(tables.rows("Spell", ["Amount", "ID"]))) == ("50", "3")


def test_a_column_may_be_asked_for_twice(tables: Tables) -> None:
    assert next(iter(tables.rows("Spell", ["ID", "ID"]))) == ("3", "3")


def test_a_declared_absent_table_yields_nothing(source: Path) -> None:
    """How a build that predates a table reports it: the section comes out
    empty and its feature switches itself off, with no per-version branch."""
    tables = CsvTables(source, absent_tables={"SpellVisual": "the visual route"})
    assert list(tables.rows("SpellVisual", ["ID"])) == []


def test_a_declared_optional_column_yields_its_stand_in(source: Path) -> None:
    tables = CsvTables(source, defaults={("Spell", "Missing"): "-1"})
    assert list(tables.rows("Spell", ["ID", "Missing"])) == [
        ("3", "-1"), ("1", "-1"), ("2", "-1")]


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
    """A truncated download is not a declared absence.

    A build that predates a table leaves NO file, so a file that exists and
    says nothing is a broken cache -- and it has to be reported as one. Left to
    itself the header read runs off the end of a generator, which Python
    re-raises as a `RuntimeError` naming neither the table nor the directory it
    came from.
    """
    (source / "SpellVisual.csv").write_text("", encoding="utf-8", newline="")
    with pytest.raises(SystemExit):
        list(tables.rows("SpellVisual", ["ID"]))
