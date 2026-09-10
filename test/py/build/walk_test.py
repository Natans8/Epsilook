"""The graph walk: what a spell reaches, when, and who each thing plays for.

Every case here is built from plain values. The derive layer reads no game
table, so its tests need no source at all -- which is the point of that rule
rather than a convenience.
"""

from __future__ import annotations

from collections import defaultdict

from pack.derive.walk import (
    KIT_BUCKETS,
    Bucket,
    Occurrence,
    SpellVisuals,
    screen_occurrences,
    screen_reach,
    sky_spells,
    walk_spells,
)
from pack.phases import PHASE_AURA, PHASE_CAST, PHASE_IMPACT, PHASE_NONE, PHASE_TRAVEL
from pack.routes import (
    Ambience,
    ChainEffect,
    FxPayloads,
    KitEffects,
    KitEvent,
    Missile,
    ScreenRow,
    SpellEffectRows,
    VisualGraph,
    VisualMissiles,
    ZoneMusic,
)
from pack.routes.models import MODEL_CAT_MISSILE, SCALE_UNIT, UNPLACED, AttachModel
from pack.targets import NO_TARGET, TARGET_AREA, TARGET_CASTER, TARGET_TARGET, merge_masked

SPELLS = frozenset({100})

MODEL = AttachModel(500, 1, 2, 3, 0, 0, UNPLACED, SCALE_UNIT)
"""A missile model: file, category, source, destination, ref, motion, how it is
placed, and the size the model itself is."""


def graph(
    *,
    visual: int = 7,
    kit: int = 9,
    extra: int = NO_TARGET,
    phase: int = PHASE_CAST,
    bit: int = TARGET_CASTER,
    sound: int = 0,
    spell: int = 100,
) -> VisualGraph:
    """One spell reaching one kit through one visual, at one event."""
    return VisualGraph(
        spell_visuals={spell: {visual: extra}},
        visual_events={visual: [KitEvent(kit, phase, bit)]},
        visual_sounds={visual: sound} if sound else {},
    )


def walk(
    graph_in: VisualGraph,
    kits: KitEffects | None = None,
    *,
    missiles: dict[int, VisualMissiles] | None = None,
    soundkit_files: dict[int, set[int]] | None = None,
    fx: FxPayloads | None = None,
    effects: SpellEffectRows | None = None,
    zone_music: dict[int, ZoneMusic] | None = None,
    ambiences: dict[int, Ambience] | None = None,
    delayed: frozenset[int] = frozenset(),
) -> SpellVisuals:
    """Run the walk with everything not under test left empty."""
    return walk_spells(
        SPELLS,
        graph_in,
        missiles or {},
        kits or KitEffects(),
        soundkit_files or {},
        fx or FxPayloads(),
        effects or SpellEffectRows(),
        zone_music or {},
        ambiences or {},
        delayed,
    )


def at(item: object, phase: int = PHASE_CAST) -> Occurrence:
    """One occurrence, at the cast unless said otherwise."""
    return Occurrence(item, phase)


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
    vis = walk(graph(), kits, fx=FxPayloads(chains={3: ChainEffect(0, 0, 0, 0, (), ())}))
    for index, bucket in enumerate(KIT_BUCKETS):
        collected = bucket.of_spell(vis)[100]
        assert collected == {at(item): TARGET_CASTER}, f"family {index} did not collect"


def test_a_kit_reached_twice_at_one_phase_unions_its_audiences() -> None:
    """The same content playing for the caster through one visual and the
    target through another, both at the cast, is one occurrence with both
    bits, not two."""
    kits = KitEffects(models={9: {MODEL}})
    reached = VisualGraph(
        spell_visuals={100: {7: NO_TARGET, 8: NO_TARGET}},
        visual_events={7: [KitEvent(9, PHASE_CAST, TARGET_CASTER)], 8: [KitEvent(9, PHASE_CAST, TARGET_TARGET)]},
    )
    vis = walk(reached, kits)
    assert vis.models[100] == {at(MODEL): TARGET_CASTER | TARGET_TARGET}


def test_the_same_content_at_two_phases_is_two_occurrences() -> None:
    """A model on the caster at the cast and on the target at the impact is
    two facts, each keeping its own audience; folding them into one row
    wearing both bits is the loss this shape exists to stop."""
    kits = KitEffects(models={9: {MODEL}})
    reached = VisualGraph(
        spell_visuals={100: {7: NO_TARGET}},
        visual_events={7: [KitEvent(9, PHASE_CAST, TARGET_CASTER), KitEvent(9, PHASE_IMPACT, TARGET_TARGET)]},
    )
    vis = walk(reached, kits)
    assert vis.models[100] == {at(MODEL, PHASE_CAST): TARGET_CASTER, at(MODEL, PHASE_IMPACT): TARGET_TARGET}


def test_a_redirect_edge_adds_its_bits_to_everything_beyond_it() -> None:
    """Content behind a redirect never passed an event row, so the edge is the
    only thing that can say whose view it is."""
    kits = KitEffects(models={9: {MODEL}})
    vis = walk(graph(extra=TARGET_TARGET, bit=NO_TARGET), kits)
    assert vis.models[100] == {at(MODEL): TARGET_TARGET}


def test_a_target_bit_becomes_a_caster_bit_on_a_self_cast_spell() -> None:
    """ "The target" is the caster when the spell aims only at itself, and only
    the spell's own effects can say that."""
    kits = KitEffects(models={9: {MODEL}})
    effects = SpellEffectRows(cast_target_bits={100: TARGET_CASTER})
    vis = walk(graph(bit=TARGET_TARGET), kits, effects=effects)
    assert vis.models[100] == {at(MODEL): TARGET_CASTER}


def test_an_aura_phase_event_believes_the_aura_effects_alone() -> None:
    """A self-buff's aura visual plays on the caster even when the spell's
    other effects aim elsewhere, and only the apply-aura targets say so."""
    kits = KitEffects(models={9: {MODEL}})
    effects = SpellEffectRows(aura_target_bits={100: TARGET_CASTER}, cast_target_bits={100: TARGET_TARGET})
    vis = walk(graph(phase=PHASE_AURA, bit=TARGET_TARGET), kits, effects=effects)
    assert vis.models[100] == {at(MODEL, PHASE_AURA): TARGET_CASTER}


def test_a_missile_starts_the_travel_and_carries_no_target_of_its_own() -> None:
    """A missile set has no event row: it is what the travel phase is, so it
    starts there, and it takes only what the edge gave it."""
    launched = {7: VisualMissiles(models={Missile(500, 4, 2, 3)}, soundkits=set(), animkits={11})}
    vis = walk(graph(extra=TARGET_AREA, bit=NO_TARGET), missiles=launched)
    shot = AttachModel(500, MODEL_CAT_MISSILE, 2, 3, 0, 4, UNPLACED, SCALE_UNIT)
    assert vis.models[100] == {at(shot, PHASE_TRAVEL): TARGET_AREA}
    assert vis.animkits[100] == {at(11, PHASE_TRAVEL): TARGET_AREA}


def test_a_sound_kit_becomes_one_pair_per_file() -> None:
    """A kit names the variations the client picks between, and the pack keeps
    the pairing so a reader can tell which kit a file came from."""
    kits = KitEffects(soundkits={9: {40}})
    vis = walk(graph(), kits, soundkit_files={40: {501, 502}})
    assert vis.sounds[100] == {at((40, 501)): TARGET_CASTER, at((40, 502)): TARGET_CASTER}


def test_a_visuals_own_animation_sound_is_placed_nowhere() -> None:
    """It hangs off the visual rather than off a kit or a missile, and no
    event names its moment, so it is a sound at no phase rather than at a
    guessed one."""
    vis = walk(graph(sound=40), soundkit_files={40: {501}})
    assert vis.sounds[100] == {at((40, 501), PHASE_NONE): NO_TARGET}


def test_an_effects_own_sound_happens_where_the_spell_lands() -> None:
    """A sound the effect row plays outright is at the cast, or at the impact
    when the spell is one whose effects arrive later."""
    effects = SpellEffectRows()
    effects.sounds[(100, 40)] = TARGET_TARGET
    files = {40: {501}}
    assert walk(graph(), effects=effects, soundkit_files=files).sounds[100][at((40, 501), PHASE_CAST)] == TARGET_TARGET
    landed = walk(graph(), effects=effects, soundkit_files=files, delayed=frozenset({100}))
    assert at((40, 501), PHASE_IMPACT) in landed.sounds[100]


def test_a_chains_own_sound_inherits_the_chains_audience_and_phase() -> None:
    kits = KitEffects(chains={9: {(3, 1, 2)}})
    fx = FxPayloads(chains={3: ChainEffect(0, 0, 0, 40, (), ())})
    vis = walk(graph(phase=PHASE_IMPACT), kits, fx=fx, soundkit_files={40: {501}})
    assert vis.sounds[100] == {at((40, 501), PHASE_IMPACT): TARGET_CASTER}


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
    assert vis.screens == {100: {at(22): TARGET_CASTER}}
    assert effects.screens.ids == {100: {21}}


def test_a_screen_occurs_at_the_aura_by_aura_and_at_the_event_by_kit() -> None:
    """The two routes to one screen are two occurrences, and the same screen
    reached both ways at one phase unions its audiences."""
    effects = SpellEffectRows()
    effects.screens.add(100, 21, TARGET_TARGET)
    effects.screens.add(100, 22, TARGET_TARGET)
    by_kit = walk(graph(phase=PHASE_AURA), KitEffects(screens={9: {22, 23}}), effects=effects).screens
    assert screen_occurrences(effects.screens, by_kit) == {
        (100, 21, PHASE_AURA): TARGET_TARGET,
        (100, 22, PHASE_AURA): TARGET_TARGET | TARGET_CASTER,
        (100, 23, PHASE_AURA): TARGET_CASTER,
    }


def test_a_screens_music_and_ambience_join_the_spells_sounds() -> None:
    """The bundle's two sound halves are kits like any visual's, under the
    audience the screen was reached by and for the aura it holds; a kit named
    twice is one entry."""
    effects = SpellEffectRows()
    effects.screens.add(100, 21, TARGET_TARGET)
    vis = walk(
        graph(),
        effects=effects,
        fx=FxPayloads(screens={21: ScreenRow(music=7, ambience=8)}),
        soundkit_files={70: {700}, 71: {710}, 80: {800}},
        zone_music={7: ZoneMusic("Zone-Test", 70, 71)},
        ambiences={8: Ambience(80, 80)},
    )
    assert vis.sounds[100] == {
        at((70, 700), PHASE_AURA): TARGET_TARGET,
        at((71, 710), PHASE_AURA): TARGET_TARGET,
        at((80, 800), PHASE_AURA): TARGET_TARGET,
    }


def test_a_screen_reached_by_a_kit_alone_still_plays_its_music() -> None:
    """The aura route is not the only way to a screen, and the kit's event is
    when and for whom the sound plays then."""
    vis = walk(
        graph(phase=PHASE_IMPACT),
        KitEffects(screens={9: {22}}),
        fx=FxPayloads(screens={22: ScreenRow(music=7)}),
        soundkit_files={70: {700}},
        zone_music={7: ZoneMusic("Zone-Test", 70, 0)},
    )
    assert vis.sounds[100] == {at((70, 700), PHASE_IMPACT): TARGET_CASTER}


def test_the_sky_edge_is_the_preset_on_the_reached_screen() -> None:
    """A spell sets a sky through the screen its aura names, on every pack;
    a screen with no preset sets none, and when it was reached does not
    matter to which sky it is."""
    effects = SpellEffectRows()
    effects.screens.add(100, 21, NO_TARGET)
    effects.screens.add(101, 21, NO_TARGET)
    effects.screens.add(102, 23, NO_TARGET)
    screens = {21: ScreenRow(sky=2124), 22: ScreenRow(sky=2124), 23: ScreenRow()}
    by_kit: Bucket = defaultdict(dict, {99: {at(22): NO_TARGET}})
    reached = screen_reach(effects.screens, by_kit)
    assert sky_spells(reached, screens) == {2124: [99, 100, 101]}


def test_a_visual_with_no_sound_conjures_no_empty_bucket() -> None:
    """The merge is guarded, so a spell reaching no sound at all stays absent
    from the family rather than arriving with an empty entry."""
    vis = walk(graph(), KitEffects(models={9: {MODEL}}))
    assert 100 not in vis.sounds


def test_a_kit_naming_a_chain_the_payload_pass_dropped_is_survivable() -> None:
    """One unresolved row must not be fatal to a build that renders without
    it, so the chain sound asks rather than indexes."""
    vis = walk(graph(), KitEffects(chains={9: {(404, 1, 2)}}), fx=FxPayloads())
    assert vis.chains[100] == {at((404, 1, 2)): TARGET_CASTER}


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


def test_every_kit_a_visual_names_is_kept_by_id_at_its_event() -> None:
    """The kit id is the handle a model frame renders a look by, so it ships
    beside what the kit contributes, when it starts and for whom: the spine
    of the spell's timeline."""
    vis = walk(graph(phase=PHASE_IMPACT), KitEffects(models={9: {MODEL}}))
    assert vis.visual_kits[100] == {at(9, PHASE_IMPACT): TARGET_CASTER}
