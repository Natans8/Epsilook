"""The sky: which dome a place draws, in which colours, and under which condition.

A `LightSkybox` row is a dome's model. A `LightParams` row is a preset that
picks one and colours the day around it, and its `LightData` rows are that
day's ramp, one stop per moment of the 2,880 half-minutes.

Where a preset is drawn is a `Light` row: a sphere on a map, carrying EIGHT
LightParams rather than one. The slots are conditions, not a set --
`ParamsClear`, `ParamsClearWat`, `ParamsStorm`, `ParamsStormWat`, `ParamsDeath`
and three the client documents as unknown -- so reading them together makes the
sky of being dead look like the sky of everywhere, which is what it looked like
before they were separated. A `ZoneLight` row is the only thing that gives a
stretch of a map a name; without one, the map is as close to a place as a light
gets, because no table turns a light's coordinates into an area.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .columns import to_int
from .route import route

CONDITIONS = (
    "",
    "underwater",
    "in a storm",
    "underwater in a storm",
    "while you are dead",
    "in another state",
    "in another state",
    "in another state",
)
"""What each of a Light row's eight LightParams slots means.

Read off `LightRec::m_lightParamsID` (wowdev.wiki, DB/Light). The clear-weather
slot needs no saying and is empty; the last three are documented as unknown and
carry 37 rows between them, so they are named for what can be said rather than
guessed at.
"""

SLOT_START = 7
"""Where a Light row's eight LightParams slots begin in the projection.

The five before them are the id, the map, the three coordinates and the two
falloff radii, and the pair that decides whether a light stands anywhere at all
is read from the same span, so the two must move together.
"""

RAMP_COLORS = (
    "SkyTopColor",
    "SkyMiddleColor",
    "SkyBand1Color",
    "SkyBand2Color",
    "SkySmogColor",
    "SkyFogColor",
    "SunColor",
    "AmbientColor",
    "DirectColor",
    "HorizonAmbientColor",
    "GroundAmbientColor",
    "RiverCloseColor",
    "OceanCloseColor",
    "EndFogColor",
)
"""The packed colours of one ramp stop, in the order the columns ship in.

The sky's own six, the two lights that fall on the world, the two ambients a
surface reads, the two waters, and the colour the far distance fades to. Packed
0xAARRGGBB, as `screens` already ships a colour.
"""


@dataclass
class SkyStop:
    """One `LightData` row: what the sky holds at one moment of the day."""

    time: int
    """The half-minute of the 2,880-half-minute day this stop is keyed at."""

    colors: tuple[int, ...]
    """One packed colour per name in `RAMP_COLORS`, in that order."""

    fog_end: float
    """How far the fog reaches, in the client's own units."""

    shadow: float
    """How opaque a shadow is under this light, from zero to one."""

    cloud: float
    """How dense the cloud layer is, from zero to one."""


@dataclass
class Skybox:
    """One `LightSkybox` row: a dome, its model, and how it is drawn."""

    name: str
    """The client's own path, `Environments\\Stars\\X.mdx`."""

    file: int
    """The model's file id. Zero on the builds that name a skybox by path alone."""

    celestial: int
    """A second model drawn for the celestial sphere, or zero."""

    flags: int
    """Bit 1 animates the dome over the whole day, bit 2 combines it with the
    procedural sky, bit 4 blends the procedural fog."""


@dataclass
class SkyPreset:
    """One `LightParams` row: the dome it picks and the day it colours."""

    skybox: int
    """The `LightSkybox` row, or zero for a preset that draws no model."""

    flags: int
    glow: float
    ramp: list[SkyStop] = field(default_factory=list)
    """The day's stops, in time order. Empty for a preset with no LightData."""


@dataclass
class SkyPlace:
    """Where and when one preset is drawn."""

    zones: list[str] = field(default_factory=list)
    """The `ZoneLight` names, which is the only naming of a place there is."""

    maps: list[str] = field(default_factory=list)
    """The maps a Light row carrying this preset stands on."""

    defaults: list[str] = field(default_factory=list)
    """The maps whose own sky this is: a light at the origin with no radius."""

    conditions: list[int] = field(default_factory=list)
    """The `CONDITIONS` slots that reach it, ascending."""

    lights: int = 0
    """How many `Light` rows carry it, in any slot.

    What says a preset is the one people have actually seen, which a count of
    maps does not: a preset on one map under a hundred lights is the sky of
    that place, and one on three maps under three lights is a corner of each.
    """


@dataclass
class SkyRoster:
    """Every sky the build declares, and where each is drawn."""

    skyboxes: dict[int, Skybox]
    presets: dict[int, SkyPreset]
    places: dict[int, SkyPlace]
    """Keyed by `LightParams` id; a preset no light carries is absent."""


def flat_ramp(preset: SkyPreset) -> bool:
    """Whether every stop holds the same colours, so the hour changes nothing.

    A preset like this needs one picture rather than one per hour, and a reader
    wants telling that the sky it is looking at is the sky at every hour.
    """
    return all(stop.colors == preset.ramp[0].colors for stop in preset.ramp)


def read_skyboxes(tables: Tables) -> dict[int, Skybox]:
    """Every skybox dome the build declares."""
    return {
        to_int(sky_id): Skybox(
            name=(name or "").strip(), file=to_int(file), celestial=to_int(celestial), flags=to_int(flags)
        )
        for sky_id, name, flags, file, celestial in tables.rows(
            "LightSkybox", ["ID", "Name", "Flags", "SkyboxFileDataID", "CelestialSkyboxFileDataID"]
        )
    }


def read_presets(tables: Tables) -> dict[int, SkyPreset]:
    """Every preset, with its ramp attached in time order."""
    presets = {
        to_int(preset_id): SkyPreset(skybox=to_int(skybox), flags=to_int(flags), glow=float(glow or 0))
        for preset_id, skybox, flags, glow in tables.rows("LightParams", ["ID", "LightSkyboxID", "Flags", "Glow"])
    }
    columns = ["LightParamID", "Time", *RAMP_COLORS, "FogEnd", "ShadowOpacity", "CloudDensity"]
    for row in tables.rows("LightData", columns):
        preset = presets.get(to_int(row[0]))
        if preset is None:
            continue
        preset.ramp.append(
            SkyStop(
                time=to_int(row[1]),
                colors=tuple(to_int(value) for value in row[2 : 2 + len(RAMP_COLORS)]),
                fog_end=float(row[-3] or 0),
                shadow=float(row[-2] or 0),
                cloud=float(row[-1] or 0),
            )
        )
    for preset in presets.values():
        preset.ramp.sort(key=lambda stop: stop.time)
    return presets


def read_places(tables: Tables) -> dict[int, SkyPlace]:
    """Where each preset is drawn, and under which of the eight conditions.

    A light at the origin with no falloff radius is not standing anywhere: the
    client reads it as the whole map's own sky, which is a different fact from
    a light that happens to sit at the middle of the world.
    """
    maps = {to_int(map_id): (name or "").strip() for map_id, name in tables.rows("Map", ["ID", "MapName_lang"])}
    slots = [f"LightParamsID_{slot}" for slot in range(len(CONDITIONS))]
    columns = [
        "ID",
        "ContinentID",
        *[f"GameCoords_{axis}" for axis in range(3)],
        "GameFalloffStart",
        "GameFalloffEnd",
        *slots,
    ]
    lights: dict[int, tuple[int, ...]] = {}
    places: dict[int, SkyPlace] = {}
    for row in tables.rows("Light", columns):
        light_id, continent = to_int(row[0]), to_int(row[1])
        params = tuple(to_int(value) for value in row[SLOT_START:])
        lights[light_id] = params
        name = maps.get(continent) or f"map {continent}"
        whole = not any(float(value or 0) for value in row[2:SLOT_START])
        for slot, preset in enumerate(params):
            if not preset:
                continue
            place = places.setdefault(preset, SkyPlace())
            place.lights += 1
            if slot not in place.conditions:
                place.conditions.append(slot)
            if name not in place.maps:
                place.maps.append(name)
            if whole and name not in place.defaults:
                place.defaults.append(name)
    for zone_name, light in tables.rows("ZoneLight", ["Name", "LightID"]):
        for preset in lights.get(to_int(light), ()):
            if not preset:
                continue
            place = places.setdefault(preset, SkyPlace())
            spaced = spaced_name(zone_name or "")
            if spaced and spaced not in place.zones:
                place.zones.append(spaced)
    for place in places.values():
        place.conditions.sort()
    return places


def spaced_name(name: str) -> str:
    """`BoreanTundra` as `Borean Tundra`, which is how a reader spells a zone."""
    out: list[str] = []
    for index, letter in enumerate(name.strip()):
        if letter == "_":
            out.append(" ")
            continue
        # only a lower-to-upper step is a word boundary: a build prefix like
        # `9CAS` is one word, and splitting on the digit spells it "9 CAS"
        if index and letter.isupper() and name[index - 1].islower():
            out.append(" ")
        out.append(letter)
    return "".join(out).strip()


@route("skies")
def read_skies(tables: Tables) -> SkyRoster:
    """Read the whole sky: the domes, the presets that pick them, and the places.

    Which spells set a preset is not read here. A spell reaches a preset through
    the screen effect its aura names, and that edge is derived from the effect
    rows and the screen payloads rather than from any sky table.
    """
    return SkyRoster(skyboxes=read_skyboxes(tables), presets=read_presets(tables), places=read_places(tables))
