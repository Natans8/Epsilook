"""The section registry: every section the build ships, as data."""

from __future__ import annotations

from .section import Section

SECTIONS: list[Section] = []
"""Every registered section, in registration order: the artifact's key order."""


def register(section: Section) -> Section:
    """Add a section to the registry and return it.

    Raises:
        ValueError: the name is already registered.
        ValueError: a section already in this one's module declares a
            different scope. A module is one file, written once and referenced
            by whoever wants it, so it cannot be per-build for one section and
            universal for another. The check belongs here rather than at
            assembly because it is a property of the declarations: a build that
            switched one of the two sections off would otherwise never see it,
            hiding the error on exactly the builds that drift most.
    """
    if any(existing.name == section.name for existing in SECTIONS):
        raise ValueError(f"duplicate section: {section.name}")
    for existing in SECTIONS:
        if existing.module == section.module and existing.scope is not section.scope:
            raise ValueError(
                f"module {section.module!r} is declared {existing.scope.value} "
                f"by {existing.name} and {section.scope.value} by {section.name}")
    SECTIONS.append(section)
    return section
