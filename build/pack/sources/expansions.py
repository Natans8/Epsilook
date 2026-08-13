"""Which expansion introduced a spell.

A checked-in ladder of spell-id ceilings, built once from historical clients by
``tools/expansions.py`` rather than fetched: the builds it reads are archive
material and do not change.
"""

from __future__ import annotations

import gzip
import json
from typing import Any

from .cache import BUILD_DIR

EXPANSIONS_FILE = BUILD_DIR / "expansion_ids.json.gz"


def load_expansions() -> tuple[list[dict[str, Any]], dict[int, int]]:
    """The committed expansion ladder: (rungs oldest-first, {spell id -> rung}).

    Which expansion introduced a spell is recorded by no client table, so it is
    derived once by tools/expansions.py from the original era clients and
    committed — see that script for the sources and their caveats. Frozen
    historical data, so it is READ here and never re-derived, and a missing or
    malformed file is a hard error exactly like load_local_enum.
    """
    with gzip.open(EXPANSIONS_FILE, "rt", encoding="utf-8") as f:
        data = json.load(f)
    rungs: list[dict[str, Any]] = data["ladder"]
    index = {sid: i for i, rung in enumerate(rungs)
             for sid in data["ids"][rung["key"]]}
    return rungs, index

