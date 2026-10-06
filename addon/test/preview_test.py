"""What a part can be looked at as, and in what order a spell plays.

The drawing half needs the client's frames and is not here, save where the
camera stands, which is arithmetic on a box. What is here is the half that
decides what gets handed to the client, which is the half that can be wrong
quietly: a file id says nothing about what the file is, and the client loads
whatever it is given as whatever it was asked for.
"""

from __future__ import annotations

import math
from typing import cast

import pytest
from support import LuaRuntime, unwrap

FROSTBOLT = 116


def value(engine: LuaRuntime, code: bytes) -> object:
    """One Lua value as what it stands for."""
    return unwrap(engine.execute(code))


def test_a_sound_is_not_a_model(engine: LuaRuntime) -> None:
    """A sound row names a file, and it is not one the model loader can take.

    Handing an `.ogg` to `SetModel` crashes the client outright, which no `pcall`
    around it survives, so the refusal has to happen before the call.
    """
    # language=Lua
    code = b"""
        for i = 1, Epsilook:GetNumParts(%d, "sound") do
            local part = Epsilook:GetPartDataByIndex(%d, "sound", i)
            if Epsilook.Preview.Offers(part) then
                return "sound row " .. i .. " offered a preview"
            end
        end
        return "none"
    """ % (FROSTBOLT, FROSTBOLT)
    assert value(engine, code) == "none"


def test_every_offered_model_is_a_model_file(engine: LuaRuntime) -> None:
    """Whatever is offered as a model is a file the model loader reads."""
    # language=Lua
    code = b"""
        local out = {}
        for _, axis in ipairs(Epsilook:GetPartAxes()) do
            for i = 1, Epsilook:GetNumParts(%d, axis) do
                local part = Epsilook:GetPartDataByIndex(%d, axis, i)
                if Epsilook.Preview.ModelOf(part) then
                    local _, path = Epsilook.Inspect.FileOf(part)
                    out[#out + 1] = string.lower(string.match(path, "%%.([%%a%%d]+)$"))
                end
            end
        end
        return out
    """ % (FROSTBOLT, FROSTBOLT)
    offered = cast(list[str], value(engine, code))
    assert offered, "the example spell carries models"
    assert set(offered) == {"m2"}


def test_a_model_part_is_still_offered(engine: LuaRuntime) -> None:
    """The refusal above is about the file, not about turning previews off."""
    # language=Lua
    code = (
        b"""
        local part = Epsilook:GetPartDataByIndex(%d, "model", 1)
        local subject = Epsilook.Preview.SubjectOf(part)
        return subject and subject.word or "none"
    """
        % FROSTBOLT
    )
    assert value(engine, code) == "model"


def test_a_spell_plays_its_stages_in_cast_order(engine: LuaRuntime) -> None:
    """A stage's stored number is its place in the cast, so the sort is by it."""
    # language=Lua
    code = (
        b"""
        local out = {}
        for _, stage in ipairs(Epsilook.Preview.SequenceOf(%d)) do
            out[#out + 1] = stage.stage
        end
        return out
    """
        % FROSTBOLT
    )
    stages = cast(list[int], value(engine, code))
    assert stages == sorted(stages)
    assert stages == [1, 3, 6, 7], "precast, cast, impact, then the aura"


def test_a_stage_carries_the_body_as_well_as_the_effects(engine: LuaRuntime) -> None:
    """A cast read without its animations is a caster standing still through it.

    The example spell readies, casts, and is hit, each beside a visual kit, so a
    sequence that gathered only the kits would lose all three.
    """
    # language=Lua
    code = (
        b"""
        local out = {}
        for _, stage in ipairs(Epsilook.Preview.SequenceOf(%d)) do
            out[#out + 1] = stage.stage
                .. ":" .. #stage.kits .. ":" .. #stage.animkits .. ":" .. #stage.anims
        end
        return out
    """
        % FROSTBOLT
    )
    assert cast(list[str], value(engine, code)) == ["1:1:1:0", "3:1:1:0", "6:1:0:1", "7:1:0:0"]


def test_a_spell_with_no_visuals_has_nothing_to_play(engine: LuaRuntime) -> None:
    """Which is what stops a hover drawing an empty frame over a result line."""
    # language=Lua
    code = b"""
        for i = 1, 400 do
            local spell = Epsilook:GetSpellDataByIndex(i)
            if spell and #Epsilook.Preview.SequenceOf(spell.id) == 0 then
                return "found"
            end
        end
        return "every spell tried had something to play"
    """
    assert value(engine, code) == "found"


def test_a_creature_is_previewed_as_its_display(engine: LuaRuntime) -> None:
    """A display is the model already wearing its textures; the file is a grey shape."""
    # language=Lua
    code = b"""
        for i = 1, Epsilook:GetNumParts(118, "fx") do
            local part = Epsilook:GetPartDataByIndex(118, "fx", i)
            local subject = Epsilook.Preview.SubjectOf(part)
            if subject and subject.word == "creature" then
                return "found"
            end
        end
        return "the morph offered no creature"
    """
    assert value(engine, code) == "found"


def test_a_part_is_read_as_the_richest_thing_it_names(engine: LuaRuntime) -> None:
    """The order of the subjects is which reading wins where two could apply.

    A creature comes before the file it is built from, since a display is that
    model already wearing its textures; a mount comes before either, since you
    sit on one rather than turn into one.
    """
    # language=Lua
    code = b"""
        local out = {}
        for _, subject in ipairs(Epsilook.Preview.SUBJECTS) do
            out[#out + 1] = subject.word
            if type(subject.put) ~= "function" then
                return "a subject with no way to put it up: " .. subject.word
            end
        end
        return out
    """
    assert cast(list[str], value(engine, code)) == [
        "animkit",
        "anim",
        "visual",
        "mount",
        "creature",
        "model",
    ]


def test_a_visual_kit_is_previewed_on_its_own(engine: LuaRuntime) -> None:
    """The kit rows are the handles on what a spell draws, so each is a look."""
    # language=Lua
    code = b"""
        for i = 1, Epsilook:GetNumParts(%d, "fx") do
            local part = Epsilook:GetPartDataByIndex(%d, "fx", i)
            if part.kind == "visual" then
                local subject = Epsilook.Preview.SubjectOf(part)
                return subject and subject.word or "none"
            end
        end
        return "no visual row"
    """ % (FROSTBOLT, FROSTBOLT)
    assert value(engine, code) == "visual"


def test_the_loop_settles_on_the_aura_whatever_else_the_spell_carries(engine: LuaRuntime) -> None:
    """The aura is played last by construction, not by where a list happens to put it.

    A stage no word in the running order names sorts after every named one, and
    left there it would be what the loop settles on. So across a spread of real
    spells, wherever a sequence has an aura, the aura is its last beat.
    """
    # language=Lua
    code = b"""
        local held, wrong = 0, {}
        for i = 1, 3000 do
            local spell = Epsilook:GetSpellDataByIndex(i)
            if spell then
                local sequence = Epsilook.Preview.SequenceOf(spell.id)
                for at, stage in ipairs(sequence) do
                    if stage.word == Epsilook.Preview.HELD then
                        held = held + 1
                        if at ~= #sequence then
                            wrong[#wrong + 1] = spell.id
                        end
                    end
                end
            end
        end
        return held, #wrong, wrong[1]
    """
    held, wrong, first = cast(tuple[int, int, object], engine.execute(code))
    assert held > 100, "enough spells carry an aura for the check to mean something"
    assert wrong == 0, f"spell {first} settles somewhere after its aura"


def test_the_aura_ending_is_not_part_of_the_run(engine: LuaRuntime) -> None:
    """On this server an aura runs until it is cancelled.

    So the stage where one ends is what a player sees when they choose to stop
    it, not a stage of the spell running, and a loop that played it would say
    every spell undoes itself a moment after it lands.
    """
    # language=Lua
    code = b"""
        local ending = 0
        for _, spell in ipairs({ 458, 2645, 32235 }) do
            for _, stage in ipairs(Epsilook.Preview.SequenceOf(spell)) do
                if stage.word == Epsilook.Preview.ENDED then
                    ending = ending + 1
                end
            end
        end
        return ending
    """
    assert value(engine, code) == 0, "all three spells carry an auraend row"


def test_a_mount_is_shown_at_the_stage_the_spell_leaves(engine: LuaRuntime) -> None:
    """A mount row carries no stage; being mounted is what the spell leaves."""
    # language=Lua
    code = b"""
        local sequence = Epsilook.Preview.SequenceOf(458)
        local at = Epsilook.Preview.HoldOf(sequence)
        local held = sequence[at]
        if not held then
            return "nothing held"
        end
        return held.word .. ":" .. #held.mounts
    """
    assert value(engine, code) == "aura:1", "the horse, held, with a rider to seat"


def test_a_shapeshift_form_reads_down_to_what_it_looks_like(engine: LuaRuntime) -> None:
    """A form is stored as a number and shown as a name, which says what the
    caster turns into without saying what that looks like.

    The pack has carried the rest of the way since the form names shipped, so
    this is a reader rather than a route.
    """
    # language=Lua
    code = b"""
        local worn = Epsilook:GetDisplaysByForm(16)
        if #worn == 0 then
            return "the ghost wolf wears nothing"
        end
        return worn[1].id
    """
    assert value(engine, code) == 55287


def test_a_shapeshift_is_the_body_for_the_rest_of_the_run(engine: LuaRuntime) -> None:
    """Ghost Wolf leaves the caster a wolf, which is the whole of what it does."""
    # language=Lua
    code = b"""
        local sequence = Epsilook.Preview.SequenceOf(2645)
        local held = sequence[Epsilook.Preview.HoldOf(sequence)]
        if not held then
            return "nothing held"
        end
        return held.word .. ":" .. tostring(held.displays[1])
    """
    assert value(engine, code) == "aura:55287"


def test_a_shapeshift_row_is_previewed_on_its_own(engine: LuaRuntime) -> None:
    """Resting on the form's own line shows the form, not nothing."""
    # language=Lua
    code = b"""
        for i = 1, Epsilook:GetNumParts(2645, "fx") do
            local part = Epsilook:GetPartDataByIndex(2645, "fx", i)
            if part.kind == "shapeshift" then
                local subject, worn = Epsilook.Preview.SubjectOf(part)
                if not subject then
                    return "the form offered nothing"
                end
                return subject.word .. ":" .. tostring(worn)
            end
        end
        return "no shapeshift row"
    """
    assert value(engine, code) == "creature:55287"


def test_a_mount_is_its_own_subject_so_a_rider_can_be_seated(engine: LuaRuntime) -> None:
    """A mount is not a morph: you sit on it rather than turn into it.

    The client's own mount list draws the rider, so the distinction has to
    survive as far as the frame rather than collapsing into a display.
    """
    # language=Lua
    code = b"""
        for i = 1, Epsilook:GetNumParts(458, "model") do
            local part = Epsilook:GetPartDataByIndex(458, "model", i)
            if part.kind == "mount" then
                local subject, display = Epsilook.Preview.SubjectOf(part)
                if not subject then
                    return "the mount offered nothing"
                end
                return subject.word .. ":" .. tostring(display)
            end
        end
        return "no mount row"
    """
    assert value(engine, code) == "mount:2404"


Box = tuple[float, float, float, float, float, float]


def camera_for(engine: LuaRuntime, box: Box | None) -> list[float]:
    """Where the camera stands once a body with this bounding box has loaded."""
    given = ", ".join(str(side) for side in box) if box else ""
    # language=Lua
    code = b"""
        local box = { %s }
        local placed
        local frame = {
            scene = { SetCameraPosition = function(_, x, y, z) placed = { x, y, z } end },
            body = { GetActiveBoundingBox = function() return unpack(box) end },
        }
        Epsilook.Preview.Fit(frame)
        return placed
    """ % given.encode()
    return cast(list[float], value(engine, code))


def off_centre(camera: list[float], point: tuple[float, float, float]) -> float:
    """How far off the line of sight a point is, as an angle, for a camera
    looking back along the first axis at the scene's origin."""
    seen = (point[0] - camera[0], point[1] - camera[1], point[2] - camera[2])
    length = math.sqrt(sum(part * part for part in seen))
    return math.acos(-seen[0] / length)


FIGURE: Box = (-0.5, -0.55, 0.0, 0.5, 0.55, 2.1)
DRAGON: Box = (-12.0, -6.0, 0.0, 12.0, 6.0, 9.0)
PROP: Box = (0.0, 0.0, 0.0, 4.0, 3.0, 2.0)


@pytest.mark.parametrize("box", [FIGURE, DRAGON, PROP], ids=["figure", "dragon", "prop"])
def test_a_body_is_wholly_in_view_however_it_is_turned(engine: LuaRuntime, box: Box) -> None:
    """A preview drew the model in the top half of its box and cut it off there.

    The camera looked at the model's origin, which is at its feet. Every corner
    of the model, stood on the middle of its height as the look stands it, has
    to fall inside the field of view from where the camera is fitted, at every
    turn a reader can drag it to: a dragon and a prop whose origin is a corner
    as much as a figure.
    """
    camera = camera_for(engine, box)
    half_field = cast(float, value(engine, b"return Epsilook.Preview.FIELD")) / 2
    x1, y1, z1, x2, y2, z2 = box
    middle = (z1 + z2) / 2
    for step in range(16):
        turn = step * math.tau / 16
        for x in (x1, x2):
            for y in (y1, y2):
                for z in (z1, z2):
                    point = (
                        x * math.cos(turn) - y * math.sin(turn),
                        x * math.sin(turn) + y * math.cos(turn),
                        z - middle,
                    )
                    assert off_centre(camera, point) <= half_field


def test_a_figure_fills_its_look_rather_than_shrinking_into_it(engine: LuaRuntime) -> None:
    """In view is not the whole answer: a camera stood a mile off holds every
    model and shows none of them. A standing figure is at least half the
    height of its look."""
    camera = camera_for(engine, FIGURE)
    half_field = cast(float, value(engine, b"return Epsilook.Preview.FIELD")) / 2
    top = (0.0, 0.0, (FIGURE[5] - FIGURE[2]) / 2)
    assert off_centre(camera, top) >= half_field / 2


def test_a_body_with_no_size_yet_keeps_the_camera_where_it_waits(engine: LuaRuntime) -> None:
    """A model with no bounding box, an invisible one or one not yet read,
    leaves the camera where it waits rather than nowhere."""
    camera = camera_for(engine, None)
    assert camera == [value(engine, b"return Epsilook.Preview.DISTANCE"), 0, 0]


def test_a_lent_inside_is_left_empty_where_there_is_nothing_to_play(engine: LuaRuntime) -> None:
    """A spell with no visuals, and a client with no frames to draw in, both answer false."""
    # language=Lua
    answers = value(
        engine,
        b"""
        local quiet
        for i = 1, 400 do
            local spell = Epsilook:GetSpellDataByIndex(i)
            if spell and #Epsilook.Preview.SequenceOf(spell.id) == 0 then
                quiet = spell.id
                break
            end
        end
        local parent, Preview = {}, Epsilook.Preview
        local answers = { Preview.Lent(parent, quiet), Preview.Lent(parent, 116) }
        Preview.Unlent(parent)
        return answers
        """,
    )
    assert answers == [False, False], "no visuals; then no CreateFrame in this tree"


def test_a_lent_inside_is_left_empty_where_the_data_cannot_load(engine: LuaRuntime) -> None:
    # language=Lua
    shown = value(
        engine,
        b"""
        local loaded, load = Epsilook.IsDataLoaded, Epsilook.LoadData
        Epsilook.IsDataLoaded = function() return false end
        Epsilook.LoadData = function() return false, "missing" end
        local result = Epsilook.Preview.Lent({}, 116)
        Epsilook.IsDataLoaded, Epsilook.LoadData = loaded, load
        return result
        """,
    )
    assert shown is False


def test_spells_are_offered_to_glimpse_where_it_is_loaded(beside_glimpse: LuaRuntime) -> None:
    # language=Lua
    offered = value(
        beside_glimpse,
        b"""
        local spell = OFFERED.spell
        return { spell.name, type(spell.Show), type(spell.Hide), tostring(spell.Show({}, 116)) }
        """,
    )
    assert offered == ["Epsilook", "function", "function", "false"], "no data here, so nothing shown"


def test_a_fault_while_filling_glimpse_is_answered_as_an_empty_inside(
    beside_glimpse: LuaRuntime,
) -> None:
    # language=Lua
    answer = value(
        beside_glimpse,
        b"""
        Epsilook.Preview.Lent = function() error("broken") end
        return tostring(OFFERED.spell.Show({}, 116))
        """,
    )
    assert answer == "false"
