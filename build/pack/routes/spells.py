"""The per-spell columns of `SpellMisc`: icon, school and attribute flags.

A spell may carry one `SpellMisc` row per difficulty, and the base row is the
one a player sees, so every column here resolves the same way: the base row
wins, and the first row seen stands until it arrives.

Read in a single pass because the three columns share that rule and the table
is large. The attribute words are returned raw; `attributes.py` decodes them.
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


def read_spell_properties(tables: Tables,
                          spell_names: Container[int]) -> SpellProperties:
    """Read the icon, school and attribute flags of every listed spell.

    Args:
        tables: the source to read from.
        spell_names: the build's spell list; rows for anything absent from it
            are skipped.

    Returns:
        One entry per spell for each column, taken from its base-difficulty row
        where it has one.
    """
    columns = array_columns(tables, "SpellMisc", "Attributes",
                            ATTRIBUTE_COLUMNS_MAX)
    spells = SpellProperties()
    for row in tables.rows("SpellMisc", [
            "SpellID", "DifficultyID", "SpellIconFileDataID", "SchoolMask",
            *columns]):
        spell, difficulty = to_int(row[0]), to_int(row[1])
        if spell not in spell_names:
            continue
        base = difficulty == BASE_DIFFICULTY
        # An icon of zero is no icon, so it never displaces one already found.
        # School and attributes have no such value: zero is schoolless and no
        # flags set, both of which are answers.
        if (icon := to_int(row[2])) and (base or spell not in spells.icon_fid):
            spells.icon_fid[spell] = icon
        if base or spell not in spells.school:
            spells.school[spell] = to_int(row[3])
        if base or spell not in spells.attribute_words:
            spells.attribute_words[spell] = tuple(
                to_int(value) for value in row[4:])
    return spells
