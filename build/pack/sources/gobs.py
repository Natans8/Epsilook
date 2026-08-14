"""The vendored map from a model file to the object that places it in the world.

Read from Epsilon's own client rather than from any game table, and vendored
because no build can regenerate it: the ids are Epsilon's, not Blizzard's.
Regenerating it needs the client, which is why the file is tracked.
"""

from __future__ import annotations

import csv
import gzip
import sys

from .cache import BUILD_DIR

GOB_DISPLAYS = BUILD_DIR / "sources" / "epsilon-gameobject-displays.csv.gz"
"""The vendored table, one row per model file that has an object."""

GOB_FLOOR = 100_000
"""Fewest rows a readable copy has.

The file is vendored, so a short read is a corrupt or truncated checkout rather
than a build that legitimately finds less -- and a route that silently shipped
a hundred rows instead of twelve thousand would look like a working build of an
emptier game.
"""


def read_gob_displays() -> dict[int, int]:
    """Model file id -> the id `.gob spawn` takes to place that model.

    The command reads the SIGN: a positive number is a `gameobject_template`
    entry, a negative one is a `GameObjectDisplayInfo` id. The vendored table
    holds display ids as the client stores them, positive, so they are negated
    here and the pack carries the value a player pastes -- a positive id would
    silently name a different object.

    Raises:
        SystemExit: the file is absent or reads short. Every pack ships this
            route, so there is no build for which absence is an answer.
    """
    displays: dict[int, int] = {}
    if not GOB_DISPLAYS.exists():
        sys.exit(f"error: {GOB_DISPLAYS} is missing; it is a tracked file")
    with gzip.open(GOB_DISPLAYS, "rt", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            fid, display = int(row["fid"] or 0), int(row["display"] or 0)
            if fid and display:
                displays[fid] = -display
    if len(displays) < GOB_FLOOR:
        sys.exit(f"error: {GOB_DISPLAYS.name} parsed as {len(displays):,} rows, "
                 f"under the {GOB_FLOOR:,} a readable copy has")
    return displays
