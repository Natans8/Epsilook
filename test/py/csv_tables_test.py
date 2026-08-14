"""`CsvTables` must agree with the reader it replaces, over the real cache.

Same rows, same order, same text, for every table the build downloads. Skipped
when the cache is absent, which is every CI run.
"""

from __future__ import annotations

import sys

import pytest

from pack.sources.cache import CACHE_DIR
from pack.sources.wago import TABLES
from pack.tables.csv_tables import CsvTables

PACK = "9.2.7.45745"
TABLE_DIR = CACHE_DIR / PACK

pytestmark = pytest.mark.skipif(
    not TABLE_DIR.is_dir(), reason=f"no cached tables for {PACK}; build a pack first")


@pytest.fixture(name="legacy", scope="module")
def _legacy() -> object:
    """The builder being replaced, imported only when the cache is there."""
    sys.path.insert(0, str(CACHE_DIR.parent.parent / "build"))
    import build_data  # pylint: disable=import-outside-toplevel

    return build_data


@pytest.mark.parametrize("table", TABLES)
def test_every_downloaded_table_reads_identically(table: str, legacy: object) -> None:
    """Whole tables, not samples: one late row differing is what a sample
    misses."""
    tables = CsvTables(TABLE_DIR)
    if not tables.available(table):
        pytest.skip(f"{table} is absent on {PACK}")
    columns = tables.header(table)
    assert columns, f"{table} has no header"
    theirs = list(legacy.read_table(TABLE_DIR, table, columns))  # type: ignore[attr-defined]
    ours = list(tables.rows(table, columns))
    assert ours == theirs


def test_the_pinned_sound_kit_build_is_just_another_source(legacy: object) -> None:
    """The one cross-build read in the build: a different directory is a
    different provider instance, not a special case."""
    pinned = CACHE_DIR / legacy.SOUNDKITNAME_BUILD  # type: ignore[attr-defined]
    if not (pinned / "SoundKitName.csv").exists():
        pytest.skip("the pinned sound-kit build is not cached")
    tables = CsvTables(pinned)
    assert list(tables.rows("SoundKitName", ["ID", "Name"])) == list(
        legacy.read_table(pinned, "SoundKitName", ["ID", "Name"]))  # type: ignore[attr-defined]
