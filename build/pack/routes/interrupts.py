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
from ..tables import Tables, array_columns
from .attributes import bit_test, carries
from .columns import BASE_DIFFICULTY, to_int
from .route import route
from .spells import SpellProperties

AURA_INTERRUPT_ENUM = "spell_interrupt_flags"
"""The vendored enum naming each bit; its `label` is the word the pack prints."""

HOUSEKEEPING = frozenset({19, 22})
"""Leaving the world and entering it, which cancel most auras and say nothing."""

INTERRUPT_COLUMNS_MAX = 4
"""Upper bound when probing for `SpellInterrupts.AuraInterruptFlags_N`."""


def interrupt_words() -> dict[int, str]:
    """Bit -> the word the pack prints for it, housekeeping left out."""
    return {
        bit: str(record["label"])
        for bit, record in load_local_enum(AURA_INTERRUPT_ENUM).items()
        if isinstance(record, dict) and record.get("label") and bit not in HOUSEKEEPING
    }


@route("aura_interrupts", spells="props")
def read_aura_interrupts(tables: Tables, spells: SpellProperties) -> dict[int, tuple[int, ...]]:
    """Spell -> the events that remove its aura, as enum bits, ascending.

    The base difficulty's row is the spell's answer where it has one, and a
    spell carrying only housekeeping bits is absent rather than empty. The
    table is declared optional, so a build without it reads nothing.

    Args:
        tables: the source to read from.
        spells: the build's spells; rows for anything absent are skipped.
    """
    if not tables.available("SpellInterrupts"):
        return {}
    tests = {bit: bit_test(bit) for bit in interrupt_words()}
    columns = array_columns(tables, "SpellInterrupts", "AuraInterruptFlags", INTERRUPT_COLUMNS_MAX)
    found: dict[int, tuple[int, ...]] = {}
    seen_base: set[int] = set()
    for row in tables.rows("SpellInterrupts", ["SpellID", "DifficultyID", *columns]):
        spell, difficulty = to_int(row[0]), to_int(row[1])
        base = difficulty == BASE_DIFFICULTY
        if spell not in spells.attribute_words or (spell in seen_base and not base):
            continue
        if base:
            seen_base.add(spell)
        words = tuple(to_int(value) for value in row[2:])
        bits = tuple(bit for bit, test in tests.items() if carries(words, test))
        if bits:
            found[spell] = bits
        else:
            found.pop(spell, None)
    return found
