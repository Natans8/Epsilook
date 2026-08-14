"""Invariants of the TDB declarations, checked where they are declared.

Properties of the tables at module scope, not of any one fetch.
"""

from __future__ import annotations

import pytest

from pack.sources.dump import Column, parse_create_table
from pack.sources.tdb import STAMP_COLUMN, TDB_LOSSY_COLUMNS, TDB_RELEASES, TDB_TABLES, check_lossy_declaration


def test_the_two_dump_kinds_cannot_share_a_table_name() -> None:
    """Both distil into one directory, so a shared name would collide."""
    assert not set(TDB_TABLES["world"]) & set(TDB_TABLES["hotfixes"])


def test_every_hotfix_table_is_stamped() -> None:
    """The overlay filter has nothing to judge a row on otherwise."""
    for table, columns in TDB_TABLES["hotfixes"].items():
        assert STAMP_COLUMN in columns, table


def test_no_world_table_is_stamped() -> None:
    """World data revises nothing, so no client build verifies it."""
    for table, columns in TDB_TABLES["world"].items():
        assert STAMP_COLUMN not in columns, table


def test_every_lossy_column_belongs_to_a_table_we_distil() -> None:
    for table, column in TDB_LOSSY_COLUMNS:
        assert column in TDB_TABLES["hotfixes"].get(table, []), f"{table}.{column}"


def test_every_release_names_a_world_dump() -> None:
    """The world tables are the only source of what they carry."""
    for build, release in TDB_RELEASES.items():
        assert "world" in release, build


def schema(**kinds: str) -> list[Column]:
    return parse_create_table(
        "CREATE TABLE `t` (" + ", ".join(f"`{name}` {kind}"
                                         for name, kind in kinds.items()) + ");")


def test_a_lossy_column_must_be_declared() -> None:
    """An undeclared FLOAT stops the distill."""
    with pytest.raises(SystemExit):
        check_lossy_declaration("t", schema(Amount="float"), ["Amount"])


def test_a_declaration_that_stopped_being_true_is_caught() -> None:
    with pytest.raises(SystemExit):
        check_lossy_declaration("spell_effect", schema(EffectBasePoints="int"),
                                ["EffectBasePoints"])


def test_a_column_this_release_predates_is_not_a_type_disagreement() -> None:
    """Absence is declared elsewhere, so it is not checked here."""
    check_lossy_declaration("spell_effect", schema(ID="int"), ["EffectBasePoints"])
