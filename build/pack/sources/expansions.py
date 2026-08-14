"""Which expansion introduced a spell.

A checked-in ladder of spell-id ceilings, built once from historical clients by
``tools/expansions.py`` rather than fetched.
"""

from __future__ import annotations

import gzip
import json
from typing import Any

from .cache import BUILD_DIR, tracked_source
from .source import Source

EXPANSIONS_FILE = BUILD_DIR / "expansion_ids.json.gz"


def expansions_source() -> Source:
    """The committed ladder: in the checkout, or nowhere.

    No fetch can produce it -- it was derived once from historical clients --
    so acquiring it is the check that it is there.
    """
    return tracked_source("expansion ladder", EXPANSIONS_FILE)


def load_expansions() -> tuple[list[dict[str, Any]], dict[int, int]]:
    """Load the committed expansion ladder.

    No client table records which expansion introduced a spell; see
    tools/expansions.py for the sources it was derived from. A missing or
    malformed file is a hard error.

    Returns:
        The rungs oldest-first, and a {spell id: rung index} map.
    """
    with gzip.open(EXPANSIONS_FILE, "rt", encoding="utf-8") as f:
        data = json.load(f)
    rungs: list[dict[str, Any]] = data["ladder"]
    index = {sid: i for i, rung in enumerate(rungs)
             for sid in data["ids"][rung["key"]]}
    return rungs, index

