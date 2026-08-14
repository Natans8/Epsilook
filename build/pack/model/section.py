"""The ``Section`` record: everything one pack section declares."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum

from ..derive import DeriveContext, Reads


class Encoding(Enum):
    """How a column is laid out in the artifact.

    The cardinality of the mapping the column carries, named by what that
    cardinality costs to store. `encode/` holds the layout each one means.
    """

    DENSE = "dense"
    """One value per row, in row order. A total mapping."""

    SPARSE = "sparse"
    """The rows that have a value, and which rows those are."""

    DEDUP = "dedup"
    """A pool of the distinct values, and one index per row."""


class Layout(Enum):
    """The shape a section's payload takes in the artifact."""

    COLUMNS = "columns"
    """A dict of the section's columns, by column name."""

    BARE = "bare"
    """The single column's encoded value, unwrapped.

    For a section that IS one array: wrapping it in a one-key dict would make
    the reader name the column twice and say nothing more.
    """


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

    ``produce`` receives the fields named in ``reads`` and nothing else;
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

    produce: Callable[[Reads], SectionColumns]

    columns: tuple[str, ...]

    reads: tuple[str, ...] = ()
    """The derive-context fields this section maps from.

    The section's domain, stated. Everything else on this record describes what
    the section produces; without this the only account of what it consumes is
    the body of ``produce``, which no guard can read.
    """

    encoding: Mapping[str, Encoding] = field(default_factory=dict)

    layout: Layout = Layout.COLUMNS

    counts: tuple[Count, ...] = ()

    domains: tuple[Domain, ...] = ()

    localizable: tuple[str, ...] = ()
    """Columns carrying locale text; empty means one copy serves every
    language."""

    needs: tuple[str, ...] = ()
    """Source tables required; a build lacking one switches the section off."""

    degraded_without: tuple[str, ...] = ()
    """Source tables that thin the section without emptying it.

    The difference `meta.absentTables` cannot state. A section whose table is
    absent ships nothing and says so; a section missing one of these still
    ships, holding less than it would -- morph names falling back to raw ids on
    a build with no server dump is the standing example. Reported apart so a
    thin section reads as declared rather than as a build that went wrong.
    """

    scope: Scope = Scope.PER_BUILD
