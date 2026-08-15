"""Which source column answers each column a route asked for.

The rule is small and every provider needs all of it: read the column where the
header has it, stand in for one the build predates and a declaration covers, and
refuse anything else. Written once because the third case is the one worth
crashing over, and two copies of a refusal drift towards disagreeing about what
is fatal.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Projection:
    """How one table's header answers a request for named columns.

    Attributes:
        sources: per requested column, the source column that answers it, or
            None where the build has none and a stand-in is declared.
        stand_ins: per requested column, the text a None yields.
    """

    sources: tuple[str | None, ...]
    stand_ins: tuple[str, ...]


def project(table: str, header: Sequence[str], columns: Sequence[str], *,
            defaults: Mapping[tuple[str, str], str]) -> Projection:
    """Resolve `columns` against `header`, or exit naming what is missing.

    Args:
        table: the table being read, for the message.
        header: its column names as the source spells them.
        columns: what the route asked for, in the order it wants them back.
        defaults: `(table, column) -> stand-in` for the columns a build may
            legitimately lack.

    Returns:
        The projection to read this request with.
    """
    known = set(header)
    sources: list[str | None] = []
    for column in columns:
        if column in known:
            sources.append(column)
        elif (table, column) in defaults:
            sources.append(None)
        else:
            sys.exit(f"error: {table}.csv is missing column {column!r} and it is "
                     f"not declared in OPTIONAL_COLUMNS; header = {list(header)}")
    return Projection(
        sources=tuple(sources),
        stand_ins=tuple(defaults.get((table, column), "") for column in columns))


def absent(table: str, absent_tables: Mapping[str, str], where: Path) -> bool:
    """Whether a table with no file is one this build is declared to lack.

    Exits when it is not: a table that vanished from a source without a
    declaration saying it would is a section that ships empty forever, and the
    build finding out is the only chance anybody gets to notice.
    """
    if table in absent_tables:
        return True
    sys.exit(f"error: {table}.csv is missing from {where} and it is "
             f"not declared optional")
