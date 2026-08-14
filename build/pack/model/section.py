"""The ``Section`` record: everything one pack section declares."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum

from ..derive import DeriveContext


class Encoding(Enum):
    """How a column is laid out in the artifact."""

    DENSE = "dense"
    SPARSE = "sparse"


class Scope(Enum):
    """Whether a section ships per build or once across builds.

    ``UNIVERSAL`` is a content-addressed shared module, not one global file:
    the section is still produced per build, and a build that diverges
    references its own variant.
    """

    PER_BUILD = "per-build"
    UNIVERSAL = "universal"


SectionColumns = Mapping[str, Sequence[object]]
"""What ``produce`` returns: parallel arrays keyed by column name."""


@dataclass(frozen=True)
class Count:
    """One ``meta.counts`` entry: its key and the computation behind it.

    A computation rather than a column reference: many counts are filtered,
    cross-section or dynamic.
    """

    key: str
    compute: Callable[[DeriveContext], int]


@dataclass(frozen=True)
class Domain:
    """One ``meta.domains`` entry: the measured domain of a numeric axis.

    Measured per pack; bounds taken from one build are wrong on the others.
    """

    key: str
    compute: Callable[[DeriveContext], Mapping[str, object]]


@dataclass(frozen=True)
class Section:
    """One pack section, declared whole.

    ``produce`` receives the shared ``DeriveContext`` and nothing else;
    inter-section dependencies are forbidden. Sections naming ``localizable``
    columns are produced again per locale. A build missing any table in
    ``needs`` ships the section absent, and an undeclared miss fails the build.
    A column absent from ``encoding`` is ``Encoding.DENSE``.
    """

    name: str
    """The section's key in the artifact."""

    doc: str
    """One sentence for the generated route documentation."""

    module: str
    """Which module file the section lands in."""

    produce: Callable[[DeriveContext], SectionColumns]

    columns: tuple[str, ...]

    encoding: Mapping[str, Encoding] = field(default_factory=dict)

    counts: tuple[Count, ...] = ()

    domains: tuple[Domain, ...] = ()

    localizable: tuple[str, ...] = ()
    """Columns carrying locale text; empty means one copy serves every
    language."""

    needs: tuple[str, ...] = ()
    """Source tables required; a build lacking one switches the section off."""

    scope: Scope = Scope.PER_BUILD
