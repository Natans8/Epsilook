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

import inspect
from collections.abc import Callable, Container, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
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

    def among(self, values: Iterable[int]) -> Compare:
        """Whether the id this column holds is one of the values."""
        return Compare(self.name, "in", frozenset(values))

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
        """The column, and the other column where the comparison is against one."""
        named = {self.column}
        if isinstance(self.value, Column):
            named.add(self.value.name)
        return frozenset(named)

    def evaluate(self, row: Row, schema: Schema) -> bool:
        """The comparison on one row: numerically for a number, as text otherwise,
        and as text against another column."""
        cell = row[schema.at(self.column)]
        if self.op == "in":
            values = self.value
            if not isinstance(values, frozenset):
                raise TypeError("membership is tested against the values `among` was given")
            # The narrowing above is the check pylint cannot follow through `object`.
            return key_of(cell) in values  # pylint: disable=unsupported-membership-test
        if isinstance(self.value, Column):
            other = row[schema.at(self.value.name)]
            if self.op == "==":
                return cell == other
            if self.op == "!=":
                return cell != other
            raise TypeError(f"two columns compare only for equality, not {self.op}")
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
class Coalesce:
    """The first of several columns holding a number other than nought, as
    that number: an amount a build exports in two spellings, one of them
    left at zero."""

    names: tuple[str, ...]
    digits: int | None = None
    """Places to round to, where the spellings carry conversion noise."""

    def __repr__(self) -> str:
        return f"coalesce({', '.join(f'c.{name}' for name in self.names)})"

    def columns(self) -> frozenset[str]:
        """The columns tried."""
        return frozenset(self.names)

    def evaluate(self, row: Row, schema: Schema) -> float:
        """The first spelling that is non-empty and non-zero, or nought."""
        for name in self.names:
            cell = row[schema.at(name)]
            if cell and (held := number_of(cell)):
                return held if self.digits is None else round(held, self.digits)
        return 0.0


@dataclass(frozen=True)
class BitsOf:
    """Several id columns unioned as bits: the mask two target columns make."""

    names: tuple[str, ...]

    def __repr__(self) -> str:
        return f"bits_of({', '.join(f'c.{name}' for name in self.names)})"

    def columns(self) -> frozenset[str]:
        """The columns unioned."""
        return frozenset(self.names)

    def evaluate(self, row: Row, schema: Schema) -> int:
        """The union."""
        mask = 0
        for name in self.names:
            mask |= key_of(row[schema.at(name)])
        return mask


def coalesce(*columns: str | Column, digits: int | None = None) -> Coalesce:
    """The first of the columns holding a number other than nought, rounded where asked."""
    return Coalesce(tuple(column_name(name) for name in columns), digits)


def bits_of(*columns: str | Column) -> BitsOf:
    """The columns' ids unioned as bits."""
    return BitsOf(tuple(column_name(name) for name in columns))


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

    def __and__(self, other: Expr) -> Both:
        return Both(self, other)

    def __or__(self, other: Expr) -> Either:
        return Either(self, other)


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


def _flattened(tables: Tables, table: str, columns: Sequence[str]) -> tuple[list[str], list[int]]:
    """The provider's own column names behind the ones asked for, an array
    column standing for every ``Name_N`` the build has, with each column's width."""
    arrays = {name: _array_columns(tables, table, name[:-2]) for name in columns if name.endswith("_*")}
    flat = [name for column in columns for name in arrays.get(column, [column])]
    widths = [len(arrays.get(column, [column])) for column in columns]
    return flat, widths


def _read(tables: Tables, table: str, columns: Sequence[str]) -> Rows:
    """The table's rows by the columns named, an array column read whole into one cell."""
    if not any(name.endswith("_*") for name in columns):
        return tables.rows(table, columns)
    flat, widths = _flattened(tables, table, columns)
    return _gathered(tables.rows(table, flat), widths)


def _gathered(rows: Iterator[tuple[str, ...]], widths: Sequence[int]) -> Rows:
    """Rows with each array's columns folded back into one cell."""
    for row in rows:
        out: list[Cell] = []
        at = 0
        for width in widths:
            out.append(row[at] if width == 1 else tuple(row[at : at + width]))
            at += width
        yield tuple(out)


def _blank(columns: Sequence[str]) -> Row:
    """The cells a missed join fills in: empty text, or an empty array."""
    return tuple(() if name.endswith("_*") else "" for name in columns)


def _held(source: str, tables: Tables, needs: Needs) -> Tables | None:
    """The tables a step reads from: the build's own, or another source the
    wiring holds, such as the pinned build, the server dump or the client's
    unrevised tables; None where the build lacks that source."""
    if source == "tables":
        return tables
    found: Tables | None = needs.get(source)
    return found


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

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether this build has the table, in the source it is read from."""
        held = _held(self.source, tables, needs)
        return held is not None and held.available(self.table)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Read the table."""
        del incoming, incoming_schema, version
        held = _held(self.source, tables, needs)
        if held is None or (self.optional and not held.available(self.table)):
            return iter(())
        return _read(held, self.table, self.columns)


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

    source: str = "tables"
    """Which given the joined table is read from, as a read names it."""

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the joined ones."""
        incoming.at(self.key)
        return incoming.with_columns(*self.columns)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Append each row's joined columns.

        The other table is indexed per run, never on the step: a declaration
        is shared by every build and every language, and an index kept on it
        would answer the next run with the last run's table.
        """
        del version
        index: dict[int, list[Row]] = {}
        held = _held(self.source, tables, needs)
        for source in _read(held, self.table, [self.by, *self.columns]) if held is not None else ():
            key = key_of(source[0])
            if self.many:
                index.setdefault(key, []).append(source[1:])
            else:
                index[key] = [source[1:]]
        at = incoming_schema.at(self.key)
        blank = _blank(self.columns)
        for row in incoming:
            found = index.get(key_of(row[at]))
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

    slot: str = ""
    """A column for the position a value came from, counted over every value
    fanned, where the position means something: the legacy creature table
    keeps a display's slot as which column it sits in."""

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns less the fanned ones, then the one they became."""
        for name in self.columns:
            incoming.at(name)
        return incoming.without(*self.columns).with_columns(self.into, *((self.slot,) if self.slot else ()))

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """One row per non-empty value among the fanned columns."""
        del tables, version, needs
        fanned = [incoming_schema.at(name) for name in self.columns]
        kept = [at for at, name in enumerate(incoming_schema.columns) if name not in self.columns]
        for row in incoming:
            base = tuple(row[at] for at in kept)
            position = 0
            for at in fanned:
                cell = row[at]
                values = cell if isinstance(cell, tuple) else (cell,)
                for value in values:
                    if key_of(value):
                        yield (*base, value, *((str(position),) if self.slot else ()))
                    position += 1


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
    """Per column of the table naming another row, the bit that hop carries;
    an array column ``Name_*`` is every ``Name_N`` the build has, one bit."""

    into: str
    bits: str
    by: str = "ID"

    source: str = "tables"
    """Which given the table is read from, as a read names it."""

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the reached id and its bits."""
        incoming.at(self.key)
        return incoming.with_columns(self.into, self.bits)

    @staticmethod
    def reached(seed: int, hops: Mapping[int, list[tuple[int, int]]]) -> dict[int, int]:
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
            for target, bit in hops.get(node, ()):
                queue.append((target, mask | bit))
        return out

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """One row per id each seed reaches; the edges are read per run, as a join's index is."""
        del version
        hops: dict[int, list[tuple[int, int]]] = {}
        held = _held(self.source, tables, needs)
        if held is None:
            return
        columns, widths = _flattened(held, self.table, list(self.edges))
        bits = [bit for bit, width in zip(self.edges.values(), widths) for _each in range(width)]
        for source in held.rows(self.table, [self.by, *columns]):
            node = key_of(source[0])
            found = [(target, bit) for target, bit in zip(map(key_of, source[1:]), bits) if target and target != node]
            if found:
                hops[node] = found
        at = incoming_schema.at(self.key)
        for row in incoming:
            for node, mask in self.reached(key_of(row[at]), hops).items():
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
        return (self.one(row, incoming_schema, {}) for row in incoming)

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row:
        """One row with the value appended."""
        del needs
        value = self.expr.evaluate(row, schema)
        return (*row, str(int(value)) if isinstance(value, bool) else str(value))


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
        del tables
        if not self.holds(version):
            return iter(())
        return (row for row in incoming if self.one(row, incoming_schema, needs) is not None)

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row | None:
        """The row where the selector chooses it, on a build where the meaning holds.

        A reference of nought names no row unless the slot says nought is
        data, so such a row is dropped here rather than by every reader.
        """
        del needs
        if key_of(row[schema.at(self.on)]) not in self.values:
            return None
        for slot in self.slots:
            if slot.holds is Holds.AMOUNT or slot.zero_is_a_value:
                continue
            if key_of(row[schema.at(slot.column)]) <= 0:
                return None
        return row


@dataclass(frozen=True)
class AnyOf:
    """The rows any of several selectors on one column chooses: an id the
    game reused, so the stable values and the retired ones are two
    selections landing in one place."""

    selectors: tuple[When, ...]

    def __post_init__(self) -> None:
        if len({chosen.on for chosen in self.selectors}) != 1:
            raise ValueError("the selectors of any_of choose on one column")

    @property
    def on(self) -> str:
        """The column every selector chooses on."""
        return self.selectors[0].on

    def schema(self, incoming: Schema) -> Schema:
        """Unchanged."""
        for chosen in self.selectors:
            chosen.schema(incoming)
        return incoming

    def live(self, version: str) -> tuple[When, ...]:
        """The selectors still meaning this on the build."""
        return tuple(chosen for chosen in self.selectors if chosen.holds(version))

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """The rows any live selector chooses."""
        del tables
        live = self.live(version)
        return (row for row in incoming if any(chosen.one(row, incoming_schema, needs) is not None for chosen in live))

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row | None:
        """The row where any selector chooses it; the build's retirements are
        applied by whoever runs this per row."""
        return row if any(chosen.one(row, schema, needs) is not None for chosen in self.selectors) else None


def any_of(*selectors: When) -> AnyOf:
    """The rows any of the selectors chooses."""
    return AnyOf(selectors)


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

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row | None:
        """The row where it passes."""
        del needs
        return row if self.keep.evaluate(row, schema) else None


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

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row | None:
        """The row where the roster admits it."""
        roster = needs[self.roster] if isinstance(self.roster, str) else self.roster
        return row if key_of(row[schema.at(self.column)]) in roster else None


@dataclass(frozen=True)
class Lookup:
    """A join through a field rather than a table: the rows whose column the
    field holds, each carrying the field's value under a new name.

    What a flow reaches through another route's answer: a kit's procedure
    row is a chain id only once the procedure route has said which rows are
    chains, and the id lives in that field. The value is carried as text,
    the way every cell is, so the field's values are ids.
    """

    column: str
    field: str | Mapping[int, object]
    """The field's path, or a mapping written where the declaration is."""
    into: str

    default: object = None
    """What a row the field does not answer carries; None drops the row."""

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the value found."""
        incoming.at(self.column)
        return incoming.with_columns(self.into)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """The rows the field answers, with its answer appended."""
        del tables, version
        return (found for row in incoming if (found := self.one(row, incoming_schema, needs)) is not None)

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row | None:
        """The row with the field's answer appended, or the default, or nothing."""
        held: Mapping[int, object] = needs[self.field] if isinstance(self.field, str) else self.field
        found = held.get(key_of(row[schema.at(self.column)]), self.default)
        return None if found is None else (*row, str(found))


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
        with this directly. A tail, a flow that starts with no read, is
        checked when it is joined to the trunk it branches from.
        """
        grown = Flow(self.name, (*self.steps, step))
        if grown.is_tail:
            for held in grown.steps:
                if not hasattr(held, "one"):
                    raise ValueError(
                        f"flow {self.name!r} must start by reading a table; "
                        f"a branch of one cannot {type(held).__name__.lower()}, it takes one row at a time"
                    )
        else:
            grown.schema()
        return grown

    @property
    def is_tail(self) -> bool:
        """Whether the flow starts with no read: the steps of a branch, or none."""
        return not (self.steps and isinstance(self.steps[0], Read))

    def read(self, table: str, *columns: str | Column, optional: bool = False, source: str = "tables") -> Flow:
        """Start from one table's rows, by the columns named."""
        return self | Read(table, tuple(column_name(name) for name in columns), optional, source)

    def join(
        self,
        key: str | Column,
        table: str,
        *columns: str | Column,
        by: str = "ID",
        inner: bool = False,
        many: bool = False,
        source: str = "tables",
    ) -> Flow:
        """Hop through a key into another table, taking the columns named."""
        return self | Join(
            column_name(key), table, tuple(column_name(name) for name in columns), by, inner, many, source
        )

    def explode(self, *columns: str | Column, into: str, slot: str = "") -> Flow:
        """One row per value among the columns named, under one name, and its position where asked."""
        return self | Explode(tuple(column_name(name) for name in columns), into, slot)

    def lookup(
        self, column: str | Column, field: str | Mapping[int, object], *, into: str, default: object = None
    ) -> Flow:
        """Hop through a field, or a mapping written here: the rows it answers
        carry its answer, and the rest carry the default or are dropped."""
        return self | Lookup(column_name(column), field, into, default)

    def expand(
        self, key: str | Column, table: str, edges: Mapping[str, int], *, into: str, bits: str, source: str = "tables"
    ) -> Flow:
        """Every row the key reaches through the table's own references, with the bits the path took."""
        return self | Expand(column_name(key), table, dict(edges), into, bits, source=source)

    def prefer(self, key: str | Column, *, base: Expr) -> Flow:
        """One row per key, the base row standing for it."""
        return self | Prefer(column_name(key), base)

    def map(self, into: str, expr: Expr) -> Flow:
        """A computed column, appended."""
        return self | Map(into, expr)

    def when(self, on: str, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> Flow:
        """Keep the rows a selector chooses, and say what their columns then mean."""
        return self | when(on, values, slots, until)

    def any_of(self, *selectors: When) -> Flow:
        """Keep the rows any of several selectors on one column chooses."""
        return self | AnyOf(selectors)

    def where(self, keep: Expr) -> Flow:
        """Keep the rows the expression holds on."""
        return self | Where(keep)

    def narrow(self, column: str | Column, roster: Container[int] | str, doc: str = "") -> Flow:
        """Keep the rows whose column names something the roster holds."""
        return self | Narrow(column_name(column), roster, doc)

    def __rshift__[T](self, terminal: Terminal[T]) -> Plan[T]:
        """Land the rows in a shape: ``flow >> as_map(...)`` is the whole route."""
        return Plan(self, terminal)

    def split[T](self, record: Callable[..., T], **branches: Plan[Any] | Then[Any] | Landing) -> Split[T]:
        """Land the rows in several shapes at once: one read, a branch per
        field of the record, each a tail of steps and a terminal; the one
        marked as the landing takes the rows themselves, flagged."""
        return Split(self, record, branches)

    def schema(self, incoming: Schema | None = None) -> Schema:
        """The columns the flow's rows carry; a tail's, from the trunk's given.

        Raises:
            KeyError: a step names a column the flow does not carry there.
            ValueError: the flow has no origin and no trunk, or a step
                repeats a name.
        """
        if incoming is None and self.is_tail:
            raise ValueError(f"flow {self.name!r} must start by reading a table")
        current = incoming if self.is_tail and incoming is not None else Schema(())
        for step in self.steps:
            current = step.schema(current)
        return current

    def schemas(self, incoming: Schema) -> list[tuple[Step, Schema]]:
        """Each step with the schema its rows arrive in, for a tail run one row at a time."""
        out: list[tuple[Step, Schema]] = []
        current = incoming
        for step in self.steps:
            out.append((step, current))
            current = step.schema(current)
        return out

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
        fields = {
            step.field for step in self.of_kind(Lookup) if isinstance(step, Lookup) and isinstance(step.field, str)
        }
        sources = {
            step.source for step in self.steps if isinstance(step, (Read, Join, Expand)) and step.source != "tables"
        }
        return frozenset(rosters | fields | sources)

    @property
    def origin(self) -> Read:
        """The table the flow starts from."""
        first = self.steps[0]
        if not isinstance(first, Read):
            raise ValueError(f"flow {self.name!r} must start by reading a table")
        return first

    @property
    def tables(self) -> list[str]:
        """Every table the flow reads, origin first, joins and expansions after."""
        named: list[str] = []
        for step in self.steps:
            if isinstance(step, Read):
                named.append(step.table)
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


class Runnable[T]:
    """What the registry runs for a field: a plan, a plan with a step after
    it, the first of several plans this build can run, or a record composed
    of other fields. Each says what it needs, whether the build has what it
    reads, and runs."""

    @property
    def needs(self) -> frozenset[str]:
        """The field paths this names, for the wiring to resolve first."""
        raise NotImplementedError

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether this build has the table it starts from."""
        del tables, needs
        return True

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The shape, from one build's tables."""
        raise NotImplementedError

    def then[U](self, assemble: Callable[..., U], **wants: str) -> Then[U]:
        """A step after the collection: a function of the shape, and of any
        further fields named, for the bundle a flow's rows do not spell alone."""
        return Then(self, assemble, wants)


@dataclass(frozen=True)
class Plan[T](Runnable[T]):
    """A flow with its terminal: the whole of a route, runnable."""

    flow: Flow
    terminal: Terminal[T]

    @property
    def needs(self) -> frozenset[str]:
        """The flow's needs."""
        return self.flow.needs

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether the build has the flow's origin table."""
        return self.flow.origin.available(tables, needs)

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The shape, from one build's tables."""
        return self.terminal.collect(self.flow.rows(tables, version, needs), self.flow.schema())


@dataclass(frozen=True)
class Then[U](Runnable[U]):
    """A plan whose result a function reshapes, with further fields by name."""

    plan: Runnable[Any]
    assemble: Callable[..., U]
    wants: Mapping[str, str]
    """Per parameter of `assemble` after the first, the field path it takes."""

    @property
    def needs(self) -> frozenset[str]:
        """The plan's needs and the fields the step wants."""
        return self.plan.needs | frozenset(self.wants.values())

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether the plan underneath can run."""
        return self.plan.available(tables, needs)

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> U:
        """The reshaped result."""
        held = needs or {}
        return self.assemble(
            self.plan.run(tables, version, held), **{name: held[path] for name, path in self.wants.items()}
        )


@dataclass(frozen=True)
class Alternatives[T](Runnable[T]):
    """The first of several plans whose table this build has: one fact whose
    table, or whose shape, differs between builds, each spelling its own plan.

    A build with none of them runs the first, which reads nothing where its
    table is declared absent and fails where the absence is undeclared, as
    any read does.
    """

    plans: tuple[Runnable[T], ...]

    @property
    def needs(self) -> frozenset[str]:
        """Every plan's needs, since which runs is not known until the build is."""
        return frozenset().union(*(plan.needs for plan in self.plans))

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether any of the plans can run."""
        return any(plan.available(tables, needs) for plan in self.plans)

    def chosen(self, tables: Tables, needs: Needs) -> Runnable[T]:
        """The plan this build runs."""
        return next((plan for plan in self.plans if plan.available(tables, needs)), self.plans[0])

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The chosen plan's result."""
        held = needs or {}
        return self.chosen(tables, held).run(tables, version, held)


@dataclass(frozen=True)
class Composed[T](Runnable[T]):
    """A field built from other fields alone: a record whose every part is a
    field of its own, or a function merging several."""

    build: Callable[..., T]
    sources: Mapping[str, str]
    """Per parameter of `build`, the field path it takes."""

    @property
    def needs(self) -> frozenset[str]:
        """The fields it is built from."""
        return frozenset(self.sources.values())

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The record, from the fields."""
        del tables, version
        held = needs or {}
        return self.build(**{name: held[path] for name, path in self.sources.items()})


@dataclass(frozen=True)
class Split[T](Runnable[T]):
    """One read landing in several shapes: a trunk, and per field of a
    record a branch of filter steps and a terminal, every branch fed each
    row of the one pass.

    What a selected meaning is when the selector column is one of many: a
    misc value is a creature under one aura and a form under another, so the
    row is read once and each branch keeps what its selector chooses. The
    ``rows`` branch lands the rows themselves, and its rows carry, per column
    the branches select on, whether any branch chose the row: what a
    dedicated landing already shows, the row need not show again.
    """

    trunk: Flow
    record: Callable[..., T]
    declared: Mapping[str, Plan[Any] | Then[Any] | Landing]

    def __post_init__(self) -> None:
        """Check every branch against the trunk when the split is written."""
        if sum(isinstance(plan, Landing) for plan in self.declared.values()) > 1:
            raise ValueError("a split lands its rows once")
        schema = self.trunk.schema()
        for plan in self.branches.values():
            _planned(plan).flow.schema(schema)
        if self.landing is not None:
            _planned(self.landing).flow.schema(self.landing_schema(schema))

    @property
    def branches(self) -> dict[str, Plan[Any] | Then[Any]]:
        """The branches that select, by the field each lands in."""
        return {name: plan for name, plan in self.declared.items() if not isinstance(plan, Landing)}

    @property
    def landing(self) -> Plan[Any] | Then[Any] | None:
        """The branch that lands the rows themselves, if one is marked."""
        return next((plan.plan for plan in self.declared.values() if isinstance(plan, Landing)), None)

    @property
    def landing_name(self) -> str:
        """The field the landing fills."""
        return next(name for name, plan in self.declared.items() if isinstance(plan, Landing))

    @property
    def selects_on(self) -> tuple[str, ...]:
        """The columns the branches select on, sorted."""
        found: set[str] = set()
        for plan in self.branches.values():
            for step in _planned(plan).flow.steps:
                if isinstance(step, (When, AnyOf)):
                    found.add(step.on)
        return tuple(sorted(found))

    def landing_schema(self, schema: Schema) -> Schema:
        """The trunk's schema with a consumed flag per selected column."""
        return schema.with_columns(*(f"consumed_{on}" for on in self.selects_on))

    @property
    def selectors(self) -> tuple[When, ...]:
        """Every selector a branch declares, in branch order, each once: two
        branches over one selector land its ids and its masks apart, and the
        selector is one declaration."""
        found: dict[When, None] = {}
        for plan in self.branches.values():
            for step in _planned(plan).flow.steps:
                if isinstance(step, When):
                    found[step] = None
                elif isinstance(step, AnyOf):
                    found.update(dict.fromkeys(step.selectors))
        return tuple(found)

    @property
    def needs(self) -> frozenset[str]:
        """The trunk's needs and every branch's."""
        named = set(self.trunk.needs)
        for plan in self.branches.values():
            named |= plan.needs
        if self.landing is not None:
            named |= self.landing.needs
        return frozenset(named)

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether the build has the trunk's table."""
        return self.trunk.origin.available(tables, needs)

    @staticmethod
    def _live(plan: Plan[Any] | Then[Any], schema: Schema, version: str) -> list[tuple[Any, Schema]] | None:
        """A branch's steps with their schemas, or None on a build past a selector's meaning."""
        steps = _planned(plan).flow.schemas(schema)
        for step, _incoming in steps:
            if isinstance(step, When) and not step.holds(version):
                return None
            if isinstance(step, AnyOf):
                if not step.live(version):
                    return None
                steps = [(AnyOf(step.live(version)), held) if s is step else (s, held) for s, held in steps]
        return steps

    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """Every landing, from one pass over the trunk's rows."""
        held = needs or {}
        schema = self.trunk.schema()
        ons = self.selects_on
        live: list[tuple[str, list[tuple[Any, Schema]], frozenset[str]]] = []
        for name, plan in self.branches.items():
            steps = self._live(plan, schema, version)
            if steps is not None:
                chosen = frozenset(step.on for step, _ in steps if isinstance(step, (When, AnyOf)))
                live.append((name, steps, chosen))
        accepted: dict[str, list[Row]] = {name: [] for name in self.branches}

        def landed(rows: Rows) -> Rows:
            """Each trunk row through every branch, then the row with its flags."""
            for row in rows:
                hit: set[str] = set()
                for name, steps, chosen in live:
                    out: Row | None = row
                    for step, incoming in steps:
                        out = step.one(out, incoming, held)
                        if out is None:
                            break
                    if out is not None:
                        accepted[name].append(out)
                        hit |= chosen
                yield (*row, *("1" if on in hit else "0" for on in ons))

        results: dict[str, Any] = {}
        landing_rows = landed(self.trunk.rows(tables, version, held))
        if self.landing is None:
            for _row in landing_rows:
                pass
        else:
            landing_schema = self.landing_schema(schema)
            steps = self._live(self.landing, landing_schema, version) or []
            chosen_rows = (out for row in landing_rows if (out := self._through(row, steps, held)) is not None)
            results[self.landing_name] = _landed(self.landing, chosen_rows, landing_schema, held)
        for name, plan in self.branches.items():
            results[name] = _landed(plan, iter(accepted[name]), schema, held)
        return self.record(**results)

    @staticmethod
    def _through(row: Row, steps: list[tuple[Any, Schema]], needs: Needs) -> Row | None:
        """One row through a branch's steps."""
        out: Row | None = row
        for step, incoming in steps:
            out = step.one(out, incoming, needs)
            if out is None:
                return None
        return out


@dataclass(frozen=True)
class Landing:
    """The branch of a split that takes the rows themselves, each flagged
    per selected column with whether a branch chose it."""

    plan: Plan[Any] | Then[Any]


def landing(plan: Plan[Any] | Then[Any]) -> Landing:
    """Mark the branch of a split that lands the rows themselves."""
    return Landing(plan)


def _planned(plan: Plan[Any] | Then[Any]) -> Plan[Any]:
    """The plan a branch runs, under whatever reshaping follows it."""
    if isinstance(plan, Then):
        if not isinstance(plan.plan, Plan):
            raise TypeError("a branch reshapes a plan once; it does not nest")
        return plan.plan
    return plan


def _landed(plan: Plan[Any] | Then[Any], rows: Rows, schema: Schema, needs: Needs) -> Any:
    """A branch's rows landed in its shape, reshaped where the branch says."""
    inner = _planned(plan)
    found = inner.terminal.collect(rows, inner.flow.schema(schema))
    if isinstance(plan, Then):
        return plan.assemble(found, **{name: needs[path] for name, path in plan.wants.items()})
    return found


def first_available[T](*plans: Runnable[T]) -> Alternatives[T]:
    """The first of the plans whose table this build has."""
    return Alternatives(plans)


def compose[T](build: Callable[..., T], **sources: str) -> Composed[T]:
    """A field composed of other fields: every parameter of ``build`` is one,
    named for itself unless mapped.

    A record composes from its own field names, so a dataclass whose fields
    are the declared fields needs no mapping at all; a merge function names
    its inputs for the fields it merges.

    Raises:
        ValueError: a mapping names a parameter ``build`` does not take.
    """
    parameters = inspect.signature(build).parameters
    unknown = sorted(set(sources) - set(parameters))
    if unknown:
        raise ValueError(f"{', '.join(unknown)} is not a parameter of {getattr(build, '__name__', build)}")
    return Composed(build, {name: sources.get(name, name) for name in parameters})


def _picker(schema: Schema, columns: Sequence[Typed]) -> Callable[[Row], tuple[Any, ...]]:
    """The named columns of a row, each through its reader: ids unless typed."""
    readers = [(schema.at(picked.column), picked.read) for picked in columns]
    return lambda row: tuple(read(row[at]) for at, read in readers)


@dataclass(frozen=True)
class AsMap[T]:
    """Key to one value: the last row per key wins, as a source's revisions do,
    unless the flow says the first stands.

    Any in the key: an id, or a tuple of ids where the key is several columns,
    which the declaration says and the type cannot; the field the map lands
    in types it on the way into the context.
    """

    key: tuple[Typed, ...]
    value: str
    read: Callable[[Cell], T]
    first: bool = False
    reduce: Callable[[T, T], T] | None = None
    """How two values under one key combine, where neither simply wins: the
    least of two map ids, say."""

    def collect(self, rows: Rows, schema: Schema) -> dict[Any, T]:
        """The map."""
        keys = _picker(schema, self.key)
        at = schema.at(self.value)
        out: dict[Any, T] = {}
        single = len(self.key) == 1
        for row in rows:
            key = keys(row)
            held = key[0] if single else key
            if held in out:
                if self.first:
                    continue
                if self.reduce is not None:
                    out[held] = self.reduce(out[held], self.read(row[at]))
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
class AsRecords[T]:
    """Key to one record built from the columns, the last row per key
    standing unless the flow says the first does."""

    key: str
    record: Callable[..., T]
    columns: tuple[Typed, ...]
    first: bool = False

    def collect(self, rows: Rows, schema: Schema) -> dict[int, T]:
        """The records by key."""
        key_at = schema.at(self.key)
        readers = [(schema.at(picked.column), picked.read) for picked in self.columns]
        out: dict[int, T] = {}
        for row in rows:
            key = key_of(row[key_at])
            if self.first and key in out:
                continue
            out[key] = self.record(*(read(row[at]) for at, read in readers))
        return out


@dataclass(frozen=True)
class AsLists[T]:
    """Key to the values under it in the order met, each once: what a set
    loses, where the source's order is the fact a reader wants back."""

    key: str
    value: tuple[Typed, ...]
    record: Callable[..., T] | None = None
    """What several columns become, where not a tuple."""

    def collect(self, rows: Rows, schema: Schema) -> dict[int, list[T]]:
        """The lists."""
        key_at = schema.at(self.key)
        readers = [(schema.at(picked.column), picked.read) for picked in self.value]
        held: dict[int, dict[T, None]] = {}
        for row in rows:
            values = tuple(read(row[at]) for at, read in readers)
            if self.record is not None:
                found = self.record(*values)
            else:
                found = values[0] if len(values) == 1 else values  # type: ignore[assignment]
            held.setdefault(key_of(row[key_at]), {})[found] = None
        return {key: list(found) for key, found in held.items()}


@dataclass(frozen=True)
class AsNested[T]:
    """Key under key to one value: a spell's visuals, each with its mask."""

    outer: Typed
    inner: Typed
    value: str
    read: Callable[[Cell], T]
    reduce: Callable[[T, T], T] | None = None
    """How two values under one pair combine; otherwise the last stands."""

    def collect(self, rows: Rows, schema: Schema) -> dict[Any, dict[Any, T]]:
        """The nested maps."""
        outer_at, inner_at, at = schema.at(self.outer.column), schema.at(self.inner.column), schema.at(self.value)
        out: dict[Any, dict[Any, T]] = {}
        for row in rows:
            inner = out.setdefault(self.outer.read(row[outer_at]), {})
            key = self.inner.read(row[inner_at])
            found = self.read(row[at])
            inner[key] = self.reduce(inner[key], found) if self.reduce is not None and key in inner else found
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


def flag(named: str | Column) -> Typed:
    """A computed truth, written as 1 or 0, read back as a bool."""
    return Typed(column_name(named), lambda cell: cell == "1")


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
    sort: bool | Callable[[T], Any] = False
    """Whether to sort the records, and by what where they have no order of their own."""

    def collect(self, rows: Rows, schema: Schema) -> list[T]:
        """The records."""
        readers = [(schema.at(picked.column), picked.read) for picked in self.columns]
        out = [self.record(*(read(row[at]) for at, read in readers)) for row in rows]
        if callable(self.sort):
            return sorted(out, key=self.sort)
        return sorted(out) if self.sort else out  # type: ignore[type-var]


@dataclass(frozen=True)
class AsIds:
    """The set of ids one column holds, or of the tuples several make."""

    columns: tuple[str, ...]

    def collect(self, rows: Rows, schema: Schema) -> set[Any]:
        """The set."""
        ats = [schema.at(name) for name in self.columns]
        if len(ats) == 1:
            at = ats[0]
            return {key_of(row[at]) for row in rows}
        return {tuple(key_of(row[at]) for at in ats) for row in rows}


def as_text(cell: Cell) -> str:
    """A cell as its text."""
    if isinstance(cell, tuple):
        raise TypeError("an array column is not one text")
    return cell


def as_map(
    key: Picked | Sequence[Picked],
    value: Picked,
    *,
    first: bool = False,
    reduce: Callable[[Any, Any], Any] | None = None,
) -> AsMap[Any]:
    """Land as key to value; a key of several columns is a tuple, each an id unless typed, a value likewise."""
    keys = (key,) if isinstance(key, (str, Column, Typed)) else tuple(key)
    picked = _typed(value)
    return AsMap(tuple(_typed(name) for name in keys), picked.column, picked.read, first, reduce)


def as_sets(key: str | Column, *value: Picked) -> AsSets[Any]:
    """Land as key to the set of values under it, ids unless typed; several columns make a tuple."""
    return AsSets(column_name(key), tuple(_typed(picked) for picked in value))


def as_records[T](key: str | Column, record: Callable[..., T], *columns: Picked, first: bool = False) -> AsRecords[T]:
    """Land as key to one record per key, its columns in the record's field order."""
    return AsRecords(column_name(key), record, tuple(_typed(picked) for picked in columns), first)


def typed(named: str | Column, read: Callable[[Cell], object]) -> Typed:
    """The column read through a reader of your own, for the one shape the readers here do not spell."""
    return Typed(column_name(named), read)


def values_of(cell: Cell) -> tuple[str, ...]:
    """A cell as the texts it holds: an array's every text, a scalar's one."""
    return cell if isinstance(cell, tuple) else (cell,)


def ids_of(cell: Cell) -> tuple[int, ...]:
    """The ids an array cell holds, nought dropped, a repeat dropped, slot order kept."""
    return tuple(dict.fromkeys(held for held in map(key_of, values_of(cell)) if held))


def nonzero[K, V](found: Mapping[K, V]) -> dict[K, V]:
    """The entries whose value is something: a colour of nought, an empty
    tuple and an empty text are absences a map should not carry."""
    return {key: value for key, value in found.items() if value}


def ordered[K, V](found: Mapping[K, Iterable[V]]) -> dict[K, list[V]]:
    """Each entry's values sorted, where a source's order is not a fact."""
    return {key: sorted(values) for key, values in found.items()}  # type: ignore[type-var]


def as_lists(key: str | Column, *value: Picked, record: Callable[..., Any] | None = None) -> AsLists[Any]:
    """Land as key to its values in the order met, each once; several columns make a tuple, or the record named."""
    return AsLists(column_name(key), tuple(_typed(picked) for picked in value), record)


def as_nested(
    outer: Picked, inner: Picked, value: Picked, *, reduce: Callable[[Any, Any], Any] | None = None
) -> AsNested[Any]:
    """Land as key under key to one value, each an id unless typed."""
    picked = _typed(value)
    return AsNested(_typed(outer), _typed(inner), picked.column, picked.read, reduce)


def as_tree(*keys: str | Column, value: Picked) -> AsTree:
    """Land as nested maps down the keys, sorted lists at the leaves."""
    return AsTree(tuple(column_name(name) for name in keys), _typed(value))


def as_pairs(left: str | Column, right: str | Column) -> AsPairs:
    """Land as the sorted distinct pairs of two id columns."""
    return AsPairs(column_name(left), column_name(right))


def as_rows[T](record: Callable[..., T], *columns: Picked, sort: bool | Callable[[T], Any] = False) -> AsRows[T]:
    """Land as one record per row, the columns in the record's field order, ids unless typed."""
    return AsRows(record, tuple(_typed(picked) for picked in columns), sort)


def as_ids(*columns: str | Column) -> AsIds:
    """Land as the set of ids a column holds, or of the tuples several columns make."""
    return AsIds(tuple(column_name(name) for name in columns))


def gather(rows: Iterable[Row], schema: Schema, *columns: str | Column) -> Iterator[tuple[Cell, ...]]:
    """The named columns of each row, for a terminal written by hand."""
    ats = [schema.at(name) for name in columns]
    return (tuple(row[at] for at in ats) for row in rows)
