"""A route as a flow: a named sequence of steps from a table to a shape.

Every route reads a table and follows a few hops before it lands as a map,
a set of rows or a record, and the hops are of a handful of kinds. A flow
states them as data: which table it starts from, which column it joins
through, which column fans out, which selector decides what a column means,
which row of several stands for a key, and what the rows collect into. The
steps chain as methods and read left to right, each one a generator over
rows, so a flow streams a million-row table without holding it, and nothing
runs until the terminal asks.

A flow carries its schema as data. Each step says which columns it adds or
replaces, so a column is resolved to an index once when the flow is built,
and the rows stay tuples of the provider's own text. A step naming a column
the flow does not carry fails when the flow is written down rather than when
some build runs it.

A condition inside a flow is an expression, never a function: ``c.Speed !=
1.0`` builds a value that prints as itself, that a second executor can
compile, and that an override can be compared against. A function is welcome
at the terminal, where the row is already in hand.

The steps are the mapping-shaped part of a route. A walk that recurses over
its own output or a cooker that parses is a function that takes a flow's
rows and is not a step.
"""

from __future__ import annotations

from collections.abc import Callable, Container, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Protocol

from ..tables import Tables
from .columns import to_int_from_float

Cell = str | tuple[str, ...]
"""One value as a row carries it: the source's text, or every text of an
array column read as one."""

Row = tuple[Cell, ...]
"""One row as the provider yields it, by position."""

Rows = Iterator[Row]

Needs = Mapping[str, Any]
"""The rosters and other inputs a flow names by path, resolved by the wiring.

Any: a need is whatever the field it names holds; the step that reads it
says what it expects of it.
"""


# The columns and the expressions over them.


class Column:
    """A column of the flow, named; the operators on it build expressions.

    ``c.Speed != 1.0`` is a comparison, not a bool: the dunder methods return
    the expression as data, the way a lazy frame's columns do, so a flow can
    say what it asks without running it. Equality on a column is therefore an
    expression too, and a column is hashed by its name.
    """

    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name

    def __repr__(self) -> str:
        return f"c.{self.name}"

    def __hash__(self) -> int:
        return hash(self.name)

    # A comparison on a column is an expression rather than a truth, which is
    # the whole reason the class exists; the type checker's contract for
    # equality is what the override steps outside.
    def __eq__(self, other: object) -> Compare:  # type: ignore[override]
        return Compare(self.name, "==", other)

    def __ne__(self, other: object) -> Compare:  # type: ignore[override]
        return Compare(self.name, "!=", other)

    def __lt__(self, other: float) -> Compare:
        return Compare(self.name, "<", other)

    def __le__(self, other: float) -> Compare:
        return Compare(self.name, "<=", other)

    def __gt__(self, other: float) -> Compare:
        return Compare(self.name, ">", other)

    def __ge__(self, other: float) -> Compare:
        return Compare(self.name, ">=", other)

    def bit(self, which: int) -> Bit:
        """Whether one bit of this column, or of the array of words it holds, is set."""
        return Bit(self.name, which)

    def is_empty(self) -> Compare:
        """Whether the text is empty."""
        return Compare(self.name, "==", "")

    def __getitem__(self, span: slice) -> Column:
        """The array column ``Name_*``: every ``Name_N`` the build has, read as one cell.

        Written as ``c.Attributes[:]`` and carried under the name with the
        star, so a step after the read names it the same way.
        """
        if span != slice(None):
            raise ValueError("an array column is read whole; write c.Name[:]")
        return Column(f"{self.name}_*")


class Columns:
    """The namespace a column is named through: ``c.Speed`` is the column ``Speed``."""

    def __getattr__(self, name: str) -> Column:
        return Column(name)


c = Columns()
"""The one namespace every flow names its columns through."""


def column_name(named: str | Column) -> str:
    """A column by name, whether it was written as a string or through ``c``."""
    return named.name if isinstance(named, Column) else named


class Expr(Protocol):
    """A value computed from one row, as data the executor can read or compile."""

    def columns(self) -> frozenset[str]:
        """The columns the expression reads."""
        raise NotImplementedError

    def evaluate(self, row: Row, schema: Schema) -> object:
        """The value on one row."""
        raise NotImplementedError


def number_of(cell: Cell) -> float:
    """A cell as the number it holds; empty is nought, and an array has none."""
    if isinstance(cell, tuple):
        raise TypeError("an array column has no single number; ask a bit of it")
    return float(cell or 0)


@dataclass(frozen=True)
class Compare:
    """One column against one value, under one operator."""

    column: str
    op: str
    value: object

    def __repr__(self) -> str:
        return f"c.{self.column} {self.op} {self.value!r}"

    def columns(self) -> frozenset[str]:
        """The one column."""
        return frozenset({self.column})

    def evaluate(self, row: Row, schema: Schema) -> bool:
        """The comparison on one row: numerically for a number, as text otherwise."""
        cell = row[schema.at(self.column)]
        if isinstance(self.value, str):
            if self.op == "==":
                return cell == self.value
            if self.op == "!=":
                return cell != self.value
            raise TypeError(f"text compares only for equality, not {self.op}")
        if not isinstance(self.value, (int, float)):
            raise TypeError(f"a column compares against a number or a text, not {type(self.value).__name__}")
        held = number_of(cell)
        return {
            "==": held == self.value,
            "!=": held != self.value,
            "<": held < self.value,
            "<=": held <= self.value,
            ">": held > self.value,
            ">=": held >= self.value,
        }[self.op]

    def __and__(self, other: Expr) -> Both:
        return Both(self, other)

    def __or__(self, other: Expr) -> Either:
        return Either(self, other)

    def __invert__(self) -> Neither:
        return Neither(self)


@dataclass(frozen=True)
class Bit:
    """Whether a bit is set in a column's word, or in the array of words it holds
    read as one wide number, the low word first."""

    column: str
    which: int

    def __repr__(self) -> str:
        return f"c.{self.column}.bit({self.which})"

    def columns(self) -> frozenset[str]:
        """The one column."""
        return frozenset({self.column})

    def evaluate(self, row: Row, schema: Schema) -> bool:
        """The bit on one row."""
        cell = row[schema.at(self.column)]
        words = cell if isinstance(cell, tuple) else (cell,)
        word, offset = divmod(self.which, 32)
        return word < len(words) and bool(to_int_from_float(words[word]) & (1 << offset))

    def __and__(self, other: Expr) -> Both:
        return Both(self, other)

    def __or__(self, other: Expr) -> Either:
        return Either(self, other)

    def __invert__(self) -> Neither:
        return Neither(self)


@dataclass(frozen=True)
class Both:
    """Two conditions, both."""

    left: Expr
    right: Expr

    def __repr__(self) -> str:
        return f"({self.left!r}) & ({self.right!r})"

    def columns(self) -> frozenset[str]:
        """Both sides' columns."""
        return self.left.columns() | self.right.columns()

    def evaluate(self, row: Row, schema: Schema) -> bool:
        """Both hold."""
        return bool(self.left.evaluate(row, schema)) and bool(self.right.evaluate(row, schema))

    def __and__(self, other: Expr) -> Both:
        return Both(self, other)

    def __or__(self, other: Expr) -> Either:
        return Either(self, other)


@dataclass(frozen=True)
class Either:
    """Two conditions, either."""

    left: Expr
    right: Expr

    def __repr__(self) -> str:
        return f"({self.left!r}) | ({self.right!r})"

    def columns(self) -> frozenset[str]:
        """Both sides' columns."""
        return self.left.columns() | self.right.columns()

    def evaluate(self, row: Row, schema: Schema) -> bool:
        """Either holds."""
        return bool(self.left.evaluate(row, schema)) or bool(self.right.evaluate(row, schema))

    def __and__(self, other: Expr) -> Both:
        return Both(self, other)

    def __or__(self, other: Expr) -> Either:
        return Either(self, other)


@dataclass(frozen=True)
class Neither:
    """A condition, negated."""

    inner: Expr

    def __repr__(self) -> str:
        return f"~({self.inner!r})"

    def columns(self) -> frozenset[str]:
        """The inner columns."""
        return self.inner.columns()

    def evaluate(self, row: Row, schema: Schema) -> bool:
        """The inner does not hold."""
        return not self.inner.evaluate(row, schema)


# The schema.


@dataclass(frozen=True)
class Schema:
    """The columns a flow carries at one point, in order."""

    columns: tuple[str, ...]

    def at(self, name: str | Column) -> int:
        """Where one column sits.

        Raises:
            KeyError: the flow does not carry it, named with what it does.
        """
        name = column_name(name)
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

    def without(self, *names: str) -> Schema:
        """This schema less the columns named."""
        return Schema(tuple(name for name in self.columns if name not in names))


class Step(Protocol):
    """One hop of a flow."""

    def schema(self, incoming: Schema) -> Schema:
        """The columns rows carry after this step, given those before it."""
        raise NotImplementedError

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Yield the rows this step produces from the rows before it."""
        raise NotImplementedError


def key_of(cell: Cell) -> int:
    """A source column as the id it names.

    A key is compared as a number rather than as text, because the same id is
    exported as ``12`` on one build and ``12.0`` on another.
    """
    if isinstance(cell, tuple):
        raise TypeError("an array column is no key")
    return to_int_from_float(cell)


# The steps.


def _array_columns(tables: Tables, table: str, base: str) -> list[str]:
    """The ``Name_N`` columns a build has for an array field, or the bare
    ``Name`` where the build narrowed it to a scalar, in order."""
    header = tables.header(table)
    indexed = sorted(
        (name for name in header if name.startswith(base + "_") and name[len(base) + 1 :].isdigit()),
        key=lambda name: int(name[len(base) + 1 :]),
    )
    if indexed:
        return indexed
    return [base] if base in header else []


@dataclass(frozen=True)
class Read:
    """The origin: the rows of one table, by the columns named.

    Every flow starts here. Whatever the source was, an export, a server
    dump, a client's own storage or a checked-in declaration, the provider has
    brought it to rows of text by named column before this step sees it. A
    column named ``Name_*`` is an array field, read whole into one cell as the
    texts of every ``Name_N`` the build has.

    A table the build lacks yields nothing when the read says it may, and is
    a hard error otherwise: an undeclared absence is a bug, a declared one a
    section that ships empty.
    """

    table: str
    columns: tuple[str, ...]
    optional: bool = False

    source: str = "tables"
    """Which given the table is read from: the build's own tables, or another
    source the wiring holds, such as the pinned build or the server dump. A
    source the build lacks reads as no rows."""

    def schema(self, incoming: Schema) -> Schema:
        """The columns read, as the flow's first schema."""
        del incoming  # an origin follows nothing
        return Schema(self.columns)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Read the table."""
        del incoming, incoming_schema, version
        if self.source != "tables":
            held = needs.get(self.source)
            if held is None:
                return iter(())
            tables = held
        if self.optional and not tables.available(self.table):
            return iter(())
        arrays = {name: _array_columns(tables, self.table, name[:-2]) for name in self.columns if name.endswith("_*")}
        if not arrays:
            return tables.rows(self.table, self.columns)
        flat = [name for column in self.columns for name in arrays.get(column, [column])]
        widths = [len(arrays.get(column, [column])) for column in self.columns]
        return self._gathered(tables.rows(self.table, flat), widths)

    @staticmethod
    def _gathered(rows: Iterator[tuple[str, ...]], widths: list[int]) -> Rows:
        """Rows with each array's columns folded back into one cell."""
        for row in rows:
            out: list[Cell] = []
            at = 0
            for width in widths:
                out.append(row[at] if width == 1 else tuple(row[at : at + width]))
                at += width
            yield tuple(out)


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

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Read whichever alternative the build has; nothing where it has none."""
        chosen = self.chosen(tables)
        return iter(()) if chosen is None else chosen.rows(incoming, incoming_schema, tables, version, needs)


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
    many: bool = False
    """Whether the key finds several rows there, each of which becomes a row
    here; otherwise the last row per key stands, as a source's revisions do."""

    _index: dict[int, list[Row]] = field(default_factory=dict, compare=False, repr=False)

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the joined ones."""
        incoming.at(self.key)
        return incoming.with_columns(*self.columns)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Append each row's joined columns."""
        del version, needs
        if not self._index:
            for source in tables.rows(self.table, [self.by, *self.columns]):
                key = key_of(source[0])
                if self.many:
                    self._index.setdefault(key, []).append(source[1:])
                else:
                    self._index[key] = [source[1:]]
        at = incoming_schema.at(self.key)
        blank: Row = ("",) * len(self.columns)
        for row in incoming:
            found = self._index.get(key_of(row[at]))
            if found is None:
                if self.inner:
                    continue
                found = [blank]
            for joined in found:
                yield (*row, *joined)


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
        for name in self.columns:
            incoming.at(name)
        return incoming.without(*self.columns).with_columns(self.into)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """One row per non-empty value among the fanned columns."""
        del tables, version, needs
        fanned = [incoming_schema.at(name) for name in self.columns]
        kept = [at for at, name in enumerate(incoming_schema.columns) if name not in self.columns]
        for row in incoming:
            base = tuple(row[at] for at in kept)
            for at in fanned:
                cell = row[at]
                values = cell if isinstance(cell, tuple) else (cell,)
                for value in values:
                    if key_of(value):
                        yield (*base, value)


@dataclass(frozen=True)
class Expand:
    """The transitive closure over a self-referencing table, with the bits a
    path collects: a visual naming the visuals it redirects to, and so on.

    The graph has cycles, so this is a worklist over a mask that only gains
    bits, which terminates whatever shape the data takes. Each incoming row
    becomes one row per reachable id, carrying the id under ``into`` and the
    union of the edge bits the path took under ``bits``; the seed itself is
    reached with no bits.
    """

    key: str
    """The incoming column holding the seed id."""

    table: str
    """The self-referencing table, keyed by ``by``."""

    edges: Mapping[str, int]
    """Per column of the table naming another row, the bit that hop carries."""

    into: str
    bits: str
    by: str = "ID"
    _hops: dict[int, list[tuple[int, int]]] = field(default_factory=dict, compare=False, repr=False)

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the reached id and its bits."""
        incoming.at(self.key)
        return incoming.with_columns(self.into, self.bits)

    def reached(self, seed: int) -> dict[int, int]:
        """Every id reachable from one seed, with the bits it was reached through."""
        out: dict[int, int] = {}
        queue = [(seed, 0)]
        while queue:
            node, mask = queue.pop()
            before = out.get(node)
            merged = mask if before is None else before | mask
            if before is not None and merged == before:
                continue
            out[node] = merged
            for target, bit in self._hops.get(node, ()):
                queue.append((target, mask | bit))
        return out

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """One row per id each seed reaches."""
        del version, needs
        if not self._hops:
            columns = list(self.edges)
            for source in tables.rows(self.table, [self.by, *columns]):
                node = key_of(source[0])
                hops = [
                    (target, bit)
                    for target, bit in zip(map(key_of, source[1:]), self.edges.values())
                    if target and target != node
                ]
                if hops:
                    self._hops[node] = hops
        at = incoming_schema.at(self.key)
        for row in incoming:
            for node, mask in self.reached(key_of(row[at])).items():
                yield (*row, str(node), str(mask))


@dataclass(frozen=True)
class Prefer:
    """One row per key, the base row standing for it.

    A table carrying one row per difficulty says the same thing several times
    and a player sees the base one, so that row wins and the first row seen
    stands until it arrives. Buffered, because the copies of one key are not
    adjacent in the source; the keys come out in the order first met.
    """

    key: str
    base: Expr
    """Which row is the base one."""

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged."""
        incoming.at(self.key)
        for name in self.base.columns():
            incoming.at(name)
        return incoming

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """The chosen row per key, in first-seen key order."""
        del tables, version, needs
        at = incoming_schema.at(self.key)
        chosen: dict[int, tuple[Row, bool]] = {}
        for row in incoming:
            key = key_of(row[at])
            is_base = bool(self.base.evaluate(row, incoming_schema))
            held = chosen.get(key)
            if held is None or (is_base and not held[1]):
                chosen[key] = (row, is_base)
        return (row for row, _base in chosen.values())


@dataclass(frozen=True)
class Map:
    """A computed column: an expression's value on each row, appended."""

    into: str
    expr: Expr

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the computed one."""
        for name in self.expr.columns():
            incoming.at(name)
        return incoming.with_columns(self.into)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Each row with the value appended as text, a truth as 1 or 0."""
        del tables, version, needs
        for row in incoming:
            value = self.expr.evaluate(row, incoming_schema)
            yield (*row, str(int(value)) if isinstance(value, bool) else str(value))


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


def reference(column: str, table: str, *, zero_is_a_value: bool = False) -> Slot:
    """A column that is an id into ``table`` under this selector.

    Nought names no row, so a row reading it is dropped unless the slot says
    nought is data: a summon with no properties row is still a summon.
    """
    return Slot(column, Holds.REFERENCE, table, zero_is_a_value)


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

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """The rows the selector chooses, and none on a build past the meaning."""
        del tables, needs
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
    """Keep the rows an expression holds on."""

    keep: Expr

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged."""
        for name in self.keep.columns():
            incoming.at(name)
        return incoming

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """The rows that pass."""
        del tables, version, needs
        return (row for row in incoming if self.keep.evaluate(row, incoming_schema))


@dataclass(frozen=True)
class Narrow:
    """Keep the rows whose column names something the roster holds.

    The pack ships what a spell reaches and never the whole table, and the
    roster is what says which ids that is. A roster named by path is a need
    the wiring resolves, which is how a flow says what it depends on without
    saying it twice.
    """

    column: str
    roster: Container[int] | str
    """The ids, or the path of the field holding them."""

    doc: str = ""

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged."""
        incoming.at(self.column)
        return incoming

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """The rows the roster admits."""
        del tables, version
        roster = needs[self.roster] if isinstance(self.roster, str) else self.roster
        at = incoming_schema.at(self.column)
        return (row for row in incoming if key_of(row[at]) in roster)


# The flow.


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

    def read(self, table: str, *columns: str | Column, optional: bool = False, source: str = "tables") -> Flow:
        """Start from one table's rows, by the columns named."""
        return self | Read(table, tuple(column_name(name) for name in columns), optional, source)

    def first_of(self, *alternatives: Read) -> Flow:
        """Start from whichever of several tables this build has."""
        return self | FirstOf(alternatives)

    def join(
        self,
        key: str | Column,
        table: str,
        *columns: str | Column,
        by: str = "ID",
        inner: bool = False,
        many: bool = False,
    ) -> Flow:
        """Hop through a key into another table, taking the columns named."""
        return self | Join(column_name(key), table, tuple(column_name(name) for name in columns), by, inner, many)

    def explode(self, *columns: str | Column, into: str) -> Flow:
        """One row per value among the columns named, under one name."""
        return self | Explode(tuple(column_name(name) for name in columns), into)

    def expand(self, key: str | Column, table: str, edges: Mapping[str, int], *, into: str, bits: str) -> Flow:
        """Every row the key reaches through the table's own references, with the bits the path took."""
        return self | Expand(column_name(key), table, dict(edges), into, bits)

    def prefer(self, key: str | Column, *, base: Expr) -> Flow:
        """One row per key, the base row standing for it."""
        return self | Prefer(column_name(key), base)

    def map(self, into: str, expr: Expr) -> Flow:
        """A computed column, appended."""
        return self | Map(into, expr)

    def when(self, on: str, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> Flow:
        """Keep the rows a selector chooses, and say what their columns then mean."""
        return self | when(on, values, slots, until)

    def where(self, keep: Expr) -> Flow:
        """Keep the rows the expression holds on."""
        return self | Where(keep)

    def narrow(self, column: str | Column, roster: Container[int] | str, doc: str = "") -> Flow:
        """Keep the rows whose column names something the roster holds."""
        return self | Narrow(column_name(column), roster, doc)

    def __rshift__[T](self, terminal: Terminal[T]) -> Plan[T]:
        """Land the rows in a shape: ``flow >> as_map(...)`` is the whole route."""
        return Plan(self, terminal)

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

    def at(self, name: str | Column) -> int:
        """Where one column sits in the flow's rows."""
        return self.schema().at(name)

    def rows(self, tables: Tables, version: str = "", needs: Needs | None = None) -> Rows:
        """Run the flow over one build's tables.

        Args:
            tables: the source, whichever provider serves it.
            version: the build being packed, for the selectors whose meaning
                a patch retired. Empty reads every selector as current.
            needs: the rosters the flow names by path, resolved.
        """
        current = Schema(())
        rows: Rows = iter(())
        for step in self.steps:
            rows = step.rows(rows, current, tables, version, needs or {})
            current = step.schema(current)
        return rows

    def of_kind(self, kind: type[Step]) -> list[Step]:
        """The steps of one kind, in flow order: the joins, the selectors."""
        return [step for step in self.steps if isinstance(step, kind)]

    @property
    def needs(self) -> frozenset[str]:
        """The field paths the flow names, for the wiring to resolve: the
        rosters it narrows on and the sources other than the build's tables."""
        rosters = {
            step.roster for step in self.of_kind(Narrow) if isinstance(step, Narrow) and isinstance(step.roster, str)
        }
        sources = {step.source for step in self.of_kind(Read) if isinstance(step, Read) and step.source != "tables"}
        for step in self.of_kind(FirstOf):
            if isinstance(step, FirstOf):
                sources |= {alternative.source for alternative in step.alternatives if alternative.source != "tables"}
        return frozenset(rosters | sources)

    @property
    def origin(self) -> Read | FirstOf:
        """The table the flow starts from, or the alternatives it picks between."""
        first = self.steps[0]
        if not isinstance(first, (Read, FirstOf)):
            raise ValueError(f"flow {self.name!r} must start by reading a table")
        return first

    @property
    def tables(self) -> list[str]:
        """Every table the flow reads, origin first, joins and expansions after."""
        named: list[str] = []
        for step in self.steps:
            if isinstance(step, Read):
                named.append(step.table)
            elif isinstance(step, FirstOf):
                named.extend(alternative.table for alternative in step.alternatives)
            elif isinstance(step, (Join, Expand)):
                named.append(step.table)
        return list(dict.fromkeys(named))


def flow(name: str) -> Flow:
    """An empty flow, to be given its steps with the methods."""
    return Flow(name)


def when(on: str, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> When:
    """The discriminated reference: the rows whose selector holds a value, and
    what their columns then mean. Not `select`, which everywhere else means
    choosing columns. Built on its own where the declaration is the point,
    as the payload table does."""
    chosen = (values,) if isinstance(values, int) else tuple(values)
    return When(on, chosen, tuple(slots), until)


# The terminals: what the rows collect into.


class Terminal[T](Protocol):
    """Where a flow's rows land: the shape a route's field holds."""

    def collect(self, rows: Rows, schema: Schema) -> T:
        """The shape, from every row."""
        raise NotImplementedError


class Runnable[T](Protocol):
    """What the registry runs for a field: a plan, or a plan with a step after it."""

    @property
    def flow(self) -> Flow:
        """The flow underneath, for its needs and its tables."""
        raise NotImplementedError

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The shape, from one build's tables."""
        raise NotImplementedError


@dataclass(frozen=True)
class Plan[T]:
    """A flow with its terminal: the whole of a route, runnable."""

    flow: Flow
    terminal: Terminal[T]

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The shape, from one build's tables."""
        return self.terminal.collect(self.flow.rows(tables, version, needs), self.flow.schema())

    def then[U](self, assemble: Callable[..., U], **wants: str) -> Then[U]:
        """A step after the collection: a function of the shape, and of any
        further fields named, for the bundle a flow's rows do not spell alone."""
        return Then(self, assemble, wants)


@dataclass(frozen=True)
class Then[U]:
    """A plan whose result a function reshapes, with further fields by name."""

    plan: Plan[Any]
    assemble: Callable[..., U]
    wants: Mapping[str, str]
    """Per parameter of `assemble` after the first, the field path it takes."""

    @property
    def flow(self) -> Flow:
        """The plan's flow."""
        return self.plan.flow

    @property
    def needs(self) -> frozenset[str]:
        """The flow's needs and the fields the step wants."""
        return self.flow.needs | frozenset(self.wants.values())

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> U:
        """The reshaped result."""
        held = needs or {}
        return self.assemble(
            self.plan.run(tables, version, held), **{name: held[path] for name, path in self.wants.items()}
        )


def _picker(schema: Schema, columns: Sequence[str | Column]) -> Callable[[Row], tuple[int, ...]]:
    """The named columns of a row, as the ids they hold."""
    ats = [schema.at(name) for name in columns]
    return lambda row: tuple(key_of(row[at]) for at in ats)


@dataclass(frozen=True)
class AsMap[T]:
    """Key to one value: the last row per key wins, as a source's revisions do,
    unless the flow says the first stands.

    Any where the value's type is the reader's: a terminal built through
    ``as_map`` types its values by the reader the column was picked with.
    """

    key: tuple[str, ...]
    value: str
    read: Callable[[Cell], T]
    first: bool = False

    def collect(self, rows: Rows, schema: Schema) -> dict[int | tuple[int, ...], T]:
        """The map."""
        keys = _picker(schema, self.key)
        at = schema.at(self.value)
        out: dict[int | tuple[int, ...], T] = {}
        single = len(self.key) == 1
        for row in rows:
            key = keys(row)
            held = key[0] if single else key
            if self.first and held in out:
                continue
            out[held] = self.read(row[at])
        return out


@dataclass(frozen=True)
class AsSets[T]:
    """Key to every value that occurred under it; a value of several columns
    is a tuple."""

    key: str
    value: tuple[Typed, ...]

    def collect(self, rows: Rows, schema: Schema) -> dict[int, set[T]]:
        """The sets."""
        key_at = schema.at(self.key)
        readers = [(schema.at(picked.column), picked.read) for picked in self.value]
        out: dict[int, set[T]] = {}
        for row in rows:
            values = tuple(read(row[at]) for at, read in readers)
            out.setdefault(key_of(row[key_at]), set()).add(values[0] if len(values) == 1 else values)  # type: ignore[arg-type]
        return out


@dataclass(frozen=True)
class AsTree:
    """Key under key to the sorted values beneath: kit to animation to regions."""

    keys: tuple[str, ...]
    value: Typed

    def collect(self, rows: Rows, schema: Schema) -> dict[int, Any]:
        """The tree, its leaves sorted lists."""
        key_ats = [schema.at(name) for name in self.keys]
        at, read = schema.at(self.value.column), self.value.read
        leaves: dict[tuple[int, ...], set[Any]] = {}
        for row in rows:
            leaves.setdefault(tuple(key_of(row[k]) for k in key_ats), set()).add(read(row[at]))
        tree: dict[int, Any] = {}
        for path, held in leaves.items():
            node = tree
            for key in path[:-1]:
                node = node.setdefault(key, {})
            node[path[-1]] = sorted(held)
        return tree


@dataclass(frozen=True)
class AsPairs:
    """Every distinct pair of two id columns, sorted."""

    left: str
    right: str

    def collect(self, rows: Rows, schema: Schema) -> list[tuple[int, int]]:
        """The pairs."""
        left, right = schema.at(self.left), schema.at(self.right)
        return sorted({(key_of(row[left]), key_of(row[right])) for row in rows})


@dataclass(frozen=True)
class Typed:
    """A column with the reader its cell goes through: ``text(c.Name_lang)``."""

    column: str
    read: Callable[[Cell], object]


Picked = str | Column | Typed
"""A column a terminal takes: by name, through ``c``, or with its reader."""


def text(named: str | Column) -> Typed:
    """The column read as its text."""
    return Typed(column_name(named), as_text)


def word(named: str | Column) -> Typed:
    """The column read as its text with the ends trimmed, as a name is."""
    return Typed(column_name(named), lambda cell: as_text(cell).strip())


def real(named: str | Column) -> Typed:
    """The column read as the number it holds, fraction kept."""
    return Typed(column_name(named), number_of)


def _typed(picked: Picked) -> Typed:
    """A picked column with its reader, ids by default."""
    return picked if isinstance(picked, Typed) else Typed(column_name(picked), key_of)


@dataclass(frozen=True)
class AsRows[T]:
    """One record per row, built from the columns in the record's own order.

    Sorted where the flow says so: a source's row order is its own and not a
    fact the pack should carry, so a route that ships rows in order says it.
    """

    record: Callable[..., T]
    columns: tuple[Typed, ...]
    sort: bool = False

    def collect(self, rows: Rows, schema: Schema) -> list[T]:
        """The records."""
        readers = [(schema.at(picked.column), picked.read) for picked in self.columns]
        out = [self.record(*(read(row[at]) for at, read in readers)) for row in rows]
        return sorted(out) if self.sort else out  # type: ignore[type-var]


@dataclass(frozen=True)
class AsIds:
    """The set of ids one column holds."""

    column: str

    def collect(self, rows: Rows, schema: Schema) -> set[int]:
        """The set."""
        at = schema.at(self.column)
        return {key_of(row[at]) for row in rows}


def as_text(cell: Cell) -> str:
    """A cell as its text."""
    if isinstance(cell, tuple):
        raise TypeError("an array column is not one text")
    return cell


def as_map(key: str | Column | Sequence[str | Column], value: Picked, *, first: bool = False) -> AsMap[Any]:
    """Land as key to value; a key of several columns is a tuple, a value an id unless typed."""
    keys = (key,) if isinstance(key, (str, Column)) else tuple(key)
    picked = _typed(value)
    return AsMap(tuple(column_name(name) for name in keys), picked.column, picked.read, first)


def as_sets(key: str | Column, *value: Picked) -> AsSets[Any]:
    """Land as key to the set of values under it, ids unless typed; several columns make a tuple."""
    return AsSets(column_name(key), tuple(_typed(picked) for picked in value))


def as_tree(*keys: str | Column, value: Picked) -> AsTree:
    """Land as nested maps down the keys, sorted lists at the leaves."""
    return AsTree(tuple(column_name(name) for name in keys), _typed(value))


def as_pairs(left: str | Column, right: str | Column) -> AsPairs:
    """Land as the sorted distinct pairs of two id columns."""
    return AsPairs(column_name(left), column_name(right))


def as_rows[T](record: Callable[..., T], *columns: Picked, sort: bool = False) -> AsRows[T]:
    """Land as one record per row, the columns in the record's field order, ids unless typed."""
    return AsRows(record, tuple(_typed(picked) for picked in columns), sort)


def as_ids(column: str | Column) -> AsIds:
    """Land as the set of ids a column holds."""
    return AsIds(column_name(column))


def gather(rows: Iterable[Row], schema: Schema, *columns: str | Column) -> Iterator[tuple[Cell, ...]]:
    """The named columns of each row, for a terminal written by hand."""
    ats = [schema.at(name) for name in columns]
    return (tuple(row[at] for at in ats) for row in rows)
