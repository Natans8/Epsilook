"""The spell-scaling game table: what a scaled effect's amount is built from.

A game table is not a db2. It is a tab-separated text file inside the client,
one row per level and one column per scaling class, and wago serves it only
through the raw file route rather than under `/db2/` -- which is why no db2 fit
ever explained a scaled value.

    value = table[level][column(ScalingClass)] * SpellEffect.Coefficient

The column a negative `ScalingClass` selects is fixed by the client and mapped
below. A positive one names a player class, which a pack has no caster for and
so cannot resolve.
"""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from .cache import Pinned
from .source import Fetched, Origin

SPELL_SCALING_FILE = 1391660
"""`GameTables/SpellScaling.txt`, by file id.

Addressed by id because the raw route takes one: the listfile knows the name,
and nothing else needs to.
"""

RAW_FILE_URL = "https://wago.tools/api/casc/{file}?version={build}"
"""Where a file the named-table route does not carry comes from.

The same raw route the db2s use. It answers slowly while busy rather than
404ing, so a caller that gets a timeout should retry rather than conclude the
file is absent.
"""

SCALING_COLUMNS = {
    -1: "Item",
    -2: "Consumable",
    -3: "Gem1",
    -4: "Gem2",
    -5: "Gem3",
    -6: "Health",
    -7: "Item",
    -8: "DamageReplaceStat",
    -9: "DamageSecondary",
    -10: "Mana Consumable",
}
"""Which column each negative `ScalingClass` reads.

Taken from the client's own mapping as TrinityCore implements it, not guessed
from the column order: `-1` and `-7` share `Item`, and the header spells the
last one with a space.

A POSITIVE class names a player class column, and those are deliberately absent
here -- a pack has no caster, so a class-scaled amount has no single value to
print and is left unresolved rather than resolved to somebody arbitrary.
"""


def scaling_source(build: str, cache_dir: Path) -> Fetched:
    """The scaling table as a source, declared like every other one.

    `Pinned`, because the table is a fact about a client already released: the
    bytes at that address cannot change under a build that already shipped, so
    the first fetch is the last one.

    OPTIONAL, because not every client ships it. A build without the file has
    no scaled effects to resolve either, so its absence costs nothing -- and
    the raw route answers slowly when busy, so a transient failure must leave
    the build printing base points rather than stopping it.
    """
    return Fetched(
        name=f"spell scaling game table ({build})",
        origin=Origin(RAW_FILE_URL.format(file=SPELL_SCALING_FILE, build=build)),
        dest=cache_dir / f"gtSpellScaling-{build}.txt",
        fetch=Pinned(), optional=True)


def read_scaling(landing: Path | None) -> dict[int, dict[str, float]]:
    """The fetched table, by level and then by column name.

    Returns:
        Every level the table declares. Empty when acquisition returned
        nothing, which leaves scaled amounts unresolved rather than wrong --
        the same answer a build predating the table gives.
    """
    if landing is None or not landing.exists():
        return {}
    lines = landing.read_text(encoding="utf-8", errors="replace").splitlines()
    if not lines:
        return {}
    header = lines[0].split("\t")
    table: dict[int, dict[str, float]] = {}
    for line in lines[1:]:
        parts = line.split("\t")
        if len(parts) != len(header):
            continue
        try:
            level = int(parts[0])
        except ValueError:
            continue
        row: dict[str, float] = {}
        for name, value in zip(header[1:], parts[1:]):
            try:
                row[name] = float(value)
            except ValueError:
                continue
        table[level] = row
    return table


def scaled_amount(table: Mapping[int, Mapping[str, float]], scaling_class: int,
                  coefficient: float, level: int,
                  minimum: int = 0, maximum: int = 0) -> float | None:
    """One effect's amount at `level`, or None when it cannot be resolved.

    The level is clamped to the spell's own scaling window first, which is what
    makes a low-level item read the same on any character above its cap.

    Returns:
        The amount, or None when the class names a player class, the table
        lacks the level, or the table was never fetched. None means "do not
        print", never "zero".
    """
    column = SCALING_COLUMNS.get(scaling_class)
    if column is None or not coefficient or not table:
        return None
    if minimum and level < minimum:
        level = minimum
    if maximum and level > maximum:
        level = maximum
    row = table.get(level) or table.get(max(table)) if table else None
    if row is None or column not in row:
        return None
    value = row[column] * coefficient
    # The client floors a positive amount at one rather than printing a zero,
    # so a tiny coefficient reads as "some" instead of "none".
    return 1.0 if 0 < value < 1 else value
