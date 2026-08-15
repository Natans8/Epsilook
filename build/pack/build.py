"""The ``Build`` value: what one game version is to the code."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Build:
    """One game build, constructed from its roster row once sources are probed.

    The engine generation -- which shape the tables arrive in -- and the
    distribution line are deliberately not fields; add one when its second
    value exists.
    """

    version: str
    """Full build id, e.g. ``"9.2.7.45745"``."""

    patch: str
    """The patch triple, e.g. ``"9.2.7"``."""

    tdb: str | None = None
    """The matched TDB release tag; ``None`` when the build ships without one."""

    absent_tables: frozenset[str] = frozenset()
    """Declared-optional tables this build predates, shipped in
    ``meta.absentTables``."""

    max_level: int = 0
    """The level cap this build's expansion shipped with.

    What a description's level-dependent placeholders are resolved at, since a
    tooltip's caster is nobody in particular here and the level a reader cares
    about is the one they play at. Zero means no rung claimed the build, and
    the cooker elides rather than inventing a level.
    """
