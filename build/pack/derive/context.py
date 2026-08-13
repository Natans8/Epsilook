"""The shared context every section's ``produce`` receives."""

from __future__ import annotations

from dataclasses import dataclass

from ..build import Build


@dataclass(frozen=True)
class DeriveContext:
    """Everything a section may read, computed once per build per locale.

    The only argument a ``Section.produce`` callable receives.
    Inter-section dependencies are forbidden: anything two sections share is
    computed in ``derive/`` and carried here. A locale build constructs its
    own context over locale-qualified tables; the base and locale contexts
    are otherwise identical in shape.

    TODO: the derived fields (route bundles, the walk, path resolution, the
    icon index) land here as the readers move over from ``build_data.py``.
    """

    build: Build
    """The build being packed."""
