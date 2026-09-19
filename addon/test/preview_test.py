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


def test_a_spell_plays_its_kits_in_cast_order(engine: LuaRuntime) -> None:
    """A stage's stored number is its place in the cast, so the sort is by it."""
    # language=Lua
    code = (
        b"""
        local out = {}
        for _, kit in ipairs(Epsilook.Preview.KitsOf(%d)) do
            out[#out + 1] = kit.stage
        end
        return out
    """
        % FROSTBOLT
    )
    stages = cast(list[int], value(engine, code))
    assert stages == sorted(stages)
    assert stages == [1, 3, 6, 7], "precast, cast, impact, then the aura"


def test_a_spell_with_no_visuals_has_nothing_to_play(engine: LuaRuntime) -> None:
    """Which is what stops a hover drawing an empty frame over a result line."""
    # language=Lua
    code = b"""
        for i = 1, 400 do
            local spell = Epsilook:GetSpellDataByIndex(i)
            if spell and #Epsilook.Preview.KitsOf(spell.id) == 0 then
                return "found"
            end
        end
        return "every spell tried had kits"
    """
    assert value(engine, code) == "found"
