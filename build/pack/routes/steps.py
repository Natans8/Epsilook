"""The steps of a flow: one hop each, from a table to the rows a terminal collects.

Each step says which columns it adds or replaces and yields the rows it
produces from the rows before it, a generator over the provider's own text,
so a flow streams a million-row table without holding it. The steps are the
mapping-shaped part of a route; a walk that recurses over its own output or a
cooker that parses is a function over a flow's rows and is not a step.
"""

from __future__ import annotations

from collections.abc import Container, Iterator, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable
from ..tables import Tables
from .expressions import (
    Cell,
    Column,
    Expr,
    Needs,
    Row,
    Rows,
    Schema,
    Table,
    column_name,
    export_name,
    key_of,
    table_name,
)


class Step(Protocol):
    """One hop of a flow."""

    def schema(self, incoming: Schema) -> Schema:
        """The columns rows carry after this step, given those before it."""
        raise NotImplementedError

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Yield the rows this step produces from the rows before it."""
        raise NotImplementedError


@runtime_checkable
class RowStep(Step, Protocol):
    """A step a branch of a split may take: one row in, one row or none out.

    A branch runs on each row of the trunk as the split reaches it, so only
    a step that can answer for one row at a time belongs in one; a read or
    a join needs the table whole.
    """

    def one(self, row: Row, schema: Schema, needs: Needs) -> Row | None:
        """The row this step produces from one row, or none where it drops it."""
        raise NotImplementedError


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
    """The provider's own column names behind the ones asked for, the table
    qualifier dropped and an array column standing for every ``Name_N`` the
    build has, with each column's width."""
    named = [export_name(column) for column in columns]
    arrays = {name: _array_columns(tables, table, name[:-2]) for name in named if name.endswith("_*")}
    flat = [name for column in named for name in arrays.get(column, [column])]
    widths = [len(arrays.get(column, [column])) for column in named]
    return flat, widths


def _read(tables: Tables, table: str, columns: Sequence[str]) -> Rows:
    """The table's rows by the columns named, an array column read whole into one cell."""
    if not any(name.endswith("_*") for name in columns):
        return tables.rows(table, [export_name(name) for name in columns])
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


def _layer(revised: bool, tables: Tables, needs: Needs) -> Tables | None:
    """The tables a step reads from: the build's, revisions applied, or the
    client's unrevised ones, which the wiring holds under `base`; None where
    the build lacks them. Where a table lives is the union's business."""
    if revised:
        return tables
    found: Tables | None = needs.get("base")
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
    """The columns read; none where the read is open, which the plan settles."""

    optional: bool = False

    revised: bool = True
    """Whether the hotfix revisions apply. A number a description prints reads
    the client's own, unrevised, which the wiring holds under `base`."""

    open: type[Table] | None = None
    """The table's class where the read lists no columns: every column is
    carried until the plan settles which its later steps and terminal name."""

    def schema(self, incoming: Schema) -> Schema:
        """The columns read, as the flow's first schema."""
        del incoming  # an origin follows nothing
        return (
            Schema(self.columns).opened(self.open)
            if self.open is not None and not self.columns
            else Schema(self.columns)
        )

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether this build has the table, in the source it is read from."""
        held = _layer(self.revised, tables, needs)
        return held is not None and held.available(self.table)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Read the table."""
        del incoming, incoming_schema, version
        held = _layer(self.revised, tables, needs)
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

    revised: bool = True
    """Whether the hotfix revisions apply. A number a description prints reads
    the client's own, unrevised, which the wiring holds under `base`."""

    open: type[Table] | None = None
    """The joined table's class where the join lists no columns, as a read's."""

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the joined ones."""
        incoming.check(self.key)
        if self.open is not None and not self.columns:
            return incoming.opened(self.open)
        return incoming.with_columns(*self.columns)

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """Append each row's joined columns.

        The other table is indexed per run, never on the step: a declaration
        is shared by every build and every language, and an index kept on it
        would answer the next run with the last run's table.
        """
        del version
        index: dict[int, list[Row]] = {}
        held = _layer(self.revised, tables, needs)
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
            incoming.check(name)
        fanned = tuple(incoming.columns[at] for name in self.columns if (at := incoming._found(name)) is not None)
        return incoming.without(*fanned).with_columns(self.into, *((self.slot,) if self.slot else ()))

    def rows(self, incoming: Rows, incoming_schema: Schema, tables: Tables, version: str, needs: Needs) -> Rows:
        """One row per non-empty value among the fanned columns."""
        del tables, version, needs
        fanned = [incoming_schema.at(name) for name in self.columns]
        kept = [at for at in range(len(incoming_schema.columns)) if at not in fanned]
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

    revised: bool = True
    """Whether the hotfix revisions apply. A number a description prints reads
    the client's own, unrevised, which the wiring holds under `base`."""

    def schema(self, incoming: Schema) -> Schema:
        """The incoming columns, then the reached id and its bits."""
        incoming.check(self.key)
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
        held = _layer(self.revised, tables, needs)
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
        incoming.check(self.key)
        for name in self.base.columns():
            incoming.check(name)
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
            incoming.check(name)
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


def reference(column: str | Column, table: str | type[Table], *, zero_is_a_value: bool = False) -> Slot:
    """A column that is an id into ``table`` under this selector.

    Nought names no row, so a row reading it is dropped unless the slot says
    nought is data: a summon with no properties row is still a summon.
    """
    return Slot(column_name(column), Holds.REFERENCE, table_name(table), zero_is_a_value)


def vocabulary(column: str | Column, name: str, *, zero_is_a_value: bool = False) -> Slot:
    """A column that a checked-in vocabulary names under this selector."""
    return Slot(column_name(column), Holds.VOCABULARY, name, zero_is_a_value)


def amount(column: str | Column) -> Slot:
    """A column that is a number under this selector."""
    return Slot(column_name(column), Holds.AMOUNT)


def parameter(column: str | Column) -> Slot:
    """A column whose meaning another slot decides under this selector."""
    return Slot(column_name(column), Holds.PARAMETER)


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
        incoming.check(self.on)
        for slot in self.slots:
            incoming.check(slot.column)
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
            incoming.check(name)
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
        incoming.check(self.column)
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
        incoming.check(self.column)
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


def when(on: str | Column, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> When:
    """The discriminated reference: the rows whose selector holds a value, and
    what their columns then mean. Not `select`, which everywhere else means
    choosing columns. Built on its own where the declaration is the point,
    as the payload table does."""
    chosen = (values,) if isinstance(values, int) else tuple(values)
    return When(column_name(on), chosen, tuple(slots), until)
