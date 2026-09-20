"""Where a spell comes from, read through the interpreter the client runs.

The two halves are joined in the pack and read back here: a spell names its
source, the source names a creature, a gameobject or a quest, and the item that
carries it is named beside them.

The fields are read inside Lua rather than through `unwrap`, because a record
field called `kind` is summarised to its id there, which is what a parse tree
wants and not what these rows do.
"""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, unwrap


def texts(engine: LuaRuntime, code: bytes) -> list[str]:
    """One Lua array of strings as the list it stands for."""
    return [cast(str, held) for held in cast(list[object], unwrap(engine.execute(code)))]


def test_a_spell_says_who_hands_it_over(engine: LuaRuntime) -> None:
    """Apprentice Riding is taught across a counter, by a good many trainers."""
    # language=Lua
    code = b"""
        local out = {}
        for _, row in ipairs(Epsilook:GetSpellSources(33389)) do
            out[#out + 1] = row.kind.text .. ": " .. row.source.text
        end
        return out
    """
    rows = texts(engine, code)
    assert rows, "riding is taught by somebody"
    assert all(row.startswith("trainer: ") for row in rows)
    assert any(len(row) > len("trainer: ") for row in rows), "a trainer is named"


def test_an_item_carried_spell_names_the_item_and_counts_the_rest(engine: LuaRuntime) -> None:
    """A spell reached through an item says which item, and how many sources of
    that kind it has in all, which is more than the few rows kept."""
    # language=Lua
    code = b"""
        local out = {}
        for _, row in ipairs(Epsilook:GetSpellSources(56)) do
            if row.item.text ~= "" and row.of > 1 then
                out[#out + 1] = row.kind.text .. " " .. row.item.text .. " " .. tostring(row.of)
            end
        end
        return out
    """
    rows = texts(engine, code)
    assert rows, "the stun a weapon carries names the weapon"
    assert any(row.startswith("drop ") for row in rows)


def test_a_spell_nothing_hands_over_answers_nothing(engine: LuaRuntime) -> None:
    # language=Lua
    assert unwrap(engine.execute(b"return #Epsilook:GetSpellSources(-1)")) == 0
