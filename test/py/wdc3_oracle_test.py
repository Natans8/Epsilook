"""The reader against a published decoding of the same bytes.

A decoder that is wrong about a field agrees with itself perfectly, so nothing
it can be asked about itself finds a defect. What finds one is a second reading
of the same file: wago publishes both the db2 and its own CSV export of that
db2, so decoding the first and comparing to the second leaves nowhere for a
misread field to hide.

Both sides describing the SAME FILE is what makes this an oracle. An earlier
version of this test compared a private server's copy of each table against the
public export and excused the differences as that server's edits, which cannot
tell an edited value from a misread one -- it is the decoder's own claim used
to grade the decoder. It passed while the float spelling was wrong, because the
rows it got wrong were inside the excuse.

So there is no per-table declaration here, and the only tolerance is one the
file computes about itself:

  * Every row that decodes must match the export exactly, column for column.
  * The header must match in length and order. A name the export spells as a
    placeholder is skipped: names come from the definitions, so a placeholder
    against a real name compares their vintages rather than the decoding.
  * No row may be invented: the decoded ids are a subset of the export's.
  * Rows may be MISSING only up to what the encrypted sections hold. Blizzard
    ships sections under keys the reader does not have, and skipping them is
    the documented behaviour rather than a failure. A table with no encrypted
    section must therefore reproduce every row.
  * A float beyond 1e15 may be spelled differently, because past that
    magnitude the export's decimal is a few units in the last place off the
    value it came from. Both spellings must still name the same float32.

Fetching the db2 files means asking wago for one file per table, so this is
opt-in: set `EPSILOOK_DB2_ORACLE` to run it. They are cached, so only the first
run pays.
"""

from __future__ import annotations

import csv
import os
import struct
import time

import dbd
import epsilon_tables
import pytest

from pack.sources import wdc3
from pack.sources.cache import CACHE_DIR, download

BUILD_TEXT = "9.2.7.45745"
BUILD = dbd.parse_build(BUILD_TEXT)
EXPORT = CACHE_DIR / BUILD_TEXT
"""Where the build already caches the CSV export of each table."""

DB2_CACHE = CACHE_DIR / "wago-db2" / BUILD_TEXT
DEFINITIONS = CACHE_DIR / "dbd"
CASC_URL = "https://wago.tools/api/casc/{fid}?version=" + BUILD_TEXT

pytestmark = pytest.mark.skipif(
    not os.environ.get("EPSILOOK_DB2_ORACLE"),
    reason="fetches one db2 per table; set EPSILOOK_DB2_ORACLE to run")


@pytest.fixture(name="file_ids", scope="session")
def _file_ids() -> dict[str, int]:
    """Every client table's file id, keyed by lowercase name."""
    ids = epsilon_tables.table_ids()
    if not ids:
        pytest.skip("the listfile is not cached")
    return ids


def fetch_db2(table: str, fid: int) -> bytes:
    """The published db2 for this build, cached after the first fetch.

    Retried because the service extracts the file on demand and answers 504
    while it is busy, which is not the same as the file being absent.
    """
    dest = DB2_CACHE / f"{table}.db2"
    for attempt in range(3):
        try:
            if not download(CASC_URL.format(fid=fid), dest, refresh=False,
                            optional=True):
                pytest.skip(f"{table} is not published for {BUILD_TEXT}")
            return dest.read_bytes()
        except OSError as exc:
            if attempt == 2:
                pytest.skip(f"{table}: the service did not answer ({exc})")
            time.sleep(5)
    raise AssertionError("unreachable")


def export_rows(table: str) -> tuple[list[str], list[tuple[str, ...]]]:
    """The cached CSV export: its header and its rows."""
    path = EXPORT / f"{table}.csv"
    if not path.exists():
        return [], []
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.reader(handle)
        return next(reader, []), [tuple(row) for row in reader]


def same_huge_float(left: str, right: str) -> bool:
    """Whether two spellings name one float32 too large for a decimal to pin.

    Past 1e15 a double cannot hold every integer, and the export's decimal
    drifts a few units in the last place from the exact widening of the stored
    float32 -- it prints `-9.999999843067501e+16` where the value is exactly
    `-9.999999843067494e+16`. Both name the same float32, which is all the
    column holds, so the disagreement is about spelling a number neither format
    can write down rather than about what was decoded.

    Scoped to that magnitude on purpose. Allowing it anywhere would stop the
    comparison noticing a rounding rule that is simply wrong, which is how the
    spelling stayed broken before.
    """
    try:
        pair = [struct.unpack("<f", struct.pack("<f", float(text)))[0]
                for text in (left, right)]
    except (ValueError, OverflowError):
        return False
    return pair[0] == pair[1] and abs(pair[0]) >= 1e15


def unreadable_rows(data: wdc3.Db2, size: int) -> int:
    """How many rows sit in sections this reader cannot open.

    Their records and their copies both count: a copy is an exported row in its
    own right, so a skipped section withholds more rows than it has records.
    """
    return sum(section.record_count + section.copy_table_count
               for section in data.sections if not section.readable(size))


def tables() -> list[str]:
    """Every table the build reads, which is what the oracle has to cover."""
    from pack.sources.wago import TABLES
    return sorted({"SpellName", *TABLES})


@pytest.mark.parametrize("table", tables())
def test_the_reader_reproduces_the_published_export(
        table: str, file_ids: dict[str, int]) -> None:
    """Decode the published db2; every row must match the published CSV."""
    header, export = export_rows(table)
    if not export:
        pytest.skip(f"{table} is not in the cached export")
    if table.lower() not in file_ids:
        pytest.skip(f"{table} is not in the listfile")

    definition = dbd.load(table, DEFINITIONS)
    if definition is None:
        pytest.skip(f"{table} has no definition")
    data = wdc3.Db2(fetch_db2(table, file_ids[table.lower()]),
                    epsilon_tables.schema_for(definition, BUILD))
    decoded = list(data.rows())
    columns = data.columns

    assert len(columns) == len(header), (
        f"{table}: {len(columns)} columns decoded against {len(header)} "
        f"exported, so every value comparison below would be meaningless\n"
        f"  decoded  {columns}\n  exported {header}")
    # A name the export does not share with the definitions is one the
    # definitions have since supplied, so comparing it compares their vintages
    # rather than the decoding. Asked of the definition rather than matched
    # against the shape of a placeholder, which would also excuse a schema
    # sliding by one column past such a position.
    renamed = {name for name in header if name not in definition.columns}
    disagree = [(mine, theirs) for mine, theirs in zip(columns, header)
                if mine != theirs and theirs not in renamed]
    assert not disagree, (
        f"{table}: the decoded column order is not the export's: "
        + "; ".join(f"{theirs!r} decoded as {mine!r}"
                    for mine, theirs in disagree))

    at = data.id_position()
    expected = {row[at]: row for row in export}
    got = {row[at]: row for row in decoded}

    invented = got.keys() - expected.keys()
    assert not invented, (
        f"{table}: {len(invented)} decoded row(s) are not in the export, "
        f"first {sorted(invented)[:5]}")

    withheld = unreadable_rows(data, len(data.blob))
    absent = expected.keys() - got.keys()
    assert len(absent) <= withheld, (
        f"{table}: {len(absent)} row(s) missing but only {withheld} sit in "
        f"sections this reader cannot open, so {len(absent) - withheld} were "
        f"lost while decoding a readable section")

    floats = {name for column in data.declared if column.spec.kind == "float"
              for name in column.spec.spellings()}
    wrong: dict[str, tuple[str, str, str]] = {}
    for key in expected.keys() & got.keys():
        want, mine = expected[key], got[key]
        if want == mine:
            continue
        for index, name in enumerate(columns):
            if name in wrong or want[index] == mine[index]:
                continue
            if name in floats and same_huge_float(want[index], mine[index]):
                continue
            wrong[name] = (key, want[index], mine[index])
    assert not wrong, (
        f"{table}: {len(wrong)} column(s) decode to something the export does "
        f"not hold: " + "; ".join(
            f"{name} at id {key}: export {want!r}, decoded {mine!r}"
            for name, (key, want, mine) in sorted(wrong.items())))
