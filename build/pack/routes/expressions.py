"""A row's cells, the columns a flow names, and the expressions over them.

A condition inside a flow is an expression, never a function: ``c.Speed !=
1.0`` builds a value that prints as itself, that a second executor can
compile, and that an override can be compared against. The schema is the
columns a flow carries at one point, so a name resolves to a position once,
when the flow is written down.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, ClassVar, Protocol
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


class Column:
    """A column of the flow, named; the operators on it build expressions.

    ``T.SpellMisc.Speed != 1.0`` is a comparison, not a bool: the dunder
    methods return the expression as data, the way a lazy frame's columns do,
    so a flow can say what it asks without running it. Equality on a column
    is therefore an expression too, and a column is hashed by its name.
    """

    __slots__ = ("base", "table", "array")

    def __init__(self, name: str, table: str = "", array: bool | None = None) -> None:
        self.base = name
        """The name as the source spells it."""
        self.table = table
        """The table the column belongs to; empty for a computed one, or one
        named through ``c`` without its table."""
        self.array = array
        """Whether the column is an array on some build; None where nothing says."""

    @property
    def name(self) -> str:
        """The name the flow carries the column under: qualified by its table
        where it has one, the way SQL spells a joined column, so two tables'
        ``ID`` stay apart and a read can be settled from what names it."""
        return f"{self.table}.{self.base}" if self.table else self.base

    def __repr__(self) -> str:
        return spelled(self.name)

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

    def __getitem__(self, span: slice | int) -> Column:
        """The array column: ``Name[:]`` is every ``Name_N`` the build has, read
        as one cell and carried under the name with the star, so a step after
        the read names it the same way; ``Name[2]`` is the one slot ``Name_2``.

        Raises:
            ValueError: the column is no array, or the slice is not the whole.
        """
        if self.array is False:
            raise ValueError(f"{self!r} is no array column")
        if isinstance(span, int):
            return Column(f"{self.base}_{span}", self.table, array=False)
        if span != slice(None):
            raise ValueError("an array column is read whole; write Name[:]")
        return Column(f"{self.base}_*", self.table, array=False)


class Columns:
    """The namespace a column is named without its table: ``c.mask`` is the
    computed column ``mask``, and ``c.DifficultyID`` the column several tables
    carry, whichever the flow is on."""

    def __getattr__(self, name: str) -> Column:
        return Column(name)


c = Columns()
"""The namespace for a column named without its table."""


class Table:
    """A table a flow reads, named by its class, its columns the attributes.

    ``T.SpellEffect`` is the table ``SpellEffect`` and ``T.SpellEffect.SpellID``
    its column, so a misspelt name is the checker's error rather than the
    build's. The classes are generated from the source roster into
    ``catalogue.py``, one per table a build can read.
    """

    __tablename__: ClassVar[str] = ""

    def __init_subclass__(cls) -> None:
        super().__init_subclass__()
        cls.__tablename__ = cls.__name__
        for value in vars(cls).values():
            if isinstance(value, Column):
                value.table = cls.__name__
                if value.array is None:
                    value.array = False


def column_name(named: str | Column) -> str:
    """A column by name, whether it was written as a string or as a column."""
    return named.name if isinstance(named, Column) else named


def table_name(named: str | type[Table]) -> str:
    """A table by name, whether it was written as a string or as its class."""
    return named if isinstance(named, str) else named.__tablename__


def export_name(name: str) -> str:
    """The column as the source spells it, the table qualifier dropped."""
    return name.rpartition(".")[2]


def spelled(name: str) -> str:
    """A column name as a flow writes it: off its table, or through ``c``."""
    return f"T.{name}" if "." in name else f"c.{name}"


def has_column(table: type[Table], base: str) -> bool:
    """Whether the table's class declares the column, a slot or the whole of
    an array column included."""
    if isinstance(vars(table).get(base), Column):
        return True
    stem, _, suffix = base.rpartition("_")
    held = vars(table).get(stem)
    return isinstance(held, Column) and bool(held.array) and (suffix == "*" or suffix.isdigit())


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
        return f"{spelled(self.column)} {self.op} {self.value!r}"

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
        return f"{spelled(self.column)}.bit({self.which})"

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
        return f"coalesce({', '.join(spelled(name) for name in self.names)})"

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
        return f"bits_of({', '.join(spelled(name) for name in self.names)})"

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


def key_of(cell: Cell) -> int:
    """A source column as the id it names.

    A key is compared as a number rather than as text, because the same id is
    exported as ``12`` on one build and ``12.0`` on another.
    """
    if isinstance(cell, tuple):
        raise TypeError("an array column is no key")
    return to_int_from_float(cell)


@dataclass(frozen=True)
class Schema:
    """The columns a flow carries at one point, in order.

    A column is found by its full name, or by its bare name where one column
    carries it, the way SQL resolves an unqualified column.
    """

    columns: tuple[str, ...]

    open: tuple[type[Table], ...] = ()
    """Tables read with no columns listed: every column of each is carried
    until the plan settles, from what its later steps name, which it reads."""

    def _found(self, name: str) -> int | None:
        """The position of a carried column, or None."""
        if name in self.columns:
            return self.columns.index(name)
        if "." in name:
            return None
        matched = [at for at, held in enumerate(self.columns) if export_name(held) == name]
        if len(matched) > 1:
            raise KeyError(f"column {name!r} is carried by {len(matched)} tables; name its table")
        return matched[0] if matched else None

    def _open(self, name: str) -> bool:
        """Whether an open table carries the column."""
        table, _, base = name.rpartition(".")
        return any((not table or table == held.__tablename__) and has_column(held, base) for held in self.open)

    def check(self, name: str | Column) -> None:
        """That the flow carries the column, settled or not.

        Raises:
            KeyError: it does not, named with what the flow does carry.
        """
        name = column_name(name)
        if self._found(name) is None and not self._open(name):
            tables = "".join(f", every column of {held.__tablename__}" for held in self.open)
            raise KeyError(f"no column {name!r}; the flow carries {', '.join(self.columns)}{tables}")

    def at(self, name: str | Column) -> int:
        """Where one column sits.

        Raises:
            KeyError: the flow does not carry it, named with what it does.
            ValueError: it is carried by a read not yet settled, so it has no
                position until the plan runs.
        """
        name = column_name(name)
        found = self._found(name)
        if found is None:
            if self._open(name):
                raise ValueError(f"column {name!r} has no position until the plan settles its reads")
            self.check(name)
        return found if found is not None else -1

    def with_columns(self, *names: str) -> Schema:
        """This schema with columns appended.

        Raises:
            ValueError: a name is already carried, so it would be reachable
                only by position.
        """
        taken = [name for name in names if name in self.columns]
        if taken:
            raise ValueError(f"{', '.join(taken)} already carried; a column is named once")
        return Schema((*self.columns, *names), self.open)

    def opened(self, table: type[Table]) -> Schema:
        """This schema with every column of a table carried, unsettled."""
        return Schema(self.columns, (*self.open, table))

    def without(self, *names: str) -> Schema:
        """This schema less the columns named."""
        return Schema(tuple(name for name in self.columns if name not in names), self.open)
