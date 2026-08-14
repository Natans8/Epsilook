"""The shared context every section's ``produce`` receives."""

from __future__ import annotations

from dataclasses import dataclass, field

from ..build import Build
from .icons import IconIndex
from .walk import SpellVisuals


@dataclass(frozen=True, eq=False)
class DeriveContext:
    """Everything a section may read, computed once per build per locale.

    The only argument a ``Section.produce`` callable receives. A locale build
    constructs its own context over locale-qualified tables.

    Anything two sections share belongs here rather than being recomputed by
    each of them, which is what keeps the section registry flat: a section
    depends on this and never on another section.

    Frozen so a section cannot swap a field out from under the next one, and
    compared by identity because every field it holds is unhashable -- the
    default equality would advertise a hash that raises the moment anyone
    keyed a cache on a build's context.

    TODO: the route bundles join these as the sections that read them are
    declared, which is the section registry's stage.
    """

    build: Build
    """The build being packed."""

    visuals: SpellVisuals = field(default_factory=SpellVisuals)
    """What the graph walk attributed to each spell."""

    icons: IconIndex = field(default_factory=IconIndex)
    """The deduped icon table and each spell's place in it."""

    paths: dict[int, str] = field(default_factory=dict)
    """File id to asset path, in the listfile's own casing.

    Resolved once for every file id the build references, since the listfile is
    far too large to consult per lookup.
    """
