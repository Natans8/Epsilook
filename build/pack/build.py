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

    Constructed once per pack build and passed down, replacing per-build
    facts previously looked up in scattered module-level tables keyed on
    different things.

    The engine generation -- which shape the tables arrive in -- is
    deliberately not a field: every buildable pack is the post-7.0
    generation, and a second generation would be served by a ``tables/``
    projection, not a reader branch. Add the field when its second value
    exists.
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
    """The matched TDB release tag; ``None`` means the build ships without
    one and every route needing it degrades as declared."""

    absent_tables: frozenset[str]
    """Declared-optional tables this build predates, probed at source time
    and shipped in ``meta.absentTables``."""
