"""The per-spell columns of `SpellMisc`: icon, school, timing, reach and
attributes.

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

from collections.abc import Container
from dataclasses import dataclass, field

from ..tables import Tables, array_columns
from .columns import BASE_DIFFICULTY, to_int

ATTRIBUTE_COLUMNS_MAX = 32
"""Upper bound when probing for `SpellMisc.Attributes_N`.

Slack rather than a limit: the widest build exports 17 and the flag enum tops
out at 15 columns, and `array_columns` returns only the ones a build has.
"""


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


def read_spell_properties(tables: Tables, spell_names: Container[int]) -> SpellProperties:
    """Read the icon, school and attribute flags of every listed spell.

    Args:
        tables: the source to read from.
        spell_names: the build's spell list; rows for anything absent from it
            are skipped.

    Returns:
        One entry per spell for each column, taken from its base-difficulty row
        where it has one.
    """
    columns = array_columns(tables, "SpellMisc", "Attributes", ATTRIBUTE_COLUMNS_MAX)
    spells = SpellProperties()
    for row in tables.rows(
        "SpellMisc",
        [
            "SpellID",
            "DifficultyID",
            "SpellIconFileDataID",
            "SchoolMask",
            "CastingTimeIndex",
            "DurationIndex",
            "RangeIndex",
            *columns,
        ],
    ):
        spell, difficulty = to_int(row[0]), to_int(row[1])
        if spell not in spell_names:
            continue
        base = difficulty == BASE_DIFFICULTY
        # An icon of zero is no icon, so it never displaces one already found.
        # The others have no such value: zero is schoolless, no flags set, and
        # no cast, duration or range row, all of which are answers.
        if (icon := to_int(row[2])) and (base or spell not in spells.icon_fid):
            spells.icon_fid[spell] = icon
        if base or spell not in spells.school:
            spells.school[spell] = to_int(row[3])
            spells.cast_index[spell] = to_int(row[4])
            spells.duration_index[spell] = to_int(row[5])
            spells.range_index[spell] = to_int(row[6])
            spells.attribute_words[spell] = tuple(to_int(value) for value in row[7:])
    return spells
