"""Building a source for a route to read.

A route may not name a file, so its tests need somewhere to put the rows it
should read. This writes them as CSVs and hands back a real `CsvTables`, which
keeps the tests honest -- they exercise the same provider the build uses rather
than a stand-in that agrees with the route by construction.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from ..tables import CsvTables

BuildTables = Callable[..., CsvTables]


@pytest.fixture(name="tables")
def _tables(tmp_path: Path) -> BuildTables:
    """A factory taking `Table="header,row\\n..."` and serving those tables.

    Written as text rather than as rows so a test reads like the CSV the build
    actually meets, quoting and empty cells included.
    """

    def build(**csvs: str) -> CsvTables:
        for table, text in csvs.items():
            (tmp_path / f"{table}.csv").write_text(text, encoding="utf-8", newline="")
        return CsvTables(tmp_path)

    return build
