"""The kit dispatch: where a visual kit's effect rows become payloads.

One `SpellVisualKitEffect` row says "this kit plays effect E of type T", and
the type decides which of ten tables E is an id in. A procedure reference is
dispatched twice: the second dispatch is a membership test against the buckets
the procedure route filled. A row pointing at a payload this build lacks is
dropped rather than treated as an error.
"""

from __future__ import annotations

from collections.abc import Callable, Container, Mapping
from dataclasses import dataclass, field

from ..sources import enum_id_where, load_local_enum
from ..tables import Tables
from .attachments import NO_ATTACHMENT, NO_MOTION
from .columns import to_int
from .fx import ChainEffect, FxPayloads, expand_chain
from .models import (MODEL_CAT_AREA, MODEL_CAT_BARRAGE, SCALE_UNIT, UNPLACED,
                     AttachModel, ModelSources)
from .procedures import ProcEffects

_KIT_EFFECT_TYPES = load_local_enum("spell_visual_kit_effect_types")
EFFECT_TYPE_PROC = enum_id_where(_KIT_EFFECT_TYPES, "proc")
EFFECT_TYPE_SOUND = enum_id_where(_KIT_EFFECT_TYPES, "sound")
EFFECT_TYPE_ANIM = enum_id_where(_KIT_EFFECT_TYPES, "anim")
EFFECT_TYPE_SHADOWY = enum_id_where(_KIT_EFFECT_TYPES, "shadowy")
EFFECT_TYPE_EMISSION = enum_id_where(_KIT_EFFECT_TYPES, "emission")
EFFECT_TYPE_DISSOLVE = enum_id_where(_KIT_EFFECT_TYPES, "dissolve")
EFFECT_TYPE_EDGE_GLOW = enum_id_where(_KIT_EFFECT_TYPES, "edge_glow")
EFFECT_TYPE_BEAM = enum_id_where(_KIT_EFFECT_TYPES, "beam")
EFFECT_TYPE_BARRAGE = enum_id_where(_KIT_EFFECT_TYPES, "barrage")
EFFECT_TYPE_SCREEN = enum_id_where(_KIT_EFFECT_TYPES, "screen")

# (chain, source attachment, destination attachment)
ChainDraw = tuple[int, int, int]


@dataclass
class KitEffects:
    """What each kit contributes, in the bucket its effect type chose.

    Every field is kit -> the payload ids it references; freezes and camos are
    valueless, so kit membership is the whole payload. A kit is absent from a
    bucket it contributed nothing to, so read these with `.get(kit, ())`. They
    are plain dicts on purpose: a defaulting bucket would grow as it is read.
    """

    models: dict[int, set[AttachModel]] = field(default_factory=dict)
    soundkits: dict[int, set[int]] = field(default_factory=dict)
    animkits: dict[int, set[int]] = field(default_factory=dict)
    anims: dict[int, set[tuple[int, int]]] = field(default_factory=dict)
    """Kit -> the (base, replacement) animation pairs it swaps in."""
    visual_anims: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the animations it plays directly on the unit."""
    chains: dict[int, set[ChainDraw]] = field(default_factory=dict)
    dissolves: dict[int, set[int]] = field(default_factory=dict)
    glows: dict[int, set[int]] = field(default_factory=dict)
    shadowies: dict[int, set[int]] = field(default_factory=dict)
    ghost_mats: dict[int, set[int]] = field(default_factory=dict)
    tints: dict[int, set[int]] = field(default_factory=dict)
    desats: dict[int, set[int]] = field(default_factory=dict)
    transps: dict[int, set[int]] = field(default_factory=dict)
    screens: dict[int, set[int]] = field(default_factory=dict)
    freezes: set[int] = field(default_factory=set)
    camos: set[int] = field(default_factory=set)


@dataclass(frozen=True)
class RosteredPayload:
    """An effect type whose payload is kept only if its table has the row.

    Three of the ten types differ in nothing but which table answers and which
    bucket receives, so they are declared rather than written out. The rest do
    something structurally different and stay in the walk.
    """

    known: Callable[[FxPayloads], Container[int]]
    """Where to ask whether this build carries the row."""

    into: Callable[[KitEffects], dict[int, set[int]]]
    """Which bucket receives it."""


ROSTERED_PAYLOADS: dict[int, RosteredPayload] = {
    EFFECT_TYPE_DISSOLVE: RosteredPayload(lambda fx: fx.dissolves,
                                          lambda kits: kits.dissolves),
    EFFECT_TYPE_EDGE_GLOW: RosteredPayload(lambda fx: fx.glows,
                                           lambda kits: kits.glows),
    EFFECT_TYPE_SHADOWY: RosteredPayload(lambda fx: fx.shadowies,
                                         lambda kits: kits.shadowies),
}
"""Effect type to the payload it keeps, for the types that only look one up."""


def add_chains(chains: Mapping[int, ChainEffect], chain_id: int,
               source: int, destination: int, into: set[ChainDraw]) -> None:
    """Add a chain and every chain it nests, tagged with an attachment pair.

    Nested chains inherit the parent beam's attachments: they are segments of
    the same beam.
    """
    expanded: set[int] = set()
    expand_chain(chains, chain_id, expanded)
    into.update((chain, source, destination) for chain in expanded)


def read_kit_effects(tables: Tables, models: ModelSources, procs: ProcEffects,
                     fx: FxPayloads) -> KitEffects:
    """Dispatch every kit effect row into the bucket its type chose."""
    kits = KitEffects(
        models={kit: set(rows) for kit, rows in models.attach_models.items()},
        # The attached models seed the same buckets this walk fills; the walk
        # unions rather than replaces.
        animkits={kit: set(rows) for kit, rows in models.attach_animkits.items()},
        visual_anims={kit: set(rows) for kit, rows in models.attach_anims.items()})

    # An animation effect points at a row carrying both an anim kit and up to
    # two animations the kit plays directly on the unit. 0 and -1 both mean
    # unset here: 0 would be Stand.
    visual_anims: dict[int, tuple[int, int, int]] = {}
    for row_id, initial, loop, animkit in tables.rows(
            "SpellVisualAnim", ["ID", "InitialAnimID", "LoopAnimID", "AnimKitID"]):
        visual_anims[to_int(row_id)] = (to_int(initial), to_int(loop), to_int(animkit))

    for kit_id, type_id, effect_id in tables.rows(
            "SpellVisualKitEffect",
            ["ParentSpellVisualKitID", "EffectType", "Effect"]):
        kit, effect_type, effect = to_int(kit_id), to_int(type_id), to_int(effect_id)
        if not (kit and effect):
            continue
        if effect_type == EFFECT_TYPE_SOUND:
            kits.soundkits.setdefault(kit, set()).add(effect)
        elif effect_type == EFFECT_TYPE_ANIM:
            first, second, kit_anim = visual_anims.get(effect, (0, 0, 0))
            if kit_anim:
                kits.animkits.setdefault(kit, set()).add(kit_anim)
            played = {anim for anim in (first, second) if anim > 0}
            if played:
                kits.visual_anims.setdefault(kit, set()).update(played)
        elif effect_type == EFFECT_TYPE_PROC:
            _add_procedure(kits, kit, effect, procs, fx)
        elif effect_type == EFFECT_TYPE_BEAM:
            chain, source, destination = fx.beam_chain.get(
                effect, (0, NO_ATTACHMENT, NO_ATTACHMENT))
            add_chains(fx.chains, chain, source, destination,
                       kits.chains.setdefault(kit, set()))
        elif (rostered := ROSTERED_PAYLOADS.get(effect_type)) is not None:
            if effect in rostered.known(fx):
                rostered.into(kits).setdefault(kit, set()).add(effect)
        elif effect_type == EFFECT_TYPE_EMISSION:
            file = models.emission_fid.get(effect, 0)
            if file:
                kits.models.setdefault(kit, set()).add(
                    AttachModel(file, MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT,
                                0, NO_MOTION, UNPLACED, SCALE_UNIT))
        elif effect_type == EFFECT_TYPE_BARRAGE:
            file = models.barrage_fid.get(effect, 0)
            if file:
                attach = models.barrage_attach.get(effect, NO_ATTACHMENT)
                kits.models.setdefault(kit, set()).add(
                    AttachModel(file, MODEL_CAT_BARRAGE, attach, NO_ATTACHMENT,
                                0, NO_MOTION, UNPLACED, SCALE_UNIT))
        elif effect_type == EFFECT_TYPE_SCREEN:
            screen = fx.svse_screen.get(effect, 0)
            if screen in fx.screens:
                kits.screens.setdefault(kit, set()).add(screen)
    return kits


def _add_procedure(kits: KitEffects, kit: int, procedure: int,
                   procs: ProcEffects, fx: FxPayloads) -> None:
    """Route one procedure reference to whichever buckets it landed in.

    A procedure-route chain has no beam row, so it carries no attachment pair.
    """
    chain = procs.chain.get(procedure, 0)
    if chain:
        add_chains(fx.chains, chain, NO_ATTACHMENT, NO_ATTACHMENT,
                   kits.chains.setdefault(kit, set()))
    for bucket, into in ((procs.tints, kits.tints),
                         (procs.ghost_mats, kits.ghost_mats),
                         (procs.desats, kits.desats),
                         (procs.transps, kits.transps)):
        if procedure in bucket:
            into.setdefault(kit, set()).add(procedure)
    if procedure in procs.freezes:
        kits.freezes.add(kit)
    if procedure in procs.camos:
        kits.camos.add(kit)
    if procedure in procs.models:
        kits.models.setdefault(kit, set()).add(procs.models[procedure])
    if procedure in procs.anims:
        kits.anims.setdefault(kit, set()).update(procs.anims[procedure])
