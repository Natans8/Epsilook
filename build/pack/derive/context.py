"""The shared context every section's ``produce`` receives."""

from __future__ import annotations

from dataclasses import dataclass

from ..build import Build


@dataclass(frozen=True)
class DeriveContext:
    """Everything a section may read, computed once per build per locale.

    The only argument a ``Section.produce`` callable receives. A locale build
    constructs its own context over locale-qualified tables.

    TODO: the readers moving over from ``build_data.py`` - add the derived
    fields (route bundles, the walk, path resolution, the icon index) here.
    """

    build: Build
    """The build being packed."""
