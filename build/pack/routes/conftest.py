"""Building a source for a route to read.

A route may not name a file, so its tests write rows as CSVs and read them back
through a real `CsvTables` rather than a stand-in.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable
from pathlib import Path

import pytest

from ..tables import CsvTables

BuildTables = Callable[..., CsvTables]


@pytest.fixture(name="tables")
def _tables(tmp_path: Path) -> BuildTables:
    """A factory taking `Table="header,row\\n..."` and serving those tables.

    Each call gets its own directory, so one test can build both sources a
    route is handed -- the client tables and the server dump. `absent` and
    `defaults` carry that source's own drift declarations.
    """
    sources = itertools.count()

    def build(*, absent: dict[str, str] | None = None,
              defaults: dict[tuple[str, str], str] | None = None,
              **csvs: str) -> CsvTables:
        directory = tmp_path / f"source{next(sources)}"
        directory.mkdir()
        for table, text in csvs.items():
            (directory / f"{table}.csv").write_text(text, encoding="utf-8", newline="")
        return CsvTables(directory, absent_tables=absent, defaults=defaults)

    return build
