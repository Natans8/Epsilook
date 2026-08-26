"""Reading a db2 array field, whatever shape the build at hand exports it in."""

from __future__ import annotations

import sys

from .provider import Tables


def array_columns(tables: Tables, table: str, base: str, count: int) -> list[str]:
    """Column names for a db2 array field, tolerating an array-to-scalar collapse.

    wago exports ``X[n]`` as ``X_0 .. X_{n-1}``, but a field Blizzard narrows
    to a scalar between builds exports as a bare ``X``; the header states which,
    so nothing declares it. An absent table has no columns and its section
    empties, while an undeclared absence still fails at the row read.
    """
    if not tables.available(table):
        return []
    header = set(tables.header(table))
    indexed = [f"{base}_{i}" for i in range(count)]
    if indexed[0] in header:
        return [column for column in indexed if column in header]
    if base in header:
        return [base]
    sys.exit(f"error: {table} has neither {indexed[0]} nor a scalar {base}; header = {sorted(header)}")
