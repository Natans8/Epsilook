"""Reader for the pre-CASC client tables, WDBC and WDB2.

A peer of the WDC3 reader, differing only in how old the container is. Both
answer the same question -- give me this table's rows by column name -- and both
take their column names from a `.dbd`, because a record is a flat run of fields
with no self-description whatsoever. Reading one by position is what makes a
column shift silently change every value after it.

Two containers rather than one because the boundary falls inside a single
expansion: a client may ship the same table as WDBC in one patch and WDB2 in
the next, and the difference is a longer header plus an optional index block,
not a different record layout. Handling both here keeps that an implementation
detail rather than a decision every caller has to make.

The rows these tables hold are unreachable any other way. Every published export
of client data begins at the CASC boundary, so a table that lost a column before
then can only be read out of a client old enough to still have it.
"""

from __future__ import annotations

import struct
from pathlib import Path
from typing import Any

from .dbd import Build, BuildColumn, Definition

WDBC = b"WDBC"
"""The pre-Cataclysm container: a fixed header, records, then a string block."""

WDB2 = b"WDB2"
"""The same with a longer header and, usually, an id index in front of the rows."""

HEADER = 20
"""Bytes of WDBC header: the magic plus four counts."""

WDB2_HEADER = 48
"""Bytes of WDB2 header. The four counts sit where WDBC puts them; the seven
words after them describe the optional index block."""

INDEX_ENTRY = 6
"""Bytes the WDB2 index spends per possible id: a four-byte row offset in one
array and a two-byte string length in another."""

LOCALE_SLOTS = 17
"""Words a localised string occupies: sixteen language offsets and a flags word.

Only the first is read. A pre-CASC client ships one language per install, so the
other fifteen are empty in every file we can obtain, and a caller wanting
another language wants a different client rather than a different slot.
"""

WORD = 4
"""Bytes in one field slot. Strings, floats and full-width integers are all one."""


def _record_size(columns: list[BuildColumn], definition: Definition) -> int:
    """Bytes one record occupies under this layout.

    Computed rather than taken from the header so the two can be compared. A
    disagreement means the layout is not this file's, which is the one error
    worth failing on: every value would still decode, and every one would be
    wrong.
    """
    total = 0
    for column in columns:
        kind = definition.columns[column.name].type if column.name in definition.columns else "int"
        if kind == "locstring":
            each = LOCALE_SLOTS * WORD
        elif kind in ("string", "float"):
            each = WORD
        else:
            each = max((column.width or 32) // 8, 1)
        total += each * (column.array or 1)
    return total


def read(path: Path, definition: Definition, build: Build) -> list[dict[str, Any]]:
    """Decode every record of a WDBC or WDB2 file into a dict per row.

    Args:
        path: the `.dbc` or `.db2` to read.
        definition: the parsed `.dbd` naming and typing the columns.
        build: which client's layout to read it under.

    Returns:
        One dict per record, keyed by column name. An array column holds a list;
        every other column holds its single value. A string that points outside
        the string block reads as empty rather than raising, because a client
        genuinely ships rows whose optional strings are unset.

    Raises:
        ValueError: if the file is neither container, if the definition has no
            layout for this build, or if that layout disagrees with the file
            about how wide a record is.
    """
    raw = path.read_bytes()
    magic = raw[:4]
    if magic not in (WDBC, WDB2):
        raise ValueError(f"{path.name}: not a client table, magic {magic!r}")

    count, _fields, record_size, string_size = struct.unpack_from("<4I", raw, 4)

    block = definition.block_for(build)
    if block is None:
        raise ValueError(f"{path.name}: {definition.table} has no layout for {build}")

    declared = _record_size(block.columns, definition)
    if declared != record_size:
        raise ValueError(
            f"{path.name}: {definition.table} layout for {build} describes a "
            f"{declared}-byte record, the file holds {record_size}"
        )

    body = HEADER
    if magic == WDB2:
        low, high = struct.unpack_from("<2I", raw, 32)
        body = WDB2_HEADER + ((high - low + 1) * INDEX_ENTRY if high else 0)

    strings = raw[body + count * record_size :][:string_size]

    def text(offset: int) -> str:
        if offset <= 0 or offset >= len(strings):
            return ""
        end = strings.find(b"\0", offset)
        return strings[offset : end if end >= 0 else None].decode("utf-8", "replace")

    rows: list[dict[str, Any]] = []
    for index in range(count):
        base = body + index * record_size
        at = 0
        row: dict[str, Any] = {}
        for column in block.columns:
            kind = definition.columns[column.name].type if column.name in definition.columns else "int"
            values: list[Any] = []
            for _ in range(column.array or 1):
                if kind == "locstring":
                    values.append(text(struct.unpack_from("<I", raw, base + at)[0]))
                    at += LOCALE_SLOTS * WORD
                elif kind == "string":
                    values.append(text(struct.unpack_from("<I", raw, base + at)[0]))
                    at += WORD
                elif kind == "float":
                    values.append(struct.unpack_from("<f", raw, base + at)[0])
                    at += WORD
                else:
                    # Signedness comes from the definition at every width. Tying
                    # it to the full word instead would read a signed narrow
                    # column as a large positive number rather than a negative
                    # one, and only for the values that go negative.
                    width = max((column.width or 32) // 8, 1)
                    values.append(
                        int.from_bytes(raw[base + at : base + at + width], "little", signed=not column.unsigned)
                    )
                    at += width
            row[column.name] = values if column.array else values[0]
        rows.append(row)
    return rows
