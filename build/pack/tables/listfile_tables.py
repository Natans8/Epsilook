"""The listfile served as a table, because that is what it is.

`SpellName` maps a name to a spell id; the listfile maps a name to a file id.
Nothing about it is a different kind of thing, so it arrives through the same
seam as every game table and is supplemented by the same merge -- an asset-name
supplement is an `Overlay` with a rule, not a second mechanism.

The one difference from `CsvTables` is the format, which is why this is its own
provider rather than a directory of CSVs: rows are `<file id>;<path>`,
semicolon-separated, with no header line to read the column names from.
"""

from __future__ import annotations

import gzip
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import IO

from ..supplements import above
from .overlay import Overlay

TABLE = "Listfile"
"""The one table this provider serves. Declared once so the provider and the
overlay that supplements it cannot disagree about the name."""

ID = "FileDataID"
PATH = "Path"
COLUMNS = (ID, PATH)
"""Column names for a format that carries none of its own."""


def supplement_overlay(floor: int) -> dict[str, Overlay]:
    """The asset-name supplement, as an overlay on the listfile.

    An `Overlay` with a rule rather than a second mechanism: the supplement is
    a second source of the same two columns, admitted only above the id space
    a private client allocates its own assets from. Confined that way it can
    add a name the community list has not got and can never replace one it has,
    whatever either file grows to.

    It adds rather than restates, because a row the community list lacks is
    exactly what it is for.
    """
    return {TABLE: Overlay(table=TABLE, key=ID, judged_on=ID,
                           admits=above(floor))}


class ListfileTables:
    """One listfile, presented row-wise as text.

    Serves exactly one table. Asking for another is a wiring mistake rather
    than an absence, so it fails loudly the way an undeclared missing CSV does.
    """

    def __init__(self, path: Path) -> None:
        """Serve the listfile at `path`, gzipped or plain."""
        self.path = path

    def _open(self) -> IO[str]:
        """The file as text, decompressing a vendored copy on the way.

        A downloaded listfile is plain and a vendored one is compressed, because
        one is cached and the other is tracked and wants to stay small. Which it
        is follows from the suffix rather than from a flag, so a caller never
        chooses.
        """
        if self.path.suffix == ".gz":
            return gzip.open(self.path, "rt", encoding="utf-8", errors="replace",
                             newline="")
        # `newline=""` on purpose: without it a lone carriage return counts as a
        # line terminator, so a path carrying one would be split into a
        # truncated row that still looks like a real name and a remainder that
        # is silently skipped.
        return self.path.open(newline="", encoding="utf-8", errors="replace")

    def available(self, table: str) -> bool:
        """Whether this is the table served, and its file is there."""
        return table == TABLE and self.path.exists()

    def header(self, table: str) -> list[str]:
        """The synthetic column names; empty when the table is not served."""
        return list(COLUMNS) if self.available(table) else []

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, in file order.

        Only the line terminator is removed. A field's own surrounding
        whitespace is the source's, and the provider contract is to hand back
        what the source says -- the route that shows a name is where it gets
        trimmed.

        A row whose separator is missing is skipped rather than fatal: the
        listfile is a community artifact that has carried stray blank lines,
        and one unreadable line is not a truncated download.
        """
        if table != TABLE:
            sys.exit(f"error: {type(self).__name__} serves only {TABLE!r}, "
                     f"and was asked for {table!r}")
        if not self.path.exists():
            sys.exit(f"error: the listfile is missing from {self.path}")

        index = []
        for column in columns:
            if column not in COLUMNS:
                sys.exit(f"error: the listfile has no column {column!r}; "
                         f"it carries {list(COLUMNS)}")
            index.append(COLUMNS.index(column))

        # This is the largest read in the build -- some two million rows per
        # pack -- and building the projection per row through a generator costs
        # more than the rest of the read put together. Both orders of the only
        # two columns there are get it hoisted out of the loop instead.
        forward = index == [0, 1]
        reverse = index == [1, 0]

        with self._open() as handle:
            for line in handle:
                fid, separator, asset = line.rstrip("\r\n").partition(";")
                if not separator:
                    continue
                if forward:
                    yield fid, asset
                elif reverse:
                    yield asset, fid
                else:
                    cells = (fid, asset)
                    yield tuple(cells[position] for position in index)
