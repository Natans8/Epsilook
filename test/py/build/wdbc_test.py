"""The WDBC and WDB2 reader, over the vendored client table and synthetic files.

Unlike the WDC3 reader's tests, one real file is available: the client table the
visual effect names come from is committed, because no archive serves a client
from that window. So the decode is asserted against rows a person can look up,
and the structural rules that file cannot exercise are asserted against files
built here.
"""

from __future__ import annotations

import gzip
import struct
from pathlib import Path
from typing import Any

import pytest

from pack.sources import dbd, wdbc
from pack.sources.cache import BUILD_DIR, CACHE_DIR

VENDORED = BUILD_DIR / "sources" / "mop-spellvisualeffectname.dbc.gz"
LAYOUT_BUILD = (5, 3, 0, 17116)


@pytest.fixture(name="definition")
def _definition() -> dbd.Definition:
    """The committed definition for the vendored table."""
    parsed = dbd.load("SpellVisualEffectName", CACHE_DIR)
    if parsed is None:
        pytest.skip("no cached .dbd for SpellVisualEffectName")
    return parsed


@pytest.fixture(name="table")
def _table(definition: dbd.Definition, tmp_path: Path) -> list[dict[str, Any]]:
    """The vendored dump, decoded."""
    unpacked = tmp_path / "SpellVisualEffectName.dbc"
    with gzip.open(VENDORED, "rb") as packed:
        unpacked.write_bytes(packed.read())
    return wdbc.read(unpacked, definition, LAYOUT_BUILD)


def test_reads_every_record(table: list[dict[str, Any]]) -> None:
    """The row count is the vendored dump's identity, so it is asserted."""
    assert len(table) == 12597


def test_carries_both_strings(table: list[dict[str, Any]]) -> None:
    """The window this file comes from is the one where both strings exist.

    A file where the name holds a model path is a later client whose name column
    was replaced by its filename, which is the failure this table exists to
    avoid.
    """
    rows = {row["ID"]: row for row in table}
    assert rows[273]["Name"] == "Rake"
    assert rows[273]["FileName"] == r"Spells\Rake.mdx"
    assert rows[855]["Name"] == "Banish (Green)"

    named = [row for row in table if row["Name"]]
    paths = [row for row in named if row["Name"].lower().endswith(".mdx")]
    assert len(named) == 12596
    assert len(paths) < 50, "the name column holds paths — this is a 5.4 client"


def test_refuses_a_layout_that_does_not_fit(
    definition: dbd.Definition, table: list[dict[str, Any]], tmp_path: Path
) -> None:
    """A layout from the wrong build is an error rather than a silent misread.

    Every value would still decode under a wrong layout, and every one would be
    wrong, so this is the only disagreement worth failing on.
    """
    assert table  # the fixture ran; the file is the same one
    unpacked = tmp_path / "SpellVisualEffectName.dbc"
    with gzip.open(VENDORED, "rb") as packed:
        unpacked.write_bytes(packed.read())
    with pytest.raises(ValueError, match="describes a 28-byte record"):
        wdbc.read(unpacked, definition, (3, 3, 5, 12340))


def test_refuses_a_foreign_container(tmp_path: Path, definition: dbd.Definition) -> None:
    """Anything that is not one of the two containers is refused by magic."""
    stray = tmp_path / "stray.dbc"
    stray.write_bytes(b"WDC3" + bytes(64))
    with pytest.raises(ValueError, match="not a client table"):
        wdbc.read(stray, definition, LAYOUT_BUILD)


def _one_column_file(magic: bytes, values: list[int], *, index: bool) -> bytes:
    """A minimal table of one four-byte integer column.

    WDB2 optionally carries an id index in front of the records, and its width
    depends on the id range rather than on the row count. Getting that wrong
    shifts every record, which is why it is built here both ways.
    """
    records = b"".join(struct.pack("<i", v) for v in values)
    header = struct.pack("<4s4I", magic, len(values), 1, 4, 1)
    if magic == wdbc.WDBC:
        return header + records + b"\0"
    low, high = (1, len(values)) if index else (0, 0)
    tail = struct.pack("<7I", 0, 0, 0, low, high, 0, 0)
    block = bytes((high - low + 1) * wdbc.INDEX_ENTRY) if high else b""
    return header + tail + block + records + b"\0"


@pytest.mark.parametrize("magic,index", [(wdbc.WDBC, False), (wdbc.WDB2, False), (wdbc.WDB2, True)])
def test_finds_the_records_in_either_container(magic: bytes, index: bool, tmp_path: Path) -> None:
    """Both containers, and both WDB2 shapes, put the records where we look."""
    definition = dbd.parse("COLUMNS\nint Value\n\nBUILD 1.0.0.1\nValue<32>\n", "Probe")
    path = tmp_path / "probe.dbc"
    path.write_bytes(_one_column_file(magic, [7, 11, 13], index=index))
    assert [row["Value"] for row in wdbc.read(path, definition, (1, 0, 0, 1))] == [7, 11, 13]
