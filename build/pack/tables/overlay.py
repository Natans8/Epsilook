"""Reading one source ON TOP of another.

Some of the game's data is revised after the client ships: the server keeps
rows that replace what the client holds, and a build that reads only the client
is reading a snapshot that was already out of date when it was cut.

Applying that revision has been an opt-in per reader -- ask for the overrides,
merge them by row id -- and the trouble with an opt-in is that forgetting it
looks exactly like having nothing to overlay. A reader that skips it ships
pre-revision data and nothing says so.

So the overlay is not a feature of a reader, and not a flag inside the provider
that reads files either: it is one source read over another, which makes it a
COMPOSITION. `OverlaidTables` implements `Tables` over two `Tables`, so the
merge is written once instead of once per call site, every provider inherits
it, and a reader cannot forget what it never has to ask for.

Three rules the merge follows, each earned by measurement rather than
symmetry -- see `Overlay` and `OverlaidTables.rows` for the evidence:

- it merges per COLUMN, not per row;
- it UNIONS rows rather than only replacing them;
- it applies a row only where the overlay is at least as current as the base.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field

from .provider import Tables


def join_key(text: str) -> str:
    """One row id, in a spelling both sources can be compared on.

    The join is the one place text-in-text-out is not enough. Values travel
    as the source's own text, which is what keeps two providers producing the
    same pack -- but the base and the overlay are different exporters, and two
    spellings of the same NUMBER must still name the same row. A row id that
    arrives as `2` on one side and `2.0` or ` 2` on the other would otherwise
    miss its match and, because unmatched revisions are added rather than
    dropped, surface as a second row carrying the same logical id.

    So numeric keys compare numerically and anything else compares as trimmed
    text. This is deliberately narrower than parsing the VALUES: it decides
    only which rows are the same row.
    """
    trimmed = text.strip()
    if trimmed.isascii() and trimmed.isdigit():
        return trimmed.lstrip("0") or "0"  # the overwhelmingly common shape
    try:
        return str(int(float(trimmed)))
    except ValueError:
        return trimmed


@dataclass(frozen=True)
class Overlay:
    """How one base table is revised by a second source.

    The two sources rarely spell anything the same way -- a client table is
    `SpellVisual` where the server's dump calls it `spell_visual`, and a column
    the client exports as `EffectMiscValue_0` arrives as `EffectMiscValue1` --
    so the mapping is the declaration, and it is the only place either spelling
    appears.

    A base column absent from `columns` is one the overlay may not supply,
    and that is the point of merging per column rather than per row. Some
    columns are declared here only because a wholesale row replace would BLANK
    them; others must be left out because the overlay's copy is worse than the
    base's -- a value that has been through a text format which prints it with
    fewer digits than it holds. Under a per-column merge the lossy one is
    simply not mapped and the base's precise value stands, with no delta to
    explain and nothing to remember.
    """

    table: str
    """The overlay's own name for the table."""

    columns: Mapping[str, str]
    """Base column name -> the overlay's name for it."""

    key: str = "ID"
    """The base column both sides identify a row by. Must be mapped."""

    stamp: str | None = None
    """The overlay column naming the client build a row was verified against,
    when the source stamps its rows. `None` means it does not, and every row
    applies."""

    def __post_init__(self) -> None:
        if self.key not in self.columns:
            raise ValueError(f"overlay {self.table}: the key {self.key!r} is not "
                             f"among the mapped columns")


@dataclass(frozen=True)
class OverlaidTables:
    """One source read over another, presented as a single `Tables`.

    Honours the `Tables` contract in full, which is what lets a route be handed
    this or a bare provider and never learn which. Availability, headers and
    row ORDER all follow the BASE: an overlay revises data, it does not
    introduce a table, and the routes' last-write-wins semantics depend on file
    order surviving the merge.
    """

    base: Tables
    overlays: Mapping[str, Overlay] = field(default_factory=dict)
    """Base table name -> how it is overlaid. A table absent from this map is
    passed straight through."""

    source: Tables | None = None
    """Where the revisions come from. `None` means the build has no such
    source, which is ordinary rather than exceptional -- four of the shipped
    packs have no server release at all -- and every table passes through."""

    build: int = 0
    """The client build being read, against which a stamped row is judged."""

    def available(self, table: str) -> bool:
        """Whether the base has the table. An overlay cannot introduce one."""
        return self.base.available(table)

    def header(self, table: str) -> list[str]:
        """The base's column names. The overlay's spellings are its own."""
        return self.base.header(table)

    def _applies(self, stamp: str) -> bool:
        """Whether a row stamped `stamp` is current enough to apply.

        A stamp names the client build the row was last verified against, so a
        row stamped BELOW the build being read describes an older client -- and
        anything it had to say has already been folded into the client we are
        reading. Applying it would put stale data over current data. At or
        beyond the build it is genuinely newer than the client, which is the
        whole reason an overlay exists.

        An unreadable stamp is treated as older. A source that stamps its rows
        at all stamps every one of them, so a missing value is a malformed row
        rather than a row that means "always".
        """
        try:
            return int(stamp) >= self.build
        except ValueError:
            return False

    def _revisions(self, source: Tables, overlay: Overlay,
                   columns: Sequence[str]) -> dict[str, tuple[str, dict[str, str]]]:
        """The overlay's rows for one table, keyed by the joinable key value.

        Each entry is the key's OWN text alongside the columns it supplies. The
        joinable form is a dictionary key and never a value: a row the base does
        not have has to come out spelling its id the way its source spelled it,
        or one table would yield two spellings of the same column.

        Only the OVERLAY is buffered, never the base: a revision set is a few
        hundred rows against millions, and holding the small side is what lets
        the large one stay a stream.
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

        A revised row keeps every base value the overlay does not supply, so a
        column left out of the mapping is untouched rather than blanked.

        Rows the base does not have are APPENDED rather than dropped, and
        that is not tidiness: measured across the shipped releases, a handful of
        revision rows name ids the client's own table never carried. They are
        genuine additions the server made and the client never shipped, so
        dropping them would lose real data. They come last, after the base's own
        order, and the columns the overlay does not supply come out empty --
        there is no base row to take them from.
        """
        source, overlay = self.source, self.overlays.get(table)
        # `base.available` is not redundant with the others. A build that
        # PREDATES a table reads it as empty by declaration, and without this
        # test every revision row would come out as an addition -- conjuring a
        # table the client never had out of the revisions to it.
        if overlay is None or source is None or not self.base.available(table) \
                or not source.available(overlay.table):
            yield from self.base.rows(table, columns)
            return

        revisions = self._revisions(source, overlay, columns)
        if not revisions:
            # The ordinary case for several tables rather than a rare one: an
            # overlay ships only the rows it revised, and a release that revised
            # none of a table -- or predates it -- still leaves a header-only
            # file behind. Without this every base row would pay for a join that
            # cannot match anything.
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
