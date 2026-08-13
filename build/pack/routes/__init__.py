"""The readers: one module per route family.

A reader takes the `Tables` it is handed and returns a typed bundle. This is the
INTERPRETIVE half of the build -- dispatch on effect and procedure types, chain
expansion, target-mask resolution, the decode of a column that means one thing
under one enum value and another under the next. It is the half a relational
engine is worst at, which is why the routes are Python over a provider rather
than views over a database.

⛔ A ROUTE NEVER LEARNS WHERE A ROW CAME FROM OR WHAT SHIPS. No file paths, no
URLs, no emitters -- the path rule in `tools/check.py` enforces it. That is what
makes the source swappable and the artifact reshapeable without editing a
reader, and it is why the layer can be tested against a directory of three-row
CSVs.

`docs/DATA_ROUTES.md` documents what each route MEANS; these modules are how it
is read.
"""

from __future__ import annotations

from .names import SpellNames, read_override_names, read_spell_names
from .text import SpellText, read_spell_text
from .visuals import VisualGraph, read_visual_graph

__all__ = [
    "SpellNames",
    "SpellText",
    "VisualGraph",
    "read_override_names",
    "read_spell_names",
    "read_spell_text",
    "read_visual_graph",
]
