"""The keys an aura stops working while it holds.

What each suppressed override actually is. Which spell suppresses it is a thing
the spell does, so those rows are in the mech column; this is what the number
one of them stores resolves to.
"""

from __future__ import annotations

from ...derive import Reads
from ..registry import register
from ..section import (Section, SectionColumns, size)


def keybinds(reads: Reads) -> SectionColumns:
    """Each referenced override's key, its timing word, and what it casts."""
    used = reads.effects.keybinds.distinct()
    rows = [reads.keybinds[override] for override in used]
    return {"ids": used,
            "functions": [row.function for row in rows],
            # "" is an ordinary press; the other value is the airborne one.
            "whens": [row.when for row in rows],
            # The two above as the one string a row names the key by. Cooked
            # here rather than joined by each reader, because a key and when it
            # applies are one answer to "which key" and two readers joining
            # them their own way is two spellings of it.
            "keys": [f"{row.function} {row.when}".strip() for row in rows],
            # What retail casts in the key's place. Shipped for a later pass
            # and not displayed, since Epsilon only disables the key.
            "spells": [row.spell for row in rows]}


KEYBINDS = register(Section(
    name="keybinds",
    doc="Each suppressed key, when it is suppressed, and what replaces it.",
    module="core",
    produce=keybinds,
    columns=("ids", "functions", "whens", "keys", "spells"),
    reads=("effects", "keybinds"),
    needs=("SpellKeyboundOverride",),
    counts=(size("keybinds", "ids"),),
))
