"""The provider seam: one interface every reader reads game tables through.

A ``Tables`` is ONE SOURCE, not the whole build. A route may be handed several
-- the building pack's own tables, a pinned build's, the distilled TrinityCore
dump -- and the caller wires which. That is what makes the source swappable:
``CsvTables`` today, a SQL provider or a served feed later, with the readers
untouched because they never learn where a row came from.

Composition rather than cases is the rule here. The hotfix overlay is one
source read over another, so it belongs in a provider that wraps two rather
than as a flag inside the one that reads files.
"""

from __future__ import annotations

from .arrays import array_columns
from .csv_tables import CsvTables
from .hotfixes import HOTFIX_OVERLAYS
from .overlay import OverlaidTables, Overlay
from .provider import Tables

__all__ = ["HOTFIX_OVERLAYS", "CsvTables", "OverlaidTables", "Overlay", "Tables",
           "array_columns"]
