"""Character procedures: one table, many meanings, chosen by its Type.

Type is the client's character procedure index: it selects both the handler and
which of the four generic `Value` columns carries the payload, so reading a
`Value` before the Type reads a colour as a model id. Each row lands in the
bucket its type feeds. The types are declared with their decodes in
`enums/spell_procedural_effect_types.json`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..sources import enum_id_where, enum_ids_where, load_local_enum
from ..tables import Tables
from .attachments import NO_ATTACHMENT, NO_MOTION
from .colors import RGB_MASK
from .columns import to_float, to_int, to_int_from_float
from .models import MODEL_CAT_AREA, MODEL_CAT_TRAIL, SCALE_UNIT, UNPLACED, AttachModel, ModelSources

_PROC_TYPES = load_local_enum("spell_procedural_effect_types")
PROC_TYPES_CHAIN = enum_ids_where(_PROC_TYPES, "chain")
PROC_TYPE_TINT = enum_id_where(_PROC_TYPES, "tint")
PROC_TYPE_TINT_MAT = enum_id_where(_PROC_TYPES, "tint_mat")
PROC_TYPE_GHOST_MAT = enum_id_where(_PROC_TYPES, "ghost_mat")
PROC_TYPE_DESATURATE = enum_id_where(_PROC_TYPES, "desaturate")
PROC_TYPE_TRANSPARENCY = enum_id_where(_PROC_TYPES, "transparency")
PROC_TYPE_FREEZE = enum_id_where(_PROC_TYPES, "freeze")
PROC_TYPE_CAMO = enum_id_where(_PROC_TYPES, "camo")
PROC_TYPE_AREAMODEL = enum_id_where(_PROC_TYPES, "areamodel")
PROC_TYPE_WEAPONTRAIL = enum_id_where(_PROC_TYPES, "weapontrail")
PROC_TYPE_STANDWALK = enum_id_where(_PROC_TYPES, "standwalk")

PROC_STANDWALK_SLOTS = (0, 4, 5)
"""The base animation each of the stand/walk procedure's first three values
replaces: Stand, Walk, Run. The fourth value overrides no slot and is dropped."""


@dataclass
class ProcEffects:
    """Every procedure row, in the bucket its Type sent it to."""

    chain: dict[int, int] = field(default_factory=dict)
    """Procedure -> the chain effect it plays."""

    tints: dict[int, int] = field(default_factory=dict)
    """Procedure -> the packed colour it multiplies the model by."""

    ghost_mats: dict[int, int] = field(default_factory=dict)
    """Procedure -> the packed colour of its ghost recolour."""

    desats: dict[int, int] = field(default_factory=dict)
    """Procedure -> how far it drains the colour, as a percentage."""

    transps: dict[int, int] = field(default_factory=dict)
    """Procedure -> how transparent it makes the model, as a percentage."""

    freezes: set[int] = field(default_factory=set)
    """Procedures that freeze the character in place. Valueless."""

    camos: set[int] = field(default_factory=set)
    """Procedures that hide the character. Valueless."""

    models: dict[int, AttachModel] = field(default_factory=dict)
    """Procedure -> the model it puts on screen: a ground model or a trail."""

    anims: dict[int, tuple[tuple[int, int], ...]] = field(default_factory=dict)
    """Procedure -> the (base, replacement) animation pairs it swaps in."""


def read_proc_effects(tables: Tables, models: ModelSources) -> ProcEffects:
    """Read every procedure row and bucket it by what its Type means.

    A row that says nothing is dropped, and "nothing" is spelled differently
    per type. The colourless case is deliberately not uniform: a colourless
    ghost is dropped, while a colourless tint folds in as black, because black
    is a tint that multiplies the model to darkness.
    """
    procs = ProcEffects()
    for row in tables.rows("SpellProceduralEffect", ["ID", "Type", "Value_0", "Value_1", "Value_2", "Value_3"]):
        proc_id, type_id = to_int(row[0]), to_int(row[1])
        first, second, third, fourth = row[2], row[3], row[4], row[5]
        if type_id in PROC_TYPES_CHAIN:
            procs.chain[proc_id] = to_int_from_float(first)
        elif type_id == PROC_TYPE_TINT:
            procs.tints[proc_id] = to_int_from_float(first) & RGB_MASK
        elif type_id == PROC_TYPE_TINT_MAT:
            procs.tints[proc_id] = to_int_from_float(fourth) & RGB_MASK
        elif type_id == PROC_TYPE_GHOST_MAT:
            colour = to_int_from_float(fourth)
            if colour:
                procs.ghost_mats[proc_id] = colour & RGB_MASK
        elif type_id == PROC_TYPE_DESATURATE:
            percent = _to_percent(third)
            if percent > 0:
                procs.desats[proc_id] = percent
        elif type_id == PROC_TYPE_TRANSPARENCY:
            percent = _to_percent(first)
            if percent > 0:
                procs.transps[proc_id] = percent
        elif type_id == PROC_TYPE_FREEZE:
            procs.freezes.add(proc_id)
        elif type_id == PROC_TYPE_CAMO:
            procs.camos.add(proc_id)
        elif type_id == PROC_TYPE_AREAMODEL:
            file = models.area_model_fid.get(to_int_from_float(first), 0)
            if file:
                procs.models[proc_id] = AttachModel(
                    file, MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT
                )
        elif type_id == PROC_TYPE_WEAPONTRAIL:
            file = models.weapontrail_fid.get(to_int_from_float(first), 0)
            if file:
                procs.models[proc_id] = AttachModel(
                    file, MODEL_CAT_TRAIL, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT
                )
        elif type_id == PROC_TYPE_STANDWALK:
            # Paired with the base slot each value overrides, folding into the
            # same replacement group as the animation-replacement aura. A value
            # of 0 leaves its slot alone.
            pairs = tuple(
                (base, replacement)
                for base, replacement in zip(
                    PROC_STANDWALK_SLOTS, (to_int_from_float(value) for value in (first, second, third))
                )
                if replacement > 0
            )
            if pairs:
                procs.anims[proc_id] = pairs
    return procs


def _to_percent(text: str) -> int:
    """A 0..1 strength column as a whole percentage."""
    return round(to_float(text) * 100)
