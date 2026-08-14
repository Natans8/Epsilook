"""Reading a source column as the value it means.

The provider hands every column back as the source's own text, so turning it
into a number is a route's job. Each of these is a decode rather than a cast:
the game exports an empty cell where it means zero, an integer as `2.0` on some
builds and `2` on others, and one value under two column names depending on the
build.
"""

from __future__ import annotations


def to_int(text: str) -> int:
    """An integer column. An empty cell means zero, which is what it is."""
    return int(text) if text else 0


def to_int_from_float(text: str) -> int:
    """An integer column that some builds export in float form (`2.0` -> 2).

    Not a rounding: these columns hold ids and enum values.
    """
    return int(float(text)) if text else 0


def to_amount(*spellings: str) -> float:
    """An effect's amount, from the first spelling that is nonempty and nonzero.

    Some builds export both `EffectBasePoints` and `EffectBasePointsF` with the
    float left at zero, so callers pass the int spelling first. Rounded to one
    decimal, which drops the modern builds' float32 conversion noise.
    """
    for spelling in spellings:
        if spelling and float(spelling):
            return round(float(spelling), 1)
    return 0.0
