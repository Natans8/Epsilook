"""The one graph walk: spell to visual to kit, unioning every payload.

A spell reaches its content through two hops, and what it reaches is the union
over every kit every one of its visuals names, plus whatever its missile sets
carry. Every payload family merges the same way, so the families are declared
once and the walk is a loop rather than a dozen near-identical statements.

Each payload is collected as an occurrence: the thing, and the phase of the
spell it happens in. A row of the visual graph says when a kit starts and who
it plays for, so the same model at the cast and at the impact is two
occurrences with their own audiences rather than one wearing both. A spell to
visual edge can add bits of its own when it was reached through a redirect. A
missile set has no event row, and needs none: it is what fills the travel, so
it starts there, and its content carries only what the edge gave it. Every
family carries a mask even where the pack does not ship one today, so giving a
family an audience later is a section change rather than a walk change.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Container, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any, NamedTuple

from ..routes import (
    Ambience,
    FxPayloads,
    KitEffects,
    MaskedIds,
    ScreenRow,
    SpellEffectRows,
    VisualGraph,
    VisualMissiles,
    ZoneMusic,
)
from ..routes.models import MODEL_CAT_MISSILE, SCALE_UNIT, UNPLACED, AttachModel
from ..phases import PHASE_AURA, PHASE_NONE, PHASE_TRAVEL, landing
from ..routes.route import route
from ..targets import merge_masked, resolve_target_bit


class Occurrence(NamedTuple):
    """One thing a spell reaches, at one phase of the spell.

    The key every bucket holds. The two together are what a row is: a model at
    the impact is a different fact from the same model at the cast, and the
    audience is unioned per occurrence rather than per model.
    """

    item: Any
    """The family's own payload: a model record, a sound pair, a chain tuple.
    One bucket holds one family's shape, and the walk only moves it through."""

    phase: int
    """A value of the vendored phase enum: where in the spell it starts."""


Bucket = defaultdict[int, dict[Occurrence, int]]
"""Spell to its occurrences, each with the union of the masks it arrived by.

A `defaultdict` in the type and not only in the default, because the walk
merges into `bucket[spell]` before that spell has one. Declaring it as a plain
dict would let a caller construct `SpellVisuals` with one and get a `KeyError`
the annotation said was impossible.
"""

SoundPairs = Mapping[int, list[tuple[int, int]]]
"""Sound kit to the `(kit, file)` pairs the pack ships for it.

A kit names several files -- the variations the client picks between -- and the
pack carries the pairing so a reader can tell which kit a file came from. Built
once per build, so every spell that reaches a kit shares one set of tuples
rather than allocating its own equal copies.
"""


def _bucket() -> Bucket:
    """An empty payload bucket, ready to be merged into."""
    return defaultdict(dict)


@dataclass
class SpellVisuals:
    """Everything the walk attributes to a spell, keyed by spell.

    The same families a kit contributes, which is what lets the merge be one
    declaration. Unlike `KitEffects` these are accumulators, so they default
    rather than refusing to grow as they are read.
    """

    models: Bucket = field(default_factory=_bucket)
    sounds: Bucket = field(default_factory=_bucket)
    animkits: Bucket = field(default_factory=_bucket)
    anims: Bucket = field(default_factory=_bucket)
    """The base-to-replacement animation pairs its auras swap in."""
    visual_anims: Bucket = field(default_factory=_bucket)
    """The animations played directly on the unit."""
    chains: Bucket = field(default_factory=_bucket)
    dissolves: Bucket = field(default_factory=_bucket)
    glows: Bucket = field(default_factory=_bucket)
    shadowies: Bucket = field(default_factory=_bucket)
    ghost_mats: Bucket = field(default_factory=_bucket)
    tints: Bucket = field(default_factory=_bucket)
    desats: Bucket = field(default_factory=_bucket)
    transps: Bucket = field(default_factory=_bucket)

    visual_kits: Bucket = field(default_factory=_bucket)
    """The visual kits themselves, by id: the handle a model frame renders a
    spell's look by, kept beside what each kit contributes."""

    screens: Bucket = field(default_factory=_bucket)
    """The screen effects a spell's kits grade the frame with.

    The kit half only. Screens also arrive through an aura, with no visual
    involved, so the two are unioned where they are read rather than one being
    written into the other's bundle.
    """

    freezes: set[int] = field(default_factory=set)
    """Spells that freeze their target's animation. Valueless, so membership is
    the whole payload."""

    camos: set[int] = field(default_factory=set)
    """Spells that apply the camouflage shimmer. Valueless in the same way."""

    orphans: int = 0
    """Visual rows naming a spell the build has no `SpellName` row for."""


@dataclass(frozen=True)
class KitBucket:
    """One payload family, as the two ends the walk has to join.

    Declared rather than written out because every family merges identically:
    the only thing that differs is which bucket a kit contributes from and
    which one the spell collects into. Adding a family is one row here.
    """

    of_kit: Callable[[KitEffects], dict[int, set[Any]]]
    """Where a kit's contribution to this family lives.

    The bundle's own dictionary rather than a read-only view of it, which is
    what lets a caller enumerating the declaration reach both ends of it.
    """

    of_spell: Callable[[SpellVisuals], Bucket]
    """Where the spell collects it."""


KIT_BUCKETS: tuple[KitBucket, ...] = (
    KitBucket(lambda kits: kits.models, lambda vis: vis.models),
    KitBucket(lambda kits: kits.animkits, lambda vis: vis.animkits),
    KitBucket(lambda kits: kits.anims, lambda vis: vis.anims),
    KitBucket(lambda kits: kits.visual_anims, lambda vis: vis.visual_anims),
    KitBucket(lambda kits: kits.chains, lambda vis: vis.chains),
    KitBucket(lambda kits: kits.dissolves, lambda vis: vis.dissolves),
    KitBucket(lambda kits: kits.glows, lambda vis: vis.glows),
    KitBucket(lambda kits: kits.shadowies, lambda vis: vis.shadowies),
    KitBucket(lambda kits: kits.ghost_mats, lambda vis: vis.ghost_mats),
    KitBucket(lambda kits: kits.tints, lambda vis: vis.tints),
    KitBucket(lambda kits: kits.desats, lambda vis: vis.desats),
    KitBucket(lambda kits: kits.transps, lambda vis: vis.transps),
    KitBucket(lambda kits: kits.screens, lambda vis: vis.screens),
)
"""Every family a kit contributes by id, in the order the pack lists them.

Screens are here like any other family even though they also arrive through an
aura: a family carries its audience whether or not the pack ships one today, so
collecting this half by hand would make giving screens an audience a change to
the walk rather than to a section.
"""


@route("visuals", phase="walk_spells", spell_names="names.names", delayed="props.delayed")
def walk_spells(
    spell_names: Container[int],
    graph: VisualGraph,
    missiles: Mapping[int, VisualMissiles],
    kits: KitEffects,
    soundkit_files: Mapping[int, set[int]],
    fx: FxPayloads,
    effects: SpellEffectRows,
    zone_music: Mapping[int, ZoneMusic],
    ambiences: Mapping[int, Ambience],
    delayed: Container[int],
) -> SpellVisuals:
    """Walk every spell's visuals once, unioning what each one reaches.

    Args:
        spell_names: the build's spells; a visual row naming anything else is
            counted as an orphan rather than followed.
        graph: the two hops, and the sound a visual plays on its own.
        missiles: visual to the projectiles it launches.
        kits: what each kit contributes, by family.
        soundkit_files: sound kit to the files it plays.
        fx: the payload tables, for the sound a chain carries and the music
            and ambience a screen effect swaps in.
        effects: the per-spell target bits, which decide when "the target"
            means the caster, and the screen effects the auras name.
        zone_music: the music sets a screen effect can name, by id.
        ambiences: the ambiences a screen effect can name, by id.
        delayed: the spells whose effects land at the impact rather than the
            cast, which places the sound an effect plays outright.

    Returns:
        Every family, keyed by spell, each occurrence carrying the union of the
        masks it was reached by. Nothing it was handed is modified.
    """
    vis = SpellVisuals()
    # The pairs a kit expands to, and the two ends of every family, resolved
    # once instead of per kit visit. The innermost loop below runs for every
    # spell-visual-kit triple in the build, so anything constant across it is
    # worth lifting out -- and the shared pair tuples also stop each spell's
    # bucket keying on its own equal-but-distinct copies.
    pairs = {kit: [(kit, file) for file in files] for kit, files in soundkit_files.items()}
    families = [(bucket.of_kit(kits), bucket.of_spell(vis)) for bucket in KIT_BUCKETS]

    for spell, visuals in graph.spell_visuals.items():
        if spell not in spell_names:
            vis.orphans += 1
            continue
        aimed = (effects.aura_target_bits.get(spell, 0), effects.cast_target_bits.get(spell, 0))
        for visual, extra in visuals.items():
            _walk_missiles(vis, spell, missiles.get(visual), pairs, extra)
            # The visual's own animation-event sound hangs off the visual
            # rather than off a kit or a missile, but is a sound kit like any
            # other once found. Asked for only where there is one, so a visual
            # without a sound does not conjure the spell an empty bucket.
            # No event names its moment, so it is placed nowhere rather than
            # somewhere guessed.
            if soundkit := graph.visual_sounds.get(visual, 0):
                occurred(vis.sounds[spell], pairs.get(soundkit, ()), PHASE_NONE, extra)
            _walk_kits(vis, spell, visual, graph, kits, pairs, families, aimed, extra)

    _fold_chain_sounds(vis, fx, pairs)
    _fold_effect_sounds(vis, effects, pairs, delayed)
    _fold_screen_sounds(vis, fx, effects, zone_music, ambiences, pairs)
    return vis


def occurred(into: dict[Occurrence, int], items: Iterable[Any], phase: int, mask: int) -> None:
    """Record items happening at one phase, unioning the audience per occurrence.

    The one way anything enters a bucket, so the key is spelled once.
    """
    merge_masked(into, (Occurrence(item, phase) for item in items), mask)


def _walk_missiles(
    vis: SpellVisuals, spell: int, launched: VisualMissiles | None, pairs: SoundPairs, mask: int
) -> None:
    """Collect one visual's missile sets.

    Missile content has no `SpellVisualEvent` row, so it carries only whatever
    the spell-to-visual edge contributed and never a target type of its own.
    Its phase needs no row: a missile is what the travel phase is, and it
    starts where the travel starts. The projectile's own fields are widened to
    the model shape the rest of the walk uses, which is what lets missiles
    share the models bucket.
    """
    if launched is None:
        return
    occurred(
        vis.models[spell],
        (
            AttachModel(
                shot.file,
                MODEL_CAT_MISSILE,
                shot.source,
                shot.destination,
                0,
                shot.motion,
                UNPLACED,
                SCALE_UNIT,
                shot.effect,
            )
            for shot in launched.models
        ),
        PHASE_TRAVEL,
        mask,
    )
    occurred(vis.animkits[spell], launched.animkits, PHASE_TRAVEL, mask)
    for soundkit in launched.soundkits:
        occurred(vis.sounds[spell], pairs.get(soundkit, ()), PHASE_TRAVEL, mask)


def _walk_kits(
    vis: SpellVisuals,
    spell: int,
    visual: int,
    graph: VisualGraph,
    kits: KitEffects,
    pairs: SoundPairs,
    families: list[tuple[dict[int, set[Any]], Bucket]],
    aimed: tuple[int, int],
    extra: int,
) -> None:
    """Collect every event one visual names, into every family.

    An event is one kit at one phase for one audience, and the event's phase
    is the occurrence's. The audience is resolved per event, because "the
    target" means the caster on a self-cast spell and only the spell's own
    effects can say whether it is one.

    Args:
        vis: what the walk has attributed to this spell so far.
        spell: the spell being walked.
        visual: the visual it reached these kits through.
        graph: the two hops.
        kits: what each kit contributes, for the families with no id.
        pairs: sound kit to the `(kit, file)` pairs it expands to.
        families: the two ends of every declared family, resolved once.
        aimed: the spell's aura and cast target bits.
        extra: the bits the spell-to-visual edge contributed.
    """
    for kit, phase, bit in graph.visual_events.get(visual, ()):
        mask = resolve_target_bit(bit, phase, *aimed) | extra
        occurred(vis.visual_kits[spell], (kit,), phase, mask)
        for of_kit, of_spell in families:
            # Asked before indexing, so a family this kit contributes nothing
            # to does not leave the spell an empty bucket in it.
            if contributed := of_kit.get(kit):
                occurred(of_spell[spell], contributed, phase, mask)
        for soundkit in kits.soundkits.get(kit, ()):
            occurred(vis.sounds[spell], pairs.get(soundkit, ()), phase, mask)
        if kit in kits.freezes:
            vis.freezes.add(spell)
        if kit in kits.camos:
            vis.camos.add(spell)


def _fold_effect_sounds(
    vis: SpellVisuals, effects: SpellEffectRows, pairs: SoundPairs, delayed: Container[int]
) -> None:
    """Fold the sound an effect plays outright into the spell's sounds.

    A spell can play a sound without any visual doing it: `PLAY_SOUND` and
    `PLAY_MUSIC` name a kit on the effect row itself. It is the same fact as a
    kit's sound once found -- the same kit, the same files, masked by the
    effect row's own implicit target, happening where the spell's effects land
    -- so it merges into the same family rather than becoming a route of its
    own.
    """
    for (spell, soundkit), mask in effects.sounds.items():
        occurred(vis.sounds[spell], pairs.get(soundkit, ()), landing(spell in delayed), mask)


def _fold_chain_sounds(vis: SpellVisuals, fx: FxPayloads, pairs: SoundPairs) -> None:
    """Fold each drawn chain's own sound into the spell's sounds.

    A chain carries a sound kit of its own, which belongs in the sounds family
    like any other and inherits the phase and the mask the chain itself was
    reached by. Done after the walk because a chain can be reached more than
    once and its mask is only final once every visual has been followed.
    """
    for spell, chains in vis.chains.items():
        for (chain, phase), mask in chains.items():
            # A kit can name a chain the payload pass did not keep, so this
            # asks rather than indexes. Exiting on it would make one unresolved
            # row fatal to a build that renders perfectly well without it.
            if (row := fx.chains.get(chain[0])) and (soundkit := row.sound):
                occurred(vis.sounds[spell], pairs.get(soundkit, ()), phase, mask)


def _fold_screen_sounds(
    vis: SpellVisuals,
    fx: FxPayloads,
    effects: SpellEffectRows,
    zone_music: Mapping[int, ZoneMusic],
    ambiences: Mapping[int, Ambience],
    pairs: SoundPairs,
) -> None:
    """Fold the music and ambience a screen effect swaps in into the spell's sounds.

    A screen effect row bundles paint with a music set and an ambience, and the
    two sound halves name kits like any visual does, so they merge into the
    same family under the phase and the audience the screen was reached by.
    """
    for (spell, screen, phase), mask in screen_occurrences(effects.screens, vis.screens).items():
        row = fx.screens.get(screen)
        if row is None:
            continue
        music = zone_music.get(row.music)
        ambience = ambiences.get(row.ambience)
        kits = {*(music[1:] if music else ()), *(ambience if ambience else ())}
        for soundkit in kits:
            if soundkit:
                occurred(vis.sounds[spell], pairs.get(soundkit, ()), phase, mask)


def screen_occurrences(by_aura: MaskedIds, by_kit: Bucket) -> dict[tuple[int, int, int], int]:
    """Every screen effect a spell reaches, when, and for whom.

    An aura naming the effect holds it for the aura phase, under the aura's
    own audience; a visual kit playing it starts it at the kit's event. Where
    both reach one screen at one phase the audiences union, as everywhere.

    Args:
        by_aura: the screen effects the aura rows name, with their masks.
        by_kit: the walk's screens family.

    Returns:
        `(spell, screen effect, phase)` to the mask it plays under.
    """
    out: dict[tuple[int, int, int], int] = {}
    for spell, screens in by_aura.ids.items():
        for screen in screens:
            out[(spell, screen, PHASE_AURA)] = by_aura.masks.get((spell, screen), 0)
    for spell, played in by_kit.items():
        for (screen, phase), mask in played.items():
            key = (spell, screen, phase)
            out[key] = out.get(key, 0) | mask
    return out


def sky_spells(reached: Iterable[tuple[int, int]], screens: Mapping[int, ScreenRow]) -> dict[int, list[int]]:
    """LightParams id -> the spells that set it, ascending.

    The edge from a spell to a sky is the screen effect its aura names and the
    preset that row carries. It is the same on every pack: a retail spell that
    darkens the sky and a private server's spell that exists only to set a
    preset both reach it this way, so nothing is parsed out of a name.

    Args:
        reached: every `(spell, screen effect)` pair, from `screen_reach`.
        screens: screen effect -> its payload.

    Returns:
        Each preset some spell sets, with those spells in id order.
    """
    out: dict[int, set[int]] = {}
    for spell, screen in reached:
        row = screens.get(screen)
        if row is not None and row.sky:
            out.setdefault(row.sky, set()).add(spell)
    return {preset: sorted(spells) for preset, spells in sorted(out.items())}


def screen_reach(by_aura: MaskedIds, by_kit: Bucket) -> set[tuple[int, int]]:
    """Every spell paired with a screen effect it reaches, by either route.

    `screen_occurrences` with the phase dropped: this answers WHICH screens a
    spell reaches, for the rosters and the sky edge, and it is derived rather
    than written beside the other union so the two cannot disagree about
    which spells carry one.

    Args:
        by_aura: the screen effects the aura rows name, with their masks.
        by_kit: the walk's screens family.

    Returns:
        Every reached `(spell, screen effect)` pair, unordered.
    """
    return {(spell, screen) for spell, screen, _phase in screen_occurrences(by_aura, by_kit)}
