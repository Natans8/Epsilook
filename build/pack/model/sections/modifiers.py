"""The values a spell sets on its subject: how fast, how big, how hidden.

Three families that have nothing in common at the source and everything in
common here: each is a number an aura sets, each carries who it was aimed at,
and each is searched by that number rather than by a name.
"""

from __future__ import annotations

from collections.abc import Callable

from ...derive import Reads
from ...measure import numeric_domain
from ..registry import register
from ..section import Count, Domain, Section, SectionColumns

PAIRED = "paired"
"""Keep only the channels the other side of the pairing also has."""

UNPAIRED = "unpaired"
"""Keep every channel, whether or not anything answers it."""


def channels(payload: str, gate: str) -> Callable[[Reads], SectionColumns]:
    """One side of the invisibility pairing.

    A channel is materialised only where it has an invisible side, and that one
    rule is the whole asymmetry: a spell that hides always shows a pill, even
    when nothing in the game can reveal it, while a spell that reveals shows one
    only when its channel has something to reveal.
    """
    def produce(reads: Reads) -> SectionColumns:
        hidden = {kind for kinds in reads.effects.invis.ids.values()
                  for kind in kinds}
        source = getattr(reads.effects, payload)
        rows = sorted((spell, kind) for spell, kinds in source.ids.items()
                      for kind in kinds if gate == UNPAIRED or kind in hidden)
        return {"spellIds": [row[0] for row in rows],
                "types": [row[1] for row in rows],
                "targets": [source.masks.get(row, 0) for row in rows]}
    return produce


def speeds(reads: Reads) -> SectionColumns:
    """Every movement a spell scales, and by how much.

    Several auras reach one movement, so a spell setting two of them to the
    same amount is one row rather than two identical pills.
    """
    rows = sorted((spell, movement, percent)
                  for spell, mods in reads.effects.speeds.items()
                  for movement, percent in mods)
    return {"spellIds": [row[0] for row in rows],
            "movements": [row[1] for row in rows],
            "percents": [row[2] for row in rows],
            "targets": [reads.effects.speed_targets.get(row, 0) for row in rows]}


def scales(reads: Reads) -> SectionColumns:
    """Every size change a spell applies.

    One number per row and nothing else: unlike movement there is only one
    thing an aura can scale, so the number is the whole pill.
    """
    rows = sorted((spell, percent) for spell, percents
                  in reads.effects.scales.items() for percent in percents)
    return {"spellIds": [row[0] for row in rows],
            "percents": [row[1] for row in rows],
            "targets": [reads.effects.scale_targets.get(row, 0) for row in rows]}


SPELL_INVIS = register(Section(
    name="spellInvis",
    doc="Which invisibility channel a spell hides its subject on.",
    module="core",
    produce=channels("invis", UNPAIRED),
    columns=("spellIds", "types", "targets"),
    reads=("effects",),
    counts=(Count("spellInvis", lambda columns, _r: len(columns["spellIds"])),
            Count("invisChannels",
                  lambda columns, _r: len(set(columns["types"])))),
    domains=(Domain("invis",
                    lambda columns, _r: numeric_domain(columns["types"])),),
))

SPELL_DETECTS = register(Section(
    name="spellDetects",
    doc="Which invisibility channel a spell can see through.",
    module="core",
    produce=channels("detect", PAIRED),
    columns=("spellIds", "types", "targets"),
    reads=("effects",),
    counts=(Count("spellDetects", lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_SPEEDS = register(Section(
    name="spellSpeeds",
    doc="Every movement a spell scales, and by how much.",
    module="core",
    produce=speeds,
    columns=("spellIds", "movements", "percents", "targets"),
    reads=("effects",),
    counts=(Count("spellSpeeds", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("speed",
                    lambda columns, _r: numeric_domain(columns["percents"])),),
))

SPELL_SCALES = register(Section(
    name="spellScales",
    doc="Every size change a spell applies.",
    module="core",
    produce=scales,
    columns=("spellIds", "percents", "targets"),
    reads=("effects",),
    counts=(Count("spellScales", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("scale",
                    lambda columns, _r: numeric_domain(columns["percents"])),),
))
