"""The client's own database tables, read with their real column names.

The reader the build ships can present a table positionally, which is enough to
inspect one. It is not enough to join five of them: a join written against
column positions is correct only for as long as nobody looks at it, because a
position read off a sample row is a guess that no longer looks like one once it
is written down. Two of the positions recorded for the tables here were wrong.

So this pairs the reader with the published definitions, which name every column
for a given build, and everything downstream joins by name.

Reading these needs the client's storage rather than the public exports: the
whole point is the rows a private client added, and no public copy of a table
has them.
"""

from __future__ import annotations

import struct
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))

import dbd  # noqa: E402  (path set above)
from epsilon_storage import Reads  # noqa: E402
from pack.sources.wdc3 import ColumnSpec, Db2  # noqa: E402
from repo import CACHE, LISTFILE_ASSET  # noqa: E402

DEFINITIONS = CACHE / "dbd"
"""Where parsed table definitions are cached, shared with the other tools."""

LISTFILE = CACHE / "listfile" / LISTFILE_ASSET

CLIENT_BUILD = "9.2.7.45745"
"""The build the client is pinned to, and the one whose column layout applies.

A private client stays on one build indefinitely, so this is a constant rather
than something to resolve: the storage reports the same build every time, and a
definition block is chosen for that build.
"""

_DEFAULT_BITS = {"float": 32, "string": 32, "locstring": 32}
"""Declared width for the kinds a definition does not give one for."""


def schema_for(definition: Any, build: Any) -> list[ColumnSpec] | None:
    """The reader's schema, out of a parsed definition's block for one build.

    Args:
        definition: the parsed definition.
        build: the build to take the column block of.

    Returns:
        The columns in export order, or None if the definition covers no such
        build -- which is the case worth telling apart from a parse failure,
        because it means the table exists but not for this client.
    """
    block = definition.block_for(build) if definition else None
    if block is None:
        return None
    out = []
    for entry in block.columns:
        meaning = definition.columns.get(entry.name)
        kind = meaning.type if meaning else "int"
        out.append(ColumnSpec(name=entry.name, kind=kind,
                              bits=entry.width or _DEFAULT_BITS.get(kind, 32),
                              signed=not entry.unsigned, count=entry.array or 1,
                              is_id=entry.is_id, is_relation=entry.is_relation,
                              in_record=not entry.noninline))
    return out


class Table:
    """One table's rows, addressed by column name."""

    def __init__(self, columns: list[str], rows: list[tuple[str, ...]]) -> None:
        self.columns = columns
        self.rows = rows
        self._at = {name: index for index, name in enumerate(columns)}

    def __len__(self) -> int:
        return len(self.rows)

    def has(self, *names: str) -> bool:
        """Whether every named column is present."""
        return all(name in self._at for name in names)

    def values(self, *names: str) -> Iterator[tuple[str, ...]]:
        """Just the named columns of every row, in the order asked for."""
        wanted = [self._at[name] for name in names]
        for row in self.rows:
            if len(row) > wanted[-1]:
                yield tuple(row[at] for at in wanted)

    def pairs(self, key: str, value: str) -> dict[int, int]:
        """A numeric column mapped to another, which is what a join needs.

        Rows whose either side does not read as a number are dropped rather
        than raising: a table read from a private client carries rows the
        published definition never anticipated.
        """
        found: dict[int, int] = {}
        for left, right in self.values(key, value):
            try:
                found[int(left)] = int(right)
            except ValueError:
                continue
        return found

    def named(self, key: str, value: str) -> dict[int, str]:
        """A numeric column mapped to a text one."""
        found: dict[int, str] = {}
        for left, right in self.values(key, value):
            try:
                found[int(left)] = right
            except ValueError:
                continue
        return found


def table_ids() -> dict[str, int]:
    """Every table's file id, by lowercase table name.

    Read from the community listfile, because a table is a file like any other
    and its name is what the listfile is for.
    """
    found: dict[str, int] = {}
    if not LISTFILE.exists():
        return found
    prefix = "dbfilesclient/"
    with LISTFILE.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            fid, separator, path = line.partition(";")
            name = path.strip().lower()
            if separator and name.startswith(prefix) and name.endswith(".db2"):
                found[name[len(prefix):-len(".db2")]] = int(fid)
    return found


def open_positional(storage: Reads, fid: int) -> Table | None:
    """One table read without its definition, its columns merely numbered.

    For asking what values a table holds rather than what they mean. A
    definition is fetched per table and there are well over a thousand of them,
    so a sweep that only needs the numbers should not be paying for names it
    will not read.

    Returns:
        The table, or None if the client does not carry it or it does not parse.
    """
    raw = storage.read(fid)
    if not raw:
        return None
    try:
        parsed = Db2(raw, None)
        return Table(list(parsed.columns), list(parsed.rows()))
    except (ValueError, IndexError, KeyError, struct.error):
        return None


def open_table(storage: Reads, name: str, ids: dict[str, int]) -> Table | None:
    """One of the client's tables, with its columns named.

    Args:
        storage: the opened storage.
        name: the table's name, as the definitions spell it.
        ids: table name to file id, from `table_ids`.

    Returns:
        The table, or None when the client does not carry it, the definitions
        do not cover this build, or the bytes do not parse. Each of those is a
        reason to skip a route rather than to fail a run, and the caller says
        which it was.
    """
    fid = ids.get(name.lower())
    if fid is None:
        return None
    raw = storage.read(fid)
    if not raw:
        return None
    definition = dbd.load(name, DEFINITIONS)
    schema = schema_for(definition, dbd.parse_build(CLIENT_BUILD))
    if schema is None:
        return None
    try:
        parsed = Db2(raw, schema)
    except (ValueError, IndexError, KeyError):
        return None
    return Table(list(parsed.columns), list(parsed.rows()))
