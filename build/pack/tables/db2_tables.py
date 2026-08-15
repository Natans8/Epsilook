"""A `Tables` over a client's own db2 files, read straight out of its storage.

Every other provider reads a CSV somebody exported. This one reads the game's
binary tables where they live, which is the only way to pack a client whose
tables no public export carries -- a private server's own build.

Columns are addressed by NAME, which is why this needs the published
definitions and not just the reader: a join written against column positions is
correct only until somebody looks at it, and two positions recorded from sample
rows have already turned out wrong. The definitions come from `sources/dbd`.

Values come back as text, because that is the contract every route reads
through. The reader hands back typed values, so this is the one place the two
disagree, and stringifying here keeps a route indifferent to which provider it
was handed.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Protocol

from ..progress import log
from ..sources import dbd
from ..sources.wdc3 import Db2


class Storage(Protocol):
    """The one thing this needs of a client's storage: bytes for a file id.

    Narrower than any real storage on purpose -- stated this way a test hands
    over a dict of bytes instead of standing up a CASC and a network service.
    """

    def read(self, file_id: int, *, local_only: bool = False) -> bytes | None:
        """One file's decoded bytes, or None when the client lacks it."""


class Db2Tables:
    """The client's own tables, named by the published definitions.

    A table is read once and held: the routes read most tables several times,
    and a db2 costs a storage fetch plus a full decode where a re-read of an
    already-decoded table costs nothing.

    Absence is not an error here. A private client carries tables the
    definitions never anticipated and lacks ones they describe, so a table that
    cannot be read reports itself unavailable and the sections that need it
    switch off -- which is the same answer an older build gives for a table
    that did not exist yet.
    """

    def __init__(self, storage: Storage, ids: dict[str, int], build: str,
                 definitions: Path) -> None:
        """Wire a provider over one client's storage.

        Args:
            storage: anything answering `read(file_id)` with bytes or None.
            ids: table name (lowercased) to file id, from the listfile.
            build: the client's build id, which picks the definition block.
            definitions: where parsed definitions are cached.
        """
        self._storage = storage
        self._ids = ids
        self._build = dbd.parse_build(build)
        self._definitions = definitions
        self._read: dict[str, tuple[list[str], list[tuple[str, ...]]] | None] = {}

    def _table(self, table: str) -> tuple[list[str], list[tuple[str, ...]]] | None:
        """One decoded table, or None if this client cannot supply it."""
        key = table.lower()
        if key in self._read:
            return self._read[key]

        self._read[key] = None
        fid = self._ids.get(key)
        if fid is None:
            return None
        raw = self._storage.read(fid)
        if not raw:
            return None
        schema = dbd.schema_for(dbd.load(table, self._definitions), self._build)
        if schema is None:
            log(f"  {table}: no definition block for this build")
            return None
        try:
            parsed = Db2(raw, schema)
            decoded = (list(parsed.columns),
                       [tuple("" if value is None else str(value) for value in row)
                        for row in parsed.rows()])
        except (ValueError, IndexError, KeyError, struct.error) as exc:
            log(f"  {table}: does not decode ({type(exc).__name__})")
            return None
        self._read[key] = decoded
        return decoded

    def available(self, table: str) -> bool:
        """Whether this client has the named table at all."""
        return self._table(table) is not None

    def header(self, table: str) -> list[str]:
        """The table's column names, in export order."""
        decoded = self._table(table)
        return list(decoded[0]) if decoded else []

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, in file order.

        A row too short to carry the last column asked for is skipped rather
        than padded: a short row means the schema and the bytes disagree, and
        inventing an empty value would put that disagreement into the pack.
        """
        decoded = self._table(table)
        if not decoded:
            return
        names, body = decoded
        at = {name: index for index, name in enumerate(names)}
        missing = [name for name in columns if name not in at]
        if missing:
            raise KeyError(f"{table} has no column {', '.join(missing)}")
        wanted = [at[name] for name in columns]
        limit = max(wanted)
        for row in body:
            if len(row) > limit:
                yield tuple(row[index] for index in wanted)
