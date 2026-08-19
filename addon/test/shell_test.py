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


def test_a_result_line_reads_like_lookup(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    spell = method(api, b"GetSpellDataByID")(api, 133)
    counts = method(api, b"GetPartCounts")(api, 133)
    axes = method(api, b"GetPartAxes")(api)
    line = lua_function(engine, b"Epsilook.Shell.ResultLine")(spell, counts, axes)
    assert isinstance(line, bytes)
    text = line.decode()
    assert text.startswith("|cffffd100133|r - |cffffffff|Hspell:133|h[Fireball]|h|r - ")
    for verb, label in (("learn", "Learn"), ("cast", "Cast"), ("aura", "Aura"), ("inspect", "Inspect")):
        assert f"|Hepsilook:133:{verb}|h[{label}]|h" in text
    assert "5 model" in text and "12 sound" in text


def test_a_lone_spell_is_an_inspection(engine: LuaRuntime) -> None:
    lone = lua_function(engine, b"Epsilook.Shell.LoneSpell")
    assert lone(b"133") == 133
    assert lone(b"|cff71d5ff|Hspell:133:0|h[Fireball]|h|r") == 133
    assert lone(b"|Hspell:133|h[Fireball]|h") == 133
    assert lone(b"133 fire") is None
    assert lone(b"fireball") is None


def test_only_a_leading_subcommand_word_is_taken(engine: LuaRuntime) -> None:
    split = lua_function(engine, b"Epsilook.Shell.Split")
    assert split(b"count model:missile") == (b"count", b"model:missile")
    assert split(b"More") == (b"more", b"")
    assert split(b"countess fire") == (None, b"countess fire")
    assert split(b'name:"more fire"') == (None, b'name:"more fire"')


def test_a_part_line_carries_its_actions(engine: LuaRuntime) -> None:
    api = lua_table(engine, b"Epsilook")
    part = method(api, b"GetPartDataByIndex")(api, 133, b"model", 1)
    line = lua_function(engine, b"Epsilook.Inspect.PartLine")(133, part, 1)
    assert isinstance(line, bytes)
    text = line.decode()
    assert "missile" in text and "file:" in text
    # Fireball's missile model has a known spawn id, so the spawn link is offered.
    assert "|Hepsilook:133:spawn:model:1|h[Spawn]|h" in text
    sound = method(api, b"GetPartDataByIndex")(api, 133, b"sound", 1)
    sound_line = lua_function(engine, b"Epsilook.Inspect.PartLine")(133, sound, 1)
    assert isinstance(sound_line, bytes)
    assert "|Hepsilook:133:play:sound:1|h[Play]|h" in sound_line.decode()
    assert "|Hepsilook:133:stop:sound:1|h[Stop]|h" in sound_line.decode()


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
    assert "[Fireball]" in text and "5 model" in text and "12 sound" in text and "1 mech" in text
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
