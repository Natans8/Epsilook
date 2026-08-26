"""Which expansion introduced a spell.

A checked-in ladder of spell-id ceilings, built once from historical clients by
``tools/expansions.py`` rather than fetched.
"""

from __future__ import annotations

import gzip
import json
from typing import Any, TypeAlias

from .cache import BUILD_DIR, tracked_source
from .source import Source

EXPANSIONS_FILE = BUILD_DIR / "expansion_ids.json.gz"

ExpansionLadder: TypeAlias = tuple[list[dict[str, Any]], dict[int, int]]
"""The rungs oldest-first, and the {spell id: rung index} map over them.

Named because the pair travels together from acquisition to every derivation
that dates a spell, and a bare tuple of two containers says nothing at the
call sites it passes through.
"""


def expansions_source() -> Source:
    """The committed ladder: in the checkout, or nowhere.

    No fetch can produce it -- it was derived once from historical clients --
    so acquiring it is the check that it is there.
    """
    return tracked_source("expansion ladder", EXPANSIONS_FILE)


def load_expansions() -> ExpansionLadder:
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
    index = {sid: i for i, rung in enumerate(rungs) for sid in data["ids"][rung["key"]]}
    return rungs, index
