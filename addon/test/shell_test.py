"""The chat shell's pure half: the lines it prints and the messages it reads.

Printing and the slash command need the client and are not tested here; what
is tested is every function that turns a record into a line or a message into
a decision, run bare.
"""

from __future__ import annotations

from typing import cast

from support import LuaFunction, LuaRuntime, LuaTable, lua_function, lua_table


def method(table: LuaTable, name: bytes) -> LuaFunction:
    return cast(LuaFunction, table[name])


def result(engine: LuaRuntime, spell_id: int) -> tuple[str, str]:
    api = lua_table(engine, b"Epsilook")
    spell = method(api, b"GetSpellDataByID")(api, spell_id)
    counts = method(api, b"GetPartCounts")(api, spell_id)
    axes = method(api, b"GetPartAxes")(api)
    head, actions = cast(tuple[bytes, bytes], lua_function(engine, b"Epsilook.Shell.ResultLines")(spell, counts, axes))
    return head.decode(), actions.decode()


def test_a_result_is_the_spell_then_its_actions(engine: LuaRuntime) -> None:
    head, actions = result(engine, 133)
    # Under a bare interpreter there is no client to ask, so the pack's name and
    # icon stand in; the icon leads the game's own spell link.
    assert head.startswith("|cffffd100133|r - |cffffffff|Hspell:133|h|T135812:16|t[Fireball]|h|r")
    # Each count is a link that lists the axis on hover and prints it on a click.
    assert "|Hgarrmission:epsilook:133:list:model:0|h[5 model]|h" in head
    assert "12 sound" in head
    assert actions.startswith("      ")
    for verb, label in (("learn", "Learn"), ("cast", "Cast"), ("inspect", "Inspect")):
        assert f"|Hgarrmission:epsilook:133:{verb}|h[{label}]|h" in actions


def test_a_lone_spell_is_an_inspection(engine: LuaRuntime) -> None:
    lone = lua_function(engine, b"Epsilook.Shell.LoneSpell")
    assert lone(b"133") == 133
    assert lone(b"|cff71d5ff|Hspell:133:0|h[Fireball]|h|r") == 133
    assert lone(b"|Hspell:133|h[Fireball]|h") == 133
    assert lone(b"133 fire") is None
    assert lone(b"fireball") is None


def test_only_a_leading_subcommand_word_is_taken(engine: LuaRuntime) -> None:
    split = lua_function(engine, b"Epsilook.Shell.Split")
    assert split(b"Next") == (b"next", b"")
    assert split(b"next") == (b"next", b"")
    assert split(b"nextdoor fire") == (None, b"nextdoor fire")
    assert split(b'name:"next fire"') == (None, b'name:"next fire"')


def test_a_part_line_carries_its_actions(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    part = method(api, b"GetPartDataByIndex")(api, 133, b"model", 1)
    line = lua_function(engine, b"Epsilook.Inspect.PartLine")(133, part, 1)
    assert isinstance(line, bytes)
    text = line.decode()
    # The line names the kind, the file by its name alone, and the part's own link.
    assert "missile:" in text and "|Hgarrmission:epsilook:133:part:model:1|h[" in text
    assert ".m2]" in text and "SPELLS/" not in text
    # Fireball's missile model has a known spawn id, so the spawn link is offered.
    assert "|Hgarrmission:epsilook:133:spawn:model:1|h[Spawn]|h" in text
    sound = method(api, b"GetPartDataByIndex")(api, 133, b"sound", 1)
    sound_line = lua_function(engine, b"Epsilook.Inspect.PartLine")(133, sound, 1)
    assert isinstance(sound_line, bytes)
    assert "|Hgarrmission:epsilook:133:play:sound:1|h[Play]|h" in sound_line.decode()
    assert "|Hgarrmission:epsilook:133:stop:sound:1|h[Stop]|h" in sound_line.decode()


def test_the_dossier_prints_every_axis_the_spell_has(engine: LuaRuntime) -> None:
    # language=Lua
    engine.execute(b"""
    function DOSSIER(id)
      local out = {}
      Epsilook.Inspect.Print(id, function(line) out[#out + 1] = line end)
      return table.concat(out, "\\n")
    end
    """)
    printed = lua_function(engine, b"DOSSIER")(133)
    assert isinstance(printed, bytes)
    text = printed.decode()
    assert "[Fireball]" in text and "5 Models" in text and "12 Sounds" in text and "1 Mechanics" in text
    # Sounds are grouped under their kit: the kit's line, then its files indented.
    assert "|cff00ccffkit:|r" in text
    assert "\n    |cffffffff|Hgarrmission:epsilook:133:part:sound:1|h[fx_fire_magic_loop_medium_01.ogg]|h" in text
    assert "no spell" in str(lua_function(engine, b"DOSSIER")(0))


def test_help_comes_from_the_declarations(engine: LuaRuntime) -> None:
    lines = cast(LuaTable, lua_function(engine, b"Epsilook.Shell.HelpLines")())
    text = "\n".join(str(cast(bytes, lines[i]).decode()) for i in range(1, len(list(lines.keys())) + 1))
    assert "model" in text and "cast" in text and ">=" in text


def test_the_spell_text_record_holds_the_pools(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    text = cast(LuaTable, method(api, b"GetSpellTextByID")(api, 317228))
    assert cast(bytes, text[b"description"]).startswith(b"Kneel before your master")
    assert cast(bytes, text[b"aura"]).startswith(b"Kneel before your master")
    assert text[b"encounter"] == b""
    assert method(api, b"GetSpellTextByID")(api, 0) is None


def test_a_leading_head_word_scopes_everything_after_it(engine: LuaRuntime) -> None:
    lenient = lua_function(engine, b"Epsilook.Shell.Lenient")
    assert lenient(b"model 6dr") == b"model:{6dr}"
    assert lenient(b"model 6dr fire") == b"model:{6dr fire}"
    assert lenient(b"model 6dr -missile") == b"model:{6dr -missile}"
    assert lenient(b"model {6dr fire}") == b"model:{6dr fire}"
    assert lenient(b'name "fire ball"') == b'name:{"fire ball"}'
    assert lenient(b"model:6dr fire") == b"model:6dr fire"
    assert lenient(b"fire model") == b"fire model"
    assert lenient(b"cast >2s") == b"cast:>2s"
    assert lenient(b"cast >2s fire") == b"cast:>2s fire"
    assert lenient(b"fireball") == b"fireball"


def test_the_aura_word_is_offered_only_where_an_aura_is_applied(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    has = method(api, b"HasPartOfKind")
    # Kneel 317228 applies an aura; Fireball 133 does not.
    assert has(api, 317228, b"mech", b"aura") is True
    assert has(api, 133, b"mech", b"aura") is False
    assert "[Aura]" not in result(engine, 133)[1]
    assert "[Aura]" in result(engine, 317228)[1]


def test_every_part_tooltip_fills_on_every_axis(engine: LuaRuntime) -> None:
    """A tooltip that throws half-filled never sizes itself; the filler must run clean on every axis."""
    # language=Lua
    engine.execute(b"""
    function TOOLTIPS(list)
      local ids = {}
      for word in list:gmatch("%d+") do ids[#ids + 1] = tonumber(word) end
      local tip = { n = 0 }
      function tip:SetText() self.n = 1 end
      function tip:AddLine() self.n = self.n + 1 end
      local failures = {}
      for _, id in ipairs(ids) do
        for _, axis in ipairs(Epsilook:GetPartAxes()) do
          for i = 1, Epsilook:GetPartCounts(id)[axis] or 0 do
            local ok, err = pcall(Epsilook.Inspect.FillTooltip, tip, Epsilook:GetPartDataByIndex(id, axis, i))
            if not ok then failures[#failures + 1] = axis .. " " .. id .. " " .. i .. ": " .. tostring(err) end
          end
          local ok, err = pcall(Epsilook.Inspect.FillAxisTooltip, tip, id, axis)
          if not ok then failures[#failures + 1] = axis .. " " .. id .. ": " .. tostring(err) end
        end
      end
      return table.concat(failures, "; ")
    end
    """)
    # The ids cross as one string: a Python list arrives in Lua as userdata, not a table.
    failures = lua_function(engine, b"TOOLTIPS")(b"133 317228 32979 126 116 160955")
    assert failures == b"", failures
