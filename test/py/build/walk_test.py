"""The graph walk: what a spell reaches, and who each thing plays for.

Every case here is built from plain values. The derive layer reads no game
table, so its tests need no source at all -- which is the point of that rule
rather than a convenience.
"""

from __future__ import annotations

from pack.derive.walk import KIT_BUCKETS, SpellVisuals, walk_spells
from pack.routes import (ChainEffect, FxPayloads, KitEffects, Missile,
                         SpellEffectRows, VisualGraph, VisualMissiles)
from pack.routes.models import (MODEL_CAT_MISSILE, SCALE_UNIT, UNPLACED,
                                AttachModel)
from pack.targets import (NO_TARGET, TARGET_AREA, TARGET_CASTER, TARGET_TARGET,
                          merge_masked)

SPELLS = frozenset({100})

MODEL = AttachModel(500, 1, 2, 3, 0, 0, UNPLACED, SCALE_UNIT)
"""A missile model: file, category, source, destination, ref, motion, how it is
placed, and the size the model itself is."""


def graph(*, visual: int = 7, kit: int = 9, extra: int = NO_TARGET,
          aura_mask: int = NO_TARGET, other_mask: int = TARGET_CASTER,
          sound: int = 0, spell: int = 100) -> VisualGraph:
    """One spell reaching one kit through one visual."""
    return VisualGraph(spell_visuals={spell: {visual: extra}},
                       visual_kits={visual: {kit: (aura_mask, other_mask)}},
                       visual_sounds={visual: sound} if sound else {})


def walk(graph_in: VisualGraph, kits: KitEffects | None = None, *,
         missiles: dict[int, VisualMissiles] | None = None,
         soundkit_files: dict[int, set[int]] | None = None,
         fx: FxPayloads | None = None,
         effects: SpellEffectRows | None = None) -> SpellVisuals:
    """Run the walk with everything not under test left empty."""
    return walk_spells(SPELLS, graph_in, missiles or {}, kits or KitEffects(),
                       soundkit_files or {}, fx or FxPayloads(),
                       effects or SpellEffectRows())


def test_every_declared_family_reaches_the_spell() -> None:
    """The families are a declaration, so the test is one too: a bucket added
    to `KIT_BUCKETS` and forgotten here would otherwise go unwalked.

    One opaque item serves every family. The walk only ever moves these
    through, so the single shape that has to be real is the chain's, whose
    first element indexes the payload table.
    """
    item = (3, 1, 2)
    kits = KitEffects()
    for bucket in KIT_BUCKETS:
        bucket.of_kit(kits)[9] = {item}
    vis = walk(graph(), kits,
               fx=FxPayloads(chains={3: ChainEffect(0, 0, 0, 0, (), ())}))
    for index, bucket in enumerate(KIT_BUCKETS):
        collected = bucket.of_spell(vis)[100]
        assert collected == {item: TARGET_CASTER}, f"family {index} did not collect"


def test_a_kit_reached_twice_unions_its_audiences() -> None:
    """The same content playing for the caster through one visual and the
    target through another is one item with both bits, not two items."""
    kits = KitEffects(models={9: {MODEL}})
    reached = VisualGraph(
        spell_visuals={100: {7: NO_TARGET, 8: NO_TARGET}},
        visual_kits={7: {9: (NO_TARGET, TARGET_CASTER)},
                     8: {9: (NO_TARGET, TARGET_TARGET)}})
    vis = walk(reached, kits)
    assert vis.models[100] == {MODEL: TARGET_CASTER | TARGET_TARGET}


def test_a_redirect_edge_adds_its_bits_to_everything_beyond_it() -> None:
    """Content behind a redirect never passed an event row, so the edge is the
    only thing that can say whose view it is."""
    kits = KitEffects(models={9: {MODEL}})
    vis = walk(graph(extra=TARGET_TARGET, other_mask=NO_TARGET), kits)
    assert vis.models[100] == {MODEL: TARGET_TARGET}


def test_a_target_bit_becomes_a_caster_bit_on_a_self_cast_spell() -> None:
    """"The target" is the caster when the spell aims only at itself, and only
    the spell's own effects can say that."""
    kits = KitEffects(models={9: {MODEL}})
    effects = SpellEffectRows(cast_target_bits={100: TARGET_CASTER})
    vis = walk(graph(other_mask=TARGET_TARGET), kits, effects=effects)
    assert vis.models[100] == {MODEL: TARGET_CASTER}


def test_a_missile_carries_no_target_type_of_its_own() -> None:
    """A missile set has no event row, so it takes only what the edge gave it."""
    launched = {7: VisualMissiles(models={Missile(500, 4, 2, 3)}, soundkits=set(),
                                  animkits={11})}
    vis = walk(graph(extra=TARGET_AREA, other_mask=NO_TARGET), missiles=launched)
    assert vis.models[100] == {
        AttachModel(500, MODEL_CAT_MISSILE, 2, 3, 0, 4,
                    UNPLACED, SCALE_UNIT): TARGET_AREA}
    assert vis.animkits[100] == {11: TARGET_AREA}


def test_a_sound_kit_becomes_one_pair_per_file() -> None:
    """A kit names the variations the client picks between, and the pack keeps
    the pairing so a reader can tell which kit a file came from."""
    kits = KitEffects(soundkits={9: {40}})
    vis = walk(graph(), kits, soundkit_files={40: {501, 502}})
    assert vis.sounds[100] == {(40, 501): TARGET_CASTER, (40, 502): TARGET_CASTER}


def test_a_visuals_own_animation_sound_is_collected() -> None:
    """It hangs off the visual rather than off a kit, but is a sound like any
    other once found."""
    vis = walk(graph(sound=40), soundkit_files={40: {501}})
    assert vis.sounds[100] == {(40, 501): NO_TARGET}


def test_a_chains_own_sound_inherits_the_chains_audience() -> None:
    kits = KitEffects(chains={9: {(3, 1, 2)}})
    fx = FxPayloads(chains={3: ChainEffect(0, 0, 0, 40, (), ())})
    vis = walk(graph(), kits, fx=fx, soundkit_files={40: {501}})
    assert vis.sounds[100] == {(40, 501): TARGET_CASTER}


def test_the_valueless_families_are_membership_only() -> None:
    kits = KitEffects(freezes={9}, camos={9})
    vis = walk(graph(), kits)
    assert vis.freezes == {100} and vis.camos == {100}


def test_the_kits_screen_effects_are_collected_without_touching_the_auras() -> None:
    """Screens also arrive through an aura with no visual involved. The walk
    reports only its own half, so neither pass writes into the other's bundle
    and the two are unioned where they are read."""
    effects = SpellEffectRows()
    effects.screens.add(100, 21, NO_TARGET)
    vis = walk(graph(), KitEffects(screens={9: {22}}), effects=effects)
    # Masked like every other family, even though the pack ships no audience
    # for a screen today -- giving it one later is then a section change.
    assert vis.screens == {100: {22: TARGET_CASTER}}
    assert effects.screens.ids == {100: {21}}


def test_a_visual_with_no_sound_conjures_no_empty_bucket() -> None:
    """The merge is guarded, so a spell reaching no sound at all stays absent
    from the family rather than arriving with an empty entry."""
    vis = walk(graph(), KitEffects(models={9: {MODEL}}))
    assert 100 not in vis.sounds


def test_a_kit_naming_a_chain_the_payload_pass_dropped_is_survivable() -> None:
    """One unresolved row must not be fatal to a build that renders without
    it, so the chain sound asks rather than indexes."""
    vis = walk(graph(), KitEffects(chains={9: {(404, 1, 2)}}), fx=FxPayloads())
    assert vis.chains[100] == {(404, 1, 2): TARGET_CASTER}


def test_a_visual_row_naming_an_unknown_spell_is_counted_not_followed() -> None:
    kits = KitEffects(models={9: {MODEL}})
    vis = walk(graph(spell=999), kits)
    assert vis.orphans == 1
    assert not vis.models


def test_merge_masked_accumulates_rather_than_replacing() -> None:
    """The property every family above depends on, pinned on its own."""
    bucket: dict[int, int] = {}
    merge_masked(bucket, [1], TARGET_CASTER)
    merge_masked(bucket, [1], TARGET_TARGET)
    assert bucket == {1: TARGET_CASTER | TARGET_TARGET}
