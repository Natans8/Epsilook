"""The drift declarations have to agree with the roster they qualify."""

from __future__ import annotations

from pack.drift import (
    CREATURE_DISPLAY_SOURCES,
    OPTIONAL_COLUMNS,
    OPTIONAL_TABLES,
    SPELL_NAME_SOURCES,
    TDB_CANDIDATE_TABLES,
    TDB_OPTIONAL_COLUMNS,
    TDB_OPTIONAL_TABLES,
)
from pack.sources.tdb import TDB_LOCALE_TABLES, TDB_TABLES
from pack.sources.wago import LOCALIZED_TABLES, TABLES


def test_every_optional_table_is_also_downloaded() -> None:
    """A table declared optional but never fetched looks exactly like a build
    that predates it: the feature switches off and the log says "absent"."""
    assert not set(OPTIONAL_TABLES) - set(TABLES)


def test_optional_columns_name_a_table_that_is_downloaded() -> None:
    assert not {table for table, _ in OPTIONAL_COLUMNS} - set(TABLES)


def test_spell_name_sources_are_downloaded() -> None:
    assert not {table for table, _ in SPELL_NAME_SOURCES} - set(TABLES)


def test_every_translated_table_is_also_downloaded() -> None:
    """A language reads copies of tables the build already fetches; one named
    here and absent from the roster would be fetched in Russian and never in
    English."""
    assert not set(LOCALIZED_TABLES) - set(TABLES)


def test_tdb_drift_names_tables_the_dumps_are_distilled_for() -> None:
    distilled = {table for roster in (TDB_TABLES, TDB_LOCALE_TABLES) for kind in roster.values() for table in kind}
    assert not set(TDB_OPTIONAL_TABLES) - distilled
    assert not {table for table, _ in TDB_OPTIONAL_COLUMNS} - distilled
    assert not {table for table, _ in CREATURE_DISPLAY_SOURCES} - distilled


def test_a_candidate_table_is_one_a_reader_picks_between() -> None:
    """The candidates are the tables a distillation deliberately leaves absent,
    and it may only leave one absent where a release is allowed to lack it."""
    assert TDB_CANDIDATE_TABLES
    assert not TDB_CANDIDATE_TABLES - (
        set(TDB_OPTIONAL_TABLES) | {table for kind in TDB_TABLES.values() for table in kind}
    )


def test_a_declared_optional_column_carries_a_stand_in_value() -> None:
    """The declaration is the default, so an empty one has to be deliberate."""
    for (table, column), default in {**OPTIONAL_COLUMNS, **TDB_OPTIONAL_COLUMNS}.items():
        assert isinstance(default, str), f"{table}.{column}"
