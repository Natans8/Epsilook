"""Reading one source on top of another.

`OverlaidTables` implements `Tables` over two `Tables`, so a reader never asks
for the overlay and cannot forget it. The merge is per column, unions rows
rather than only replacing them, and applies a row only where the overlay is at
least as current as the base.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field

from .provider import Tables


def join_key(text: str) -> str:
    """One row id, in a spelling both sources can be compared on.

    The two sources are different exporters, so `2` and `2.0` must join as one
    row; anything non-numeric compares as trimmed text.
    """
    trimmed = text.strip()
    if trimmed.isascii() and trimmed.isdigit():
        return trimmed.lstrip("0") or "0"  # the common shape
    try:
        return str(int(float(trimmed)))
    except ValueError:
        return trimmed


@dataclass(frozen=True)
class Overlay:
    """How one base table is revised by a second source.

    A base column absent from `columns` is one the overlay may not supply: a
    column whose overlay copy is lossy is left unmapped, and the base's value
    stands.
    """

    table: str
    """The overlay's own name for the table."""

    columns: Mapping[str, str]
    """Base column name -> the overlay's name for it."""

    key: str = "ID"
    """The base column both sides identify a row by. Must be mapped."""

    stamp: str | None = None
    """The overlay column naming the client build a row was verified against;
    `None` when the source does not stamp its rows."""

    def __post_init__(self) -> None:
        if self.key not in self.columns:
            raise ValueError(f"overlay {self.table}: the key {self.key!r} is not "
                             f"among the mapped columns")


@dataclass(frozen=True)
class OverlaidTables:
    """One source read over another, presented as a single `Tables`.

    Availability, headers and row order all follow the base.
    """

    base: Tables
    overlays: Mapping[str, Overlay] = field(default_factory=dict)
    """Base table name -> how it is overlaid; a table absent from this map
    passes straight through."""

    source: Tables | None = None
    """Where the revisions come from; `None` means every table passes through."""

    build: int = 0
    """The client build a stamped row is judged against; required whenever a
    stamped overlay is present."""

    def __post_init__(self) -> None:
        # Refused here because the omission is otherwise invisible: a stamp
        # compared against 0 lets every row through.
        if self.source is not None and not self.build \
                and any(overlay.stamp for overlay in self.overlays.values()):
            raise ValueError(
                "OverlaidTables: a stamped overlay needs the client build to "
                "judge its rows against; pass build=<the build being packed>")

    def available(self, table: str) -> bool:
        """Whether the base has the table. An overlay cannot introduce one."""
        return self.base.available(table)

    def header(self, table: str) -> list[str]:
        """The base's column names. The overlay's spellings are its own."""
        return self.base.header(table)

    def _applies(self, stamp: str) -> bool:
        """Whether a row stamped `stamp` is current enough to apply.

        A row stamped below the build being read describes an older client, so
        applying it would put stale data over current data. An unreadable stamp
        counts as older.
        """
        try:
            return int(stamp) >= self.build
        except ValueError:
            return False

    def _revisions(self, source: Tables, overlay: Overlay,
                   columns: Sequence[str]) -> dict[str, tuple[str, dict[str, str]]]:
        """The overlay's rows for one table, keyed by the joinable key value.

        Each entry keeps the key's own text, which an added row comes out
        spelling. Only the overlay is buffered, so the base stays a stream.
        """
        supplied = [column for column in columns
                    if column in overlay.columns and column != overlay.key]
        asked = [overlay.columns[column] for column in (overlay.key, *supplied)]
        if overlay.stamp:
            asked.append(overlay.stamp)

        out: dict[str, tuple[str, dict[str, str]]] = {}
        for row in source.rows(overlay.table, asked):
            if overlay.stamp and not self._applies(row[-1]):
                continue
            # zip stops at `supplied`, which drops the stamp without naming it
            out[join_key(row[0])] = (row[0], dict(zip(supplied, row[1:])))
        return out

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, revisions applied.

        A revised row keeps every base value the overlay does not supply. A row
        the base lacks is appended after the base's own order, with the columns
        the overlay does not supply empty.
        """
        source, overlay = self.source, self.overlays.get(table)
        # A build that predates a table reads it as empty by declaration;
        # without this test every revision row would come out as an addition.
        if overlay is None or source is None or not self.base.available(table) \
                or not source.available(overlay.table):
            yield from self.base.rows(table, columns)
            return

        revisions = self._revisions(source, overlay, columns)
        if not revisions:
            # An overlay ships only the rows it revised, so a table it revised
            # none of still leaves a header-only file behind.
            yield from self.base.rows(table, columns)
            return

        wanted = list(columns)
        keyed = wanted if overlay.key in wanted else [*wanted, overlay.key]
        at_key = keyed.index(overlay.key)
        width = len(wanted)

        seen: set[str] = set()
        for row in self.base.rows(table, keyed):
            key = join_key(row[at_key])
            found = revisions.get(key)
            if found is None:
                yield row[:width]
                continue
            seen.add(key)
            yield tuple(found[1].get(column, value)
                        for column, value in zip(wanted, row))

        for key, (spelling, revision) in revisions.items():
            if key in seen:
                continue
            added = {**revision, overlay.key: spelling}
            yield tuple(added.get(column, "") for column in wanted)
