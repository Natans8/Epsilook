"""A colour word asks what people call a stored colour, and a general word asks for its specific words too.

The words and their names come from the declarations' colour table, so these
pin the reading of it rather than the table itself: a word reads as itself
whatever regional spelling it was typed in, any other name is refused, and
`purple` finds every spell `lavender` finds, because lavender sits under purple.
"""

from support import LuaRuntime, as_list, lua_function, unwrap
from search_test import count


def ids(engine: LuaRuntime, query: str) -> set[int]:
    """Every spell a query finds."""
    # language=Lua
    engine.execute(b"""
                   function ALL(q)
                       local out = {}
                       for _, id in Epsilook.Search.Find(q) do
                           out[#out + 1] = id
                       end
                       return out
                   end
                   """)
    found = unwrap(lua_function(engine, b"ALL")(query.encode("utf-8")))
    return set() if found == {} else {int(str(v)) for v in as_list(found)}


def test_a_colour_word_reads_as_itself_in_either_spelling(engine: LuaRuntime) -> None:
    parse = lua_function(engine, b"Epsilook.Schema.ParseType")
    assert parse(b"colour", b"purple") == b"purple"
    assert parse(b"colour", b"Lavender") == b"lavender"
    assert parse(b"colour", b"grey") == b"gray"
    assert parse(b"colour", b"gray") == b"gray"


def test_any_other_name_is_refused(engine: LuaRuntime) -> None:
    """`lightblue` is a shade of blue rather than a word of its own, and `navy`
    is one colour's name rather than a word for what people call colours, so
    both are refused; one colour is written as a hex triplet."""
    parse = lua_function(engine, b"Epsilook.Schema.ParseType")
    assert parse(b"colour", b"lightblue") is None
    assert parse(b"colour", b"navy") is None
    assert parse(b"colour", b"#b088bb") == 0xB088BB


def test_a_word_is_written_back_as_itself(engine: LuaRuntime) -> None:
    format_type = lua_function(engine, b"Epsilook.Schema.FormatType")
    assert format_type(b"colour", b"purple") == b"purple"
    assert format_type(b"colour", 0xB088BB) == b"#b088bb"


def test_a_general_word_finds_every_spell_its_specific_words_find(engine: LuaRuntime) -> None:
    lavender = ids(engine, "fx:{tint colour:lavender}")
    assert lavender
    assert lavender <= ids(engine, "fx:{tint colour:purple}")


def test_anchoring_a_word_asks_nothing_more(engine: LuaRuntime) -> None:
    """A word names a set of colours rather than one, so `colour=purple` is
    `colour:purple`; an exact colour is written as a hex triplet."""
    assert ids(engine, "fx:{tint colour=purple}") == ids(engine, "fx:{tint colour:purple}")
    assert count(engine, "fx:{tint colour=#b088bb}") <= count(engine, "fx:{tint colour:#b088bb}")


def test_a_muted_gradient_answers_to_the_name_people_give_it(engine: LuaRuntime) -> None:
    """Ghostly Cosmetic's ramp centres on #b088bb, which no CSS purple sits near."""
    assert 290508 in ids(engine, "fx:{gradient colour:purple}")
    assert count(engine, "fx:{gradient colour:#800080}") == 0
