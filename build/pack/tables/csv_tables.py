"""Tables served from the CSV files acquisition left in the cache."""

from __future__ import annotations

import csv
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

from ..drift import OPTIONAL_COLUMNS, OPTIONAL_TABLES

csv.field_size_limit(10_000_000)


class CsvTables:
    """One directory of `<table>.csv` files, presented row-wise as text.

    The provider the build has always effectively used, now behind the seam.
    It serves ONE source: the build's own tables, a pinned build's, or the
    distilled TrinityCore dump are three instances rather than three cases.

    Values come back as the source's own text, unparsed. That is not laziness:
    typing here would make two providers over the same source disagree in the
    low-order digits of a float, and the routes are what decide a column's
    type anyway.
    """

    def __init__(self, directory: Path, *,
                 absent_tables: dict[str, str] | None = None,
                 defaults: dict[tuple[str, str], str] | None = None) -> None:
        """Serve the CSVs in `directory`.

        `absent_tables` names the tables a build may legitimately lack, and
        `defaults` the columns it may lack with the value to stand in. Both
        default to the build-wide drift declarations; a test or a second
        source passes its own.
        """
        self.directory = directory
        self.absent_tables = OPTIONAL_TABLES if absent_tables is None else absent_tables
        self.defaults = OPTIONAL_COLUMNS if defaults is None else defaults

    def path_of(self, table: str) -> Path:
        """Where a table's file would be, whether or not it exists."""
        return self.directory / f"{table}.csv"

    def available(self, table: str) -> bool:
        """Whether this source has the table at all."""
        return self.path_of(table).exists()

    def header(self, table: str) -> list[str]:
        """The table's column names, in source order; empty when it is absent."""
        if not self.available(table):
            return []
        with self.path_of(table).open(newline="", encoding="utf-8") as handle:
            return next(csv.reader(handle), [])

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, in file order.

        A declared-absent table yields nothing, so the section it feeds comes
        out empty and its feature switches itself off. A declared-optional
        column yields its stand-in value. A column that is missing without
        being declared is a hard error: silently dropping data is the one
        outcome worth crashing over.
        """
        path = self.path_of(table)
        if not path.exists():
            if table in self.absent_tables:
                return
            sys.exit(f"error: {table}.csv is missing from {self.directory} and it is "
                     f"not declared optional")
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.reader(handle)
            header = next(reader)
            index: list[int | None] = []
            for column in columns:
                if column in header:
                    index.append(header.index(column))
                elif (table, column) in self.defaults:
                    index.append(None)
                else:
                    sys.exit(f"error: {table}.csv is missing column {column!r} and it is "
                             f"not declared in OPTIONAL_COLUMNS; header = {header}")
            stand_ins = [self.defaults.get((table, column), "") for column in columns]
            for row in reader:
                yield tuple(row[i] if i is not None else stand_in
                            for i, stand_in in zip(index, stand_ins))
