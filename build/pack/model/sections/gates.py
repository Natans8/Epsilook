"""What stops a spell, times it, reaches with it, or places it.

Four routes that answer "can I cast this, and what happens when I do" rather
than "what does it look like".
"""

from __future__ import annotations

from collections.abc import Callable

from ...derive import Reads
from ...measure import numeric_domain
from ...routes.delivery import BREAKS_ON_MOVE, CHANNELLED
from ...routes.reach import MELEE, UNLIMITED, WEAPON
from ..registry import register
from ..section import Cardinality, Count, CountFamily, Domain, Layout, Section, SectionColumns, size


def attribute_lists(reads: Reads) -> SectionColumns:
    """Every declared attribute flag, and the spells carrying it.

    A map keyed by the flag's handler rather than a section per flag, so that
    shipping another one is an edit to the checked-in enum plus a pill type,
    and nothing here branches on which flag it is.
    """
    return {"byFlag": {handler: list(spells) for handler, spells in sorted(reads.attributes.items())}}


def delivery(reads: Reads) -> SectionColumns:
    """How each spell that has a cast time or a channel is delivered.

    Only spells that have one are listed; instant is the complement, worked out
    at load, which is what lets a spell with no timing row at all still get an
    answer. It is not a partition either way -- a spell can have both a cast
    and a channel, and thousands do.
    """
    rows = reads.delivery
    return {
        "spellIds": [row.spell for row in rows],
        "castMs": [row.cast_ms for row in rows],
        "durMs": [row.duration_ms for row in rows],
        "flags": [row.flags for row in rows],
    }


NO_REACH = 0
"""The band of a spell that reaches no further than its caster.

Bands are numbered from one, so the commonest answer by far is also the
cheapest value to store and needs no entry in the table at all.
"""


def reaches(reads: Reads) -> SectionColumns:
    """How far each spell reaches: a band table, and one band per spell.

    The band column runs parallel to `spells.ids`, so a reader joins by
    position, and `NO_REACH` is a spell that reaches nobody but its caster --
    over half of them. Shipping the band rather than the distances is what
    makes that affordable: a build draws on a couple of hundred distinct bands
    for a quarter of a million spells, so the table itself costs well under a
    kilobyte and only the index is paid per spell.
    """
    slots: dict[tuple[float, float, int], int] = {}
    bands: list[tuple[float, float, int]] = []
    reach_of = {row.spell: row for row in reads.reach}

    of: list[int] = []
    for spell in reads.spell_ids:
        row = reach_of.get(spell)
        if row is None:
            of.append(NO_REACH)
            continue
        band = (row.max_yards, row.min_yards, row.flags)
        if (slot := slots.get(band)) is None:
            slot = slots[band] = len(bands) + 1
            bands.append(band)
        of.append(slot)

    return {
        "of": of,
        "maxYards": [band[0] for band in bands],
        "minYards": [band[1] for band in bands],
        "flags": [band[2] for band in bands],
    }


def reaching(columns: SectionColumns, wanted: Callable[[float, float, int], bool]) -> int:
    """How many spells carry a band the predicate accepts.

    Every count this section reports is per spell rather than per band, since
    a band shared by nine thousand spells and one used once are not the same
    answer to "how many spells reach anywhere".
    """
    accepted = [
        wanted(far, near, flags) for far, near, flags in zip(columns["maxYards"], columns["minYards"], columns["flags"])
    ]
    return sum(1 for band in columns["of"] if band != NO_REACH and accepted[band - 1])


def distances(columns: SectionColumns) -> list[float]:
    """The far edge each reaching spell carries, one entry per spell.

    The domain describes the distances a reader can ask for, so it is measured
    over the spells rather than over the band table: a band is one row whether
    one spell uses it or thirty thousand do.
    """
    far_edges = list(columns["maxYards"])
    return [far_edges[band - 1] for band in columns["of"] if band != NO_REACH]


def area_gates(reads: Reads) -> SectionColumns:
    """One row per place a spell may be cast.

    The pill is a group, so a spell gated to four areas ships four rows and no
    primary area is invented.
    """
    return {
        "spellIds": [spell for spell, _area in reads.areas.gates],
        "areaIds": [area for _spell, area in reads.areas.gates],
    }


def areas(reads: Reads) -> SectionColumns:
    """Each gated area's own name, its root, and a map to open."""
    known = reads.areas.areas
    ids = sorted(known)
    return {
        "ids": ids,
        "names": [known[area].name for area in ids],
        "roots": [known[area].root for area in ids],
        "mapIds": [known[area].ui_map for area in ids],
    }


SPELL_ATTRS = register(
    Section(
        name="spellAttrs",
        doc="The spells carrying each declared attribute flag.",
        module="core",
        produce=attribute_lists,
        columns=("byFlag",),
        layout=Layout.BARE,
        reads=("attributes",),
        counts=(
            CountFamily(
                lambda columns, reads: {
                    f"spellAttrs.{handler}": len(spells) for handler, spells in sorted(reads.attributes.items())
                }
            ),
        ),
    )
)

SPELL_DELIVERY = register(
    Section(
        name="spellDelivery",
        doc="The cast time and channel of every spell that has either.",
        module="core",
        produce=delivery,
        columns=("spellIds", "castMs", "durMs", "flags"),
        reads=("delivery", "spell_ids"),
        degraded_without=("SpellDuration", "SpellInterrupts"),
        counts=(
            size("spellDelivery", "spellIds"),
            Count("delivery.casttime", lambda columns, _r: sum(1 for cast in columns["castMs"] if cast > 0)),
            Count(
                "delivery.channelled", lambda columns, _r: sum(1 for flags in columns["flags"] if flags & CHANNELLED)
            ),
            Count(
                "delivery.both",
                lambda columns, _r: sum(
                    1 for cast, flags in zip(columns["castMs"], columns["flags"]) if cast > 0 and flags & CHANNELLED
                ),
            ),
            Count(
                "delivery.breaksOnMove",
                lambda columns, _r: sum(1 for flags in columns["flags"] if flags & BREAKS_ON_MOVE),
            ),
            # The complement: every spell listed in no delivery row at all.
            Count("delivery.instant", lambda columns, reads: len(reads.spell_ids) - len(columns["spellIds"])),
        ),
        domains=(
            # A cast of zero is the absence of a cast bar rather than a
            # zero-second cast, so it is not part of the domain.
            Domain(
                "casttime",
                lambda columns, _r: numeric_domain(cast for cast in columns["castMs"] if cast > 0),
                unit="ms",
            ),
            # -1 is unlimited, a marker rather than a duration; 0 is no row at all.
            Domain(
                "channel",
                lambda columns, _r: numeric_domain(
                    (duration for duration in columns["durMs"] if duration != 0), sentinels=(-1,)
                ),
                unit="ms",
            ),
        ),
    )
)

SPELL_RANGES = register(
    Section(
        name="spellRanges",
        doc="Each distinct distance band, and the one every spell reaches with.",
        module="core",
        produce=reaches,
        columns=("of", "maxYards", "minYards", "flags"),
        reads=("reach", "spell_ids"),
        counts=(
            Count("spellRanges", lambda columns, _r: sum(1 for band in columns["of"] if band != NO_REACH)),
            Count("range.bands", lambda columns, _r: len(columns["maxYards"])),
            Count(
                "range.unlimited", lambda columns, _r: reaching(columns, lambda far, _near, _flags: far >= UNLIMITED)
            ),
            Count("range.minimum", lambda columns, _r: reaching(columns, lambda _far, near, _flags: near > 0)),
            Count("range.melee", lambda columns, _r: reaching(columns, lambda _far, _near, flags: bool(flags & MELEE))),
            Count(
                "range.weapon", lambda columns, _r: reaching(columns, lambda _far, _near, flags: bool(flags & WEAPON))
            ),
            # The complement: every spell reaching no further than its caster,
            # which includes the ones listed in no range row at all.
            Count("range.self", lambda columns, _r: sum(1 for band in columns["of"] if band == NO_REACH)),
        ),
        domains=(
            # The unlimited band is a marker rather than a distance: left in, it
            # would put the far bound of every control at fifty thousand yards.
            Domain("range", lambda columns, _r: numeric_domain(distances(columns), sentinels=(UNLIMITED,)), unit="yd"),
        ),
    )
)

AREAS = register(
    Section(
        name="areas",
        doc="Each gated area's own name, its root zone, and the map that shows it.",
        module="core",
        produce=areas,
        columns=("ids", "names", "roots", "mapIds"),
        reads=("areas",),
        degraded_without=("UiMap", "UiMapAssignment"),
        cardinality={"mapIds": Cardinality.PARTIAL},
        absent={"mapIds": 0},
        counts=(size("areas", "ids"),),
        localizable=("names",),
    )
)
