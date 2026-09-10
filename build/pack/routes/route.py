"""A route as a registered record: the field it fills, and what fills it.

The derive context is a set of fields, and each is produced by one function
from the sources and from other fields. Writing that as a record per field,
rather than as a method per field on one class, is what makes the dependency
graph data: which field needs which is read off the records, a field nothing
fills is found by looking, and the wiring that resolves them knows only this
record and never a reader's name.

A route's body is whatever fills the field: a flow over tables, a reader that
takes a table and a bundle, or a derivation over other fields. The record does
not care which, and that is the point.

The record is written as a decorator on the function, and a parameter is a
need whose source is its own name unless the decorator says otherwise. So a
reader whose parameters are named for the fields and givens it reads declares
nothing beyond the field it fills, and only a parameter named for something
else maps its source.
"""

from __future__ import annotations

import dataclasses
import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from ..tables import Tables
    from .flow import Runnable

Produce = Callable[..., object]
"""What fills a field, called with the inputs the record names, by keyword.

Untyped in its parameters on purpose: every reader keeps its own typed
signature, and the record maps names onto it. The field the result lands in
types it on the way into the context.
"""


@dataclass(frozen=True)
class Route:
    """One field of the derive context, and what fills it."""

    field: str
    """The context field this fills."""

    produce: Produce
    """What fills it, called with `needs` resolved and passed by keyword."""

    needs: Mapping[str, str] = dataclasses.field(default_factory=dict)
    """Per parameter of `produce`, where its value comes from.

    A source is a given input the wiring supplies (a provider, the build's
    version, a table read once for every language), another field's name, or
    a field's attribute as `field.attribute`. Naming another field is what
    orders the build: a field is produced after every field it names.
    """

    phase: str = ""
    """The name the build times this under; empty means `read <field>`."""

    def timed_as(self) -> str:
        """The phase name, defaulted from the field."""
        return self.phase or f"read {self.field}"

    def fields_named(self) -> set[str]:
        """The other fields this route reads, without their attributes."""
        return {source.partition(".")[0] for source in self.needs.values()}


ROUTES: list[Route] = []
"""Every decorated function, in the order the modules were imported."""

Filler = TypeVar("Filler", bound=Callable[..., object])


def route(field: str, *, phase: str = "", **sources: str) -> Callable[[Filler], Filler]:
    """Register the decorated function as what fills `field`.

    Every parameter without a default is a need. Its source is the parameter's
    own name, a given or another field, unless `sources` maps it to something
    else: another field, or a field's attribute as `field.attribute`. A
    parameter with a default is left to its default unless mapped.

    Args:
        field: the context field the function's result lands in.
        phase: the name the build times it under; empty means `read <field>`.
        sources: per parameter, where it comes from when that is not its name.

    Raises:
        ValueError: `sources` names a parameter the function does not take,
            which is a mapping that would silently apply to nothing.
    """

    def register(filler: Filler) -> Filler:
        parameters = inspect.signature(filler).parameters
        unknown = sorted(set(sources) - set(parameters))
        if unknown:
            raise ValueError(f"{field}: {', '.join(unknown)} is not a parameter of {filler.__name__}")
        needs = {
            name: sources.get(name, name)
            for name, parameter in parameters.items()
            if name in sources or parameter.default is inspect.Parameter.empty
        }
        ROUTES.append(Route(field, filler, needs, phase))
        return filler

    return register


DECLARED: dict[str, list[tuple[str, Any]]] = {}
"""Per declared field, its plans by the version each holds from, in order.

Any: a plan's result type is the field's, and the field types it on the way
into the context; the registry only picks which plan runs.
"""


def _plan_for(field: str, version: str) -> Any:
    """The plan a build runs for a field: the last one declared for a version
    at or before this build's."""
    from .flow import before  # noqa: PLC0415  -- the flow imports this module's decorator

    chosen = None
    for since, plan in DECLARED[field]:
        if not since or not before(version, since):
            chosen = plan
    if chosen is None:
        raise ValueError(f"{field}: no plan holds on {version}")
    return chosen


def _needs_of(plan: Any) -> frozenset[str]:
    """What a runnable names: its flow's needs, and a post-step's wants."""
    named = getattr(plan, "needs", None)
    return named if isinstance(named, frozenset) else plan.flow.needs


def declare[T](field: str, plan: Runnable[T], *, phase: str = "", since: str = "") -> Runnable[T]:
    """Register a plan as what fills `field`.

    The plan's needs are read off the plan itself, so a flow narrowing on a
    path names its dependency once. A second declaration of the same field
    with `since` is the version override: the plan a build at or past that
    version runs instead, the same field, the same place.

    Args:
        field: the context field the plan's result lands in.
        plan: the flow and its terminal.
        phase: the name the build times it under; empty means `read <field>`.
        since: the dotted version this plan holds from; empty means always.

    Returns:
        The plan, so the declaration can be held by a name too.
    """
    plans = DECLARED.setdefault(field, [])
    plans.append((since, plan))
    plans.sort(key=lambda held: tuple(int(part) for part in held[0].split(".")) if held[0] else ())
    paths = sorted({path for _since, held in plans for path in _needs_of(held)})
    # A need's path is not a parameter name, so each is keyed by position and
    # mapped back when the plan runs.
    keys = {f"need{at}": path for at, path in enumerate(paths)}

    def produce(tables: Tables, version: str, **found: Any) -> Any:
        needs = {keys[key]: value for key, value in found.items()}
        return _plan_for(field, version).run(tables, version, needs)

    ROUTES[:] = [registered for registered in ROUTES if registered.field != field]
    ROUTES.append(Route(field, produce, {"tables": "tables", "version": "version", **keys}, phase))
    return plan
