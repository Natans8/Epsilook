"""A route as a flow: a named sequence of steps from a table to rows.

Every route reads a table and follows a few hops before a bundle is built
from what it found, and the hops are of a handful of kinds. A flow states
them as data: which table it starts from, which column it joins through,
which column fans out, which selector decides what a column means. The steps
chain as methods and read left to right, and each one is a generator over
rows, so a flow streams a million-row table without holding it.

A flow carries its schema as data. Each step says which columns it adds or
replaces, so a column is resolved to an index once when the flow is built,
and the rows stay tuples of the provider's own text. A step naming a column
the flow does not carry fails when the flow is written down rather than when
some build runs it.

The steps are the mapping-shaped part of a route. A walk that recurses or a
cooker that parses is a function that takes a flow's rows and is not a step.
"""

from __future__ import annotations

from collections.abc import Callable, Container, Iterator, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol

from ..tables import Tables
from .columns import to_int_from_float

Row = tuple[str, ...]
"""One row as the provider yields it: the source's own text, by position."""

Rows = Iterator[Row]


@dataclass(frozen=True)
class Schema:
    """The columns a flow carries at one point, in order."""

    columns: tuple[str, ...]

    def at(self, name: str) -> int:
        """Where one column sits.

        Raises:
            KeyError: the flow does not carry it, named with what it does.
        """
        if name not in self.columns:
            raise KeyError(f"no column {name!r}; the flow carries {', '.join(self.columns)}")
        return self.columns.index(name)

    def with_columns(self, *names: str) -> Schema:
        """This schema with columns appended.

        Raises:
            ValueError: a name is already carried, so it would be reachable
                only by position.
        """
        taken = [name for name in names if name in self.columns]
        if taken:
            raise ValueError(f"{', '.join(taken)} already carried; a column is named once")
        return Schema((*self.columns, *names))


class Step(Protocol):
    """One hop of a flow."""

    def schema(self, incoming: Schema) -> Schema:
        """The columns rows carry after this step, given those before it."""
        raise NotImplementedError

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """Yield the rows this step produces from the rows before it."""
        raise NotImplementedError


def key_of(text: str) -> int:
    """A source column as the id it names.

    A key is compared as a number rather than as text, because the same id is
    exported as ``12`` on one build and ``12.0`` on another.
    """
    return to_int_from_float(text)


@dataclass(frozen=True)
class Read:
    """The origin: the rows of one table, by the columns named.

    Every flow starts here. Whatever the source was, an export, a server
    dump, a client's own storage or a checked-in declaration, the provider has
    brought it to rows of text by named column before this step sees it.
    """

    table: str
    columns: tuple[str, ...]

    def schema(self, incoming: Schema) -> Schema:
        """The columns read, as the flow's first schema."""
        del incoming  # an origin follows nothing
        return Schema(self.columns)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """Read the table."""
        del incoming, incoming_schema, version
        return tables.rows(self.table, self.columns)


@dataclass(frozen=True)
class FirstOf:
    """The origin for a fact whose table differs between builds.

    The first alternative this build has wins. Every alternative names its
    columns in the same order, and the flow carries them under the first
    alternative's names, so a step after this one is written once whichever
    table answered.
    """

    alternatives: tuple[Read, ...]

    def __post_init__(self) -> None:
        widths = {len(alternative.columns) for alternative in self.alternatives}
        if len(widths) != 1:
            raise ValueError("every alternative names the same number of columns, in the same order")

    def schema(self, incoming: Schema) -> Schema:
        """The first alternative's names."""
        del incoming
        return Schema(self.alternatives[0].columns)

    def chosen(self, tables: Tables) -> Read | None:
        """Which alternative this build reads, or None where it has none."""
        return next((alternative for alternative in self.alternatives if tables.available(alternative.table)), None)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """Read whichever alternative the build has; nothing where it has none."""
        del incoming, incoming_schema, version
        chosen = self.chosen(tables)
        return iter(()) if chosen is None else tables.rows(chosen.table, chosen.columns)


@dataclass(frozen=True)
class Join:
    """A hop through a key: a row's column indexes another table.

    The other table is indexed once on first use. A row whose key finds no
    row there keeps going with empty text in the joined columns, since a
    missing name is a name to print blank and not a spell to drop; pass
    ``inner=True`` to drop it instead.
    """

    key: str
    """The column of the incoming row holding the id."""

    table: str
    columns: tuple[str, ...]
    """What to take from the joined row."""

    by: str = "ID"
    """The joined table's key column."""

    inner: bool = False
    _index: dict[int, Row] = field(default_factory=dict, compare=False, repr=False)

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the joined ones."""
        incoming.at(self.key)
        return incoming.with_columns(*self.columns)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """Append each row's joined columns."""
        del version
        if not self._index:
            for row in tables.rows(self.table, [self.by, *self.columns]):
                self._index[key_of(row[0])] = row[1:]
        at = incoming_schema.at(self.key)
        blank = ("",) * len(self.columns)
        for row in incoming:
            found = self._index.get(key_of(row[at]))
            if found is None:
                if self.inner:
                    continue
                found = blank
            yield (*row, *found)


@dataclass(frozen=True)
class Explode:
    """Several columns become several rows, one per value: what pandas and
    polars call exploding an array.

    An array the source laid flat, a day kit beside a night kit, three
    texture slots: each becomes one row carrying one value under one name,
    and the rest of the row repeats. A zero or empty value yields no row.
    """

    columns: tuple[str, ...]
    into: str

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns less the fanned ones, then the one they became."""
        kept = tuple(name for name in incoming.columns if name not in self.columns)
        for name in self.columns:
            incoming.at(name)
        return Schema(kept).with_columns(self.into)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """One row per non-empty value among the fanned columns."""
        del tables, version
        fanned = [incoming_schema.at(name) for name in self.columns]
        kept = [at for at, name in enumerate(incoming_schema.columns) if name not in self.columns]
        for row in incoming:
            base = tuple(row[at] for at in kept)
            for at in fanned:
                if key_of(row[at]):
                    yield (*base, row[at])


class Holds(Enum):
    """What a selected row's column holds, once the selector has decided."""

    REFERENCE = "reference"
    """An id into the table named."""

    VOCABULARY = "vocabulary"
    """A value the named vocabulary gives a word to."""

    AMOUNT = "amount"
    """A number that is itself the value."""

    PARAMETER = "parameter"
    """A value whose meaning another slot of the same row decides."""


@dataclass(frozen=True)
class Slot:
    """What one column of a discriminated row means under one selector value."""

    column: str
    holds: Holds
    into: str = ""
    """The table or vocabulary named, empty for an amount or a parameter."""

    zero_is_a_value: bool = False
    """Whether nought is data here rather than the absence of a reference."""


def reference(column: str, table: str) -> Slot:
    """A column that is an id into ``table`` under this selector."""
    return Slot(column, Holds.REFERENCE, table)


def vocabulary(column: str, name: str, *, zero_is_a_value: bool = False) -> Slot:
    """A column that a checked-in vocabulary names under this selector."""
    return Slot(column, Holds.VOCABULARY, name, zero_is_a_value)


def amount(column: str) -> Slot:
    """A column that is a number under this selector."""
    return Slot(column, Holds.AMOUNT)


def parameter(column: str) -> Slot:
    """A column whose meaning another slot decides under this selector."""
    return Slot(column, Holds.PARAMETER)


def before(version: str, threshold: str) -> bool:
    """Whether a build predates a dotted version, compared as far as it is written."""
    build = tuple(int(part) for part in version.split("."))
    bound = tuple(int(part) for part in threshold.split("."))
    return build[: len(bound)] < bound


@dataclass(frozen=True)
class When:
    """The discriminated reference: when one column holds a value, the others
    mean what the slots say.

    A row is kept where the selector column holds one of the values, and the
    slots say what each named column is an id into, or a word for, or a
    number of, under that meaning. The slots are the declaration a reader
    resolves a raw value through, so they are stated here whether or not the
    flow goes on to join through them.
    """

    on: str
    values: tuple[int, ...]
    slots: tuple[Slot, ...]

    until: str = ""
    """The first build on which the values stopped meaning this, or empty.

    A content fact rather than an engine one: an id the game retired and
    reused means the old thing on every build before the patch that reused
    it, whichever client line the build is on.
    """

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged: a selection narrows rows and types columns, adding none."""
        incoming.at(self.on)
        for slot in self.slots:
            incoming.at(slot.column)
        return incoming

    def holds(self, version: str) -> bool:
        """Whether the values still mean this on the build being packed."""
        return not self.until or before(version, self.until)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """The rows the selector chooses, and none on a build past the meaning."""
        del tables
        if not self.holds(version):
            return
        at = incoming_schema.at(self.on)
        wanted = set(self.values)
        # A reference of nought names no row unless the slot says nought is
        # data, so such a row is dropped here rather than by every reader.
        gates = [(incoming_schema.at(slot.column), slot) for slot in self.slots if slot.holds is not Holds.AMOUNT]
        for row in incoming:
            if key_of(row[at]) not in wanted:
                continue
            if any(not slot.zero_is_a_value and key_of(row[here]) <= 0 for here, slot in gates):
                continue
            yield row


@dataclass(frozen=True)
class Where:
    """Keep the rows one column's value satisfies."""

    column: str
    keep: Callable[[str], bool]
    doc: str = ""
    """What the predicate asks, for the generated documentation."""

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged."""
        incoming.at(self.column)
        return incoming

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """The rows that pass."""
        del tables, version
        at = incoming_schema.at(self.column)
        return (row for row in incoming if self.keep(row[at]))


@dataclass(frozen=True)
class Narrow:
    """Keep the rows whose column names something the roster holds.

    The pack ships what a spell reaches and never the whole table, and the
    roster is what says which ids that is.
    """

    column: str
    roster: Container[int]
    doc: str = ""

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged."""
        incoming.at(self.column)
        return incoming

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str) -> Rows:
        """The rows the roster admits."""
        del tables, version
        at = incoming_schema.at(self.column)
        return (row for row in incoming if key_of(row[at]) in self.roster)


@dataclass(frozen=True)
class Flow:
    """A route as data: its name, and the steps from its table to its rows."""

    name: str
    steps: tuple[Step, ...] = ()

    def __or__(self, step: Step) -> Flow:
        """This flow with one more step, its schema checked as it is added.

        The one way a step joins a flow; the methods below are the spellings
        of it for each kind of step, and a step built elsewhere is appended
        with this directly.
        """
        grown = Flow(self.name, (*self.steps, step))
        grown.schema()
        return grown

    def read(self, table: str, *columns: str) -> Flow:
        """Start from one table's rows, by the columns named."""
        return self | Read(table, columns)

    def first_of(self, *alternatives: Read) -> Flow:
        """Start from whichever of several tables this build has."""
        return self | FirstOf(alternatives)

    def join(self, key: str, table: str, *columns: str, by: str = "ID", inner: bool = False) -> Flow:
        """Hop through a key into another table, taking the columns named."""
        return self | Join(key, table, columns, by, inner)

    def explode(self, *columns: str, into: str) -> Flow:
        """One row per value among the columns named, under one name."""
        return self | Explode(columns, into)

    def when(self, on: str, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> Flow:
        """Keep the rows a selector chooses, and say what their columns then mean."""
        return self | when(on, values, slots, until)

    def where(self, column: str, keep: Callable[[str], bool], doc: str = "") -> Flow:
        """Keep the rows whose column satisfies the predicate."""
        return self | Where(column, keep, doc)

    def narrow(self, column: str, roster: Container[int], doc: str = "") -> Flow:
        """Keep the rows whose column names something the roster holds."""
        return self | Narrow(column, roster, doc)

    def schema(self) -> Schema:
        """The columns the flow's rows carry.

        Raises:
            KeyError: a step names a column the flow does not carry there.
            ValueError: the flow has no origin, or a step repeats a name.
        """
        if not self.steps or not isinstance(self.steps[0], (Read, FirstOf)):
            raise ValueError(f"flow {self.name!r} must start by reading a table")
        current = Schema(())
        for step in self.steps:
            current = step.schema(current)
        return current

    def at(self, name: str) -> int:
        """Where one column sits in the flow's rows."""
        return self.schema().at(name)

    def rows(self, tables: Tables, version: str = "") -> Rows:
        """Run the flow over one build's tables.

        Args:
            tables: the source, whichever provider serves it.
            version: the build being packed, for the selectors whose meaning
                a patch retired. Empty reads every selector as current.
        """
        current = Schema(())
        rows: Rows = iter(())
        for step in self.steps:
            rows = step.rows(rows, current, tables, version)
            current = step.schema(current)
        return rows

    def of_kind(self, kind: type[Step]) -> list[Step]:
        """The steps of one kind, in flow order: the joins, the selectors."""
        return [step for step in self.steps if isinstance(step, kind)]

    @property
    def origin(self) -> Read | FirstOf:
        """The table the flow starts from, or the alternatives it picks between."""
        first = self.steps[0]
        if not isinstance(first, (Read, FirstOf)):
            raise ValueError(f"flow {self.name!r} must start by reading a table")
        return first

    @property
    def tables(self) -> list[str]:
        """Every table the flow reads, origin first, joins after."""
        named: list[str] = []
        for step in self.steps:
            if isinstance(step, Read):
                named.append(step.table)
            elif isinstance(step, FirstOf):
                named.extend(alternative.table for alternative in step.alternatives)
            elif isinstance(step, Join):
                named.append(step.table)
        return list(dict.fromkeys(named))


def flow(name: str) -> Flow:
    """An empty flow, to be given its steps with ``|``."""
    return Flow(name)


def read(table: str, *columns: str) -> Read:
    """The origin step: one table's rows, by the columns named."""
    return Read(table, columns)


def first_of(*alternatives: Read) -> FirstOf:
    """The origin step for a fact read from whichever table this build has."""
    return FirstOf(alternatives)


def join(key: str, table: str, *columns: str, by: str = "ID", inner: bool = False) -> Join:
    """A hop through a key into another table, taking the columns named."""
    return Join(key, table, columns, by, inner)


def explode(*columns: str, into: str) -> Explode:
    """One row per value among the columns named, under one name."""
    return Explode(columns, into)


def when(on: str, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> When:
    """The discriminated reference: the rows whose selector holds a value, and
    what their columns then mean. Not `select`, which everywhere else means
    choosing columns."""
    chosen = (values,) if isinstance(values, int) else tuple(values)
    return When(on, chosen, tuple(slots), until)


def where(column: str, keep: Callable[[str], bool], doc: str = "") -> Where:
    """Keep the rows whose column satisfies the predicate."""
    return Where(column, keep, doc)


def nonzero(text: str) -> bool:
    """A predicate for a column holding an id or a count."""
    return key_of(text) != 0


def narrow(column: str, roster: Container[int], doc: str = "") -> Narrow:
    """Keep the rows whose column names something the roster holds."""
    return Narrow(column, roster, doc)
