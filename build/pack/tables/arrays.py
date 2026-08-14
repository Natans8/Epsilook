"""Reading a db2 array field, whatever shape the build at hand exports it in."""

from __future__ import annotations

import sys

from .provider import Tables


def array_columns(tables: Tables, table: str, base: str, count: int) -> list[str]:
    """Column names for a db2 array field, tolerating an array-to-scalar collapse.

    wago exports an array field ``X[n]`` as ``X_0 .. X_{n-1}``, but Blizzard
    sometimes narrows an array to a plain scalar between builds, and then the
    export is a bare ``X``. This returns whichever spelling the build at hand
    actually uses, so one reader serves both.

    Handled by READING rather than by declaring, unlike the rest of the drift:
    the header states the answer, so a declaration would only be a second
    place for it to be wrong.

    Worked example, and the reason this exists: SpellShapeshiftForm's
    CreatureDisplayID is ``[4]`` through 10.1.x and a scalar from 10.2.0 on.
    Nothing is lost in the array builds -- slots 1..3 are empty in all 64 rows.

    An absent table has no columns, which is not a schema surprise. A build
    may legitimately predate the whole table, and asking what shape its array
    field takes must not be the thing that decides whether the build survives.
    Returning nothing hands the caller a column list that yields no rows, so
    the section empties and its feature switches off -- and an absence that was
    never declared still fails, one layer down, where the row read happens.
    """
    if not tables.available(table):
        return []
    header = set(tables.header(table))
    indexed = [f"{base}_{i}" for i in range(count)]
    if indexed[0] in header:
        return [column for column in indexed if column in header]
    if base in header:
        return [base]
    sys.exit(f"error: {table} has neither {indexed[0]} nor a scalar {base}; "
             f"header = {sorted(header)}")
