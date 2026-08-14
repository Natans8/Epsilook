"""Morph and form displays, flattened to rows the pack can ship."""

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


def shifting(*form_ids: int) -> SpellEffectRows:
    rows = SpellEffectRows()
    for form in form_ids:
        rows.forms.add(500, form, NO_TARGET)
    return rows


def test_a_creature_contributes_one_row_per_display_in_slot_order() -> None:
    """The first is the one the pill shows, so the order is the contract."""
    found = resolve_displays(morphing(1), creatures(), forms())
    assert [(row.subject, row.display, row.fid) for row in found.morphs] == [
        (1, 10, 900), (1, 11, 901)]


def test_a_display_that_resolves_to_no_model_still_makes_a_row() -> None:
    """Both hops can come up empty, and the row renders without a model rather
    than not existing."""
    found = resolve_displays(morphing(2), creatures(), forms())
    assert [(row.display, row.fid) for row in found.morphs] == [(12, 0)]


def test_the_morph_rows_come_back_in_creature_order() -> None:
    found = resolve_displays(morphing(2, 1), creatures(), forms())
    assert [row.subject for row in found.morphs] == [1, 1, 2]


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
