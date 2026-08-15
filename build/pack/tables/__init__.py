"""The provider seam: one interface every reader reads game tables through.

A ``Tables`` is one source, not the whole build; the caller wires which one a
route gets. The hotfix overlay and the language a build is read in are both
compositions of two, never flags inside one -- and they are the SAME
composition, because revising a table and restating it in another language
differ only in what each source has to declare about itself.
"""

from __future__ import annotations

from .arrays import array_columns
from .csv_tables import CsvTables
from .db2_tables import Db2Tables
from .hotfixes import hotfix_overlays
from .listfile_tables import ListfileTables
from .locales import locale_overlays, translated_exports
from .overlay import OverlaidTables, Overlay
from .provider import Tables

__all__ = ["CsvTables", "Db2Tables", "ListfileTables", "OverlaidTables", "Overlay",
           "Tables", "array_columns", "hotfix_overlays", "locale_overlays",
           "translated_exports"]
