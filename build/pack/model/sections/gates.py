"""What stops a spell, times it, or places it: flags, delivery, and areas.

Three routes that answer "can I cast this, and what happens when I do" rather
than "what does it look like".
"""

from __future__ import annotations

from ...derive import Reads
from ...measure import numeric_domain
from ...routes.delivery import BREAKS_ON_MOVE, CHANNELLED
from ..registry import register
from ..section import (Cardinality, Count, CountFamily, Domain, Layout, Section,
                       SectionColumns)


def attribute_lists(reads: Reads) -> SectionColumns:
    """Every declared attribute flag, and the spells carrying it.

    A map keyed by the flag's handler rather than a section per flag, so that
    shipping another one is an edit to the checked-in enum plus a pill type,
    and nothing here branches on which flag it is.
    """
    return {"byFlag": {handler: list(spells)
                       for handler, spells in sorted(reads.attributes.items())}}


def delivery(reads: Reads) -> SectionColumns:
    """How each spell that has a cast time or a channel is delivered.

    Only spells that have one are listed; instant is the complement, worked out
    at load, which is what lets a spell with no timing row at all still get an
    answer. It is not a partition either way -- a spell can have both a cast
    and a channel, and thousands do.
    """
    rows = reads.delivery
    return {"spellIds": [row.spell for row in rows],
            "castMs": [row.cast_ms for row in rows],
            "durMs": [row.duration_ms for row in rows],
            "flags": [row.flags for row in rows]}


def area_gates(reads: Reads) -> SectionColumns:
    """One row per place a spell may be cast.

    The pill is a group, so a spell gated to four areas ships four rows and no
    primary area is invented.
    """
    return {"spellIds": [spell for spell, _area in reads.areas.gates],
            "areaIds": [area for _spell, area in reads.areas.gates]}


def areas(reads: Reads) -> SectionColumns:
    """Each gated area's own name, its root, and a map to open."""
    known = reads.areas.areas
    ids = sorted(known)
    return {"ids": ids,
            "names": [known[area].name for area in ids],
            "roots": [known[area].root for area in ids],
            "mapIds": [known[area].ui_map for area in ids]}


SPELL_ATTRS = register(Section(
    name="spellAttrs",
    doc="The spells carrying each declared attribute flag.",
    module="core",
    produce=attribute_lists,
    columns=("byFlag",),
    layout=Layout.BARE,
    reads=("attributes",),
    counts=(CountFamily(lambda columns, reads: {
        f"spellAttrs.{handler}": len(spells)
        for handler, spells in sorted(reads.attributes.items())}),),
))

SPELL_DELIVERY = register(Section(
    name="spellDelivery",
    doc="The cast time and channel of every spell that has either.",
    module="core",
    produce=delivery,
    columns=("spellIds", "castMs", "durMs", "flags"),
    reads=("delivery", "spell_ids"),
    counts=(
        Count("spellDelivery", lambda columns, _r: len(columns["spellIds"])),
        Count("delivery.casttime", lambda columns, _r: sum(
            1 for cast in columns["castMs"] if cast > 0)),
        Count("delivery.channelled", lambda columns, _r: sum(
            1 for flags in columns["flags"] if flags & CHANNELLED)),
        Count("delivery.both", lambda columns, _r: sum(
            1 for cast, flags in zip(columns["castMs"], columns["flags"])
            if cast > 0 and flags & CHANNELLED)),
        Count("delivery.breaksOnMove", lambda columns, _r: sum(
            1 for flags in columns["flags"] if flags & BREAKS_ON_MOVE)),
        # The complement: every spell listed in no delivery row at all.
        Count("delivery.instant", lambda columns, reads:
        len(reads.spell_ids) - len(columns["spellIds"])),
    ),
    domains=(
        # A cast of zero is the absence of a cast bar rather than a
        # zero-second cast, so it is not part of the domain.
        Domain("casttime", lambda columns, _r: numeric_domain(
            cast for cast in columns["castMs"] if cast > 0), unit="ms"),
        # -1 is unlimited, a marker rather than a duration; 0 is no row at all.
        Domain("channel", lambda columns, _r: numeric_domain(
            (duration for duration in columns["durMs"] if duration != 0),
            sentinels=(-1,)), unit="ms"),
    ),
))

AREAS = register(Section(
    name="areas",
    doc="Each gated area's own name, its root zone, and the map that shows it.",
    module="core",
    produce=areas,
    columns=("ids", "names", "roots", "mapIds"),
    reads=("areas",),
    cardinality={"mapIds": Cardinality.PARTIAL},
    absent={"mapIds": 0},
    counts=(Count("areas", lambda columns, _r: len(columns["ids"])),),
    localizable=('names',),
))
