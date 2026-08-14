"""The ``Section`` record: everything one pack section declares."""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum

from ..derive import Reads


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

    A computation rather than a column reference, because half the real counts
    are filtered, cross-section or dynamic -- how many spells cast instantly is
    the spells that appear in no delivery row.

    ``compute`` is handed what the section produced and the same ``Reads`` the
    section declared, in that order. What shipped is the first argument on
    purpose: a count derived a second way from the sources is a second answer
    waiting to disagree with the column it claims to describe.
    """

    key: str
    compute: Callable[[SectionColumns, Reads], int]


@dataclass(frozen=True)
class CountFamily:
    """Several ``meta.counts`` entries one section computes together.

    For a count whose KEYS come from the data rather than from the record: one
    per expansion rung, one per attribute flag. Declaring those singly would
    mean editing the registry every time the game adds a rung, which is the
    kind of edit this record exists to remove.
    """

    compute: Callable[[SectionColumns, Reads], Mapping[str, int]]


@dataclass(frozen=True)
class Domain:
    """One ``meta.domains`` entry: the measured domain of a numeric axis.

    Measured per pack, from the column that shipped: bounds taken from one
    build are wrong on the other ten, and bounds taken from anything but the
    shipped column describe a control the data does not back.
    """

    key: str
    compute: Callable[[SectionColumns, Reads], Mapping[str, object] | None]


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

    counts: tuple[Count | CountFamily, ...] = ()
    """What this section contributes to ``meta.counts``: keyed numbers, and
    families whose keys the data decides."""

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
