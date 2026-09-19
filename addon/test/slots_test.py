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


def test_a_reference_reads_down_to_its_name(engine: LuaRuntime) -> None:
    """Aura 36 shifts into a form, and form 1 is the cat."""
    # language=Lua
    code = b"""
        local read = Epsilook:GetSelectorReads("SpellEffect", "EffectAura", 36)[1]
        return Epsilook:GetReferenceName(read.into, 1)
    """
    assert unwrap(engine.execute(code)) == "Cat Form"


def test_a_reference_is_named_through_its_own_table(engine: LuaRuntime) -> None:
    # language=Lua
    assert unwrap(engine.execute(b'return Epsilook:GetReferenceName("creature_template", 3)')) == "Flesh Eater"
    # language=Lua
    assert unwrap(engine.execute(b'return Epsilook:GetReferenceName("FactionTemplate", 1)')) == "PLAYER, Human"


def test_an_id_no_row_points_at_names_nothing(engine: LuaRuntime) -> None:
    # language=Lua
    assert unwrap(engine.execute(b'return Epsilook:GetReferenceName("creature_template", -1)')) is None


def test_a_mask_reads_every_bit_a_negative_value_sets(engine: LuaRuntime) -> None:
    """A mask of every school is stored as -1, and the client hands it over signed."""
    # language=Lua
    schools = listed(engine, b'return Epsilook:GetSlotWords("spell_schools", "mask", -1)')
    assert len(schools) == 7


def test_a_rating_aura_reads_its_misc_value_as_ratings(engine: LuaRuntime) -> None:
    """Aura 189 raises the ratings its mask sets, here the three crits and melee haste."""
    # language=Lua
    code = b"""
        local read = Epsilook:GetSelectorReads("SpellEffect", "EffectAura", 189)[1]
        return Epsilook:GetSlotWords(read.into, read.holds, 256 + 512 + 1024 + 131072)
    """
    assert listed(engine, code) == ["Crit Melee", "Crit Ranged", "Crit Spell", "Haste Melee"]


def test_an_amount_says_what_it_is_divided_by(engine: LuaRuntime) -> None:
    """Aura 453 stores a cooldown in milliseconds, which the descriptions print as seconds."""
    # language=Lua
    code = b"""
        for _, read in ipairs(Epsilook:GetSelectorReads("SpellEffect", "EffectAura", 453)) do
            if read.column == "EffectBasePoints" then
                return {read.holds, read.into, read.scale}
            end
        end
    """
    assert listed(engine, code) == ["amount", "seconds", 1000]


def test_an_effect_carries_its_numbers(engine: LuaRuntime) -> None:
    """Cone of Cold's damage reaches twelve yards, adds 37.5% of spell power and rolls within 5%."""
    # language=Lua
    code = b"""
        local effect = Epsilook:GetEffectAmounts(120)[1]
        return {effect.index, effect.radius, effect.spellPower, effect.spread, effect.chain, effect.pvp}
    """
    assert listed(engine, code) == [0, 12, 0.375, 0.05, 1, 1]


def test_a_spell_without_numbers_carries_no_effects(engine: LuaRuntime) -> None:
    # language=Lua
    assert unwrap(engine.execute(b"return #Epsilook:GetEffectAmounts(-1)")) == 0


def test_a_cone_is_the_spell_s_own(engine: LuaRuntime) -> None:
    """Cone of Cold takes a quarter circle, and Frostbolt takes no cone at all."""
    # language=Lua
    assert unwrap(engine.execute(b"local cone = Epsilook:GetSpellCone(120) return {cone.degrees, cone.width}")) == [
        90,
        0,
    ]
    # language=Lua
    assert unwrap(engine.execute(b"return Epsilook:GetSpellCone(116)")) is None
