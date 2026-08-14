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
import re
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from pack.sources import wdc3

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache"
BUILD_TEXT = "9.2.7.45745"
BUILD: tuple[int, int, int, int] = (9, 2, 7, 45745)
EXPORT = CACHE / BUILD_TEXT
"""Where the build already caches the CSV export of each table."""

DB2_CACHE = CACHE / "wago-db2" / BUILD_TEXT
LISTFILE = CACHE / "listfile" / "community-listfile-withcapitals.csv"
DEFINITIONS = CACHE / "dbd"
CASC_URL = "https://wago.tools/api/casc/{fid}?version=" + BUILD_TEXT

_DEFAULT_BITS = {"float": 32, "string": 32, "locstring": 32}

UNNAMED = re.compile(r"^Field_\d+_\d+_\d+_\d+_\d+(_lang)?$")
"""How the export spells a column its definitions had no name for.

The name in a header comes from the definitions rather than from decoding, so
where the export carries a placeholder and the definitions have since named the
column, comparing the two compares their vintages. The position is still
checked, which is the part decoding decides."""

pytestmark = pytest.mark.skipif(
    not os.environ.get("EPSILOOK_DB2_ORACLE"),
    reason="fetches one db2 per table; set EPSILOOK_DB2_ORACLE to run")


def load_definitions_parser() -> object:
    """The `.dbd` parser, loaded from the tools directory by its path.

    Loaded rather than imported because the package does not hold it yet, and
    tolerantly because a checkout without it should skip this rather than fail
    to collect.

    TODO: import it as an ordinary module once the source layer places the
    parser inside the package. Where a schema parser belongs is that layer's
    question, and this follows it wherever it lands.
    """
    import importlib.util
    import sys

    path = ROOT / "tools" / "dbd.py"
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location("dbd", path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    # Registered before it runs: a dataclass declared inside it resolves its
    # own module while being built, and finds nothing if this is left until
    # afterwards.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dbd = load_definitions_parser()


def schema_for(definition: object) -> list[wdc3.ColumnSpec] | None:
    """The reader's schema, out of a parsed definition's build block."""
    block = definition.block_for(BUILD) if definition else None  # type: ignore[attr-defined]
    if block is None:
        return None
    out = []
    for entry in block.columns:
        meaning = definition.columns.get(entry.name)  # type: ignore[attr-defined]
        kind = meaning.type if meaning else "int"
        out.append(wdc3.ColumnSpec(
            name=entry.name, kind=kind,
            bits=entry.width or _DEFAULT_BITS.get(kind, 32),
            signed=not entry.unsigned, count=entry.array or 1,
            is_id=entry.is_id, is_relation=entry.is_relation,
            in_record=not entry.noninline))
    return out


@pytest.fixture(name="file_ids", scope="session")
def _file_ids() -> dict[str, int]:
    """The file data id of every client table, from the listfile.

    Matching on the `.db2` extension is not optional: each of these tables also
    has a legacy `.dbc` id that no modern root references, and matching the
    stem resolves to a file the game stopped shipping several expansions ago.
    """
    if not LISTFILE.exists():
        pytest.skip("the listfile is not cached")
    out: dict[str, int] = {}
    with LISTFILE.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            fid, _, path = line.partition(";")
            low = path.strip().lower()
            if low.startswith("dbfilesclient/") and low.endswith(".db2"):
                out[Path(path.strip()).stem] = int(fid)
    return out


def fetch_db2(table: str, fid: int) -> bytes:
    """The published db2 for this build, cached after the first fetch.

    Retried because the service extracts the file on demand and answers 504
    while it is busy, which is not the same as the file being absent.
    """
    dest = DB2_CACHE / f"{table}.db2"
    if dest.exists() and dest.stat().st_size:
        return dest.read_bytes()
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(CASC_URL.format(fid=fid),
                                     headers={"User-Agent": "epsilook-build"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                blob = response.read()
            dest.write_bytes(blob)
            return blob
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                pytest.skip(f"{table} is not published for {BUILD_TEXT}")
            if attempt == 2:
                pytest.skip(f"{table}: the service answered {exc.code}")
            time.sleep(5)
        except OSError:
            if attempt == 2:
                pytest.skip(f"{table}: the service could not be reached")
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
    if dbd is None:
        pytest.skip("the definition parser is not present")
    header, export = export_rows(table)
    if not export:
        pytest.skip(f"{table} is not in the cached export")
    if table not in file_ids:
        pytest.skip(f"{table} is not in the listfile")

    data = wdc3.Db2(fetch_db2(table, file_ids[table]),
                    schema_for(dbd.load(table, DEFINITIONS)))  # type: ignore[attr-defined]
    decoded = list(data.rows())

    assert len(data.columns) == len(header), (
        f"{table}: {len(data.columns)} columns decoded against {len(header)} "
        f"exported, so every value comparison below would be meaningless\n"
        f"  decoded  {data.columns}\n  exported {header}")
    named = [(mine, theirs) for mine, theirs in zip(data.columns, header)
             if not UNNAMED.match(theirs)]
    assert all(mine == theirs for mine, theirs in named), (
        f"{table}: the decoded column order is not the export's: "
        + "; ".join(f"{theirs!r} decoded as {mine!r}"
                    for mine, theirs in named if mine != theirs))

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
        for index, name in enumerate(data.columns):
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
