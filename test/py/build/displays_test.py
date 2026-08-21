"""Creature and form displays, flattened to rows the pack can ship."""

from __future__ import annotations

from pack.derive.displays import resolve_displays
from pack.routes import CreatureModels, ShapeshiftForms, SpellEffectRows
from pack.targets import NO_TARGET


def forms(displays: dict[int, list[int]] | None = None) -> ShapeshiftForms:
    """Two forms the build knows, with whichever displays a test gives them."""
    return ShapeshiftForms(names={30: "Bear", 31: "Cat"},
                           displays=displays or {})


def creatures() -> CreatureModels:
    """Two creatures, one wearing two displays, resolving through two hops."""
    return CreatureModels(
        displays={1: [(0, 10), (1, 11)], 2: [(0, 12)]},
        display_model={10: 100, 11: 101, 12: 102, 20: 200},
        model_fid={100: 900, 101: 901, 200: 902})


def morphing(*creature_ids: int) -> SpellEffectRows:
    rows = SpellEffectRows()
    for creature in creature_ids:
        rows.morphs.add(500, creature, NO_TARGET)
    return rows


def summoning(*creature_ids: int) -> SpellEffectRows:
    rows = SpellEffectRows()
    for creature in creature_ids:
        rows.summons.setdefault(500, set()).add((creature, 0))
    return rows


def shifting(*form_ids: int) -> SpellEffectRows:
    rows = SpellEffectRows()
    for form in form_ids:
        rows.forms.add(500, form, NO_TARGET)
    return rows


def test_a_creature_contributes_one_row_per_display_in_slot_order() -> None:
    """The first is the one the pill shows, so the order is the contract."""
    found = resolve_displays(morphing(1), creatures(), forms())
    assert [(row.subject, row.display, row.fid) for row in found.creatures] == [
        (1, 10, 900), (1, 11, 901)]


def test_a_summoned_creature_resolves_like_a_morphed_one() -> None:
    """A creature is one thing whichever effect names it, so both land in the
    one list and a creature both morph and summon is one entry."""
    rows = morphing(1)
    rows.summons = summoning(1, 2).summons
    found = resolve_displays(rows, creatures(), forms())
    assert [(row.subject, row.display) for row in found.creatures] == [
        (1, 10), (1, 11), (2, 12)]


def test_a_display_that_resolves_to_no_model_still_makes_a_row() -> None:
    """Both hops can come up empty, and the row renders without a model rather
    than not existing."""
    found = resolve_displays(morphing(2), creatures(), forms())
    assert [(row.display, row.fid) for row in found.creatures] == [(12, 0)]


def test_the_creature_rows_come_back_in_creature_order() -> None:
    found = resolve_displays(morphing(2, 1), creatures(), forms())
    assert [row.subject for row in found.creatures] == [1, 1, 2]


def test_a_form_the_build_has_no_row_for_is_dropped() -> None:
    """Shipping it would put an empty word on the pill."""
    found = resolve_displays(shifting(30, 99), creatures(), forms({30: [20]}))
    assert found.known_forms == {500: {30}}
    assert [(row.subject, row.fid) for row in found.forms] == [(30, 902)]


def test_a_spell_losing_every_form_drops_out_entirely() -> None:
    found = resolve_displays(shifting(99), creatures(), forms())
    assert found.known_forms == {}
    assert found.forms == []


def test_a_form_with_no_display_survives_without_a_row() -> None:
    """It keeps its name and renders as a name-only pill."""
    found = resolve_displays(shifting(31), creatures(), forms())
    assert found.known_forms == {500: {31}}
    assert found.forms == []


def test_the_effect_rows_are_left_alone() -> None:
    """The surviving forms come back rather than being pruned in place: the
    rows are a route's output, and editing them would leave the two
    disagreeing about what the build found."""
    rows = shifting(30, 99)
    resolve_displays(rows, creatures(), forms({30: [20]}))
    assert rows.forms.ids == {500: {30, 99}}


def test_a_totem_spell_gains_its_per_race_displays() -> None:
    """The summon edge carries a spell-keyed table onto a creature-keyed row,
    and the creature's own display stays in front so the pill still leads with
    what it led with before."""
    models = creatures()
    models.totem_displays = {500: (20, 11)}
    found = resolve_displays(summoning(1), models, forms())
    assert [(row.subject, row.display, row.fid) for row in found.creatures] == [
        (1, 10, 900), (1, 11, 901), (1, 20, 902)]


def test_a_totem_display_the_creature_already_wears_is_not_repeated() -> None:
    """Deduplicated by display, so the race whose model is the creature's own
    default contributes nothing rather than a second identical row."""
    models = creatures()
    models.totem_displays = {500: (10,)}
    found = resolve_displays(summoning(1), models, forms())
    assert [row.display for row in found.creatures] == [10, 11]


def test_totem_displays_reach_only_the_creature_the_spell_summons() -> None:
    """A morph is not a summon, so a spell that only morphs gains nothing even
    when the table names it."""
    models = creatures()
    models.totem_displays = {500: (20,)}
    found = resolve_displays(morphing(1), models, forms())
    assert [row.display for row in found.creatures] == [10, 11]


def test_a_release_without_the_table_leaves_every_display_untouched() -> None:
    """The empty mapping is what a TDB-less build ships, and it must read the
    same as the build did before the table was read at all."""
    found = resolve_displays(summoning(1, 2), creatures(), forms())
    assert [(row.subject, row.display) for row in found.creatures] == [
        (1, 10), (1, 11), (2, 12)]


def test_a_display_named_in_two_slots_stays_two_rows() -> None:
    """It always has, and collapsing it would move `creatureDisplays` in every
    pack for a reason unrelated to totems -- measured at -7 rows on 3.4.3
    before this was pinned."""
    models = CreatureModels(displays={1: [(0, 10), (1, 10)]},
                            display_model={10: 100}, model_fid={100: 900})
    found = resolve_displays(morphing(1), models, forms())
    assert [row.display for row in found.creatures] == [10, 10]
