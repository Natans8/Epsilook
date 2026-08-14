"""The ``Build`` value: what one game version is to the code."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Line(Enum):
    """The distribution line a build ships on.

    Decides the wago product, TDB availability, freshness tracking and the
    external link flavour.
    """

    RETAIL = "retail"
    CLASSIC = "classic"
    PTR = "ptr"


@dataclass(frozen=True)
class Build:
    """One game build, constructed from its roster row once sources are probed.

    The engine generation -- which shape the tables arrive in -- is
    deliberately not a field; add it when its second value exists.
    """

    key: str
    """Roster key, e.g. ``"9.2.7"``."""

    version: str
    """Full build id, e.g. ``"9.2.7.45745"``."""

    patch: str
    """The patch triple, e.g. ``"9.2.7"``."""

    rung: int
    """Content rung: which expansion's spells exist, and the era ceiling."""

    line: Line
    """Retail, Classic re-release, or PTR."""

    tdb: str | None
    """The matched TDB release tag; ``None`` when the build ships without one."""

    absent_tables: frozenset[str]
    """Declared-optional tables this build predates, shipped in
    ``meta.absentTables``."""
