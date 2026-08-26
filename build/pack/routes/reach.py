"""How far a spell reaches: the band its target has to stand in.

A spell names a `SpellRange` row rather than a distance, and that row is a
band -- a minimum the target must be beyond and a maximum it must be within.
Every build stores the band twice, once measured against a hostile target and
once against a friendly one. The two agree on all but a few hundred spells, so
the hostile band is what ships; it is also the band a cooked description reads
for `$r`, which keeps the printed sentence and the searchable number the same
distance.

Spells reaching no further than their caster are left out, which makes self the
complement worked out at load, the same way instant is for delivery. That
sweeps up the spells with no `SpellMisc` row at all along with the ones naming
the self-only band.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..tables import Tables
from .columns import to_float, to_int
from .spells import SpellProperties

MELEE = 1 << 0
"""The reach is the caster's own combat reach rather than the band's distance.

Set on the bands the game calls combat range, whose stored distance is the
fallback the client uses before it knows the two bodies' sizes.
"""

WEAPON = 1 << 1
"""The reach is whatever the caster's equipped ranged weapon reaches."""

REACH_FLAGS = MELEE | WEAPON
"""The bits this route takes from `SpellRange.Flags`, which orders its own the
same way. Anything else the column carries is dropped rather than passed on
under a name nothing here can give it."""

YARD_DIGITS = 1
"""Places a distance keeps. The source is float32, so a whole number of yards
arrives with a tail that would otherwise make every value distinct."""

UNLIMITED = 50_000.0
"""The distance the client uses for a band with no far edge.

A quantity in the table and a marker everywhere else: it is the stored value
the `unlimited` word means, and it is kept out of the measured domain so the
axis's bounds describe the distances a reader can actually ask for.
"""


@dataclass(frozen=True)
class Reach:
    """One spell's band, for a spell that reaches past its caster."""

    spell: int
    """The spell."""

    max_yards: float
    """The far edge, in yards. `UNLIMITED` where there is none."""

    min_yards: float
    """The near edge, in yards. Zero where a target may stand anywhere up to
    the far edge, which is nearly every spell."""

    flags: int
    """`MELEE` and `WEAPON`."""


def read_spell_reach(tables: Tables, spells: SpellProperties) -> list[Reach]:
    """Read the band of every spell that reaches past its caster.

    Args:
        tables: the source to read from.
        spells: the band ids, already resolved to one row per spell.

    Returns:
        One entry per spell reaching past its caster, sorted by spell.
    """
    bands = {
        to_int(row[0]): (to_float(row[1], YARD_DIGITS), to_float(row[2], YARD_DIGITS), to_int(row[3]) & REACH_FLAGS)
        for row in tables.rows("SpellRange", ["ID", "RangeMax_0", "RangeMin_0", "Flags"])
    }

    out: list[Reach] = []
    for spell, band_id in sorted(spells.range_index.items()):
        band = bands.get(band_id)
        if band is None:
            continue
        far, near, flags = band
        if far <= 0:
            continue
        out.append(Reach(spell, far, near, flags))
    return out
