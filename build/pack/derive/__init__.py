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
from .icons import NO_ICON, IconIndex, build_icon_index, build_item_icons, icon_name
from .kinds import (COLUMN_FAMILIES, VOCABULARIES, ColumnRows, Family,
                    build_column)
from .prose import CookedText, cook_text
from .references import References, collect_references
from .rows import (PackRows, boneset_rows, build_rows, color_rows, id_rows,
                   masked_rows, replacement_rows, spell_role_rows, spell_rows)
from .walk import KIT_BUCKETS, SpellVisuals, walk_spells

__all__ = [
    "COLUMN_FAMILIES",
    "CONTEXT_FIELDS",
    "KIT_BUCKETS",
    "NO_ICON",
    "VOCABULARIES",
    "ColumnRows",
    "CookedText",
    "DeriveContext",
    "Display",
    "Family",
    "IconIndex",
    "PackRows",
    "Reads",
    "References",
    "ResolvedDisplays",
    "SpellVisuals",
    "boneset_rows",
    "build_column",
    "build_icon_index",
    "build_item_icons",
    "build_rows",
    "color_rows",
    "collect_references",
    "cook_text",
    "icon_name",
    "id_rows",
    "masked_rows",
    "replacement_rows",
    "resolve_displays",
    "spell_role_rows",
    "spell_rows",
    "walk_spells",
]
