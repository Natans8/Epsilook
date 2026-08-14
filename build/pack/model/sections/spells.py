"""The spell list itself, and everything carried one value per spell.

The row order of the whole pack: every other per-spell column is parallel to
`spells.ids`, so a reader joins by position and never by lookup.
"""

from __future__ import annotations

from ...derive import Reads
from ..registry import register
from ..section import Cardinality, Count, Section, SectionColumns

NO_ERA = -1
"""What a spell no expansion rung claims carries.

A real value rather than a guess: it means the id postdates the newest rung, so
the app can say the era is unknown instead of showing the wrong one.
"""

NO_SCHOOL = 0
"""What a spell with no school mask carries, which is schoolless and not absent."""


def spells(reads: Reads) -> SectionColumns:
    """Every spell the build ships, one row each."""
    ids = reads.spell_ids
    names = reads.names
    return {
        "ids": list(ids),
        "names": [names.names[spell] for spell in ids],
        "subtexts": [names.subtexts.get(spell, "") for spell in ids],
        # Folded into the name search corpus and never rendered: a spell may
        # carry several override names and picks between them at cast time, so
        # the row keeps showing the name it actually has.
        "altNames": [reads.alt_names.get(spell, "") for spell in ids],
        "icons": list(reads.icons.spells),
        "schools": [reads.props.school.get(spell, NO_SCHOOL) for spell in ids],
        "eras": [reads.declared.era_of.get(spell, NO_ERA) for spell in ids],
    }


SPELLS = register(Section(
    name="spells",
    doc="Every spell the build lists, and the values it carries one of.",
    module="core",
    produce=spells,
    columns=("ids", "names", "subtexts", "altNames", "icons", "schools", "eras"),
    reads=("spell_ids", "names", "alt_names", "icons", "props", "declared"),
    # Three of these are answers most spells do not have. Saying so is what
    # lets the encoder stop padding them the day the app can read a gap: 831 KB
    # of the raw pack is empty alternative names, which gzip eats and
    # `JSON.parse` still walks.
    cardinality={"subtexts": Cardinality.PARTIAL,
                 "altNames": Cardinality.PARTIAL,
                 "icons": Cardinality.PARTIAL},
    absent={"icons": 0},
    counts=(Count("spells", lambda columns, _reads: len(columns["ids"])),),
    localizable=('names', 'subtexts', 'altNames'),
))
