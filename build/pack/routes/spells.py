"""The per-spell columns of `SpellMisc`: icon, school, timing, reach,
whether the landing is delayed, and attributes.

A spell may carry one `SpellMisc` row per difficulty, and the base row is the
one a player sees, so every column here resolves the same way: the base row
wins, and the first row seen stands until it arrives.

Read in a single pass because every column shares that rule and the table is
large. Sharing the pass is also what keeps one answer to "which row represents
the spell" -- a second reader deciding it again is a second answer waiting to
disagree. The values are returned raw: `attributes.py` decodes the flag words
and `delivery.py` resolves the two timing ids against their own tables.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from ..sources import load_local_enum


SPEED_IS_DELAY_BIT = next(
    bit
    for bit, held in load_local_enum("spell_attributes").items()
    if isinstance(held, dict) and held.get("name") == "MissileSpeedIsDelayInSec"
)
"""The attribute saying `Speed` is seconds of delay before the impact rather
than yards a second, found by its name in the vendored list."""


class PropertiesRow(NamedTuple):
    """One spell's base row of `SpellMisc`, its array of flag words read whole."""

    spell: int
    school: int
    cast_index: int
    duration_index: int
    range_index: int
    speed: float
    launch_delay: float
    attribute_words: tuple[int, ...]


@dataclass
class SpellProperties:
    """What `SpellMisc` says about a spell, one entry per spell."""

    icon_fid: dict[int, int] = field(default_factory=dict)
    """Spell to its icon file id. Absent where the spell declares none."""

    school: dict[int, int] = field(default_factory=dict)
    """Spell to its school mask. Zero is a valid value, meaning schoolless."""

    attribute_words: dict[int, tuple[int, ...]] = field(default_factory=dict)
    """Spell to its raw `Attributes` array, one 32-bit word per column."""

    cast_index: dict[int, int] = field(default_factory=dict)
    """Spell to its `SpellCastTimes` id. Zero where it names no row."""

    duration_index: dict[int, int] = field(default_factory=dict)
    """Spell to its `SpellDuration` id. Zero where it names no row."""

    range_index: dict[int, int] = field(default_factory=dict)
    """Spell to its `SpellRange` id. Zero where it names no row."""

    delayed: set[int] = field(default_factory=set)
    speed: dict[int, float] = field(default_factory=dict)
    """Spell -> `SpellMisc.Speed`, for the spells that carry one: yards a
    second, or seconds of delay where `SPEED_IS_DELAY_BIT` says so."""
    launch_delay: dict[int, float] = field(default_factory=dict)
    """Spell -> `SpellMisc.LaunchDelay`, in seconds, for the spells that carry one."""
    """The spells whose effects land at the impact rather than the cast.

    A missile speed or a launch delay is what puts time between the cast and
    the landing; either alone does it, and a speed that is really a delay in
    seconds delays the landing all the same. This is the client's own test
    for whether a spell has a hit delay, and it places every effect the spell
    has.
    """

    @classmethod
    def assemble(cls, rows: Iterable[PropertiesRow], icons: Mapping[int, int]) -> SpellProperties:
        """The record from each spell's base row, and its icon from the row
        that has one: an icon of zero never displaces one, so the icon is read
        apart, base row first."""
        spells = cls()
        for row in rows:
            spells.school[row.spell] = row.school
            spells.cast_index[row.spell] = row.cast_index
            spells.duration_index[row.spell] = row.duration_index
            spells.range_index[row.spell] = row.range_index
            if row.speed > 0 or row.launch_delay > 0:
                spells.delayed.add(row.spell)
            if row.speed > 0:
                spells.speed[row.spell] = row.speed
            if row.launch_delay > 0:
                spells.launch_delay[row.spell] = row.launch_delay
            spells.attribute_words[row.spell] = row.attribute_words
        spells.icon_fid = {spell: icon for spell, icon in icons.items() if spell in spells.school}
        return spells
