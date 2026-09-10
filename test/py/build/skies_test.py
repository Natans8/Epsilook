"""The sky route, whose one hard fact is that a Light row's slots are conditions.

Reading the eight LightParams of a Light row as one set is the mistake this
route exists to prevent: the death sky sits in slot four of nearly every light
in the game, so a reader that unions the slots reports it as the sky of
everywhere rather than the sky of being dead.
"""

from __future__ import annotations

import support
from pack.model.sections.skies import PLACE_MAP, PLACE_WHOLE, PLACE_ZONE, representative
from pack.routes.skies import (
    CONDITIONS,
    RAMP_COLORS,
    SkyPlace,
    SkyPreset,
    SkyRoster,
    read_skies,
    spaced_name,
)

BuildTables = support.BuildTables

SKYBOX = "ID,Name,Flags,SkyboxFileDataID,CelestialSkyboxFileDataID\n1,Environments\\Stars\\Dome.mdx,3,4242,0\n"
PARAMS = "ID,LightSkyboxID,Flags,Glow\n10,1,0,0.5\n11,1,0,0.5\n12,0,0,0.5\n"
RAMP_HEADER = "ID,LightParamID,Time," + ",".join(RAMP_COLORS) + ",FogEnd,ShadowOpacity,CloudDensity\n"
LIGHT_HEADER = (
    "ID,ContinentID,GameCoords_0,GameCoords_1,GameCoords_2,GameFalloffStart,GameFalloffEnd,"
    + ",".join(f"LightParamsID_{slot}" for slot in range(len(CONDITIONS)))
    + "\n"
)
MAPS = "ID,MapName_lang\n0,Azeroth\n1,Draenor\n"


def ramp_row(row: int, preset: int, time: int, colour: int) -> str:
    """One LightData stop holding the same colour in every channel."""
    return f"{row},{preset},{time}," + ",".join([str(colour)] * len(RAMP_COLORS)) + ",100,0.5,0.25\n"


def light_row(row: int, continent: int, coords: str, falloff: str, slots: dict[int, int]) -> str:
    """One Light row with presets in the named slots and nothing in the rest."""
    params = [str(slots.get(slot, 0)) for slot in range(len(CONDITIONS))]
    return f"{row},{continent},{coords},{falloff}," + ",".join(params) + "\n"


def test_a_slot_is_a_condition_rather_than_a_membership(tables: BuildTables) -> None:
    """The whole point: a preset in the death slot is not the sky of that map."""
    lights = LIGHT_HEADER + light_row(1, 1, "5,5,5", "10,20", {0: 10, 4: 11})
    roster = read_skies(tables(LightSkybox=SKYBOX, LightParams=PARAMS, Light=lights, Map=MAPS))
    assert roster.places[10].conditions == [0]
    assert roster.places[11].conditions == [4]
    assert CONDITIONS[4] == "while you are dead"


def test_a_light_at_the_origin_with_no_radius_is_the_whole_map(tables: BuildTables) -> None:
    """The client reads that row as the map's own sky, which is a different
    fact from a light that happens to stand at the middle of the world."""
    lights = LIGHT_HEADER + light_row(1, 1, "0,0,0", "0,0", {0: 10}) + light_row(2, 0, "5,5,5", "10,20", {0: 11})
    roster = read_skies(tables(LightSkybox=SKYBOX, LightParams=PARAMS, Light=lights, Map=MAPS))
    assert roster.places[10].defaults == ["Draenor"]
    assert roster.places[11].defaults == []
    assert roster.places[11].maps == ["Azeroth"]


def test_a_zone_names_the_place_and_a_map_is_the_fallback(tables: BuildTables) -> None:
    lights = LIGHT_HEADER + light_row(7, 1, "5,5,5", "10,20", {0: 10})
    zones = "ID,Name,MapID,LightID\n1,ShadowMoonMain,1,7\n"
    roster = read_skies(tables(LightSkybox=SKYBOX, LightParams=PARAMS, Light=lights, Map=MAPS, ZoneLight=zones))
    assert roster.places[10].zones == ["Shadow Moon Main"]
    assert roster.places[10].maps == ["Draenor"]


def test_a_build_without_zone_lights_still_places_a_sky(tables: BuildTables) -> None:
    """ZoneLight arrives in Cataclysm; before it the client hardcodes the rows."""
    lights = LIGHT_HEADER + light_row(7, 1, "5,5,5", "10,20", {0: 10})
    roster = read_skies(
        tables(
            LightSkybox=SKYBOX,
            LightParams=PARAMS,
            Light=lights,
            Map=MAPS,
            absent={
                "ZoneLight": "pre-Cataclysm",
                "LightData": "no ramp in this fixture",
                "SpellName": "no spells in this fixture",
            },
        )
    )
    assert roster.places[10].zones == []
    assert roster.places[10].maps == ["Draenor"]


def test_a_ramp_arrives_in_time_order_whatever_the_file_says(tables: BuildTables) -> None:
    ramp = RAMP_HEADER + ramp_row(1, 10, 1440, 7) + ramp_row(2, 10, 0, 3)
    roster = read_skies(tables(LightSkybox=SKYBOX, LightParams=PARAMS, LightData=ramp))
    assert [stop.time for stop in roster.presets[10].ramp] == [0, 1440]
    assert roster.presets[10].ramp[0].colors == (3,) * len(RAMP_COLORS)


def test_a_map_a_light_names_but_the_table_does_not_still_reads(tables: BuildTables) -> None:
    """A place with no name is better than a light dropped for want of one."""
    lights = LIGHT_HEADER + light_row(1, 99, "5,5,5", "10,20", {0: 10})
    roster = read_skies(tables(LightSkybox=SKYBOX, LightParams=PARAMS, Light=lights, Map=MAPS))
    assert roster.places[10].maps == ["map 99"]


def test_the_preset_a_dome_stands_for_is_the_one_most_lights_draw() -> None:
    """Lights rather than maps: a preset on one map under forty lights is the
    sky of that place, and one on three maps under three is a corner of each."""
    roster = SkyRoster(
        skyboxes={},
        presets={10: SkyPreset(1, 0, 0.0), 11: SkyPreset(1, 0, 0.0)},
        places={10: SkyPlace(maps=["Azeroth"], lights=3), 11: SkyPlace(maps=["Draenor"], lights=40)},
    )
    assert representative(roster, [10, 11], {}) == 11


def test_a_preset_a_spell_can_reach_breaks_a_tie() -> None:
    """A row nobody can apply is worth less than one they can."""
    roster = SkyRoster(
        skyboxes={},
        presets={10: SkyPreset(1, 0, 0.0), 11: SkyPreset(1, 0, 0.0)},
        places={10: SkyPlace(maps=["Azeroth"], lights=5), 11: SkyPlace(maps=["Draenor"], lights=5)},
    )
    assert representative(roster, [10, 11], {11: [1002455]}) == 11


def test_a_zone_name_is_spaced_the_way_a_reader_spells_it() -> None:
    assert spaced_name("BoreanTundra") == "Borean Tundra"
    assert spaced_name("ZulDrak") == "Zul Drak"
    # a build prefix is one word, so the digit is not a boundary
    assert spaced_name("9CAS_Main") == "9CAS Main"


def test_the_three_place_kinds_are_distinct() -> None:
    """They ship as numbers, so a reader tells them apart by value."""
    assert len({PLACE_ZONE, PLACE_MAP, PLACE_WHOLE}) == 3
