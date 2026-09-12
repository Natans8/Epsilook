"""Where a flow's rows land: the shapes a route's field can hold, and the readers a cell goes through."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from .expressions import Cell, Column, Row, Rows, Schema, column_name, key_of, number_of


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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({*(picked.column for picked in self.key), self.value})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({self.key, *(picked.column for picked in self.value)})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({self.key, *(picked.column for picked in self.columns)})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({self.key, *(picked.column for picked in self.value)})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({self.outer.column, self.inner.column, self.value})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({*self.keys, self.value.column})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({self.left, self.right})

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset(picked.column for picked in self.columns)

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

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset(self.columns)

    def collect(self, rows: Rows, schema: Schema) -> set[Any]:
        """The set."""
        ats = [schema.at(name) for name in self.columns]
        if len(ats) == 1:
            at = ats[0]
            return {key_of(row[at]) for row in rows}
        return {tuple(key_of(row[at]) for at in ats) for row in rows}


def as_text(cell: Cell) -> str:
    """A cell as its text, its line ends as newlines.

    A client table stores prose with carriage returns where an export writes
    newlines, and the addon's Lua rewrites a carriage return inside a long
    string, which would move every offset after it. One spelling of a line
    break here keeps the two sources the same text.
    """
    if isinstance(cell, tuple):
        raise TypeError("an array column is not one text")
    return cell.replace("\r\n", "\n").replace("\r", "\n")


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
