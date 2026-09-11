"""The kit dispatch: where a visual kit's effect rows become payloads.

One `SpellVisualKitEffect` row says "this kit plays effect E of type T", and
the type decides which of ten tables E is an id in. Each type is one
declaration over that read, and this module holds the bundle they merge into.
A procedure reference is dispatched twice: the second dispatch is a membership
test against the buckets the procedure route filled. A row pointing at a
payload this build lacks is dropped rather than treated as an error.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from ..sources import enum_id_where, load_local_enum
from .attachments import NO_ATTACHMENT
from .models import AttachModel, KitAttachments
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

ChainDraw = tuple[int, int, int]
"""A chain a kit draws, with the source and destination attachments of the
beam it hangs from; a chain reached through a procedure hangs from nothing."""


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

    @classmethod
    def assemble(  # noqa: PLR0913  -- one parameter per declaration it merges
        cls,
        attachments: KitAttachments,
        kit_sounds: Mapping[int, set[int]],
        kit_animkits: Mapping[int, set[int]],
        kit_visual_anims: Mapping[int, set[int]],
        kit_dissolves: Mapping[int, set[int]],
        kit_glows: Mapping[int, set[int]],
        kit_shadowies: Mapping[int, set[int]],
        kit_screens: Mapping[int, set[int]],
        kit_emissions: Mapping[int, set[int]],
        kit_barrages: Mapping[int, set[int]],
        kit_beams: Mapping[int, set[ChainDraw]],
        kit_procedures: Mapping[int, set[int]],
        kit_proc_chains: Mapping[int, set[int]],
        emissions: Mapping[int, AttachModel],
        barrages: Mapping[int, AttachModel],
        procs: ProcEffects,
    ) -> KitEffects:
        """Merge every per-type declaration into the buckets the walk reads.

        The attached models seed the model, animation and anim-kit buckets and
        the effect rows union into them; a procedure lands in every bucket the
        procedure route sorted it into, which is the second dispatch.
        """
        kits = cls(
            models=union(
                attachments.models,
                resolved(kit_emissions, emissions),
                resolved(kit_barrages, barrages),
                resolved(kit_procedures, procs.ground),
                resolved(kit_procedures, procs.trails),
            ),
            soundkits=union(kit_sounds),
            animkits=union(attachments.animkits, kit_animkits),
            visual_anims=union(attachments.anims, kit_visual_anims),
            chains=union(
                kit_beams,
                {
                    kit: {(chain, NO_ATTACHMENT, NO_ATTACHMENT) for chain in chains}
                    for kit, chains in kit_proc_chains.items()
                },
            ),
            dissolves=union(kit_dissolves),
            glows=union(kit_glows),
            shadowies=union(kit_shadowies),
            screens=union(kit_screens),
            ghost_mats=members(kit_procedures, procs.ghost_mats),
            tints=members(kit_procedures, procs.tints),
            desats=members(kit_procedures, procs.desats),
            transps=members(kit_procedures, procs.transps),
            freezes={kit for kit, procedures in kit_procedures.items() if procedures & procs.freezes},
            camos={kit for kit, procedures in kit_procedures.items() if procedures & procs.camos},
        )
        for kit, procedures in kit_procedures.items():
            for procedure in procedures:
                if pairs := procs.anims.get(procedure):
                    kits.anims.setdefault(kit, set()).update(pairs)
        return kits


def union[T](*buckets: Mapping[int, Iterable[T]]) -> dict[int, set[T]]:
    """Several kit-keyed buckets as one, each kit's sets unioned."""
    merged: dict[int, set[T]] = {}
    for bucket in buckets:
        for kit, held in bucket.items():
            merged.setdefault(kit, set()).update(held)
    return merged


def resolved[T](bucket: Mapping[int, Iterable[int]], through: Mapping[int, T]) -> dict[int, set[T]]:
    """Each kit's ids mapped through a payload table, the ids it lacks dropped."""
    found = {kit: {through[held] for held in ids if held in through} for kit, ids in bucket.items()}
    return {kit: payloads for kit, payloads in found.items() if payloads}


def members(bucket: Mapping[int, Iterable[int]], of: Mapping[int, object]) -> dict[int, set[int]]:
    """Each kit's ids that a payload table holds: the second dispatch is a membership test."""
    found = {kit: {held for held in ids if held in of} for kit, ids in bucket.items()}
    return {kit: ids for kit, ids in found.items() if ids}
