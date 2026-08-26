"""Tables served from the CSV files acquisition left in the cache."""

from __future__ import annotations

import csv
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

from ..drift import OPTIONAL_COLUMNS, OPTIONAL_TABLES
from .projection import absent, project

csv.field_size_limit(10_000_000)


class CsvTables:
    """One directory of `<table>.csv` files, presented row-wise as text.

    Values come back as the source's own text: typing here would make two
    providers over the same source disagree in a float's low-order digits.
    """

    def __init__(
        self,
        directory: Path,
        *,
        absent_tables: dict[str, str] | None = None,
        defaults: dict[tuple[str, str], str] | None = None,
    ) -> None:
        """Serve the CSVs in `directory`.

        `absent_tables` and `defaults` fall back to the build-wide drift
        declarations; a test or a second source passes its own.
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

        A declared-absent table yields nothing and a declared-optional column
        yields its stand-in; anything undeclared exits. A file with no header
        is a truncated download rather than an absence, and exits too.
        """
        path = self.path_of(table)
        if not path.exists():
            absent(table, self.absent_tables, self.directory)
            return
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.reader(handle)
            header = next(reader, None)
            if header is None:
                sys.exit(
                    f"error: {table}.csv in {self.directory} is empty; it has no "
                    f"header row, so the cached copy is incomplete"
                )
            plan = project(table, header, columns, defaults=self.defaults)
            index = [header.index(source) if source is not None else None for source in plan.sources]
            stand_ins = plan.stand_ins
            width = len(header)
            for row in reader:
                # A row narrower than the header is a truncated file, and
                # indexing it would raise naming neither the table nor where it
                # came from. Every other failure here says both.
                if len(row) < width:
                    sys.exit(
                        f"error: {table}.csv in {self.directory} has a row "
                        f"of {len(row)} fields against a {width}-column "
                        f"header; the cached copy is truncated"
                    )
                yield tuple(row[i] if i is not None else stand_in for i, stand_in in zip(index, stand_ins))
