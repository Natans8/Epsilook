"""What removes an aura once it is on you, as words.

`SpellInterrupts.AuraInterruptFlags` is two words of bits, each bit an event
that cancels the aura: moving, mounting, entering water, shapeshifting. The
enum behind it is the channel's, not the cast's, and it is vendored. Two bits
are housekeeping the client sets on most auras -- leaving or entering the
world cancels almost anything -- and they are not words a reader means, so
they are left out here rather than by every reader of the column.
"""

from __future__ import annotations

from ..sources import load_local_enum
from .attributes import bit_test, carries
from .columns import to_int
from .flow import Cell, values_of

AURA_INTERRUPT_ENUM = "spell_interrupt_flags"
"""The vendored enum naming each bit; its `label` is the word the pack prints."""

HOUSEKEEPING = frozenset({19, 22})
"""Leaving the world and entering it, which cancel most auras and say nothing."""


def interrupt_bits(cell: Cell) -> tuple[int, ...]:
    """The named bits a spell's interrupt words carry, ascending."""
    words = tuple(to_int(value) for value in values_of(cell))
    return tuple(bit for bit in interrupt_words() if carries(words, bit_test(bit)))


def interrupt_words() -> dict[int, str]:
    """Bit -> the word the pack prints for it, housekeeping left out."""
    return {
        bit: str(record["label"])
        for bit, record in load_local_enum(AURA_INTERRUPT_ENUM).items()
        if isinstance(record, dict) and record.get("label") and bit not in HOUSEKEEPING
    }
