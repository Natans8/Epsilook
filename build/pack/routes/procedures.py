"""Character procedures: one table, many meanings, chosen by its Type.

Type is the client's character procedure index: it selects both the handler and
which of the four generic `Value` columns carries the payload, so reading a
`Value` before the Type reads a colour as a model id. Each bucket is declared
as the rows of one Type and the column that Type reads. The types are declared
with their decodes in `enums/spell_procedural_effect_types.json`.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..sources import enum_id_where, enum_ids_where, load_local_enum
from .colors import RGB_MASK
from .flow import Cell, number_of
from .models import AttachModel

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

    chains: Mapping[int, int] = field(default_factory=dict)
    """Procedure -> the chain effect it plays."""
    tints: Mapping[int, int] = field(default_factory=dict)
    """Procedure -> the packed colour it multiplies the model by."""
    ghost_mats: Mapping[int, int] = field(default_factory=dict)
    """Procedure -> the packed colour of its ghost recolour."""
    desats: Mapping[int, int] = field(default_factory=dict)
    """Procedure -> how far it drains the colour, as a percentage."""
    transps: Mapping[int, int] = field(default_factory=dict)
    """Procedure -> how transparent it makes the model, as a percentage."""
    freezes: set[int] = field(default_factory=set)
    """Procedures that freeze the character in place. Valueless."""
    camos: set[int] = field(default_factory=set)
    """Procedures that hide the character. Valueless."""
    ground: Mapping[int, AttachModel] = field(default_factory=dict)
    """Procedure -> the ground model it puts on screen."""
    trails: Mapping[int, AttachModel] = field(default_factory=dict)
    """Procedure -> the weapon trail it draws."""
    anims: Mapping[int, tuple[tuple[int, int], ...]] = field(default_factory=dict)
    """Procedure -> the (base, replacement) animation pairs it swaps in."""


# The readers a cell goes through on its way into a bucket.


def tint(kind: int, base: int, material: int) -> int:
    """A tint's packed colour, from whichever value column its Type reads.

    A colourless tint folds in as black, deliberately unlike the ghost case:
    black is a tint that multiplies the model to darkness.
    """
    return (material if kind == PROC_TYPE_TINT_MAT else base) & RGB_MASK


def percent(cell: Cell) -> int:
    """A 0..1 strength column as a whole percentage."""
    return round(number_of(cell) * 100)


def standwalk(*replacements: int) -> tuple[tuple[int, int], ...]:
    """The (base, replacement) pairs a stand/walk procedure swaps in, a slot
    it leaves alone contributing none."""
    return tuple((base, swapped) for base, swapped in zip(PROC_STANDWALK_SLOTS, replacements) if swapped > 0)
