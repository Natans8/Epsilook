"""The sky surface, read through the interpreter the client runs.

The sky is the one family the addon carries whose subject is not a spell, so
nothing else here exercises the shape: a roster keyed by its own id with three
side sections hanging off it. These run against the built data, because what is
worth proving is that the Lua reads what the Python emitted.
"""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, unwrap

# A Lua value's shape is not knowable to the checker, so the two shapes these
# tests read are named once here rather than cast at every assertion.
Record = dict[str, object]
Listed = list[object]


def record(engine: LuaRuntime, code: bytes) -> Record:
    """One Lua table as the mapping it stands for."""
    return cast(Record, unwrap(engine.execute(code)))


def listed(engine: LuaRuntime, code: bytes) -> Listed:
    """One Lua array as the list it stands for."""
    return cast(Listed, unwrap(engine.execute(code)))


def number(value: object) -> float:
    """One field as the number it is, so arithmetic on it typechecks."""
    if not isinstance(value, (int, float)):
        raise TypeError(f"expected a number, got {value!r}")
    return value


def test_the_roster_is_carried_and_reachable(engine: LuaRuntime) -> None:
    # language=Lua
    assert number(unwrap(engine.execute(b"return Epsilook:GetNumSkies()"))) > 300


def test_a_dome_reads_down_to_where_it_is_seen(engine: LuaRuntime) -> None:
    """Shadowmoon: a dome seventeen presets share, named by two zones."""
    # language=Lua
    sky = record(engine, b"return Epsilook:GetSkyDataByID(9)")
    assert cast(str, sky["name"]).endswith("shadowmoonskybox.mdx")
    assert sky["file"] == 130623
    assert sky["presets"] == 17
    assert sky["param"] == 2124
    assert sky["zones"] == ["Shadow Moon Main", "Talador City Corrupt"]
    assert sky["maps"] == ["Outland", "Draenor"]


def test_a_condition_bit_is_spelled_and_the_plain_sky_is_not(engine: LuaRuntime) -> None:
    """Shadowmoon is drawn clear and in a storm, and only the storm is worth saying."""
    # language=Lua
    sky = record(engine, b"return Epsilook:GetSkyDataByID(9)")
    assert sky["conditions"] == 5
    assert sky["conditionWords"] == ["in a storm"]


def test_the_spell_offered_is_the_one_setting_the_standing_preset(engine: LuaRuntime) -> None:
    """A dome with seventeen ways in must offer the one that draws its own row."""
    # language=Lua
    found = record(engine, b"local s, p = Epsilook:GetSkySpells(9) return {spells = s, params = p}")
    spells, params = cast(Listed, found["spells"]), cast(Listed, found["params"])
    assert len(spells) == len(params) > 1
    # language=Lua
    sky = record(engine, b"return Epsilook:GetSkyDataByID(9)")
    assert sky["spell"] == spells[params.index(sky["param"])]


def test_a_colour_unpacks_to_four_channels(engine: LuaRuntime) -> None:
    # language=Lua
    channels = listed(engine, b"local r, g, b, a = Epsilook:UnpackColor(0xFF804020) return {r, g, b, a}")
    r, g, b, a = (round(number(value), 3) for value in channels)
    assert (r, g, b, a) == (round(0x80 / 255, 3), round(0x40 / 255, 3), round(0x20 / 255, 3), 1.0)


def test_the_light_is_answered_at_any_moment_of_the_day(engine: LuaRuntime) -> None:
    """The ramp ships as stops, so a moment between two of them is blended."""
    # language=Lua
    light = record(engine, b"return Epsilook:GetSkyLight(9, 1440)")
    for field in ("top", "middle", "band1", "sun", "ambient", "fog"):
        assert isinstance(light[field], (int, float))
    assert number(light["cloud"]) >= 0


def test_the_day_wraps_rather_than_falling_off_its_last_stop(engine: LuaRuntime) -> None:
    """A moment past the last stop reads back towards the first, not to nothing."""
    # language=Lua
    late = record(engine, b"return Epsilook:GetSkyLight(9, 2879)")
    # language=Lua
    early = record(engine, b"return Epsilook:GetSkyLight(9, 0)")
    assert late["top"] is not None and early["top"] is not None


def test_a_dome_nothing_carries_answers_nothing(engine: LuaRuntime) -> None:
    # language=Lua
    assert engine.execute(b"return Epsilook:GetSkyDataByID(999999)") is None
    # language=Lua
    assert engine.execute(b"return Epsilook:GetSkyLight(999999, 0)") is None


def test_a_search_finds_a_dome_by_its_zone(engine: LuaRuntime) -> None:
    """The zone is what a reader knows, and the file name is what the game knows."""
    # language=Lua
    assert 9 in listed(engine, b"return Epsilook:FindSkies('Talador City Corrupt')")


def test_an_action_returns_its_command_and_sends_nothing(engine: LuaRuntime) -> None:
    """The surface performs nothing, so a command comes back as text."""
    # language=Lua
    sky = record(engine, b"return Epsilook:GetSkyDataByID(9)")
    # language=Lua
    command = unwrap(engine.execute(b"return Epsilook:GetSkyCommand('zone', 9)"))
    assert command == f"phase shift zone skybox {sky['spell']}"
    # language=Lua
    assert engine.execute(b"return Epsilook:GetSkyCommand('nonesuch', 9)") is None


def test_every_action_names_a_field_the_record_carries(engine: LuaRuntime) -> None:
    """An action naming a field no record has is one no interface can offer."""
    # language=Lua
    actions = listed(engine, b"return Epsilook:GetSkyActions()")
    # language=Lua
    sky = record(engine, b"return Epsilook:GetSkyDataByID(9)")
    for action in actions:
        assert cast(Record, action)["needs"] in sky


def test_a_preset_a_spell_sets_carries_its_own_colours(engine: LuaRuntime) -> None:
    """Shadowmoon is shared by seventeen presets, and a spell may set any of
    them; the one the dome's row stands for is only one answer of the many."""
    # language=Lua
    own = record(engine, b"return Epsilook:GetSkyLightByParam(2124, 1440)")
    # language=Lua
    sibling = listed(
        engine,
        b"""
            local _, params = Epsilook:GetSkySpells(9)
            local found = {}
            for at = 1, #params do
                if params[at] ~= 2124 and Epsilook:GetSkyLightByParam(params[at], 1440) then
                    found[#found + 1] = params[at]
                end
            end
            return found
        """,
    )
    assert isinstance(own["top"], (int, float))
    assert sibling, "a dome's other presets carry ramps of their own"


def test_a_dome_answers_through_the_preset_its_row_stands_for(engine: LuaRuntime) -> None:
    """The dome call is the preset call underneath, so the two agree."""
    # language=Lua
    by_dome = record(engine, b"return Epsilook:GetSkyLight(9, 600)")
    # language=Lua
    by_param = record(engine, b"return Epsilook:GetSkyLightByParam(2124, 600)")
    assert by_dome == by_param


def test_a_preset_nothing_carries_answers_nothing(engine: LuaRuntime) -> None:
    # language=Lua
    assert engine.execute(b"return Epsilook:GetSkyLightByParam(999999, 0)") is None


def test_a_preset_says_which_dome_it_draws(engine: LuaRuntime) -> None:
    """A spell names a preset, and the dome is what a reader wants to show."""
    # language=Lua
    preset = record(engine, b"return Epsilook:GetSkyPresetByID(2124)")
    assert preset["skybox"] == 9
    # language=Lua
    assert engine.execute(b"return Epsilook:GetSkyPresetByID(999999)") is None
