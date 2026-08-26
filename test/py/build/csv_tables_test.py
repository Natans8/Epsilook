"""`CsvTables` must read the real cache the way the files are actually written.

Same rows, same order, same text, for every table the build downloads, against
a plain `csv` reader standing in as an independent second implementation. The
provider narrows and reorders columns and stands in for the ones a build
predates, and none of that may change a value.

Whole tables, not samples: one late row differing is what a sample misses.
Skipped when the cache is absent, which is every CI run.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from pack.sources.cache import CACHE_DIR
from pack.sources.wago import LOCALIZED_TABLES, SOUNDKITNAME_BUILD, TABLES, locale_dir
from pack.tables.csv_tables import CsvTables

PACK = "9.2.7.45745"
TABLE_DIR = CACHE_DIR / PACK

pytestmark = pytest.mark.skipif(not TABLE_DIR.is_dir(), reason=f"no cached tables for {PACK}; build a pack first")


def plainly(directory: Path, table: str, columns: list[str]) -> list[tuple[str, ...]]:
    """One table's named columns, read with nothing but the csv module."""
    with (directory / f"{table}.csv").open(newline="", encoding="utf-8") as handle:
        return [tuple(row[column] for column in columns) for row in csv.DictReader(handle)]


@pytest.mark.parametrize("table", TABLES)
def test_every_downloaded_table_reads_identically(table: str) -> None:
    """Every column of every row, in file order."""
    tables = CsvTables(TABLE_DIR)
    if not tables.available(table):
        pytest.skip(f"{table} is absent on {PACK}")
    columns = tables.header(table)
    assert columns, f"{table} has no header"
    assert list(tables.rows(table, columns)) == plainly(TABLE_DIR, table, columns)


@pytest.mark.parametrize("table", LOCALIZED_TABLES)
def test_every_translated_table_reads_identically(table: str) -> None:
    """A second language is a second directory and nothing else about it is
    special, which is the claim that lets one provider serve both."""
    directory = locale_dir(PACK, "ruRU")
    if not (directory / f"{table}.csv").exists():
        pytest.skip(f"{table} is not cached for ruRU")
    tables = CsvTables(directory)
    columns = tables.header(table)
    assert columns, f"{table} has no header"
    assert list(tables.rows(table, columns)) == plainly(directory, table, columns)


def test_the_pinned_sound_kit_build_is_just_another_source() -> None:
    """The one cross-build read in the build: a different directory is a
    different provider instance, not a special case."""
    pinned = CACHE_DIR / SOUNDKITNAME_BUILD
    if not (pinned / "SoundKitName.csv").exists():
        pytest.skip("the pinned sound-kit build is not cached")
    assert list(CsvTables(pinned).rows("SoundKitName", ["ID", "Name"])) == plainly(
        pinned, "SoundKitName", ["ID", "Name"]
    )
