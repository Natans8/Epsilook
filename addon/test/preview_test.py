"""What a part can be looked at as, and in what order a spell plays.

The drawing half needs the client's frames and is not here. What is here is the
half that decides what gets handed to the client, which is the half that can be
wrong quietly: a file id says nothing about what the file is, and the client
loads whatever it is given as whatever it was asked for.
"""

from __future__ import annotations

from typing import cast

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


def test_a_thing_that_happens_to_a_body_is_played_rather_than_drawn(engine: LuaRuntime) -> None:
    """An animation runs through once in about a second, so it has to loop.

    A subject carries a `stage` when it happens to a body and a `draw` when it
    simply is, and that split is what decides whether the clock runs for it.
    """
    # language=Lua
    code = b"""
        local out = {}
        for _, subject in ipairs(Epsilook.Preview.SUBJECTS) do
            out[#out + 1] = subject.word .. (subject.stage and ":played" or ":drawn")
        end
        return out
    """
    assert cast(list[str], value(engine, code)) == [
        "animkit:played",
        "anim:played",
        "visual:played",
        "creature:drawn",
        "model:drawn",
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


def test_the_loop_settles_on_the_aura_rather_than_the_last_stage(engine: LuaRuntime) -> None:
    """A stage's number is not its running order, and the aura is not always last."""
    # language=Lua
    code = b"""
        local sequence = { { word = "cast" }, { word = "aura" }, { word = "travel" } }
        local bare = { { word = "cast" }, { word = "impact" } }
        return Epsilook.Preview.HoldOf(sequence) .. ":" .. Epsilook.Preview.HoldOf(bare)
    """
    assert value(engine, code) == "2:2", "the aura, and otherwise wherever it ends up"


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
        return held.word .. ":" .. #held.displays
    """
    assert value(engine, code) == "aura:1", "the horse, held"
