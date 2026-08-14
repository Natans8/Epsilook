"""Reading one source on top of another.

`OverlaidTables` implements `Tables` over two `Tables`, so a reader never asks
for the overlay and cannot forget it. The merge is per column, unions rows
rather than only replacing them, and applies a row only where the overlay's own
rule admits it.

That rule is the supplement's, not the merge's: an overlay carries a predicate
over one of its fields (see `supplements`), so the same merge serves a hotfix
source judged on the build it was verified against and an asset-name supplement
judged on the range of ids it is allowed to name.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field

from ..supplements import Admits, always
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

    judged_on: str | None = None
    """The overlay column whose text decides whether a row counts, or `None` to
    judge the key itself."""

    admits: Admits = always
    """Whether a row counts, given the text of the field named by `judged_on`.

    Declared with its bound already closed over, so the merge has nothing to
    remember and cannot compare against a bound that never arrived.
    """

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

    def available(self, table: str) -> bool:
        """Whether the base has the table. An overlay cannot introduce one."""
        return self.base.available(table)

    def header(self, table: str) -> list[str]:
        """The base's column names. The overlay's spellings are its own."""
        return self.base.header(table)

    def _revisions(self, source: Tables, overlay: Overlay,
                   columns: Sequence[str]) -> dict[str, tuple[str, dict[str, str]]]:
        """The overlay's rows for one table, keyed by the joinable key value.

        Each entry keeps the key's own text, which an added row comes out
        spelling. Only the overlay is buffered, so the base stays a stream.

        A row the overlay's own rule refuses is dropped here rather than
        further down, so a refused row cannot reach the merge at all.

        The buffer is the sizing limit on this whole mechanism, and it is worth
        knowing before wiring a large supplement: measured at roughly 400 bytes
        per row, which is nothing for a hotfix table of a few hundred rows and
        half a gigabyte for a source of well over a million. A supplement whose
        rule confines it to ids the base cannot reach is disjoint from the base
        by construction and so needs no join at all -- that is the shape to
        reach for when one of those arrives.
        """
        supplied = [column for column in columns
                    if column in overlay.columns and column != overlay.key]
        asked = [overlay.columns[column] for column in (overlay.key, *supplied)]
        if overlay.judged_on:
            asked.append(overlay.judged_on)

        # Judging the key is the whole rule for a supplement confined to a range
        # of its own, and it reads the key through the same normalisation the
        # join uses: the two sides are different exporters, so a rule reading
        # `5000.0` strictly would refuse the row it exists to admit, silently.
        # Resolved by what the field IS rather than by whether it was named, so
        # that naming the key's own column means what omitting it means.
        judges_key = overlay.judged_on in (None, overlay.columns[overlay.key])

        out: dict[str, tuple[str, dict[str, str]]] = {}
        for row in source.rows(overlay.table, asked):
            key = join_key(row[0])
            if not overlay.admits(key if judges_key else row[-1]):
                continue
            # zip stops at `supplied`, which drops a judged column without
            # naming it
            out[key] = (row[0], dict(zip(supplied, row[1:])))
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
