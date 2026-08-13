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
    - Rows arrive in source file order. Last-write-wins and
      first-candidate-wins semantics in the routes depend on it.
    - An empty field is ``""``. A provider that distinguishes NULL from the
      empty string must collapse the difference exactly as the CSV reader
      does.
    - A table declared absent for this build yields nothing rather than
      failing, and its section comes out empty. Anything undeclared is a hard
      error.

    The hotfix overlay is NOT a rule here, because it is not a property of a
    source: it is one source read over another. Composing two ``Tables`` is
    what applies it, which keeps the merge written once instead of once per
    implementation, and leaves this contract testable against a bare
    directory of CSVs.
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
