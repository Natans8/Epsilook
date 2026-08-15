"""Every sound a spell plays, and the names of the kits that play them.

A sound reaches a spell four ways -- through a kit, through a missile, through
a chain, or from an effect row outright -- and by the time it gets here they
are one fact: this spell plays this file, from this kit, at this audience.
"""

from __future__ import annotations

from ..registry import register
from ..section import Count, Section


SOUND_KIT_NAMES = register(Section(
    name="soundKitNames",
    doc="Human names for the sound kits this pack reaches, from a pinned build.",
    module="core",
    produce=lambda reads: {
        "soundKitIds": [kit for kit, _name in reads.kit_names],
        "names": [name for _kit, name in reads.kit_names]},
    columns=("soundKitIds", "names"),
    reads=("kit_names",),
    counts=(Count("soundKitNames",
                  lambda columns, _r: len(columns["soundKitIds"])),),
))
