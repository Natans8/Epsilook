"""The drift declarations have to agree with the roster they qualify."""

from __future__ import annotations

from .drift import (CREATURE_DISPLAY_SOURCES, OPTIONAL_COLUMNS, OPTIONAL_TABLES,
                    SPELL_NAME_SOURCES, TDB_OPTIONAL_COLUMNS, TDB_OPTIONAL_TABLES)
from .sources.tdb import TDB_TABLES
from .sources.wago import TABLES


def test_every_optional_table_is_also_downloaded() -> None:
    """The two lists do different jobs and a table usually needs both.

    `TABLES` is what gets fetched; `OPTIONAL_TABLES` only says a 404 on one is
    allowed. Declaring a table optional and forgetting to fetch it leaves it
    never downloaded, which looks exactly like a build that predates it: the
    feature switches off silently on every version and the log says "absent",
    so nothing points at the mistake.
    """
    assert not set(OPTIONAL_TABLES) - set(TABLES)


def test_optional_columns_name_a_table_that_is_downloaded() -> None:
    assert not {table for table, _ in OPTIONAL_COLUMNS} - set(TABLES)


def test_spell_name_sources_are_downloaded() -> None:
    assert not {table for table, _ in SPELL_NAME_SOURCES} - set(TABLES)


def test_tdb_drift_names_tables_the_dumps_are_distilled_for() -> None:
    distilled = {table for kind in TDB_TABLES.values() for table in kind}
    assert not set(TDB_OPTIONAL_TABLES) - distilled
    assert not {table for table, _ in TDB_OPTIONAL_COLUMNS} - distilled
    assert not {table for table, _ in CREATURE_DISPLAY_SOURCES} - distilled


def test_a_declared_optional_column_carries_a_stand_in_value() -> None:
    """The declaration IS the default, so an empty one has to be deliberate."""
    for (table, column), default in {**OPTIONAL_COLUMNS, **TDB_OPTIONAL_COLUMNS}.items():
        assert isinstance(default, str), f"{table}.{column}"
