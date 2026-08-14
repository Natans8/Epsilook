"""The fan-out: one column meaning a dozen things, and the guards on each.

Every case here is a way reading `EffectMiscValue_0` without its selector, or
with the wrong guard on it, silently produces a payload that is not there --
or drops one that is.
"""

from __future__ import annotations

import pytest

from pack.routes.effects import (AURA_ANIM_REPLACEMENT_SET, AURA_KEYBOUND_OVERRIDE,
                                 AURA_MOD_INVISIBILITY, AURA_MOD_INVISIBILITY_DETECT,
                                 AURA_OVERRIDE_NAME, AURA_SCREEN_EFFECT,
                                 AURA_SET_VEHICLE_ID, AURA_SHAPESHIFT, AURA_TRANSFORM,
                                 EFFECT_APPLY_AURA, EFFECT_PLAY_SOUND, EFFECT_SUMMON,
                                 MISC_PAYLOADS, EffectRow, read_spell_effect_rows)
from pack.targets import TARGET_AREA, TARGET_CASTER, TARGET_TARGET
from support import BuildTables

SPELLS = frozenset({100, 200, 300})

# ImplicitTarget id -> bit, standing in for one build's resolved enum.
TARGET_BITS = {1: TARGET_CASTER, 2: TARGET_TARGET, 3: TARGET_AREA}

SUMMON_PROPERTIES = """\
ID,Control
7,2
"""


def effect_rows(*rows: str) -> str:
    """A `SpellEffect` table built from `SpellID,Effect,Aura,misc0,misc1,t0,t1,...`."""
    header = ("SpellID,Effect,EffectAura,EffectMiscValue_0,EffectMiscValue_1,"
              "ImplicitTarget_0,ImplicitTarget_1,EffectBasePoints,"
              "EffectBasePointsF,EffectTriggerSpell\n")
    return header + "".join(row + "\n" for row in rows)


ROSTERS = {"screens": frozenset({50}), "keybounds": frozenset({60})}


def read(tables: BuildTables, spell_effect: str, **rosters: frozenset[int]):
    """Read one `SpellEffect` fixture, overriding any roster by name."""
    return read_spell_effect_rows(
        tables(SpellEffect=spell_effect, SummonProperties=SUMMON_PROPERTIES),
        SPELLS, {**ROSTERS, **rosters}, TARGET_BITS)


def test_a_misc_value_lands_where_its_aura_sends_it(tables: BuildTables) -> None:
    """The whole point of the route: one column, and only the selector beside
    it says which table the number is an id into."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{AURA_SHAPESHIFT},900,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{AURA_SET_VEHICLE_ID},900,0,1,0,0,0,0"))
    assert rows.morphs.ids == {100: {900}}
    assert rows.forms.ids == {100: {900}}
    assert rows.vehicles.ids == {100: {900}}


def test_an_effect_and_an_aura_are_independent_selectors(tables: BuildTables) -> None:
    """A roster declared for one must not be able to veto the other.

    The two columns are read off the same row, so a guard written once for
    "this row" would let an undeclared screen effect suppress the gameobject
    the same row spawns.
    """
    rows = read(tables, effect_rows(
        f"100,50,{AURA_SCREEN_EFFECT},999,0,1,0,0,0,0"), screens=frozenset())
    assert rows.objects.ids == {100: {999}}
    assert rows.screens.ids == {}


def test_a_payload_of_zero_names_nothing(tables: BuildTables) -> None:
    """Zero is not an id, so a row carrying it reaches no payload."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},0,0,1,0,0,0,0"))
    assert rows.morphs.ids == {}


def test_zero_is_a_real_invisibility_channel(tables: BuildTables) -> None:
    """The declared exception: channel 0 is general invisibility, the one
    Vanish uses, so the ordinary "0 names nothing" rule would delete it."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_MOD_INVISIBILITY},0,0,1,0,0,0,0",
        f"200,{EFFECT_APPLY_AURA},{AURA_MOD_INVISIBILITY_DETECT},0,0,1,0,0,0,0"))
    assert rows.invis.ids == {100: {0}}
    assert rows.detect.ids == {200: {0}}


def test_a_payload_the_build_does_not_have_is_dropped(tables: BuildTables) -> None:
    """A screen effect the client does not carry has nothing to show, and a
    keybound override that trails its aura has no key and no spell to name."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_SCREEN_EFFECT},50,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{AURA_SCREEN_EFFECT},51,0,1,0,0,0,0",
        f"200,{EFFECT_APPLY_AURA},{AURA_KEYBOUND_OVERRIDE},60,0,1,0,0,0,0",
        f"200,{EFFECT_APPLY_AURA},{AURA_KEYBOUND_OVERRIDE},61,0,1,0,0,0,0"))
    assert rows.screens.ids == {100: {50}}
    assert rows.keybinds.ids == {200: {60}}


def test_masks_union_over_the_rows_that_produced_the_pair(tables: BuildTables) -> None:
    """Several effect rows routinely reach the same payload, and each says who
    its own row was aimed at, so the audiences add up rather than replace."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,2,0,0,0,0"))
    assert rows.morphs.masks == {(100, 900): TARGET_CASTER | TARGET_TARGET}


def test_both_implicit_targets_of_a_row_count(tables: BuildTables) -> None:
    """A row aims at two things at once, and the pill shows both icons."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,1,3,0,0,0"))
    assert rows.morphs.masks == {(100, 900): TARGET_CASTER | TARGET_AREA}


def test_an_unmasked_payload_keeps_no_audience(tables: BuildTables) -> None:
    """Override names reach the search corpus and never the screen, so who the
    spell was aimed at says nothing about them."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_OVERRIDE_NAME},7,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{AURA_ANIM_REPLACEMENT_SET},8,0,1,0,0,0,0"))
    assert rows.altnames == {100: {7}}
    assert rows.anim_sets == {100: {8}}


def test_a_summon_carries_its_control_word_but_is_masked_by_creature(
        tables: BuildTables) -> None:
    """The one payload whose ids and masks are keyed differently: the same
    creature summoned under two control words is one chip, aimed one way."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_SUMMON},0,900,7,1,0,0,0,0"))
    assert rows.summons == {100: {(900, 2)}}
    assert rows.summon_targets == {(100, 900): TARGET_CASTER}


def test_a_summon_property_the_build_lacks_reads_as_uncontrolled(
        tables: BuildTables) -> None:
    """0 is a real control value -- uncontrolled -- so an unresolved row lands
    on it rather than being dropped."""
    rows = read(tables, effect_rows(f"100,{EFFECT_SUMMON},0,900,99,1,0,0,0,0"))
    assert rows.summons == {100: {(900, 0)}}


def test_a_played_sound_is_a_mask_with_no_id_set(tables: BuildTables) -> None:
    """These merge into the sound column where the kits reached through visuals
    already live, so they need no bucket of their own."""
    rows = read(tables, effect_rows(f"100,{EFFECT_PLAY_SOUND},0,900,0,1,0,0,0,0"))
    assert rows.sounds == {(100, 900): TARGET_CASTER}


def test_a_speed_change_is_the_number_and_the_movement(tables: BuildTables) -> None:
    rows = read(tables, effect_rows(f"100,{EFFECT_APPLY_AURA},31,0,0,1,0,50,,0"))
    assert rows.speeds == {100: {("run", 50.0)}}
    assert rows.speed_targets == {(100, "run", 50.0): TARGET_CASTER}


def test_a_negative_change_survives_because_the_sign_is_the_point(
        tables: BuildTables) -> None:
    """The aura's NAME does not carry the direction: plenty of MOD_INCREASE
    rows hold a negative value and plenty of MOD_DECREASE rows a positive one."""
    rows = read(tables, effect_rows(f"100,{EFFECT_APPLY_AURA},31,0,0,1,0,-30,,0"))
    assert rows.speeds == {100: {("run", -30.0)}}


def test_a_zero_change_is_dropped(tables: BuildTables) -> None:
    """These pills are made of nothing but the number, so a "+0%" one promises
    a change and delivers none -- and drags the spell into counts it does not
    belong in."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},31,0,0,1,0,0,,0",
        f"200,{EFFECT_APPLY_AURA},61,0,0,1,0,0,,0"))
    assert rows.speeds == {}
    assert rows.scales == {}


def test_a_consumed_value_stays_on_its_row(tables: BuildTables) -> None:
    """Consumption marks, it does not delete.

    `MOD_SCALE` beside the scale pill would say one thing twice, so the flag
    tells the renderer to draw only the parsed one. The aura itself stays on
    the row, because a search for it must still find the spell.
    """
    rows = read(tables, effect_rows(f"100,{EFFECT_APPLY_AURA},61,0,0,1,0,30,,0"))
    assert rows.scales == {100: {30.0}}
    row, = rows.mechanics
    assert (row.aura, row.aura_consumed) == (61, True)


def test_the_effect_half_is_consumed_too(tables: BuildTables) -> None:
    """Not only auras: a summon reaches a pill of its own."""
    rows = read(tables, effect_rows(f"100,{EFFECT_SUMMON},0,900,7,1,0,0,0,0"))
    row, = rows.mechanics
    assert (row.effect, row.effect_consumed) == (EFFECT_SUMMON, True)


def test_the_two_halves_are_flagged_independently(tables: BuildTables) -> None:
    """They are two pills. An apply-aura effect carrying a consumed aura is
    still drawn, because it says the spell applies an aura rather than acting
    instantly and no other pill carries that."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,1,0,0,0,0"))
    assert rows.morphs.ids == {100: {900}}
    row, = rows.mechanics
    assert (row.effect_consumed, row.aura_consumed) == (False, True)


def test_a_dropped_payload_leaves_its_value_unflagged(tables: BuildTables) -> None:
    """Consumption is per row, not per value.

    A zero-amount scale aura reaches no pill, so the raw one is the only thing
    that can report it and must still be drawn.
    """
    rows = read(tables, effect_rows(f"100,{EFFECT_APPLY_AURA},61,0,0,1,0,0,,0"))
    assert rows.scales == {}
    row, = rows.mechanics
    assert (row.aura, row.aura_consumed) == (61, False)


def test_an_unparsed_value_stays_raw(tables: BuildTables) -> None:
    """The mechanics column is the inventory of features not built yet:
    JUMP_DEST sits there until a leap axis parses it."""
    rows = read(tables, effect_rows("100,60,0,0,0,3,0,0,0,0"))
    assert rows.mechanics == {EffectRow(100, 60, 0, 3, 0)}


def test_every_scale_aura_spelling_is_the_same_mechanic(tables: BuildTables) -> None:
    """239 on retail and WotLK, 591 on the 2024+ Classic clients. The drift is
    in the client's enum, not in what the aura does."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},61,0,0,1,0,30,,0",
        f"200,{EFFECT_APPLY_AURA},239,0,0,1,0,30,,0",
        f"300,{EFFECT_APPLY_AURA},591,0,0,1,0,30,,0"))
    assert rows.scales == {100: {30.0}, 200: {30.0}, 300: {30.0}}


def test_a_link_needs_a_target_the_pack_can_name(tables: BuildTables) -> None:
    """The chip is an icon and a name, so an unnameable target would render as
    a bare id nobody can act on."""
    rows = read(tables, effect_rows(
        "100,3,0,0,0,1,0,0,0,200",
        "100,3,0,0,0,1,0,0,0,999"))
    assert rows.links == {(100, 200, 3, 0)}


def test_a_spell_never_links_to_itself(tables: BuildTables) -> None:
    """A chip pointing at its own row."""
    rows = read(tables, effect_rows("100,3,0,0,0,1,0,0,0,100"))
    assert rows.links == set()


def test_the_two_whole_spell_views_answer_different_questions(
        tables: BuildTables) -> None:
    """`aura_target_bits` is who ends up CARRYING the aura; `cast_target_bits`
    is whether the whole spell is aimed at the caster. A spell whose aura is
    self-cast alongside effects aimed elsewhere depends on the difference."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,1,0,0,0,0",
        "100,3,0,0,0,2,0,0,0,0"))
    assert rows.aura_target_bits == {100: TARGET_CASTER}
    assert rows.cast_target_bits == {100: TARGET_CASTER | TARGET_TARGET}


def test_a_spell_the_build_does_not_list_is_skipped(tables: BuildTables) -> None:
    """The name table is the spell list, and every route filters against it."""
    rows = read(tables, effect_rows(
        f"999,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,1,0,0,0,0"))
    assert rows.morphs.ids == {}


def test_mechanics_dedupe_the_per_difficulty_copies(tables: BuildTables) -> None:
    """`SpellEffect` ships one row per difficulty, so the same effect arrives
    several times -- but two effects that really differ stay apart."""
    unparsed = 99
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{unparsed},0,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{unparsed},0,0,1,0,0,0,0",
        f"100,{EFFECT_APPLY_AURA},{unparsed},0,0,2,0,0,0,0"))
    assert rows.mechanics == {
        EffectRow(100, EFFECT_APPLY_AURA, unparsed, 1, 0),
        EffectRow(100, EFFECT_APPLY_AURA, unparsed, 2, 0)}


def test_both_targets_stay_on_the_row_that_carried_them(
        tables: BuildTables) -> None:
    """The granularity that makes a scope honest.

    `mech:{JUMP_DEST target:target}` asks for one effect that is a jump and
    aims at a unit. Union the targets per spell and the scope is satisfied by
    accident, by a spell whose trigger effect supplies the word and whose jump
    effect never aims at a unit at all.
    """
    rows = read(tables, effect_rows(
        "100,3,0,0,0,2,0,0,0,200",     # a trigger, aimed at the selected unit
        "100,60,0,0,0,3,0,0,0,0"))     # a jump, aimed at a destination
    assert rows.mechanics == {EffectRow(100, 3, 0, 2, 0),
                              EffectRow(100, 60, 0, 3, 0)}


def test_an_effect_that_does_nothing_carries_no_mechanic(tables: BuildTables) -> None:
    rows = read(tables, effect_rows("100,0,0,0,0,1,0,0,0,0"))
    assert rows.mechanics == set()


def test_an_implicit_target_the_build_does_not_name_contributes_nothing(
        tables: BuildTables) -> None:
    """The enum runs to ~150 values and plenty name neither a unit nor a place,
    so an unmapped id leaves the mask alone rather than defaulting into one."""
    rows = read(tables, effect_rows(
        f"100,{EFFECT_APPLY_AURA},{AURA_TRANSFORM},900,0,77,0,0,0,0"))
    assert rows.morphs.masks == {(100, 900): 0}


def test_every_reference_payload_is_declared_not_branched() -> None:
    """The extension point, pinned.

    Adding a payload whose misc value is a reference must be a row in
    `MISC_PAYLOADS` plus the field it names, with no edit to the walk. A
    declaration that stopped covering a selector would show up as a branch
    somewhere in the reader instead.
    """
    for payload in MISC_PAYLOADS:
        assert bool(payload.aura) != bool(payload.effects), (
            "a payload selects on an aura or on effects, never both")
        assert callable(payload.into)
    auras = [p.aura for p in MISC_PAYLOADS if p.aura]
    assert len(auras) == len(set(auras)), "two payloads claim one aura"
    # The effect half resolves the same way, so an overlap there would also
    # silently leave the last declaration holding the selector.
    effects = [effect for p in MISC_PAYLOADS for effect in p.effects]
    assert len(effects) == len(set(effects)), "two payloads claim one effect"


def test_a_roster_nobody_supplied_is_refused(tables: BuildTables) -> None:
    """A roster name with nothing behind it would keep every row silently, so
    it is refused at the call rather than discovered in a pack."""
    with pytest.raises(KeyError):
        read_spell_effect_rows(
            tables(SpellEffect=effect_rows(), SummonProperties=SUMMON_PROPERTIES),
            SPELLS, {"screens": frozenset()}, TARGET_BITS)
