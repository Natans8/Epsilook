"""A flow, and what the registry runs for a field.

A flow is the named sequence of steps, chained as methods and read left to
right, that a terminal turns into a shape. What runs for a field is a plan, a
flow with its terminal; a plan with a step after it; the first of several
plans this build can run; a record composed of other fields; or one read
split into several landings. Nothing runs until the terminal asks.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable, Container, Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from abc import ABC, abstractmethod
from typing import Any, Protocol
from ..tables import Tables
from .expressions import Column, Expr, Needs, Row, Rows, Schema, Table, column_name, export_name, has_column, table_name
from .steps import (
    AnyOf,
    Expand,
    Explode,
    Join,
    Lookup,
    Map,
    Narrow,
    Prefer,
    Read,
    RowStep,
    Slot,
    Step,
    When,
    Where,
    when,
)


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
                if not isinstance(held, RowStep):
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

    def read(
        self, table: str | type[Table], *columns: str | Column, optional: bool = False, revised: bool = True
    ) -> Flow:
        """Start from one table's rows, by the columns named; by the columns the
        later steps and the terminal name, where the table is its class and
        none are listed."""
        return self | Read(
            table_name(table),
            tuple(column_name(name) for name in columns),
            optional,
            revised,
            catalogue=_catalogue(table, columns),
        )

    def join(
        self,
        key: str | Column,
        table: str | type[Table],
        *columns: str | Column,
        by: str | Column = "ID",
        inner: bool = False,
        many: bool = False,
        revised: bool = True,
    ) -> Flow:
        """Hop through a key into another table, taking the columns named, or
        the ones the later steps name where none are listed."""
        return self | Join(
            column_name(key),
            table_name(table),
            tuple(column_name(name) for name in columns),
            column_name(by),
            inner,
            many,
            revised,
            catalogue=_catalogue(table, columns),
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
        self,
        key: str | Column,
        table: str | type[Table],
        edges: Mapping[str, int],
        *,
        into: str,
        bits: str,
        revised: bool = True,
    ) -> Flow:
        """Every row the key reaches through the table's own references, with the bits the path took."""
        return self | Expand(column_name(key), table_name(table), dict(edges), into, bits, revised=revised)

    def prefer(self, key: str | Column, *, base: Expr) -> Flow:
        """One row per key, the base row standing for it."""
        return self | Prefer(column_name(key), base)

    def map(self, into: str, expr: Expr) -> Flow:
        """A computed column, appended."""
        return self | Map(into, expr)

    def when(self, on: str | Column, values: int | Sequence[int], slots: Sequence[Slot], until: str = "") -> Flow:
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

    def into[T](self, terminal: Terminal[T]) -> Plan[T]:
        """Land the rows in a shape: ``flow.into(as_map(...))`` is the whole route.

        A method rather than an operator so a plan is one call chain from its
        read to its landing, which is what the formatter lays out one step
        per line.
        """
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

    @property
    def is_settled(self) -> bool:
        """Whether every read and join lists its columns."""
        return not any(_unsettled(step) for step in self.steps)

    def settled(self, referenced: Iterable[str] = ()) -> Flow:
        """This flow with every open read given its columns: the ones the steps
        after it and the terminal name, as the projection a lazy plan pushes
        down to its scan. A qualified name goes to its table; a bare one to the
        one open table carrying it.

        Raises:
            ValueError: a bare name is carried by two open tables, so it must
                name its table.
        """
        if self.is_settled:
            return self
        steps = list(self.steps)
        needed: set[str] = set(referenced)
        pending: list[tuple[int, frozenset[str]]] = []
        for at in range(len(steps) - 1, -1, -1):
            if _unsettled(steps[at]) is not None:
                pending.append((at, frozenset(needed)))
            needed |= _referenced(steps[at])
        opens = [held.catalogue for at, _ in reversed(pending) if (held := _unsettled(steps[at])) is not None]
        listed = {name for step in steps if isinstance(step, (Read, Join)) for name in step.columns}
        for at, after in pending:
            step = _unsettled(steps[at])
            if step is None or step.catalogue is None:
                continue
            table = step.catalogue
            mine: set[str] = set()
            for name in after:
                owner, _, base = name.rpartition(".")
                if owner:
                    if owner == table.__tablename__:
                        mine.add(name)
                elif name not in listed:
                    carriers = [held for held in opens if held is not None and has_column(held, base)]
                    if len(carriers) > 1:
                        raise ValueError(f"column {name!r} is carried by {len(carriers)} open tables; name its table")
                    if carriers and carriers[0] is table:
                        mine.add(name)
            steps[at] = replace(step, columns=tuple(sorted(mine, key=lambda name: _order(table, name))))
        return Flow(self.name, tuple(steps))

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
        for step in self.settled().steps:
            rows = step.rows(rows, current, tables, version, needs or {})
            current = step.schema(current)
        return rows

    def of_kind(self, kind: type[Step]) -> list[Step]:
        """The steps of one kind, in flow order: the joins, the selectors."""
        return [step for step in self.steps if isinstance(step, kind)]

    @property
    def needs(self) -> frozenset[str]:
        """The field paths the flow names, for the wiring to resolve: the
        rosters it narrows on, the fields it looks up, and the unrevised tables
        where a step reads them."""
        rosters = {
            step.roster for step in self.of_kind(Narrow) if isinstance(step, Narrow) and isinstance(step.roster, str)
        }
        fields = {
            step.field for step in self.of_kind(Lookup) if isinstance(step, Lookup) and isinstance(step.field, str)
        }
        layers = (
            {"base"}
            if any(isinstance(step, (Read, Join, Expand)) and not step.revised for step in self.steps)
            else set()
        )
        return frozenset(rosters | fields | layers)

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


class Terminal[T](Protocol):
    """Where a flow's rows land: the shape a route's field holds."""

    def collect(self, rows: Rows, schema: Schema) -> T:
        """The shape, from every row."""
        raise NotImplementedError

    def taken(self) -> frozenset[str]:
        """The columns it takes, which settle an open read."""
        raise NotImplementedError


def _catalogue(table: str | type[Table], columns: Sequence[object]) -> type[Table] | None:
    """The table's class where a read lists no columns and may be settled later.

    Raises:
        ValueError: a table named by string lists no columns, so nothing could
            settle it.
    """
    if columns:
        return None
    if isinstance(table, str):
        raise ValueError(f"a read of {table!r} names its columns; a read settled later names the table by its class")
    return table


def _unsettled(step: Step) -> Read | Join | None:
    """The step as a read or join whose columns the plan still has to settle."""
    if isinstance(step, (Read, Join)) and step.catalogue is not None and not step.columns:
        return step
    return None


def _referenced(step: Step) -> frozenset[str]:
    """The incoming columns a step reads, which settle the open reads before it."""
    if isinstance(step, Join):
        return frozenset({step.key})
    if isinstance(step, Explode):
        return frozenset(step.columns)
    if isinstance(step, (Expand, Prefer)):
        return frozenset({step.key}) | (step.base.columns() if isinstance(step, Prefer) else frozenset())
    if isinstance(step, Map):
        return step.expr.columns()
    if isinstance(step, When):
        return frozenset({step.on, *(slot.column for slot in step.slots)})
    if isinstance(step, AnyOf):
        return frozenset().union(*(_referenced(chosen) for chosen in step.selectors))
    if isinstance(step, Where):
        return step.keep.columns()
    if isinstance(step, (Narrow, Lookup)):
        return frozenset({step.column})
    return frozenset()


def _order(table: type[Table], name: str) -> tuple[int, str]:
    """A column's place in its table's declaration, a slot after its array."""
    declared = list(vars(table))
    base = export_name(name)
    stem = base if base in declared else base.rpartition("_")[0]
    return (declared.index(stem) if stem in declared else len(declared), base)


class Runnable[T](ABC):
    """What the registry runs for a field: a plan, a plan with a step after
    it, the first of several plans this build can run, or a record composed
    of other fields. Each says what it needs, whether the build has what it
    reads, and runs."""

    @property
    @abstractmethod
    def needs(self) -> frozenset[str]:
        """The field paths this names, for the wiring to resolve first."""

    def available(self, tables: Tables, needs: Needs) -> bool:
        """Whether this build has the table it starts from."""
        del tables, needs
        return True

    @abstractmethod
    def run(self, tables: Tables, version: str = "", needs: Needs | None = None) -> T:
        """The shape, from one build's tables."""

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
        flow = self.flow.settled(self.terminal.taken())
        return self.terminal.collect(flow.rows(tables, version, needs), flow.schema())


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
        return schema.with_columns(*(f"consumed_{export_name(on)}" for on in self.selects_on))

    @property
    def settled_trunk(self) -> Flow:
        """The trunk with its open reads settled from every branch and the landing."""
        referenced: set[str] = set()
        for plan in (*self.branches.values(), *((self.landing,) if self.landing is not None else ())):
            inner = _planned(plan)
            for step in inner.flow.steps:
                referenced |= _referenced(step)
            referenced |= inner.terminal.taken()
        return self.trunk.settled(referenced)

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
        trunk = self.settled_trunk
        schema = trunk.schema()
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
        landing_rows = landed(trunk.rows(tables, version, held))
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
