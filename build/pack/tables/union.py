"""Several sources presented as one, so a read names a table and never where it lives.

Below acquisition a table is a table: the client's export, the server dump
and the pinned build all land as rows of text by named column, and which of
them holds a given table is a fact of the roster, not something a route
should know. The union asks each source in turn and serves the one that has
the table. A table two sources both claim is an error rather than a silent
winner, because the answer would then depend on the order the wiring listed
them in.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass

from .provider import Tables


@dataclass(frozen=True)
class UnionTables:
    """One `Tables` over several, each table served by the one source holding it.

    A table no source holds is handed to the first source, so its own answer
    stands: a declared absence yields nothing and an undeclared table is the
    hard error it should be, exactly as if the union were not there.
    """

    sources: tuple[Tables, ...]

    absent: frozenset[str] = frozenset()
    """Tables declared absent for this build, which yield nothing: the server
    dump's tables on a build that ships no dump."""

    def holder(self, table: str) -> Tables | None:
        """The one source holding the table, or None.

        Raises:
            ValueError: two sources hold it, which the roster must resolve.
        """
        if table in self.absent:
            return None
        found = [source for source in self.sources if source.available(table)]
        if len(found) > 1:
            raise ValueError(f"{table} is held by {len(found)} sources; a table lives in one")
        return found[0] if found else None

    def available(self, table: str) -> bool:
        """Whether any source has the table."""
        return self.holder(table) is not None

    def header(self, table: str) -> list[str]:
        """The column names, from the source holding the table."""
        return (self.holder(table) or self.sources[0]).header(table)

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """The rows, from the source holding the table; none for a declared absence."""
        if table in self.absent:
            return iter(())
        return (self.holder(table) or self.sources[0]).rows(table, columns)
