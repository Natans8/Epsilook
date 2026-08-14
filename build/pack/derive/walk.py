"""The one graph walk: spell to visual to kit, unioning every payload.

A spell reaches its content through two hops, and what it reaches is the union
over every kit every one of its visuals names, plus whatever its missile sets
carry. Every payload family merges the same way, so the families are declared
once and the walk is a loop rather than a dozen near-identical statements.

Each payload carries the audience it was reached through. A row of the visual
graph says who a kit plays for, a spell to visual edge can add bits of its own
when it was reached through a redirect, and a missile set has no event row at
all so its content carries none. Every family carries a mask even where the
pack does not ship one today, so giving a family an audience later is a section
change rather than a walk change.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Container, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..routes import (FxPayloads, KitEffects, SpellEffectRows, VisualGraph,
                      VisualMissiles)
from ..routes.models import MODEL_CAT_MISSILE
from ..targets import merge_masked, resolve_target_mask

Bucket = dict[int, dict[Any, int]]
"""Spell to its payload items, each with the union of the masks it arrived by."""


@dataclass
class SpellVisuals:
    """Everything the walk attributes to a spell, keyed by spell.

    The same families a kit contributes, which is what lets the merge be one
    declaration. Unlike `KitEffects` these are accumulators, so they default
    rather than refusing to grow as they are read.
    """

    models: Bucket = field(default_factory=lambda: defaultdict(dict))
    sounds: Bucket = field(default_factory=lambda: defaultdict(dict))
    animkits: Bucket = field(default_factory=lambda: defaultdict(dict))
    anims: Bucket = field(default_factory=lambda: defaultdict(dict))
    """The base-to-replacement animation pairs its auras swap in."""
    visual_anims: Bucket = field(default_factory=lambda: defaultdict(dict))
    """The animations played directly on the unit."""
    chains: Bucket = field(default_factory=lambda: defaultdict(dict))
    dissolves: Bucket = field(default_factory=lambda: defaultdict(dict))
    glows: Bucket = field(default_factory=lambda: defaultdict(dict))
    shadowies: Bucket = field(default_factory=lambda: defaultdict(dict))
    ghost_mats: Bucket = field(default_factory=lambda: defaultdict(dict))
    tints: Bucket = field(default_factory=lambda: defaultdict(dict))
    desats: Bucket = field(default_factory=lambda: defaultdict(dict))
    transps: Bucket = field(default_factory=lambda: defaultdict(dict))

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
)
"""Every family a kit contributes by id, in the order the pack lists them."""


def _sounds_of(soundkit_files: Mapping[int, set[int]],
               soundkit: int) -> list[tuple[int, int]]:
    """One sound kit as the `(kit, file)` pairs the pack ships.

    A kit names several files -- the variations the client picks between -- and
    the pack carries the pairing so a reader can tell which kit a file came
    from.

    Args:
        soundkit_files: sound kit to the files it plays.
        soundkit: the kit to expand. Zero means the caller had none.

    Returns:
        The pairs, empty when the kit is zero or names no file.
    """
    return [(soundkit, file) for file in soundkit_files.get(soundkit, ())]


def walk_spells(spell_names: Container[int], graph: VisualGraph,
                missiles: Mapping[int, VisualMissiles], kits: KitEffects,
                soundkit_files: Mapping[int, set[int]], fx: FxPayloads,
                effects: SpellEffectRows,
                screens: dict[int, set[int]]) -> SpellVisuals:
    """Walk every spell's visuals once, unioning what each one reaches.

    Screen effects are the one family that also arrives from outside the graph,
    through an aura rather than a kit, so they are extended in place rather
    than collected here.

    Args:
        spell_names: the build's spells; a visual row naming anything else is
            counted as an orphan rather than followed.
        graph: the two hops, and the sound a visual plays on its own.
        missiles: visual to the projectiles it launches.
        kits: what each kit contributes, by family.
        soundkit_files: sound kit to the files it plays.
        fx: the payload tables, for the sound a chain carries.
        effects: the per-spell target bits, which decide when "the target"
            means the caster.
        screens: spell to its screen effects, already holding what the auras
            contributed. Extended with the kit route.

    Returns:
        Every family, keyed by spell, each item carrying the union of the masks
        it was reached by.
    """
    vis = SpellVisuals()

    for spell, visuals in graph.spell_visuals.items():
        if spell not in spell_names:
            vis.orphans += 1
            continue
        for visual, extra in visuals.items():
            _walk_missiles(vis, spell, missiles.get(visual), soundkit_files, extra)
            # The visual's own animation-event sound hangs off the visual
            # rather than off a kit or a missile, but is a sound kit like any
            # other once found.
            merge_masked(vis.sounds[spell],
                         _sounds_of(soundkit_files, graph.visual_sounds.get(visual, 0)),
                         extra)
            _walk_kits(vis, spell, visual, graph, kits, soundkit_files,
                       effects, screens, extra)

    _fold_chain_sounds(vis, fx, soundkit_files)
    return vis


def _walk_missiles(vis: SpellVisuals, spell: int,
                   launched: VisualMissiles | None,
                   soundkit_files: Mapping[int, set[int]], mask: int) -> None:
    """Collect one visual's missile sets.

    Missile content has no `SpellVisualEvent` row, so it carries only whatever
    the spell-to-visual edge contributed and never a target type of its own.
    The projectile's own fields are widened to the model shape the rest of the
    walk uses, which is what lets missiles share the models bucket.
    """
    if launched is None:
        return
    merge_masked(vis.models[spell],
                 ((file, MODEL_CAT_MISSILE, source, destination, 0, motion)
                  for file, motion, source, destination in launched.models), mask)
    merge_masked(vis.animkits[spell], launched.animkits, mask)
    for soundkit in launched.soundkits:
        merge_masked(vis.sounds[spell], _sounds_of(soundkit_files, soundkit), mask)


def _walk_kits(vis: SpellVisuals, spell: int, visual: int, graph: VisualGraph,
               kits: KitEffects, soundkit_files: Mapping[int, set[int]],
               effects: SpellEffectRows, screens: dict[int, set[int]],
               extra: int) -> None:
    """Collect every kit one visual names, into every family.

    The kit's two phase masks are folded into one first, because "the target"
    means the caster on a self-cast spell and only the spell's own effects can
    say whether it is one.
    """
    for kit, (aura_mask, other_mask) in graph.visual_kits.get(visual, {}).items():
        mask = resolve_target_mask(
            aura_mask, other_mask,
            effects.aura_target_bits.get(spell, 0),
            effects.cast_target_bits.get(spell, 0)) | extra
        for bucket in KIT_BUCKETS:
            merge_masked(bucket.of_spell(vis)[spell],
                         bucket.of_kit(kits).get(kit, ()), mask)
        for soundkit in kits.soundkits.get(kit, ()):
            merge_masked(vis.sounds[spell], _sounds_of(soundkit_files, soundkit), mask)
        if kit in kits.freezes:
            vis.freezes.add(spell)
        if kit in kits.camos:
            vis.camos.add(spell)
        screens.setdefault(spell, set()).update(kits.screens.get(kit, ()))


def _fold_chain_sounds(vis: SpellVisuals, fx: FxPayloads,
                       soundkit_files: Mapping[int, set[int]]) -> None:
    """Fold each drawn chain's own sound into the spell's sounds.

    A chain carries a sound kit of its own, which belongs in the sounds family
    like any other and inherits the mask the chain itself was reached by. Done
    after the walk because a chain can be reached more than once and its mask
    is only final once every visual has been followed.
    """
    for spell, chains in vis.chains.items():
        for chain, mask in chains.items():
            soundkit = fx.chains[chain[0]][3]
            merge_masked(vis.sounds[spell],
                         _sounds_of(soundkit_files, soundkit), mask)
