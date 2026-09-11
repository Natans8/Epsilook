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
from .flow import Holds, Slot, When
from .flows import effects


class Declared(NamedTuple):
    """One selector, with the table it selects rows of."""

    table: str
    select: When


def _slot(record: Mapping[str, Any]) -> Slot:
    """A slot as an enum file spells it: column, what it holds, and into what.

    `Any` because a checked-in enum's value is whatever the file holds, a name
    or a record, and the loader hands it back unparsed.
    """
    return Slot(str(record["column"]), Holds(str(record["holds"])), str(record.get("into", "")))


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
        if not isinstance(record, dict) or "reads" not in record:
            continue
        held: Sequence[Mapping[str, Any]] = record["reads"]
        declared.append(Declared(table, When(on, (value,), tuple(_slot(slot) for slot in held))))
    return declared


SELECTORS: tuple[Declared, ...] = (
    *(Declared("SpellEffect", chosen) for chosen in effects.selectors),
    *_from_enum("SpellVisualKitEffect", "EffectType", "spell_visual_kit_effect_types"),
    *_from_enum("SpellVisualEffectName", "Type", "spell_visual_effect_name_types"),
    *_from_enum("SpellProceduralEffect", "Type", "spell_procedural_effect_types"),
)
"""Every discriminated reference, in the order the pack lists them."""
