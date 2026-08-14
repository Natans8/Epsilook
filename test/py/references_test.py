"""Which file ids the pack must resolve, and the rows that survive resolution."""

from __future__ import annotations

from pack.derive.displays import Display, ResolvedDisplays
from pack.derive.references import References, collect_references
from pack.derive.walk import SpellVisuals
from pack.routes import (FxPayloads, GameObjectData, ItemModels, MountData,
                         ScreenRow, SpellEffectRows)
from pack.routes.models import MODEL_CAT_ITEM
from pack.targets import NO_TARGET


def visuals(**buckets: dict[int, dict[object, int]]) -> SpellVisuals:
    found = SpellVisuals()
    for name, rows in buckets.items():
        getattr(found, name).update(rows)
    return found


def collect(*, visuals: SpellVisuals | None = None,
            effects: SpellEffectRows | None = None,
            fx: FxPayloads | None = None,
            displays: ResolvedDisplays | None = None,
            mounts: MountData | None = None,
            objects: GameObjectData | None = None,
            items: ItemModels | None = None,
            spell_icons: dict[int, int] | None = None) -> References:
    """Run the collection with everything not under test left empty."""
    return collect_references(
        visuals or SpellVisuals(), effects or SpellEffectRows(),
        fx or FxPayloads(), displays or ResolvedDisplays(),
        mounts or MountData(), objects or GameObjectData(),
        items or ItemModels(), spell_icons or {})


def test_a_models_file_is_an_asset() -> None:
    found = collect(visuals=visuals(models={100: {(500, 1, 0, 0, 0, 0): NO_TARGET}}))
    assert found.assets == {500}


def test_a_fileless_sentinel_is_never_looked_up() -> None:
    """A negative id is the build's own equipped-weapon slot. It names no
    asset, so asking about it would report a name missing forever."""
    found = collect(visuals=visuals(models={100: {(-3, 1, 0, 0, 0, 0): NO_TARGET}}))
    assert found.assets == set()


def test_a_sounds_file_is_an_asset_but_its_kit_is_not() -> None:
    """The pair is (kit, file) and only the second half names something."""
    found = collect(visuals=visuals(sounds={100: {(40, 501): NO_TARGET}}))
    assert found.assets == {501}


def test_a_chains_textures_are_followed() -> None:
    """The walk collects the chain; its files live one table further in."""
    found = collect(visuals=visuals(chains={100: {(3, 0, 0): NO_TARGET}}),
                    fx=FxPayloads(chains={3: (0, 0, 0, 0, (701, 702), ())}))
    assert found.chains == {3}
    assert found.assets == {701, 702}


def test_a_dissolves_textures_are_followed() -> None:
    found = collect(visuals=visuals(dissolves={100: {5: NO_TARGET}}),
                    fx=FxPayloads(dissolves={5: (1.0, (703,), 0)}))
    assert found.assets == {703}


def test_a_screen_effects_textures_are_followed() -> None:
    """Screens reach the collection through the effect rows rather than the
    walk, since an aura can apply one with no visual at all."""
    effects = SpellEffectRows()
    effects.screens.add(100, 9, NO_TARGET)
    found = collect(effects=effects,
                    fx=FxPayloads(screens={9: ScreenRow(textures=((704, 0),))}))
    assert found.screens == {9}
    assert found.assets == {704}


def test_a_display_row_with_no_model_adds_nothing() -> None:
    """A display can resolve to no model, which is a row that renders without
    one rather than a file to look for."""
    found = collect(displays=ResolvedDisplays(
        morphs=[Display(1, 2, 800)], forms=[Display(3, 4, 0)]))
    assert found.assets == {800}


def test_a_mounts_model_is_an_asset() -> None:
    found = collect(mounts=MountData(links=[(100, 7)], fid={7: 900}))
    assert found.mount_displays == [7]
    assert found.assets == {900}


def test_an_object_the_world_dump_cannot_name_is_dropped() -> None:
    """It spawns nothing in game, so a pill for it would say nothing. This is
    also what empties the route on the builds that ship without a dump."""
    effects = SpellEffectRows()
    effects.objects.add(100, 11, NO_TARGET)
    effects.objects.add(100, 12, NO_TARGET)
    found = collect(effects=effects,
                    objects=GameObjectData(name={11: "Brazier"}, fid={11: 901}))
    assert found.object_rows == [(100, 11)]
    assert found.objects == [11]
    assert found.assets == {901}


def test_an_icon_stays_out_of_the_asset_set() -> None:
    """Its path becomes an icon name rather than a searchable file, so its id
    never reaches the files table."""
    found = collect(spell_icons={100: 950})
    assert found.icons == {950}
    assert found.assets == set()


def test_an_items_inventory_icon_joins_the_same_pass() -> None:
    """An item pill shows the icon the game shows in the bag."""
    found = collect(
        visuals=visuals(models={100: {(500, MODEL_CAT_ITEM, 0, 0, 77, 0): NO_TARGET}}),
        items=ItemModels(icon_fid={77: 951}))
    assert found.icons == {951}
    assert found.assets == {500}


def test_an_unresolvable_icon_is_not_asked_about() -> None:
    found = collect(spell_icons={100: 0})
    assert found.icons == set()


def test_one_pass_resolves_both_sets() -> None:
    """The listfile is streamed once for the whole build, so the two sets are
    asked for together even though the pack treats them differently."""
    found = collect(visuals=visuals(models={100: {(500, 1, 0, 0, 0, 0): NO_TARGET}}),
                    spell_icons={100: 950})
    assert found.wanted == {500, 950}
