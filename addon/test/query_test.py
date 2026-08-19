"""The parser: what query text becomes, and what it refuses."""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, as_dict, lua_function

Record = dict[str | int, object]


def parsed(engine: LuaRuntime, text: str) -> Record:
    return as_dict(lua_function(engine, b"Epsilook.Query.Parse")(text.encode("utf-8")))


def asks(engine: LuaRuntime, text: str) -> list[Record]:
    """The ask of every clause, in order; an invalid clause has none."""
    clauses = parsed(engine, text)["clauses"]
    assert isinstance(clauses, list)
    return [cast(Record, cast(Record, clause).get("ask")) for clause in clauses]


def formatted(engine: LuaRuntime, text: str) -> str:
    tree = lua_function(engine, b"Epsilook.Query.Parse")(text.encode("utf-8"))
    out = lua_function(engine, b"Epsilook.Query.Format")(tree)
    assert isinstance(out, bytes)
    return out.decode()


def test_heads_come_from_the_schema(engine: LuaRuntime) -> None:
    text = "name:fire -model:missile sound>2 | cast>2s"
    tree = parsed(engine, text)
    found = asks(engine, text)
    assert found[0]["on"] == "kind" and found[0]["kind"] == "spell.name"
    clauses = cast(list[Record], tree["clauses"])
    assert clauses[1]["not"] is True and found[1]["kind"] == "model.missile"
    assert found[2] == {"on": "column", "column": "sound",
                        "test": {"is": "count", "value": {"op": "gt", "operand": {"type": "count", "value": 2,
                                                                                    "written": "2"}}}}
    assert found[3]["on"] == "prop" and found[3]["ref"] == {"kind": "spell.spell", "prop": "cast"}
    assert cast(Record, cast(Record, found[3]["value"])["operand"])["value"] == 2000
    assert tree["groups"] == [[1, 2, 3], [4]]


def test_a_pasted_link_reads_as_the_id(engine: LuaRuntime) -> None:
    assert asks(engine, "|cff71d5ff|Hspell:133:0|h[Fireball]|h|r")[0]["column"] == "id"
    assert formatted(engine, "|Hspell:133|h[Fireball]|h") == "id:133"


def test_the_cut_grammar_refuses_what_it_does_not_read(engine: LuaRuntime) -> None:
    for text in ("model:{fire}", "model:(fire|frost)", "name:fire*", "-", "model:"):
        tree = parsed(engine, text)
        assert tree["groups"] in ([], {}), text
        assert tree["problems"], text


def test_a_column_reads_a_kind_word_a_count_and_content(engine: LuaRuntime) -> None:
    assert asks(engine, "model:mount")[0]["kind"] == "model.mount"
    assert cast(Record, asks(engine, "anim:=0")[0]["test"])["is"] == "count"
    assert cast(Record, asks(engine, "model:fire")[0]["test"])["is"] == "content"
    inner = cast(Record, asks(engine, "model:file=fire")[0]["test"])
    assert inner["is"] == "props" and len(cast(list[object], inner["props"])) == 8


def test_format_writes_the_operator_in_place_of_the_colon(engine: LuaRuntime) -> None:
    assert formatted(engine, "cast:>2s model:file=fire -model:missile") == "cast>2s model:file=fire -model:missile"
    assert formatted(engine, "anim:=0 xpac:wotlk") == "anim=0 xpac:wotlk"
    assert formatted(engine, "fire or frost") == "fire | frost"


def test_an_operator_glued_to_a_phrase_reads_the_phrase(engine: LuaRuntime) -> None:
    value = cast(Record, cast(Record, asks(engine, 'name:="Fire Ball"')[0]["test"])["value"])
    assert value["op"] == "exact" and cast(Record, value["operand"])["value"] == "Fire Ball"
    assert formatted(engine, 'name:="Fire Ball"') == 'name="Fire Ball"'
