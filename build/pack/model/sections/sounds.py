"""Every sound a spell plays, and the names of the kits that play them.

A sound reaches a spell four ways -- through a kit, through a missile, through
a chain, or from an effect row outright -- and by the time it gets here they
are one fact: this spell plays this file, from this kit, at this audience.
"""

from __future__ import annotations

from collections import Counter

from ...derive import Reads
from ...measure import numeric_domain
from ..registry import register
from ..section import Count, Domain, Section, SectionColumns


def spell_sounds(reads: Reads) -> SectionColumns:
    """One row per file a spell plays."""
    rows = reads.rows.sounds
    return {"spellIds": [row[0] for row in rows],
            "soundKitIds": [row[1] for row in rows],
            "fids": [row[2] for row in rows],
            "targets": [row[3] for row in rows]}


SPELL_SOUNDS = register(Section(
    name="spellSounds",
    doc="One row per sound file a spell plays, with the kit it came from.",
    module="core",
    produce=spell_sounds,
    columns=("spellIds", "soundKitIds", "fids", "targets"),
    reads=("rows",),
    counts=(Count("spellSounds", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("count.sound", lambda columns, _r: numeric_domain(
        Counter(columns["spellIds"]).values())),),
))

SOUND_KIT_NAMES = register(Section(
    name="soundKitNames",
    doc="Human names for the sound kits this pack reaches, from a pinned build.",
    module="names",
    produce=lambda reads: {
        "soundKitIds": [kit for kit, _name in reads.kit_names],
        "names": [name for _kit, name in reads.kit_names]},
    columns=("soundKitIds", "names"),
    reads=("kit_names",),
    counts=(Count("soundKitNames",
                  lambda columns, _r: len(columns["soundKitIds"])),),
))
