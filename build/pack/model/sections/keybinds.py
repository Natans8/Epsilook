"""The keys an aura stops working while it holds.

Two sections in the usual pairing: which override each spell suppresses, and
what each override actually is. Kept apart from the mechanics rows because the
payload is a keybinding rather than anything the spell does to a target.
"""

from __future__ import annotations

from ...derive import Reads
from ..registry import register
from ..section import Count, Section, SectionColumns


def spell_keybinds(reads: Reads) -> SectionColumns:
    """Which keybound override an aura suppresses."""
    rows = sorted((spell, override)
                  for spell, overrides in reads.effects.keybinds.ids.items()
                  for override in overrides)
    return {"spellIds": [row[0] for row in rows],
            "overrideIds": [row[1] for row in rows],
            "targets": [reads.effects.keybinds.masks.get(row, 0) for row in rows]}


def keybinds(reads: Reads) -> SectionColumns:
    """Each referenced override's key, its timing word, and what it casts."""
    used = sorted({override for overrides in reads.effects.keybinds.ids.values()
                   for override in overrides})
    return {"ids": used,
            "functions": [reads.keybinds[override].function for override in used],
            # "" is an ordinary press; the other value is the airborne one.
            "whens": [reads.keybinds[override].when for override in used],
            # What retail casts in the key's place. Shipped for a later pass
            # and not displayed, since Epsilon only disables the key.
            "spells": [reads.keybinds[override].spell for override in used]}


SPELL_KEYBINDS = register(Section(
    name="spellKeybinds",
    doc="Which keybound override an aura suppresses while it holds.",
    module="core",
    produce=spell_keybinds,
    columns=("spellIds", "overrideIds", "targets"),
    reads=("effects",),
    counts=(Count("spellKeybinds", lambda columns, _r: len(columns["spellIds"])),),
))

KEYBINDS = register(Section(
    name="keybinds",
    doc="Each suppressed key, when it is suppressed, and what replaces it.",
    module="core",
    produce=keybinds,
    columns=("ids", "functions", "whens", "spells"),
    reads=("effects", "keybinds"),
    counts=(Count("keybinds", lambda columns, _r: len(columns["ids"])),),
))
