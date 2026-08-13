"""Everything one build reads, gathered into the cache and named.

The single entry point to this layer. Above it nothing knows a URL, a cache
policy or a file name -- a table provider is handed a `Sources` and reads
through it.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .enums import fetch_enum_names
from .listfile import fetch_listfile
from .tdb import fetch_tdb
from .wago import fetch_tables


@dataclass(frozen=True)
class Sources:
    """Where one build's sources ended up on disk.

    Four independent sources rather than one merged directory, because they
    disagree on purpose: `pinned_tables` is another build's, and `tdb` holds
    rows that override `tables` by row id.
    """

    tables: Path
    """This build's own table CSVs, one file per db2 table."""

    pinned_tables: Path
    """The build sound-kit names are read from, which is never the one being
    packed: no shipped build carries that table."""

    listfile: Path
    """The community listfile: file data id to asset path."""

    tdb: Path | None
    """The distilled TrinityCore tables, or None when no release maps to this
    build. Four Classic packs ship without one and say so."""


def fetch_sources(version: str, refresh: bool) -> Sources:
    """Ensure every source this build needs is cached, and say where it is."""
    tables, pinned_tables = fetch_tables(version, refresh)
    fetch_enum_names()
    listfile = fetch_listfile(refresh)
    return Sources(tables=tables, pinned_tables=pinned_tables,
                   listfile=listfile, tdb=fetch_tdb(version))
