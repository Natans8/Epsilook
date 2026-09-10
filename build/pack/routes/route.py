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
from typing import TypeVar

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
