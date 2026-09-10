"""The sky a place draws, as one row per dome.

A skybox is not a spell's payload, which is what every other visual family here
is. It is a property of a PLACE, and it reaches a player through a spell whose
aura names a screen effect carrying a light preset -- a retail spell that
darkens the sky, or a private server's spell that exists only to set one. So
the roster is the domes, and the spell is an edge into it rather than the
other way round.

One row per dome rather than per preset: 2,884 presets share 414 domes, most of
them differing only in a colour a reader would not name. The preset a row stands
for is the one the most `Light` rows draw, which is the sky most people have
actually seen.
"""

from __future__ import annotations

from collections.abc import Mapping

from ...derive import Reads
from ...routes import CONDITIONS, RAMP_COLORS, SkyPlace, SkyRoster, flat_ramp
from ..registry import register
from ..section import Section, SectionColumns, size

PLACE_ZONE = 0
"""A `ZoneLight` name: the only naming of a place the client ships."""

PLACE_MAP = 1
"""A map a `Light` row stands on, for a light no zone names."""

PLACE_WHOLE = 2
"""A map whose own sky this is, from a light at the origin with no radius."""


def representative(skies: SkyRoster, presets: list[int], spells: Mapping[int, list[int]]) -> int:
    """The preset a dome's row stands for.

    The one the most `Light` rows draw, because that is the sky most people
    have seen; a preset a spell can reach breaks a tie, since a row nobody can
    apply is worth less than one they can, and the lowest id breaks the rest.
    """
    return min(
        presets,
        key=lambda preset: (
            -skies.places.get(preset, SkyPlace()).lights,
            0 if preset in spells else 1,
            preset,
        ),
    )


def presets_by_dome(skies: SkyRoster) -> dict[int, list[int]]:
    """Every preset that picks each dome, in id order."""
    out: dict[int, list[int]] = {}
    for preset, row in sorted(skies.presets.items()):
        if row.skybox in skies.skyboxes:
            out.setdefault(row.skybox, []).append(preset)
    return out


def chosen_presets(reads: Reads) -> list[tuple[int, int]]:
    """Every dome any preset picks, with the preset its row stands for.

    Every sky section walks the same roster, and which preset stands for a dome
    is one decision; deriving it twice is how they would come to disagree.
    """
    skies: SkyRoster = reads.skies
    by_dome = presets_by_dome(skies)
    return [(dome, representative(skies, by_dome[dome], reads.sky_spells)) for dome in sorted(by_dome)]


def dome_place(skies: SkyRoster, presets: list[int]) -> SkyPlace:
    """Where a DOME is seen, which is the union over every preset that picks it.

    A dome is what a reader is looking at, and asking only the preset its row
    stands for hides the zones its siblings are drawn in. The places come from
    the clear-weather slot wherever any preset has one, so a dome that is also
    somebody's storm sky is still named by where it is the sky.
    """
    places = [skies.places[preset] for preset in presets if preset in skies.places]
    conditions = sorted({slot for place in places for slot in place.conditions})
    plain = [place for place in places if 0 in place.conditions]
    named = plain or places
    return SkyPlace(
        zones=list(dict.fromkeys(zone for place in named for zone in place.zones)),
        maps=list(dict.fromkeys(name for place in named for name in place.maps)),
        defaults=list(dict.fromkeys(name for place in named for name in place.defaults)),
        conditions=conditions,
        lights=sum(place.lights for place in places),
    )


def rows(reads: Reads) -> SectionColumns:
    """One row per dome any preset picks, in dome-id order."""
    skies: SkyRoster = reads.skies
    picked = chosen_presets(reads)
    by_dome = presets_by_dome(skies)
    domes = [skies.skyboxes[dome] for dome, _ in picked]
    places = [dome_place(skies, by_dome[dome]) for dome, _ in picked]
    return {
        "ids": [dome for dome, _ in picked],
        "names": [dome.name for dome in domes],
        "files": [dome.file for dome in domes],
        "celestialFiles": [dome.celestial for dome in domes],
        "skyFlags": [dome.flags for dome in domes],
        "params": [preset for _, preset in picked],
        # how many presets share this dome, which is what says a row stands for more than itself
        "presets": [len(by_dome[dome]) for dome, _ in picked],
        # the eight Light slots that reach it, as a mask: bit 0 is the plain sky and the rest are conditions
        "conditions": [sum(1 << slot for slot in place.conditions) for place in places],
        # a flat ramp draws the same sky at every hour, which saves a reader comparing six pictures to find out
        "flat": [int(flat_ramp(skies.presets[preset])) for _, preset in picked],
    }


def places(reads: Reads) -> SectionColumns:
    """Where each dome is seen, one row per place, zones before maps."""
    skies: SkyRoster = reads.skies
    by_dome = presets_by_dome(skies)
    listed: list[tuple[int, int, str]] = []
    for dome, _ in chosen_presets(reads):
        place = dome_place(skies, by_dome[dome])
        listed += [(dome, PLACE_ZONE, name) for name in place.zones]
        listed += [(dome, PLACE_WHOLE if name in place.defaults else PLACE_MAP, name) for name in place.maps]
    return {
        "skyboxIds": [sky for sky, _, _ in listed],
        "kinds": [kind for _, kind, _ in listed],
        "names": [name for _, _, name in listed],
    }


def spells(reads: Reads) -> SectionColumns:
    """Every spell that sets each dome, one row per spell.

    All of them rather than the standing preset's alone: a dome with seventeen
    presets has seventeen ways in, and which one a reader wants depends on the
    zone they are after. `paramIds` says which preset each spell sets, so the
    one matching `skyboxes.params` is the one that draws the row's own picture.

    Only the presets that pick a dome are listed here, since the roster is the
    domes; a spell setting a domeless preset reaches the sky through the screen
    section's own preset column instead.
    """
    found: Mapping[int, list[int]] = reads.sky_spells
    by_dome = presets_by_dome(reads.skies)
    listed = [
        (dome, preset, spell) for dome in sorted(by_dome) for preset in by_dome[dome] for spell in found.get(preset, [])
    ]
    return {
        "skyboxIds": [dome for dome, _, _ in listed],
        "paramIds": [preset for _, preset, _ in listed],
        "spells": [spell for _, _, spell in listed],
    }


def ramps(reads: Reads) -> SectionColumns:
    """The chosen presets' ramps, one row per stop.

    A stop is keyed at a half-minute of the 2,880-half-minute day and a reader
    between two stops interpolates; shipping the stops rather than a fixed set
    of hours is what lets a consumer ask for any moment.
    """
    skies: SkyRoster = reads.skies
    stops = [(sky, stop) for sky, preset in chosen_presets(reads) for stop in skies.presets[preset].ramp]
    return {
        "skyboxIds": [sky for sky, _ in stops],
        "times": [stop.time for _, stop in stops],
        "fogEnds": [stop.fog_end for _, stop in stops],
        "shadowOpacities": [stop.shadow for _, stop in stops],
        "cloudDensities": [stop.cloud for _, stop in stops],
        **{ramp_column(name): [stop.colors[index] for _, stop in stops] for index, name in enumerate(RAMP_COLORS)},
    }


def conditions(reads: Reads) -> SectionColumns:
    """What each bit of a dome's condition mask means, in bit order.

    The words ship once, here, rather than being spelled again by every reader
    of the mask.
    """
    _ = reads
    return {"bits": list(range(len(CONDITIONS))), "words": list(CONDITIONS)}


def ramp_column(color: str) -> str:
    """`SkyTopColor` as the column name `skyTopColors`."""
    return f"{color[0].lower()}{color[1:]}s"


RAMP_COLUMNS = tuple(ramp_column(name) for name in RAMP_COLORS)
"""The ramp's colour columns, named from `RAMP_COLORS` so the two cannot drift."""

SKYBOXES = register(
    Section(
        name="skyboxes",
        doc="Every sky dome, the preset it is drawn by, and the conditions it is drawn under.",
        module="sky",
        produce=rows,
        columns=("ids", "names", "files", "celestialFiles", "skyFlags", "params", "presets", "conditions", "flat"),
        reads=("skies", "sky_spells"),
        needs=("LightSkybox", "LightParams"),
        degraded_without=("LightData", "Light"),
        counts=(size("skyboxes", "ids"),),
    )
)

SKY_PLACES = register(
    Section(
        name="skyPlaces",
        doc="Where each dome is seen: the zones that name it, then the maps it stands on.",
        module="sky",
        produce=places,
        columns=("skyboxIds", "kinds", "names"),
        reads=("skies", "sky_spells"),
        needs=("LightSkybox", "LightParams"),
        degraded_without=("Light", "ZoneLight", "Map"),
    )
)

SKY_SPELLS = register(
    Section(
        name="skySpells",
        doc="The spells that set each dome, which is how a player reaches one.",
        module="sky",
        produce=spells,
        columns=("skyboxIds", "paramIds", "spells"),
        reads=("skies", "sky_spells"),
        needs=("LightSkybox", "LightParams", "ScreenEffect"),
        counts=(size("skySpells", "spells"),),
    )
)

SKY_RAMPS = register(
    Section(
        name="skyRamps",
        doc="The colour of the day for each dome's preset, one row per stop.",
        module="sky",
        produce=ramps,
        columns=("skyboxIds", "times", "fogEnds", "shadowOpacities", "cloudDensities", *RAMP_COLUMNS),
        reads=("skies", "sky_spells"),
        needs=("LightSkybox", "LightParams", "LightData"),
    )
)

SKY_CONDITIONS = register(
    Section(
        name="skyConditions",
        doc="What each bit of a dome's condition mask means.",
        module="sky",
        produce=conditions,
        columns=("bits", "words"),
        reads=(),
        needs=("LightSkybox", "Light"),
    )
)
