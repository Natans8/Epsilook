"""The section registry: every section the build ships, as data."""

from __future__ import annotations

from ..derive import CONTEXT_FIELDS
from .section import Layout, Section

SECTIONS: list[Section] = []
"""Every registered section, in registration order: the artifact's key order."""


def register(section: Section) -> Section:
    """Add a section to the registry and return it.

    Every check here is on the declaration alone, which is why they run at
    registration rather than at assembly: a section switched off by the build
    being packed would otherwise never be looked at, hiding the mistake on
    exactly the builds that drift most.

    Raises:
        ValueError: the name is already registered.
        ValueError: a section already in this one's module declares a
            different scope. A module is one file, written once and referenced
            by whoever wants it, so it cannot be per-build for one section and
            universal for another.
        ValueError: `reads` names something the derive context does not hold.
            The declaration is what the section is handed, so a name that
            resolves to nothing would read as an empty input rather than as a
            typo.
        ValueError: `encoding` names a column the section does not produce.
        ValueError: a bare section does not have exactly one column. The
            payload is that column, so there is nothing for a second one to be.
    """
    if any(existing.name == section.name for existing in SECTIONS):
        raise ValueError(f"duplicate section: {section.name}")
    for existing in SECTIONS:
        if existing.module == section.module and existing.scope is not section.scope:
            raise ValueError(
                f"module {section.module!r} is declared {existing.scope.value} "
                f"by {existing.name} and {section.scope.value} by {section.name}")

    unknown = sorted(set(section.reads) - CONTEXT_FIELDS)
    if unknown:
        raise ValueError(
            f"{section.name} reads {', '.join(unknown)}, which the derive "
            f"context does not hold")

    stray = sorted(set(section.encoding) - set(section.columns))
    if stray:
        raise ValueError(
            f"{section.name} encodes {', '.join(stray)}, which it does not produce")

    if section.layout is Layout.BARE and len(section.columns) != 1:
        raise ValueError(
            f"{section.name} is bare but declares {len(section.columns)} columns")

    SECTIONS.append(section)
    return section
