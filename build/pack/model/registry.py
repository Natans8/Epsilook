"""The section registry: every section the build ships, as data."""

from __future__ import annotations

from ..derive import CONTEXT_FIELDS, SPOKEN_FIELDS
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
        ValueError: `encoding` or `localizable` names a column the section does
            not produce.
        ValueError: a bare section does not have exactly one column. The
            payload is that column, so there is nothing for a second one to be.
        ValueError: a bare section declares a localizable column. A language is
            split out of the payload by column name, and a bare payload has
            none -- it IS the column.
        ValueError: a localizable section reads no field that carries the
            game's own language. Its column would then be identical in every
            language, shipped once per language, with nothing to say so.
    """
    if any(existing.name == section.name for existing in SECTIONS):
        raise ValueError(f"duplicate section: {section.name}")
    for existing in SECTIONS:
        if existing.module == section.module and existing.scope is not section.scope:
            raise ValueError(
                f"module {section.module!r} is declared {existing.scope.value} "
                f"by {existing.name} and {section.scope.value} by {section.name}"
            )

    unknown = sorted(set(section.reads) - CONTEXT_FIELDS)
    if unknown:
        raise ValueError(f"{section.name} reads {', '.join(unknown)}, which the derive context does not hold")

    stray = sorted(set(section.encoding) - set(section.columns))
    if stray:
        raise ValueError(f"{section.name} encodes {', '.join(stray)}, which it does not produce")

    unspoken = sorted(set(section.localizable) - set(section.columns))
    if unspoken:
        raise ValueError(f"{section.name} declares {', '.join(unspoken)} localizable, which it does not produce")

    if section.layout is Layout.BARE:
        if len(section.columns) != 1:
            raise ValueError(f"{section.name} is bare but declares {len(section.columns)} columns")
        if section.localizable:
            raise ValueError(
                f"{section.name} is bare and localizable; a language is split "
                f"out by column name and a bare payload has none"
            )

    if section.localizable and not set(section.reads) & SPOKEN_FIELDS:
        raise ValueError(
            f"{section.name} ships {', '.join(section.localizable)} as language "
            f"but reads none of {', '.join(sorted(SPOKEN_FIELDS))}; either the "
            f"column is the same in every language or the field it comes from "
            f"is missing from `Spoken` and no locale pass rebuilds it"
        )

    SECTIONS.append(section)
    return section
