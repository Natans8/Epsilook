"""Reading values by the declarations the data carries."""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, LuaTable, as_list, lua_function, lua_table


def test_numeric_notations_read_as_the_web_does(engine: LuaRuntime) -> None:
    parse = lua_function(engine, b"Epsilook.Schema.ParseType")
    assert parse(b"seconds", b"2s") == 2000
    assert parse(b"seconds", b"2") == 2000
    assert parse(b"seconds", b"1500") == 1500
    assert parse(b"seconds", b"500ms") == 500
    assert parse(b"seconds", b"2m") == 120000
    assert parse(b"percentChange", b"+50%") == 50
    assert parse(b"percentChange", b"x1.5") == 50
    assert parse(b"percentChange", b"150%") == 50
    assert parse(b"percentChange", b"2") == 100
    assert parse(b"percentChange", b"150") == 50
    assert parse(b"percentChange", b"50") == -50
    assert parse(b"percent", b"-50") is None
    assert parse(b"colour", b"#ff0000") == 0xff0000
    assert parse(b"colour", b"red") == 0xff0000
    assert parse(b"bitmask", b"caster") == b"caster"
    assert parse(b"bitmask", b"everyone") is None
    assert parse(b"ordinal", b"wrath") == b"WotLK"
    assert parse(b"spellId", b"133") == 133
    assert parse(b"spellId", b"13.3") is None


def test_a_range_reads_both_bounds_in_one_notation(engine: LuaRuntime) -> None:
    pair = lua_function(engine, b"Epsilook.Schema.ParseTypePair")
    assert pair(b"percentChange", b"10", b"90") == (-90, -10)
    assert pair(b"seconds", b"2", b"5ms") == (2, 5)
    # The larger bound classifies the pair: five hundred is milliseconds, so two is too.
    assert pair(b"seconds", b"500", b"2") == (500, 2)


def test_heads_are_read_off_the_declarations(engine: LuaRuntime) -> None:
    head_of = lua_function(engine, b"Epsilook.Schema.HeadOf")

    def role(word: bytes) -> object:
        return cast(LuaTable, head_of(word))[b"role"]

    assert role(b"model") == b"column"
    assert role(b"models") == b"column"
    assert role(b"missile") == b"kind"
    assert role(b"cast") == b"prop"
    assert head_of(b"mount") is None
    kind_in = lua_function(engine, b"Epsilook.Schema.KindIn")
    assert cast(LuaTable, kind_in(b"model", b"mount"))[b"id"] == b"model.mount"
    assert kind_in(b"model", b"chain") is None


def test_a_kit_and_a_sound_type_are_reachable_only_inside_their_column(engine: LuaRuntime) -> None:
    """`kit:` means two different things -- an anim kit and a sound kit -- so it
    gets no door of its own, and neither does the sound type. Both are reached
    through the column that disambiguates them, and neither answers a bare word:
    a property with no plain reading stays out of chipless search."""
    head = lua_function(engine, b"Epsilook.Schema.HeadOf")
    assert head(b"kit") is None
    assert head(b"type") is None
    # The column itself is the door, and it still is one.
    assert head(b"sound") is not None
    kinds = lua_table(engine, b"Epsilook.Schema.kindById")
    props = cast(LuaTable, cast(LuaTable, kinds[b"sound.sound"])[b"props"])
    plain = {}
    for row in as_list(props):
        prop = cast(dict[str, object], row)
        plain[str(prop["name"])] = len(cast(list[object], prop.get("plain") or []))
    # The file and the kit are read by a bare word; what the kit is FOR is not.
    assert plain["type"] == 0, plain
    assert plain["file"] > 0 and plain["kit"] > 0, plain


def test_a_flag_is_read_off_the_whole_declaration(engine: LuaRuntime) -> None:
    """A flag stores no value, so its own word is what selects it, and asking
    only the first declared type would read a property that declares a flag
    second as an ordinary one. Every flag the pack ships declares nothing else,
    so the narrower reading agrees today and would part company silently. The
    two synthetic properties are here for exactly that reason.
    """
    # language=Lua
    engine.execute(b"""
                   function FLAGS_DECLARED()
                       local flags = 0
                       for _, kind in ipairs(Epsilook.Schema.kinds) do
                           for _, prop in ipairs(kind.props) do
                               if Epsilook.Schema.IsFlag(prop) ~= (prop.types[1] == "flag") then
                                   return -1
                               end
                               if Epsilook.Schema.IsFlag(prop) then
                                   flags = flags + 1
                               end
                           end
                       end
                       return flags
                   end
                   """)
    # The pack ships flags, and on every one of them the two readings agree.
    assert int(str(lua_function(engine, b"FLAGS_DECLARED")())) > 0
    is_flag = lua_function(engine, b"Epsilook.Schema.IsFlag")
    assert is_flag(engine.eval(b'{types = {"length", "flag"}}')) is True
    assert is_flag(engine.eval(b'{types = {"length"}}')) is False
