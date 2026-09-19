"""Every discriminated reference the build reads, gathered as one roster.

Four tables carry a column whose meaning another column decides: an effect
row's two misc values under its effect or aura, a kit effect's id under its
type, an effect name's generic id under its type, and a procedure's four
values under its type. Each is declared where its reader lives, in the
reader's own vocabulary or in the checked-in enum file the reader dispatches
off, and this module reads those declarations back as one list so the pack
can ship them: a reader holding a raw value and the selector beside it can
then say what the value is an id into.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

from ..sources import load_local_enum
from .flow import Holds, Slot, When, export_name
from .flows import Routes


class Declared(NamedTuple):
    """One selector, with the table it selects rows of."""

    table: str
    select: When


def _slot(record: Mapping[str, Any]) -> Slot:
    """A slot as an enum file spells it: column, what it holds, and into what.

    `Any` because a checked-in enum's value is whatever the file holds, a name
    or a record, and the loader hands it back unparsed.
    """
    return Slot(
        str(record["column"]),
        Holds(str(record["holds"])),
        str(record.get("into", "")),
        scale=int(record.get("scale", 1)),
    )


def _from_enum(table: str, on: str, enum: str) -> list[Declared]:
    """The selectors an enum file declares, one per value that says what it reads.

    A value's record carries `reads`, a list of slots, where the build
    consumes the value; a value with none is named but unrouted.

    Args:
        table: the table whose rows the enum's column discriminates.
        on: that column.
        enum: the checked-in enum naming the column's values.
    """
    declared: list[Declared] = []
    for value, record in sorted(load_local_enum(enum).items()):
        if not isinstance(record, dict) or not record.get("reads"):
            continue
        held: Sequence[Mapping[str, Any]] = record["reads"]
        declared.append(Declared(table, When(on, (value,), tuple(_slot(slot) for slot in held))))
    return declared


PAYLOADS: tuple[Declared, ...] = tuple(Declared("SpellEffect", chosen) for chosen in Routes.effects.selectors)
"""The selectors the effects split reads, which a typing file never overrides."""


def _claims() -> dict[tuple[str, int], frozenset[str]]:
    """The columns a payload already reads, by selector column and value."""
    claims: dict[tuple[str, int], frozenset[str]] = {}
    for declared in PAYLOADS:
        read = frozenset(export_name(slot.column) for slot in declared.select.slots)
        for value in declared.select.values:
            key = (export_name(declared.select.on), value)
            claims[key] = claims.get(key, frozenset()) | read
    return claims


CLAIMED = _claims()
"""The columns a payload already reads under each selector value, which a typing file leaves alone."""


def _unclaimed(declared: Sequence[Declared]) -> list[Declared]:
    """The typings' slots no payload of the split already reads; a value keeps the rest."""
    kept: list[Declared] = []
    for each in declared:
        taken = CLAIMED.get((export_name(each.select.on), each.select.values[0]), frozenset())
        slots = tuple(slot for slot in each.select.slots if export_name(slot.column) not in taken)
        if slots:
            kept.append(Declared(each.table, When(each.select.on, each.select.values, slots)))
    return kept


SELECTORS: tuple[Declared, ...] = (
    *PAYLOADS,
    *_unclaimed(_from_enum("SpellEffect", "Effect", "spell_effect_slots")),
    *_unclaimed(_from_enum("SpellEffect", "EffectAura", "spell_aura_slots")),
    *_from_enum("SpellVisualKitEffect", "EffectType", "spell_visual_kit_effect_types"),
    *_from_enum("SpellVisualEffectName", "Type", "spell_visual_effect_name_types"),
    *_from_enum("SpellProceduralEffect", "Type", "spell_procedural_effect_types"),
)
"""Every discriminated reference, in the order the pack lists them."""


class Word(NamedTuple):
    """One word of a vocabulary a slot names, with the value it stands for."""

    vocabulary: str
    value: int
    word: str


def _word(held: object) -> str:
    """A vocabulary value's word: the name the file holds, or its record's name."""
    return str(held["name"]) if isinstance(held, dict) else str(held)


WORDS: tuple[Word, ...] = tuple(
    Word(vocabulary, value, _word(held))
    for vocabulary in sorted(
        {
            slot.into
            for declared in SELECTORS
            for slot in declared.select.slots
            if slot.holds in (Holds.VOCABULARY, Holds.MASK)
        }
    )
    for value, held in sorted(load_local_enum(vocabulary).items())
)
"""Every word a vocabulary or mask slot can name, so a raw value resolves to one.

A mask vocabulary is keyed by its bits, so a mask's words are the values it sets."""
