"""Building a source for a route to read.

A route may not name a file, so its tests need somewhere to put the rows it
should read. This writes them as CSVs and hands back a real `CsvTables`, which
keeps the tests honest -- they exercise the same provider the build uses rather
than a stand-in that agrees with the route by construction.
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

    Written as text rather than as rows so a test reads like the CSV the build
    actually meets, quoting and empty cells included.

    Each call gets its OWN directory, so a test can build the two sources a
    route is handed -- the client tables and the server dump -- without the
    second overwriting the first. `absent` and `defaults` carry that source's
    own drift declarations, which is what lets a dump be served under the
    server-side ones rather than the client's.
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
