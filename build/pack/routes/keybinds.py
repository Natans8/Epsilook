"""Key overrides: pressing a game function casts a spell instead.

The Type column is documented nowhere and was decoded from the data. The
definition carries no comment and the wiki's page is a two-field stub, so the
evidence is what names it: every Type-1 row is the jump function on every build
that has the table, and every Type-1 spell is a mid-air ability while every
Type-0 spell replaces an ordinary ground press. The decisive row is a spell that
appears as BOTH types on the SAME function -- one payload, two rows -- which
makes Type a trigger CONDITION rather than a kind of payload.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..tables import Tables
from .columns import to_int

KEYBOUND_TYPE_WORDS = {0: "", 1: "mid-air"}
"""When an override fires. The ordinary press gets no word, because naming the
default would put a label on almost every row and distinguish nothing."""


@dataclass
class KeyboundOverride:
    """One override: pressing `function` casts `spell`, `when` it applies."""

    function: str
    """The game function the key is bound to."""

    when: str
    """The condition the override fires under, empty for the ordinary press."""

    spell: int
    """The spell cast instead.

    May name a spell this build no longer ships, and is kept either way so the
    pill can still show the id it points at.
    """


def keybound_type_word(type_id: int) -> str:
    """The word for when an override fires.

    An unknown future type falls back to naming its number rather than being
    guessed at -- the same rule an out-of-range seat attachment follows.
    """
    if type_id in KEYBOUND_TYPE_WORDS:
        return KEYBOUND_TYPE_WORDS[type_id]
    return f"type {type_id}"


def read_keybound_overrides(tables: Tables) -> dict[int, KeyboundOverride]:
    """Read every key override.

    The flags column is deliberately not read: it is absent on two builds,
    all-zero on most, and its handful of nonzero rows carry no recoverable
    meaning. Reading it would buy a drift declaration and nothing else.
    """
    return {to_int(override_id): KeyboundOverride(
        function=(function or "").strip(),
        when=keybound_type_word(to_int(type_id)),
        spell=to_int(data))
        for override_id, function, type_id, data in tables.rows(
            "SpellKeyboundOverride", ["ID", "Function", "Type", "Data"])}
