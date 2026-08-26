"""Every section the build ships, declared.

Imported for the registration side effects: a module here calls `register` at
import time, so the registry is populated by importing this package and the
import ORDER is the artifact's key order. That is the same pattern the
frontend's pill types use, and it is why adding a section is one record in one
of these modules rather than an edit to a list somewhere else.
"""

from __future__ import annotations

from . import (
    anims,
    assets,
    entities,
    expansions,
    fx,
    gates,
    keybinds,
    links,
    mechanics,
    models,
    modifiers,
    rows,
    screens,
    sounds,
    spells,
    text,
    vehicles,
)

__all__ = [
    "anims",
    "assets",
    "entities",
    "expansions",
    "fx",
    "gates",
    "keybinds",
    "links",
    "mechanics",
    "models",
    "modifiers",
    "rows",
    "screens",
    "sounds",
    "spells",
    "text",
    "vehicles",
]
