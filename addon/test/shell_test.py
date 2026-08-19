"""The chat shell's pure half: the lines it prints and the messages it reads.

Printing and the slash command need the client and are not tested here; what
is tested is every function that turns a record into a line or a message into
a decision, run bare.
"""

from __future__ import annotations

import re
from typing import cast

from support import LuaFunction, LuaRuntime, LuaTable, as_list, lua_function, lua_table, unwrap


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
    assert split(b"count model:missile") == (b"count", b"model:missile")
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


def dossier(engine: LuaRuntime, spell_id: int) -> str:
    """The dossier's lines, joined, as printed under a bare interpreter."""
    # language=Lua
    engine.execute(b"""
    function DOSSIER(id)
      local out = {}
      Epsilook.Inspect.Print(id, function(line) out[#out + 1] = line end)
      return table.concat(out, "\\n")
    end
    """)
    return cast(bytes, lua_function(engine, b"DOSSIER")(spell_id)).decode()


def test_the_dossier_prints_every_axis_the_spell_has(engine: LuaRuntime) -> None:
    text = dossier(engine, 133)
    assert "[Fireball]" in text and "5 Models" in text and "12 Sounds" in text and "1 Mechanics" in text
    # Sounds are grouped under their kit: the kit's line, then its files indented.
    assert "|cff3ddc84kit:|r" in text
    assert "\n    |cffffffff|Hgarrmission:epsilook:133:part:sound:1|h[fx_fire_magic_loop_medium_01.ogg]|h" in text
    assert "no spell" in dossier(engine, 0)


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
    assert lenient(b"model fire") == b"model:{fire}"
    assert lenient(b"model fire missile") == b"model:{fire missile}"
    assert lenient(b"model fire -missile") == b"model:{fire -missile}"
    assert lenient(b"model {fire missile}") == b"model:{fire missile}"
    assert lenient(b'name "fire ball"') == b'name:{"fire ball"}'
    assert lenient(b"model:fire missile") == b"model:fire missile"
    assert lenient(b"fire model") == b"fire model"
    assert lenient(b"cast >2s") == b"cast:>2s"
    assert lenient(b"cast >2s fire") == b"cast:>2s fire"
    assert lenient(b"fireball") == b"fireball"


def test_a_head_word_alone_asks_for_any_value_of_it(engine: LuaRuntime) -> None:
    """`model` on its own is the spells with a model, not the spells whose text says model."""
    lenient = lua_function(engine, b"Epsilook.Shell.Lenient")
    assert lenient(b"model") == b"model:*"
    assert lenient(b"model ") == b"model:*"
    assert lenient(b"scale") == b"scale:*"
    assert lenient(b"model:*") == b"model:*"
    assert lenient(b"fireball") == b"fireball"


def test_a_creature_resolves_to_its_displays_in_slot_order(engine: LuaRuntime) -> None:
    """Polymorph's sheep wears two displays; the first is the one a command
    is handed, and a lookup that kept the last would morph the wrong sheep."""
    api = lua_table(engine, b"Epsilook")
    worn = as_list(method(api, b"GetDisplaysByCreature")(api, 16372))
    assert worn == [
        {"id": 856, "file": {"id": 1377131, "text": "Creature/Sheep2/Sheep2.m2"}},
        {"id": 857, "file": {"id": 1377131, "text": "Creature/Sheep2/Sheep2.m2"}},
    ]
    assert method(api, b"GetDisplayByCreature")(api, 16372) == 856
    assert method(api, b"GetDisplayByCreature")(api, 0) is None
    # A display's skins are its textures, in slot order, by display id.
    skins = [cast(dict[str, object], skin)["text"]
             for skin in as_list(method(api, b"GetDisplaySkins")(api, 856))]
    assert skins == ["Creature/Sheep2/sheep2_white.blp"]
    assert unwrap(method(api, b"GetDisplaySkins")(api, 0)) == {}


def test_a_part_names_its_displays_through_a_creature_or_outright(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    # A morph stores the creature, and names every display it wears with its model.
    morph = method(api, b"GetPartDataByIndex")(api, 118, b"fx", 1)
    named = [cast(dict[str, object], display)
             for display in as_list(method(api, b"GetPartDisplays")(api, morph))]
    assert [display["id"] for display in named] == [856, 857]
    assert all("file" in display for display in named)
    # A mount stores the display itself and carries its own model, so only the skins come back.
    mount = method(api, b"GetPartDataByIndex")(api, 459, b"model", 2)
    [wolf] = [cast(dict[str, object], display)
              for display in as_list(method(api, b"GetPartDisplays")(api, mount))]
    assert wolf["id"] == 2320 and "file" not in wolf
    assert len(cast(list[object], wolf["skins"])) == 2
    # A model that is no display names none.
    missile = method(api, b"GetPartDataByIndex")(api, 133, b"model", 1)
    assert unwrap(method(api, b"GetPartDisplays")(api, missile)) == {}


def tooltip_lines(engine: LuaRuntime, spell_id: int, axis: bytes, n: int) -> list[str]:
    """The lines a part's tooltip is filled with, markup stripped."""
    # language=Lua
    engine.execute(b"""
    function TOOLTIP_LINES(id, axis, n)
      local out = {}
      local tip = {}
      function tip:SetText(text) out[#out + 1] = text end
      function tip:AddLine(text) out[#out + 1] = text end
      Epsilook.Inspect.FillTooltip(tip, Epsilook:GetPartDataByIndex(id, axis, n))
      return table.concat(out, "\\n")
    end
    """)
    text = cast(bytes, lua_function(engine, b"TOOLTIP_LINES")(spell_id, axis, n)).decode()
    return re.sub(r"\|c[0-9a-f]{8}|\|r", "", text).split("\n")


def test_a_creatures_tooltip_reads_down_to_what_it_looks_like(engine: LuaRuntime) -> None:
    """The creature and its id, then each display it wears with the model
    file and the textures painted over it; the kind's meaning under the title."""
    lines = tooltip_lines(engine, 118, b"fx", 1)
    assert lines[0] == "morph"
    assert lines[1].startswith("a morph or transform aura")
    assert "creature Polymorphed Sheep - 16372" in lines
    assert lines.index("display 856") < lines.index("  model Creature/Sheep2/Sheep2.m2")
    assert "  skin Creature/Sheep2/sheep2_white.blp" in lines
    assert lines.index("display 857") > lines.index("display 856")
    # A display the part carries itself shows its own id and file, then its skins bare.
    lines = tooltip_lines(engine, 459, b"model", 2)
    assert "name Gray Wolf - 2320" in lines and "file Creature/DIREWOLF/RidingDireWolf.M2" in lines
    assert "skin Creature/Direwolf/RidingDireWolfSkinLightGrey.blp" in lines
    assert "display 2320" not in lines


def test_a_vocabulary_word_carries_its_number_in_the_tooltip(engine: LuaRuntime) -> None:
    """The number is what the game's own tables hold; the line keeps the word alone."""
    assert "attach Chest - 34" in tooltip_lines(engine, 459, b"model", 1)
    api = lua_table(engine, b"Epsilook")
    part = method(api, b"GetPartDataByIndex")(api, 459, b"model", 1)
    line = cast(bytes, lua_function(engine, b"Epsilook.Inspect.PartLine")(459, part, 1)).decode()
    assert " - Chest - " in line and "attach Chest" not in line


def test_an_anim_kits_animations_group_under_the_kit(engine: LuaRuntime) -> None:
    """The kit's line offers the kit, its animations follow indented with their
    own actions, and a loose animation stands on its own line."""
    printed = dossier(engine, 133)
    kit_line = ("|cffc77dffkit:|r |cffffffff|Hgarrmission:epsilook:133:group:anim:1|h[13464]|h|r - "
                "|cff71d5ff|Hgarrmission:epsilook:133:animKit:anim:1|h[Kit]|h|r")
    assert kit_line in printed
    assert "\n    |cffffffff|Hgarrmission:epsilook:133:part:anim:1|h[SpellCastDirected]|h" in printed
    printed = dossier(engine, 5106)
    assert "\n  |cffc77dffloose:|r " in printed
    # A valueless kind's label is its own link, so its tooltip can explain it.
    assert "\n  |cffc77dff|Hgarrmission:epsilook:5106:part:anim:5|h[pose]|h|r" in printed


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


def test_a_passenger_row_offers_both_actions_for_whichever_role_it_carries(engine: LuaRuntime) -> None:
    """A row carries one of enter, sit or exit; a leaving animation used to
    offer nothing. The line names the role, since the animation alone is
    printed twice when a seat enters and leaves the same way."""
    printed = dossier(engine, 65303)
    assert "[JumpStart]|h|r - |cff9d9d9denter|r - " in printed
    assert "[JumpStart]|h|r - |cff9d9d9dexit|r - " in printed
    for line in printed.split("\n"):
        if "passenger:" in line:
            assert "[Anim]" in line and "[Emote]" in line, line


def test_a_speed_change_is_offered_as_the_factor_the_command_takes(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    for n in range(1, 4):
        part = method(api, b"GetPartDataByIndex")(api, 2140, b"mech", n)
        if cast(bytes, cast(LuaTable, part)[b"kind"]) == b"speed":
            break
    else:
        raise AssertionError("2140 has no speed row")
    actions = method(api, b"GetActions")(api, b"mech")
    speed = cast(LuaTable, cast(LuaTable, actions)[1])
    assert speed[b"key"] == b"speed"
    factor = lua_function(engine, b"Epsilook.Inspect.ArgumentOf")(part, speed)
    assert factor == 0.3
    line = cast(bytes, lua_function(engine, b"Epsilook.Inspect.PartLine")(2140, part, n)).decode()
    assert f"|Hgarrmission:epsilook:2140:speed:mech:{n}|h[Speed]|h" in line


def test_a_group_tooltip_names_the_group_and_its_value(engine: LuaRuntime) -> None:
    """A sound kit's group tooltip is the kit; an anim kit's is the kit's id."""
    # language=Lua
    engine.execute(b"""
    function GROUP_TIP(id, axis, n)
      local out = {}
      local tip = {}
      function tip:SetText(text) out[#out + 1] = text end
      function tip:AddLine(text) out[#out + 1] = text end
      Epsilook.Inspect.FillGroupTooltip(tip, Epsilook:GetPartDataByIndex(id, axis, n))
      return table.concat(out, "\\n")
    end
    """)
    tip = lua_function(engine, b"GROUP_TIP")
    assert cast(bytes, tip(133, b"sound", 1)).decode().split("\n") == ["kit", "SPELL_Fire_Missile_Loop - 3011"]
    assert cast(bytes, tip(133, b"anim", 1)).decode().split("\n") == ["kit", "13464"]


def test_a_copy_is_offered_only_where_a_command_takes_the_number(engine: LuaRuntime) -> None:
    """The copy hands the chat box what a server command takes, so it shows on a
    model's spawnable line and on an anim kit's group line, and not on a sound,
    whose actions are the client's own calls."""
    # language=Lua
    engine.execute(b"""
    function SPAWN_ARG(id, axis, n)
      local part = Epsilook:GetPartDataByIndex(id, axis, n)
      for _, action in ipairs(Epsilook:GetActions(axis)) do
        if action.key == "spawn" then
          local argument = Epsilook.Inspect.ArgumentOf(part, action)
          if argument then return argument end
        end
      end
      return nil
    end
    """)
    api = lua_table(engine, b"Epsilook")
    part = method(api, b"GetPartDataByIndex")(api, 133, b"model", 1)
    copied, command = cast(
        tuple[int, bytes],
        lua_function(engine, b"Epsilook.Inspect.CopyOf")(part, method(api, b"GetActions")(api, b"model")),
    )
    # The copy is exactly the argument the line's first commanded action sends.
    assert copied == lua_function(engine, b"SPAWN_ARG")(133, b"model", 1)
    assert command == b"gob spawn %s"
    line = cast(bytes, lua_function(engine, b"Epsilook.Inspect.PartLine")(133, part, 1)).decode()
    assert "|Hgarrmission:epsilook:133:copy:model:1|h[Copy Entry]|h" in line
    # A sound plays through the client, so there is no command to copy for.
    sound = method(api, b"GetPartDataByIndex")(api, 133, b"sound", 1)
    assert "Copy Entry" not in cast(bytes, lua_function(engine, b"Epsilook.Inspect.PartLine")(133, sound, 1)).decode()
    # A group's line copies what the group's own action takes, under its own verb.
    assert "|Hgarrmission:epsilook:133:copygroup:anim:1|h[Copy Entry]|h" in dossier(engine, 133)


def test_a_copy_hint_names_the_command_it_feeds(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    part = method(api, b"GetPartDataByIndex")(api, 133, b"model", 1)
    hint = lua_function(engine, b"Epsilook.Inspect.HintOf")(b"model", b"copy", part)
    assert isinstance(hint, bytes) and "for .gob spawn" in hint.decode()
    # A sound line has no command behind it, so its copy has nothing to say.
    sound = method(api, b"GetPartDataByIndex")(api, 133, b"sound", 1)
    assert lua_function(engine, b"Epsilook.Inspect.HintOf")(b"sound", b"copy", sound) is None


def test_a_lone_column_word_prints_its_doors(engine: LuaRuntime) -> None:
    """Every spell has a model, so the column word alone is answered with the
    ways into the column rather than with a search for all of them."""
    assert lua_function(engine, b"Epsilook.Shell.LoneColumn")(b"model") == b"model"
    # A kind or a property alone is a real question and still searches.
    assert lua_function(engine, b"Epsilook.Shell.LoneColumn")(b"missile") is None
    # So is a column word with anything after it, or one already bound.
    assert lua_function(engine, b"Epsilook.Shell.LoneColumn")(b"model fire") is None
    assert lua_function(engine, b"Epsilook.Shell.LoneColumn")(b"model:fire") is None
    lines = [str(line) for line in as_list(lua_function(engine, b"Epsilook.Shell.ColumnLines")(b"model"))]
    text = "\n".join(lines)
    assert lines[0].startswith("|cff3b9eff"), "the column wears its own tone"
    assert "Kinds" in text and "missile" in text
    # Every kind of the column, not only the one promoted to a top-level word.
    for kind in ("barrage", "ground", "attached", "trail", "display", "item", "equipped", "mount"):
        assert kind in text, kind
    assert "motion" in text, "a kind's properties hang under it"
    assert "/elo model:*" in text, "the search it no longer means is offered explicitly"
    assert "chain" not in text, "fx's kinds stay in fx"
    # A column whose only kind wears the column's own word has no door of its
    # own, so its properties belong to the column directly.
    sound = " ".join(
        str(line) for line in as_list(lua_function(engine, b"Epsilook.Shell.ColumnLines")(b"sound"))
    )
    assert "Properties" in sound and "kit" in sound
    # A property cannot stand alone as a value, so its example carries one.
    assert "/elo sound file:<value>" in sound
    assert "/elo sound:{file:<value>}" in sound
