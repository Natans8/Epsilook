"""The section registry: every section the build ships, as data."""

from __future__ import annotations

from .section import Section

SECTIONS: list[Section] = []
"""Every registered section, in registration order: the artifact's key order."""


def register(section: Section) -> Section:
    """Add a section to the registry and return it; a duplicate name is an
    error."""
    if any(existing.name == section.name for existing in SECTIONS):
        raise ValueError(f"duplicate section: {section.name}")
    SECTIONS.append(section)
    return section
