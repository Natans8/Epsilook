"""Decoding a spell's `Attributes` bit array into the flags the pack ships.

Which flags ship is declared in `enums/spell_attributes.json`, not here: a bit
ships when it carries a `handler` tag, so adding one is a data edit and a pill
type. Some bits mean nothing on their own and declare a `requires` bit they are
read in conjunction with.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence

from ..sources import load_local_enum

WORD_BITS = 32
"""Width of one `Attributes_N` column."""


def attribute_bit(words: Sequence[int], bit: int) -> bool:
    """Whether one flag is set in a spell's attribute array.

    Bit `B` lives in column `B // 32` at `1 << (B % 32)`. An array shorter than
    that column means the build predates the flag, which reads as unset.

    Args:
        words: the spell's raw attribute words.
        bit: the flag's bit number.

    Returns:
        True when the flag is set.
    """
    column, offset = divmod(bit, WORD_BITS)
    return column < len(words) and bool(words[column] & (1 << offset))


def shipped_attributes() -> dict[int, Mapping[str, object]]:
    """The declared flags, keyed by bit.

    Returns:
        Bit to its declaration, for the bits tagged with a handler.

    Raises:
        SystemExit: if nothing is tagged, which would ship the family empty.
    """
    declared = load_local_enum("spell_attributes")
    shipped: dict[int, Mapping[str, object]] = {
        bit: meta for bit, meta in declared.items()
        if isinstance(meta, dict) and meta.get("handler")}
    if not shipped:
        sys.exit("error: spell_attributes.json declares no handler "
                 "- nothing to ship")
    return shipped


def read_spell_attributes(
        attribute_words: Mapping[int, Sequence[int]]) -> dict[str, list[int]]:
    """Group spells by the declared attribute flags they carry.

    Counts spells rather than `SpellMisc` rows, since the words arrive already
    resolved to one array per spell.

    Args:
        attribute_words: spell to its raw attribute words.

    Returns:
        Handler name to the sorted spells carrying that flag.
    """
    out: dict[str, list[int]] = {}
    for bit, meta in sorted(shipped_attributes().items()):
        # A `requires` bit is an intersection, not a second flag: the bit alone
        # samples spells the word would be false of.
        declared = meta.get("requires")
        required = None if declared is None else int(str(declared))
        out[str(meta["handler"])] = sorted(
            spell for spell, words in attribute_words.items()
            if attribute_bit(words, bit)
            and (required is None or attribute_bit(words, required)))
    return out
