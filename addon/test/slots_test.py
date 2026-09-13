"""The selector surface, read through the interpreter the client runs.

A mechanics part carries its misc values raw, and these two calls are how a
reader names one: what the effect or aura beside it makes of each column, then
the word a vocabulary value stands for or the words a mask sets.
"""

from __future__ import annotations

from typing import cast

from support import LuaRuntime, unwrap


def listed(engine: LuaRuntime, code: bytes) -> list[object]:
    """One Lua array as the list it stands for."""
    return cast(list[object], unwrap(engine.execute(code)))


def test_a_mask_names_every_school_it_sets(engine: LuaRuntime) -> None:
    # language=Lua
    assert listed(engine, b'return Epsilook:GetSlotWords("spell_schools", "mask", 20)') == ["Fire", "Frost"]


def test_a_value_names_one_word(engine: LuaRuntime) -> None:
    # language=Lua
    assert listed(engine, b'return Epsilook:GetSlotWords("spell_mechanics", "vocabulary", 1)') == ["Charmed"]


def test_an_invisibility_aura_reads_down_to_its_type(engine: LuaRuntime) -> None:
    """Aura 18 hides its target in an invisibility type, and 6 is the drunk one."""
    # language=Lua
    code = b"""
        local read = Epsilook:GetSelectorReads("SpellEffect", "EffectAura", 18)[1]
        return Epsilook:GetSlotWords(read.into, read.holds, 6)
    """
    assert listed(engine, code) == ["Drunk"]
