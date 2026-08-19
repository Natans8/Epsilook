"""Every sound a spell plays, and the names of the kits that play them.

A sound reaches a spell four ways -- through a kit, through a missile, through
a chain, or from an effect row outright -- and by the time it gets here they
are one fact: this spell plays this file, from this kit, at this audience.
"""

from __future__ import annotations

from ..registry import register
from ..section import (Section, size)


SOUND_KIT_NAMES = register(Section(
    name="soundKitNames",
    doc="Human names for the sound kits this pack reaches, from a pinned build.",
    module="core",
    produce=lambda reads: {
        "soundKitIds": [kit for kit, _name in reads.kit_names],
        "names": [name for _kit, name in reads.kit_names]},
    columns=("soundKitIds", "names"),
    reads=("kit_names",),
    counts=(size("soundKitNames", "soundKitIds"),),
))


SOUND_TYPES = register(Section(
    name="soundTypes",
    doc="What each sound type is called, the vocabulary a sound row's type reads through.",
    module="core",
    produce=lambda reads: {
        "ids": sorted(reads.sound_type_names),
        "names": [reads.sound_type_names[value]
                  for value in sorted(reads.sound_type_names)]},
    columns=("ids", "names"),
    reads=("sound_type_names",),
    counts=(size("soundTypes", "ids"),),
))
