"""Key overrides: pressing a game function casts a spell instead.

The Type column is documented nowhere and was decoded from the data. It is a
trigger condition, not a kind of payload: Type 1 is mid-air, Type 0 an ordinary
ground press, and one spell appears as both on the same function.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..tables import Tables
from .columns import to_int

KEYBOUND_TYPE_WORDS = {0: "", 1: "mid-air"}
"""When an override fires. The ordinary press gets no word."""


@dataclass
class KeyboundOverride:
    """One override: pressing `function` casts `spell`, `when` it applies."""

    function: str
    """The game function the key is bound to."""

    when: str
    """The condition the override fires under, empty for the ordinary press."""

    spell: int
    """The spell cast instead. May name a spell this build no longer ships."""


def keybound_type_word(type_id: int) -> str:
    """The word for when an override fires; an unknown type names its number."""
    if type_id in KEYBOUND_TYPE_WORDS:
        return KEYBOUND_TYPE_WORDS[type_id]
    return f"type {type_id}"


def read_keybound_overrides(tables: Tables) -> dict[int, KeyboundOverride]:
    """Read every key override.

    The flags column is not read: absent on two builds, all-zero on most, and
    its nonzero rows carry no recoverable meaning.
    """
    return {
        to_int(override_id): KeyboundOverride(
            function=(function or "").strip(), when=keybound_type_word(to_int(type_id)), spell=to_int(data)
        )
        for override_id, function, type_id, data in tables.rows(
            "SpellKeyboundOverride", ["ID", "Function", "Type", "Data"]
        )
    }
