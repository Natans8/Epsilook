"""The provider seam: one interface every reader reads game tables through.

A ``Tables`` is one source, not the whole build; the caller wires which one a
route gets. The hotfix overlay is a composition of two, never a flag inside
one.
"""

from __future__ import annotations

from .arrays import array_columns
from .csv_tables import CsvTables
from .hotfixes import hotfix_overlays
from .listfile_tables import ListfileTables
from .overlay import OverlaidTables, Overlay
from .provider import Tables

__all__ = ["CsvTables", "ListfileTables", "OverlaidTables", "Overlay",
           "Tables", "array_columns", "hotfix_overlays"]
