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

from dataclasses import dataclass

from ..sources import enum_id_where, load_local_enum
from ..tables import Tables, array_columns
from .attributes import attribute_bit
from .columns import BASE_DIFFICULTY, to_int
from .spells import SpellProperties

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

INTERRUPT_COLUMNS_MAX = 4
"""Upper bound when probing for `SpellInterrupts.ChannelInterruptFlags_N`."""


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


def _breaks_on_move(tables: Tables, spells: SpellProperties) -> set[int]:
    """Which channels end when the caster walks.

    Reads the channel column, so the channel enum rather than the cast one.
    The table is declared optional, so a build without it loses this half and
    keeps the rest.

    Args:
        tables: the source to read from.
        spells: the build's spells; rows for anything absent are skipped.

    Returns:
        The spells whose channel is cancelled by movement.
    """
    if not tables.available("SpellInterrupts"):
        return set()
    moving = enum_id_where(load_local_enum(CHANNEL_INTERRUPT_ENUM), "moving")
    columns = array_columns(tables, "SpellInterrupts", "ChannelInterruptFlags",
                            INTERRUPT_COLUMNS_MAX)
    breaks: set[int] = set()
    seen_base: set[int] = set()
    for row in tables.rows("SpellInterrupts",
                           ["SpellID", "DifficultyID", *columns]):
        spell, difficulty = to_int(row[0]), to_int(row[1])
        base = difficulty == BASE_DIFFICULTY
        if spell not in spells.attribute_words or (spell in seen_base and not base):
            continue
        if base:
            seen_base.add(spell)
        words = tuple(to_int(value) for value in row[2:])
        if attribute_bit(words, moving):
            breaks.add(spell)
        elif base:
            # The base row is the spell's answer, so it overrides whatever a
            # difficulty row set before it arrived.
            breaks.discard(spell)
    return breaks


def read_spell_delivery(tables: Tables,
                        spells: SpellProperties) -> list[Delivery]:
    """Read the cast time and channel of every spell that has either.

    `SpellCastTimes.Minimum` is deliberately ignored: it is the haste floor,
    and the base column is the nominal number to show.

    Args:
        tables: the source to read from.
        spells: the timing ids and attribute words, already resolved to one
            row per spell.

    Returns:
        One entry per spell with a cast time or a channel, sorted by spell.
    """
    cast_of = {to_int(row[0]): to_int(row[1])
               for row in tables.rows("SpellCastTimes", ["ID", "Base"])}
    duration_of = {to_int(row[0]): to_int(row[1])
                   for row in tables.rows("SpellDuration", ["ID", "Duration"])}
    breaks = _breaks_on_move(tables, spells)

    out: list[Delivery] = []
    for spell, words in sorted(spells.attribute_words.items()):
        # A negative base is the "use the caster's ranged weapon speed"
        # sentinel rather than a duration. Epsilon fires those with no cast
        # bar, so they read as instant here.
        cast = max(cast_of.get(spells.cast_index.get(spell, 0), 0), 0)
        flags, duration = 0, 0
        if any(attribute_bit(words, bit) for bit in CHANNEL_BITS):
            flags = CHANNELLED | (BREAKS_ON_MOVE if spell in breaks else 0)
            raw = duration_of.get(spells.duration_index.get(spell, 0))
            if raw is not None:
                duration = -1 if raw < 0 or raw > DURATION_UNLIMITED else raw
        if cast or flags:
            out.append(Delivery(spell, cast, duration, flags))
    return out
