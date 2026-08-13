"""The table provider interface every reader reads through."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Protocol


class Tables(Protocol):
    """One source of game tables, presented row-wise as text.

    A ``Tables`` is one source, not the whole build: a route may be handed
    several (the building pack's own tables, the TDB, a pinned build), wired
    by the caller.

    The contract every implementation must honour, because route semantics
    depend on each point:

    - Values are the source's own text, unparsed. Typing happens in the
      route, so two providers over the same source yield identical packs.
    - Hotfixes are already applied; no reader opts in.
    - Rows arrive in source file order. Last-write-wins and
      first-candidate-wins semantics in the routes depend on it.
    - An empty field is ``""``. A provider that distinguishes NULL from the
      empty string must collapse the difference exactly as the CSV reader
      does.
    """

    def available(self, table: str) -> bool:
        """Whether this source has the named table at all."""
        ...

    def header(self, table: str) -> list[str]:
        """The table's column names, in source order."""
        ...

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, hotfixes applied."""
        ...
