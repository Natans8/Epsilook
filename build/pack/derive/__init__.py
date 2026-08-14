"""The one graph walk and every cross-route derivation.

Anything that spans routes -- the spell to visual to kit walk, the icon index --
is computed here once and handed to every section through the shared
`DeriveContext`.

The layer reads no game table. A route's input is the source; this layer's
input is what the routes produced, which is what keeps the split meaningful and
makes every derivation here testable from plain values with no source at all.
"""

from __future__ import annotations

from .context import CONTEXT_FIELDS, DeriveContext, Reads
from .displays import Display, ResolvedDisplays, resolve_displays
from .icons import NO_ICON, IconIndex, build_icon_index
from .prose import CookedText, cook_text
from .references import References, collect_references
from .walk import KIT_BUCKETS, SpellVisuals, walk_spells

__all__ = [
    "CONTEXT_FIELDS",
    "KIT_BUCKETS",
    "NO_ICON",
    "CookedText",
    "DeriveContext",
    "Display",
    "IconIndex",
    "Reads",
    "References",
    "ResolvedDisplays",
    "SpellVisuals",
    "build_icon_index",
    "collect_references",
    "cook_text",
    "resolve_displays",
    "walk_spells",
]
