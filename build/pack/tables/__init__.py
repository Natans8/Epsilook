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
from .hotfixes import hotfix_overlays
from .listfile_tables import ListfileTables, supplement_overlay
from .locales import locale_overlays, translated_exports
from .overlay import OverlaidTables, Overlay
from .provider import Provider, Tables
from .sql_tables import SqlTables

__all__ = ["CsvTables", "ListfileTables", "OverlaidTables", "Overlay",
           "Provider", "SqlTables", "Tables", "array_columns",
           "hotfix_overlays", "locale_overlays", "supplement_overlay",
           "translated_exports"]
