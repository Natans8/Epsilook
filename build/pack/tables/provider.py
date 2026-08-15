"""The table provider interface every reader reads through."""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Protocol, TypeAlias


class Tables(Protocol):
    """One source of game tables, presented row-wise as text.

    The contract every implementation must honour:

    - Values are the source's own text, unparsed; the route types them.
    - Rows arrive in source file order, which the routes' last-write-wins and
      first-candidate-wins semantics depend on.
    - An empty field is ``""``, never ``None``.
    - A table declared absent for this build yields nothing rather than
      failing; anything undeclared is a hard error.
    """

    def available(self, table: str) -> bool:
        """Whether this source has the named table at all."""
        raise NotImplementedError

    def header(self, table: str) -> list[str]:
        """The table's column names, in source order."""
        raise NotImplementedError

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, revisions applied."""
        raise NotImplementedError


Provider: TypeAlias = Callable[[Path], Tables]
"""An implementation, not yet pointed at a directory.

Which one a build reads through is one decision, and the wiring makes it once:
every source it composes is served by the same implementation, so a build is
read entirely through one or entirely through the other.
"""
