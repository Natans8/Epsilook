"""What the pack says about itself: format, provenance, counts, domains.

Everything here is a DERIVED fact shipped so nothing downstream re-derives it.
The counts are how the drift tables are read straight out of the packs instead
of being estimated, and the domains are what let a numeric control be drawn
without the app measuring a quarter of a million values on every load.

Both are assembled from the section records rather than written out by hand, so
a section that declares a count contributes one and a section that goes away
takes its own with it.
"""

from __future__ import annotations

import time
from collections.abc import Mapping

from ..build import Build
from ..derive import DeriveContext
from ..model import SECTIONS, CountFamily, Section, SectionColumns

PACK_FORMAT = 50
"""What shape the artifact is in.

50 is the row reshape: a mask on every row the game aims somewhere, the role a
rider's animation plays in, and the storage unit each numeric axis is measured
in. Two of those change row counts rather than only adding columns -- an
animation used both entering and seated is two rows now, because which act it
belongs to is the question being asked.

Bumped whenever a reader that understood the last version would misread this
one. The app refuses a pack whose format it does not know, which is what makes
a half-deployed change loud instead of subtly wrong.
"""


def counts_of(section: Section, columns: SectionColumns,
              context: DeriveContext) -> dict[str, int]:
    """Every `meta.counts` entry one section contributes."""
    reads = context.reads(section.reads)
    counted: dict[str, int] = {}
    for declared in section.counts:
        if isinstance(declared, CountFamily):
            counted.update(declared.compute(columns, reads))
        else:
            counted[declared.key] = declared.compute(columns, reads)
    return counted


def domains_of(section: Section, columns: SectionColumns,
               context: DeriveContext) -> dict[str, Mapping[str, object]]:
    """Every `meta.domains` entry one section contributes.

    A domain that measures to nothing is left out rather than shipped empty: an
    axis with no values in this pack has no control to draw, which is a
    different thing from one whose values are all zero.
    """
    reads = context.reads(section.reads)
    return {declared.key: ({**measured, "unit": declared.unit}
                           if declared.unit else measured)
            for declared in section.domains
            if (measured := declared.compute(columns, reads)) is not None}


def gathered(produced: Mapping[str, SectionColumns], context: DeriveContext
             ) -> tuple[dict[str, int], dict[str, Mapping[str, object]]]:
    """The counts and domains of every section that shipped.

    Registry order, which groups a section's counts with the section they
    describe. Nothing depends on the order -- these are looked up by key -- so
    the artifact does not carry a second list saying what it should be.

    Args:
        produced: what each section's `produce` returned, by section name.
        context: the build's derive context, for the reads a count declares.

    Returns:
        The two `meta` tables.
    """
    counted: dict[str, int] = {}
    measured: dict[str, Mapping[str, object]] = {}
    for section in SECTIONS:
        if section.name not in produced:
            continue
        counted.update(counts_of(section, produced[section.name], context))
        measured.update(domains_of(section, produced[section.name], context))
    return counted, measured


def meta(build: Build, label: str, listfile_tag: str,
         counts: Mapping[str, int],
         domains: Mapping[str, Mapping[str, object]]) -> dict[str, object]:
    """The pack's own header.

    Args:
        build: what is being packed, and what it was found to lack.
        label: the human name the version picker shows.
        listfile_tag: which listfile release named this pack's assets.
        counts: the assembled `meta.counts`.
        domains: the assembled `meta.domains`.
    """
    return {
        "format": PACK_FORMAT,
        "version": build.version,
        "label": label,
        # The date and not the time: two rebuilds on one day have to compare
        # equal, since that is what makes a deterministic rebuild provable.
        "built": time.strftime("%Y-%m-%d"),
        "listfileTag": listfile_tag,
        "tdbTag": build.tdb or "",
        "absentTables": sorted(build.absent_tables),
        "counts": dict(counts),
        "domains": dict(domains),
    }
