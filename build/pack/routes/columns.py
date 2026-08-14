"""Reading a source column as the value it means.

The provider seam hands every column back as the source's own text, because
typing it there would make two providers disagree in the low-order digits of a
float and produce different packs from one source. Turning that text into a
number is therefore a route's job, and these are the spellings the game data
actually uses.

Each of these is a DECODE, not a cast. `int(text)` would be shorter and
wrong on every one of them: the game exports an empty cell where it means zero,
an integer as `2.0` on some builds and `2` on others, and one value under two
different column names depending on which build exported it.
"""

from __future__ import annotations


def to_int(text: str) -> int:
    """An integer column. An empty cell means zero, which is what it is."""
    return int(text) if text else 0


def to_int_from_float(text: str) -> int:
    """An integer column that some builds export in float form (`2.0` -> 2).

    Not a rounding: these columns hold ids and enum values, and the float is
    an artefact of how the exporter typed the column rather than a claim that
    the value has a fractional part.
    """
    return int(float(text)) if text else 0


def to_amount(*spellings: str) -> float:
    """An effect's amount, from the first of its column spellings that is set.

    The order is the declaration and it is not arbitrary. `SpellEffect`
    exports the value as an int (`EffectBasePoints`) or a float
    (`EffectBasePointsF`) depending on the build, and three builds export BOTH
    with the float left at zero. So the rule is "first nonempty and nonzero"
    and callers pass the int spelling first: preferring the float would
    silently blank Vanilla, TBC and MoP, where 46 of 40,249 rows have it set
    at all and 771 of 783 speed rows have it at zero.

    Rounded to one decimal, which drops the float32 conversion noise the modern
    builds carry (14.27999973297 -> 14.3) while keeping the values that really
    are fractional (47.5).
    """
    for spelling in spellings:
        if spelling and float(spelling):
            return round(float(spelling), 1)
    return 0.0
