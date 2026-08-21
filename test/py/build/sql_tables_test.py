"""`SqlTables` must read the real cache exactly as `CsvTables` reads it.

The contract suite pins the semantics on a table written for the purpose; this
is the other half, and it is the one that matters: every column of every row of
every table the build downloads, against the provider that has served twelve
packs. A CSV a hand-written test would never think to write -- a quoted newline,
a field of eighty thousand characters, a value that looks like a null -- is in
the cache already.

Whole tables, not samples: one late row differing is what a sample misses.
Skipped when the cache is absent, which is every CI run.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pack.sources.cache import CACHE_DIR
from pack.sources.tdb import tdb_dir_name
from pack.sources.wago import LOCALIZED_TABLES, SOUNDKITNAME_BUILD, TABLES, locale_dir
from pack.tables.csv_tables import CsvTables
from pack.tables.sql_tables import SqlTables

PACK = "9.2.7.45745"
TABLE_DIR = CACHE_DIR / PACK

pytestmark = pytest.mark.skipif(
    not TABLE_DIR.is_dir(), reason=f"no cached tables for {PACK}; build a pack first")


def agree(directory: Path, table: str) -> None:
    """Both providers read one table's every column identically, or fail."""
    csv_tables, sql_tables = CsvTables(directory), SqlTables(directory)
    columns = csv_tables.header(table)
    assert columns, f"{table} has no header"
    assert sql_tables.header(table) == columns
    assert list(sql_tables.rows(table, columns)) == list(csv_tables.rows(table, columns))


@pytest.mark.parametrize("table", TABLES)
def test_every_downloaded_table_reads_identically(table: str) -> None:
    """The client's own tables, which is most of what a build reads."""
    if not CsvTables(TABLE_DIR).available(table):
        pytest.skip(f"{table} is absent on {PACK}")
    agree(TABLE_DIR, table)


@pytest.mark.parametrize("table", LOCALIZED_TABLES)
def test_every_translated_table_reads_identically(table: str) -> None:
    """A translated export is where a quoted separator and a blank actually
    occur, so it is worth its own pass rather than a sample of one."""
    directory = locale_dir(PACK, "ruRU")
    if not (directory / f"{table}.csv").exists():
        pytest.skip(f"{table} is not cached for ruRU")
    agree(directory, table)


def test_the_server_dump_reads_identically() -> None:
    """The distilled TrinityCore tables: the one source that is not an export
    at all, and the only one whose text came through a mysqldump parser."""
    directory = CACHE_DIR / tdb_dir_name("TDB927.22111")
    if not directory.is_dir():
        pytest.skip("no distilled TDB release is cached")
    for path in sorted(directory.glob("*.csv")):
        agree(directory, path.stem)


def test_the_pinned_sound_kit_build_reads_identically() -> None:
    """The one cross-build read in the build: a different directory is a
    different provider instance, not a special case."""
    pinned = CACHE_DIR / SOUNDKITNAME_BUILD
    if not (pinned / "SoundKitName.csv").exists():
        pytest.skip("the pinned sound-kit build is not cached")
    agree(pinned, "SoundKitName")
