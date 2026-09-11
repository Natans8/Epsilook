"""How a spell is delivered: a cast time, a channel, or both.

This is not a partition and must not be turned back into one. Thousands of
spells carry a cast time and the channelled flag together, and the old
"channel wins" rule discarded the cast number for every one of them. In game a
cast-then-channel spell shows a cast bar and then a draining channel bar; the
same spell with its cast time removed shows no fill-up phase.

Spells with neither are omitted rather than listed as a third kind, which makes
instant the complement at load time. That also sweeps up the spells with no
`SpellMisc` row at all, which fell out of every delivery query while this was a
partition.
"""

from __future__ import annotations

from collections.abc import Container, Iterable
from dataclasses import dataclass
from typing import NamedTuple

from ..sources import enum_id_where, load_local_enum

CHANNELLED = 1 << 0
"""The spell channels."""

BREAKS_ON_MOVE = 1 << 1
"""The channel ends when the caster walks. Only meaningful with `CHANNELLED`."""

CHANNEL_BITS = (34, 38)
"""The two attribute bits that make a spell a channel.

The second is the self-channelled flag, a channel that targets the caster. It
is still a channel, so delivery treats the pair as one.
"""

DURATION_UNLIMITED = 100_000_000
"""`SpellDuration.Duration` at or beyond this is the client's "no limit".

A channel that runs until something stops it. Negative values mean the same.
"""


@dataclass(frozen=True)
class Delivery:
    """One spell's delivery, for a spell that has a cast time or a channel."""

    spell: int
    """The spell."""

    cast_ms: int
    """The cast bar's length, zero where there is none."""

    duration_ms: int
    """The channel's length: -1 for no limit, 0 for no duration row.

    Only meaningful with `CHANNELLED` set.
    """

    flags: int
    """`CHANNELLED` and `BREAKS_ON_MOVE`."""


CHANNEL_INTERRUPT_ENUM = "spell_interrupt_flags"
"""Which enum names the bit that movement cancels a channel on.

Named rather than assumed because the two interrupt enums disagree: movement is
one bit in the aura and channel columns and a different one in the cast column.
Taking the three columns of one table to share an enum reported the channel
population several times too low once.
"""

MOVING_BIT = enum_id_where(load_local_enum(CHANNEL_INTERRUPT_ENUM), "moving")
"""The bit of the channel interrupt word that movement sets."""


class DeliveryRow(NamedTuple):
    """One spell's timing columns, its cast and duration rows joined."""

    spell: int
    cast_ms: int
    duration_ms: int | None
    """None where the spell names no duration row."""
    channelled: bool


def channelled_spells(rows: Iterable[Delivery]) -> set[int]:
    """The spells delivered as a channel, which the phase rule places apart."""
    return {row.spell for row in rows if row.flags & CHANNELLED}


def assemble_delivery(rows: Iterable[DeliveryRow], breaks: Container[int]) -> list[Delivery]:
    """The entries: one per spell with a cast time or a channel, sorted.

    `SpellCastTimes.Minimum` is deliberately not read: it is the haste floor,
    and the base column is the nominal number to show.
    """
    out: list[Delivery] = []
    for row in sorted(rows, key=lambda held: held.spell):
        cast = max(row.cast_ms, 0)
        flags, duration = 0, 0
        if row.channelled:
            flags = CHANNELLED | (BREAKS_ON_MOVE if row.spell in breaks else 0)
            if row.duration_ms is not None:
                duration = -1 if row.duration_ms < 0 or row.duration_ms > DURATION_UNLIMITED else row.duration_ms
        if cast or flags:
            out.append(Delivery(row.spell, cast, duration, flags))
    return out
