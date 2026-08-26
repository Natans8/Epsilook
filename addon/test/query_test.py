"""The parser: what query text becomes, and what it refuses."""

from __future__ import annotations

from typing import cast

from support import LuaFunction, LuaRuntime, as_dict, lua_function, lua_table

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
    assert found[2] == {
        "on": "column",
        "column": "sound",
        "test": {"is": "count", "value": {"op": "gt", "operand": {"type": "count", "value": 2, "written": "2"}}},
    }
    assert found[3]["on"] == "prop" and found[3]["ref"] == {"kind": "spell.spell", "prop": "cast"}
    assert cast(Record, cast(Record, found[3]["value"])["operand"])["value"] == 2000
    assert tree["groups"] == [[1, 2, 3], [4]]


def test_a_pasted_link_reads_as_the_id(engine: LuaRuntime) -> None:
    assert asks(engine, "|cff71d5ff|Hspell:133:0|h[Fireball]|h|r")[0]["column"] == "id"
    assert formatted(engine, "|Hspell:133|h[Fireball]|h") == "id:133"


def test_the_cut_grammar_refuses_what_it_does_not_read(engine: LuaRuntime) -> None:
    for text in ("model:(fire|frost)", "name:fire*", "-", "model:", "model:{-fire}", "model:{a {b}}"):
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


def test_the_limit_keeps_the_smallest_and_a_minus_counts_from_the_end(engine: LuaRuntime) -> None:
    assert parsed(engine, "fire first:20 first:5")["limit"] == 5
    assert parsed(engine, "fire first:5 first:20")["limit"] == 5
    assert parsed(engine, "fire first:-5")["limit"] == -5
    assert parsed(engine, "fire -first:5")["limit"] == -5
    assert parsed(engine, "fire first:3 first:-5")["limit"] == 3
    assert parsed(engine, "fire top:7")["limit"] == 7
    assert "limit" not in parsed(engine, "fire")
    assert parsed(engine, "first:x")["problems"]


def test_a_unit_written_anywhere_in_a_range_is_the_phrase_s_own(engine: LuaRuntime) -> None:
    """A bare bound beside a spelled one takes the sibling's notation before
    either is read: `2ms-5` is two milliseconds to five of them, and read alone
    the bare bound made it five seconds -- a range a thousand times too wide,
    reported as an ordinary answer. Both bounds then carry the spelling the
    phrase gave them, since writing the bare one back would read it the other
    way round.
    """

    def bounds(text: str) -> tuple[object, object, object, object]:
        # A property door binds the value; a kind door carries it on the test.
        ask = asks(engine, text)[0]
        held = ask.get("value") or cast(Record, ask["test"])["value"]
        value = cast(Record, held)
        lo, hi = cast(Record, value["lo"]), cast(Record, value["hi"])
        return lo["value"], lo["written"], hi["value"], hi["written"]

    assert bounds("cast:2ms-5") == (2, "2ms", 5, "5ms")
    assert bounds("cast:2-5ms") == (2, "2ms", 5, "5ms")
    # A bound wearing its own symbol is never reinterpreted.
    assert bounds("cast:2ms-5s") == (2, "2ms", 5000, "5s")
    # With both bare the pair reader classifies them together, by the further
    # of the two, and they are spelled together in what it chose.
    assert bounds("cast:2-5") == (2000, "2s", 5000, "5s")
    assert bounds("scale:10-90") == (-90, "10%", -10, "90%")


def test_an_operator_glued_to_a_phrase_reads_the_phrase(engine: LuaRuntime) -> None:
    value = cast(Record, cast(Record, asks(engine, 'name:="Fire Ball"')[0]["test"])["value"])
    assert value["op"] == "exact" and cast(Record, value["operand"])["value"] == "Fire Ball"
    assert formatted(engine, 'name:="Fire Ball"') == 'name="Fire Ball"'


def test_a_sort_directive_is_kept_apart_from_the_clauses(engine: LuaRuntime) -> None:
    tree = parsed(engine, "name:fire sort:cast sort:-id")
    sorts = cast(list[Record], tree["sorts"])
    assert [s["descending"] for s in sorts] == [False, True]
    assert len(cast(list[object], tree["groups"])) == 1
    fmt = lua_function(engine, b"Epsilook.Query.Format")
    parse = lua_function(engine, b"Epsilook.Query.Parse")
    assert fmt(parse(b"name:fire sort:-id")) == b"name:fire sort:-id"
    # The exclusion inverts the door's own direction; bare sort is sort:id.
    assert fmt(parse(b"-sort:id")) == b"sort:-id"
    assert fmt(parse(b"-sort:-id")) == b"sort:id"
    assert fmt(parse(b"fire sort")) == b"fire sort:id"
    assert fmt(parse(b"-sort")) == b"sort:-id"
    # A word that is no head is refused, and a sort alone still asks.
    assert parsed(engine, "sort:bogus")["problems"]
    api = lua_table(engine, b"Epsilook")
    empty = cast(LuaFunction, api[b"IsQueryEmpty"])
    assert empty(api, lua_function(engine, b"Epsilook.Query.Parse")(b"sort:id")) is False


def test_a_scope_holds_a_sort_sequence_and_it_is_the_canonical_form(engine: LuaRuntime) -> None:
    tree = parsed(engine, "fire sort:{name -cast}")
    sorts = cast(list[Record], tree["sorts"])
    assert [s["descending"] for s in sorts] == [False, True]
    assert formatted(engine, "fire sort:name sort:-cast") == "fire sort:{name -cast}"
    assert formatted(engine, "fire sort:{name -cast}") == "fire sort:{name -cast}"
    assert formatted(engine, "fire -sort:{name -cast} first:-5") == "fire sort:{-name cast} first:-5"
    # Half a sequence ordering would lie: an unknown member, an empty scope and an unclosed one all refuse.
    for bad in ("sort:{name zzz}", "sort:{}", "sort:{name"):
        assert parsed(engine, bad)["problems"], bad
        assert parsed(engine, bad).get("sorts") in ([], {}, None), bad


def test_a_scope_term_is_written_under_the_door_that_reached_it(engine: LuaRuntime) -> None:
    """A term reached through a kind's door is written under that door, never
    under the storage name of the property it fanned out to. Writing the name
    asks a different question: `attach:chest` came back as `file:chest`, which
    reaches every kind's file rather than the attachment's, and the two terms
    of `spell:{name:fire desc:kneel}` both came back as `text:`, which no
    longer says which kind either was on.
    """
    assert formatted(engine, "model:{attach:chest fire}") == "model:{attach:chest fire}"
    assert formatted(engine, "spell:{name:fire desc:kneel}") == "spell:{name:fire desc:kneel}"
    # A word SHARED across kinds keeps the property's word, since naming one
    # kind would narrow an ask that reaches all of them.
    assert formatted(engine, "model:{attach file:wolf}") == "model:{attach file:wolf}"
    # Inside a kind's own scope its word is already the door overhead, so the
    # property binds by its own word there.
    assert formatted(engine, "missile:{from:chest}") == "missile:{from:chest}"
    assert formatted(engine, "attach:{point:chest}") == "attach:{point:chest}"


def test_a_flag_in_a_scope_is_written_alone(engine: LuaRuntime) -> None:
    """A flag stores no value, so the word IS the ask. Bound to its own name it
    spells a property taking a value it cannot take, and the spelling stops
    parsing: `range:{melee unlimited}` came back as `melee:melee`.
    """
    assert formatted(engine, "range:{melee unlimited}") == "range:{melee dist=unlimited}"


def test_a_quoted_operand_is_written_back_quoted(engine: LuaRuntime) -> None:
    """Quotes are strict, so the phrase is part of what the ask means and
    dropping it turns a matched-as-written ask back into a squashed one:
    `name:"anti-magic"` came back as `name:antimagic`, a different question.
    """
    assert formatted(engine, 'name:"anti-magic"') == 'name:"anti-magic"'
    assert formatted(engine, 'name:"-a"') == 'name:"-a"'
    # The escape is shielded alongside the quote: shielding the quote alone
    # leaves the escape before it eating the closing one, and the phrase ends
    # early on text that is nothing but punctuation.
    assert formatted(engine, r"name:\" fire") == r'name:"\\\"" fire'
