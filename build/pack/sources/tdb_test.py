"""Invariants of the TDB declarations, checked where they are declared.

These are properties of the tables at module scope, not of any one fetch, so
they are asserted once here rather than re-tested on every download.
"""

from __future__ import annotations

import pytest

from .dump import Column, parse_create_table
from .tdb import (STAMP_COLUMN, TDB_LOSSY_COLUMNS, TDB_RELEASES, TDB_TABLES,
                  check_lossy_declaration)


def test_the_two_dump_kinds_cannot_share_a_table_name() -> None:
    """Both distil into ONE directory, so a shared name would collide.

    The second column list would win, the cached file's header would never
    match it, and every build would re-distil 700 MB of SQL to reproduce the
    same disagreement.
    """
    assert not set(TDB_TABLES["world"]) & set(TDB_TABLES["hotfixes"])


def test_every_hotfix_table_is_stamped() -> None:
    """The filter has nothing to judge a row on otherwise, and measured across
    all six cached releases every hotfix table carries the stamp."""
    for table, columns in TDB_TABLES["hotfixes"].items():
        assert STAMP_COLUMN in columns, table


def test_no_world_table_is_stamped() -> None:
    """World data is not a revision of anything, so there is no client build to
    verify it against."""
    for table, columns in TDB_TABLES["world"].items():
        assert STAMP_COLUMN not in columns, table


def test_every_lossy_column_belongs_to_a_table_we_distil() -> None:
    for table, column in TDB_LOSSY_COLUMNS:
        assert column in TDB_TABLES["hotfixes"].get(table, []), f"{table}.{column}"


def test_every_release_names_a_world_dump() -> None:
    """Hotfixes are optional -- the 3.3.5 branch ships none -- but the world
    tables are the only source of what they carry."""
    for build, release in TDB_RELEASES.items():
        assert "world" in release, build


def schema(**kinds: str) -> list[Column]:
    return parse_create_table(
        "CREATE TABLE `t` (" + ", ".join(f"`{name}` {kind}"
                                         for name, kind in kinds.items()) + ");")


def test_a_lossy_column_must_be_declared() -> None:
    """Silently overlaying a rounded value over a precise one is the failure
    this refuses, so an undeclared FLOAT stops the distill."""
    with pytest.raises(SystemExit):
        check_lossy_declaration("t", schema(Amount="float"), ["Amount"])


def test_a_declaration_that_stopped_being_true_is_caught() -> None:
    with pytest.raises(SystemExit):
        check_lossy_declaration("spell_effect", schema(EffectBasePoints="int"),
                                ["EffectBasePoints"])


def test_a_column_this_release_predates_is_not_a_type_disagreement() -> None:
    """Absence is declared where absence belongs. Treating it as a mismatch
    here crashed on the message it was trying to build."""
    check_lossy_declaration("spell_effect", schema(ID="int"), ["EffectBasePoints"])
