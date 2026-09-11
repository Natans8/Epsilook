"""The spell -> visual -> kit edges: the spine everything else hangs off.

Two many-to-many hops, both carrying a target mask saying who the content plays
for. The redirect graph contains cycles -- a visual can name itself, or a pair
name each other -- so following redirects is an expansion over a mask that
only gains bits, not a recursion. The redirected-to visual is usually reachable
no other way.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import NamedTuple

from ..phases import PHASES_ENUM
from ..sources import load_local_enum
from ..targets import NO_TARGET, TARGET_BITS
from .flow import Cell, key_of


class KitEvent(NamedTuple):
    """One `SpellVisualEvent` row: a kit, when it starts, and who sees it.

    The unit the walk collects: the same kit starting at the cast and again at
    the impact is two of these, and each keeps its own audience.
    """

    kit: int
    phase: int
    """The `StartEvent`, a value of the vendored phase enum."""
    bit: int
    """The target bit `TargetType` contributes, or `NO_TARGET`."""


@dataclass
class VisualGraph:
    """The two hops, and the sound a visual plays on its own."""

    spell_visuals: Mapping[int, Mapping[int, int]] = field(default_factory=dict)
    """Spell -> {visual -> the extra target bits it was reached through}.

    A visual reached straight from `SpellXSpellVisual` carries `NO_TARGET`,
    its rows already being masked by their own event; one reached through a
    redirect carries the bits of the columns the path went through.
    """

    visual_events: Mapping[int, Sequence[KitEvent]] = field(default_factory=dict)
    """Visual -> its event rows, distinct, in table order.

    Kept per event rather than folded per kit, because the phase is what the
    pack ships: a row says what plays, when, and for whom, and folding the
    events of one kit would lose which audience went with which moment.
    """

    visual_sounds: Mapping[int, int] = field(default_factory=dict)
    """Visual -> the SoundKit its animation events play."""


def target_bit(cell: Cell) -> int:
    """An event's `TargetType` as the bit it contributes to a row's mask."""
    return TARGET_BITS.get(key_of(cell), NO_TARGET)


def phase_words() -> list[str]:
    """The word for each event a kit can start at, indexed by event id.

    Empty where the enum leaves a value unnamed, and the vendored file lists
    every value the enum has, so a row storing an unnamed event indexes an
    entry that reads as no word rather than running off the end.
    """
    names = load_local_enum(PHASES_ENUM)
    return [str(names.get(event, "")) for event in range(max(names) + 1)]
