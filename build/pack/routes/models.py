"""Every route that ends in a model file, and the categories they land in.

Seven ways a spell puts geometry on screen -- attached model, projectile,
ground model, weapon trail, barrage volley, creature display, held item --
sharing only a file id and a category word. The category says which id space a
row's `ref` is in, so a display id and an item id can share one field.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from math import degrees
from typing import NamedTuple

from ..sources import enum_id_where, load_local_enum
from ..tables import Tables
from .attachments import NO_ATTACHMENT, NO_MOTION
from .columns import to_float, to_int
from .creatures import CreatureModels
from .items import ItemModels

MODEL_CAT_ATTACH = 0
MODEL_CAT_MISSILE = 1
MODEL_CAT_AREA = 2
MODEL_CAT_TRAIL = 3
MODEL_CAT_BARRAGE = 4
MODEL_CAT_DISPLAY = 5
MODEL_CAT_ITEM = 6

MODEL_CAT_NAMES = {
    # Attach models have no category word; the target icon says which unit. An
    # empty name tells the frontend to render loose pills with no head.
    MODEL_CAT_ATTACH: "",
    MODEL_CAT_MISSILE: "missile",
    # "ground", not "area": the target vocabulary already spends "area".
    MODEL_CAT_AREA: "ground",
    MODEL_CAT_TRAIL: "trail",
    MODEL_CAT_BARRAGE: "barrage",
    # "display", not "creature": these files live under creature/, so by the
    # filename-substring rule "creature" would match much of the corpus.
    MODEL_CAT_DISPLAY: "display",
    MODEL_CAT_ITEM: "item",
}
"""Category -> the word it answers to in search and renders under."""

_EFFECT_NAME_TYPES = load_local_enum("spell_visual_effect_name_types")
EFFECT_NAME_TYPE_DISPLAY = enum_id_where(_EFFECT_NAME_TYPES, "display")
EFFECT_NAME_TYPE_ITEM = enum_id_where(_EFFECT_NAME_TYPES, "item")

# Sentinel file ids for a model whose file is whatever the caster already has.
# One per slot rather than per weapon type: the types that repeat a slot differ
# only in which item the client picks, which a pill cannot show.
WEAPON_FID_MAIN = -1
WEAPON_FID_OFF = -2
WEAPON_FID_RANGED = -3
WEAPON_FID_AMMO = -4
_WEAPON_SLOT_FID = {
    "main hand": WEAPON_FID_MAIN,
    "off hand": WEAPON_FID_OFF,
    "ranged": WEAPON_FID_RANGED,
    "ammo": WEAPON_FID_AMMO,
}
EFFECT_NAME_TYPE_WEAPON = {
    type_id: _WEAPON_SLOT_FID[value["slot"]]
    for type_id, value in _EFFECT_NAME_TYPES.items()
    if isinstance(value, dict) and value.get("handler") == "weapon"
}
"""Effect-name Type -> the sentinel file id standing in for the caster's own
weapon, for the types that name a slot instead of a file."""

SYNTHETIC_MODEL_FILES = {
    WEAPON_FID_MAIN: "equipped main hand",
    WEAPON_FID_OFF: "equipped off hand",
    WEAPON_FID_RANGED: "equipped ranged",
    WEAPON_FID_AMMO: "equipped ammo",
}
"""A sentinel's stand-in file name, so nothing downstream special-cases it.

Every label opens with `equipped`, a word no real model path carries, so the
markers are findable as a set by ordinary filename matching.
"""

SCALE_UNIT = 1000
"""Stored units per whole factor: a scale of 1.0 ships as 1000."""

OFFSET_UNIT = 1000
"""Stored units per yard: an offset of 0.035 yards ships as 35."""

ROTATION_UNIT = 10
"""Stored units per degree: a rotation of 90 degrees ships as 900."""


class Placement(NamedTuple):
    """How an attached model sits against the attachment it hangs from.

    Fixed-point integers rather than the floats the game data holds, because a
    whole-number column is what both readers are fastest at: the browser reads
    a dense integer column, and the addon reads one as a fixed-stride slice
    instead of as indexed text. The scales live in this module's constants and
    the reader's own types carry the matching display factors, the way a
    duration is stored in milliseconds and shown in seconds.

    The rounding is deliberate and not free. Rotations are exact -- they are
    authored in whole degrees and stored in radians, so tenths of a degree both
    hold every value and drop the float32 round-trip noise that makes a right
    angle arrive as 90.000207. Offsets are not: a few are authored as binary or
    rational fractions, and 9/16 and one third have no exact form at any fixed
    scale. Their residue is under a millimetre.
    """

    scale: int
    """Thousandths of the model's native size. 1000 is unscaled."""

    offset: tuple[int, int, int]
    """Thousandths of a yard from the attachment point, forward, left and up.

    The frame is the attachment's own. For a model's base position it is the
    model's, which is what makes the words for these axes honest there.
    """

    rotation: tuple[int, int, int]
    """Tenths of a degree of yaw, pitch and roll."""

    arrives: int
    """The animation it plays once as it appears, or zero."""

    held: int
    """The animation it plays for as long as it is on the unit, or zero."""

    goes: int
    """The animation it plays once as it leaves, or zero."""

    animkit: int
    """The anim kit it plays instead of a single animation, or zero."""


UNPLACED = Placement(scale=SCALE_UNIT, offset=(0, 0, 0), rotation=(0, 0, 0), arrives=0, held=0, goes=0, animkit=0)
"""A model drawn where its attachment puts it, at native size.

Every category but the attached ones reaches its model through a table with no
placement columns at all, so they take this rather than each inventing a
neutral of their own.
"""


@dataclass(frozen=True)
class AttachModel:
    """One model a kit puts on a unit, and everything the row says about it.

    Named rather than a bare tuple because almost every field is a number, so a
    positional mistake is a value landing in a neighbour that accepts it -- a
    reference read as a motion, and nothing raising. Frozen, so it stays
    hashable for the per-kit sets.

    What identity means here is a decision rather than a default. A row is what
    the client draws, so two rows drawing the same model at the same place with
    the same placement are one row, even when they were reached through
    different effect names -- which happens on 334 rows at 9.2.7. Keeping the
    effect out of the comparison is what holds that collapse in place; putting
    it back in would split those rows and show a spell two identical pills.
    """

    file: int
    """The asset the row draws, whichever table it was reached through."""

    category: int
    """Which id space `ref` is in, and which word the row renders under."""

    source: int
    """Where on the unit the model attaches."""

    destination: int
    """Where it attaches at the far end, for the rows that span two points."""

    ref: int
    """The entity the model came from, read in `category`'s id space."""

    motion: int
    """How it travels, for the rows that move."""

    placement: Placement
    """Scale, offset, rotation and animation: how the row places the model."""

    built: int
    """The size the model itself is, before the row's own scale applies."""

    effect: int = field(default=0, compare=False)
    """The `SpellVisualEffectName` row the model was reached through, or zero.

    Carried so a name recovered from an older client can find the row that
    wears it. Only the routes that go through the effect-name table have one:
    an area model, a weapon trail and a barrage volley carry their file
    directly, and giving them a borrowed id would name them after something
    they never touched.

    `compare=False` is the whole of the identity decision above: the effect
    rides the row without defining it, so rows that differ in nothing else
    still collapse and the first one read keeps its name. Table order decides
    which that is, and table order is deterministic, so the build stays
    reproducible.

    It defaults because the five routes without one should not have to say so.
    """


PLACEMENT_COLUMNS = (
    "Scale",
    "Offset_0",
    "Offset_1",
    "Offset_2",
    "Yaw",
    "Pitch",
    "Roll",
    "StartAnimID",
    "AnimID",
    "EndAnimID",
    "AnimKitID",
)
"""The placement columns of `SpellVisualKitModelAttach`, in reading order.

`read_placement` unpacks this positionally, so the two are two declarations
that can drift: reorder either and every value lands in the wrong field, with a
yaw read as a scale and nothing raising, since all eleven are numbers. They are
kept adjacent so a reader editing one sees the other, and the model fixture
gives each column a value distinct enough that a swap moves an assertion.
"""


def _fixed(text: str, unit: int) -> int:
    """A float column as fixed-point, to the nearest stored unit."""
    return round(to_float(text) * unit)


def _scaled(text: str) -> int:
    """An ATTACHMENT's scale column, where an empty cell means native size.

    No build has an attach row whose scale is nought, so nought here can only
    have come from a cell with nothing in it -- and reading that as written
    would draw the model at nothing, which is the kind of wrong that looks like
    a rendering bug rather than a decoding one.

    It is the attach column's rule and not the effect name's. That table has no
    empty cells at all and does carry a literal nought, on one row of the
    thirty-five thousand, so the same defence there would overwrite a real
    value and never once fire for the reason it exists.
    """
    return round(to_float(text) * SCALE_UNIT) or SCALE_UNIT


def _spun(text: str) -> int:
    """A rotation column -- radians in the game data -- as tenths of a degree."""
    return round(degrees(to_float(text)) * ROTATION_UNIT)


def _played(text: str) -> int:
    """An animation or anim kit id, or zero where the row plays none.

    The table spells absence two ways, `-1` unset and `0` for the Stand pose
    every model holds by default, and neither is an animation this row chose.
    """
    return max(to_int(text), 0)


def read_placement(values: Sequence[str]) -> Placement:
    """One row's `PLACEMENT_COLUMNS`, in that order, as the record they mean."""
    scale, x, y, z, yaw, pitch, roll, arrives, held, goes, kit = values
    return Placement(
        scale=_scaled(scale),
        offset=(_fixed(x, OFFSET_UNIT), _fixed(y, OFFSET_UNIT), _fixed(z, OFFSET_UNIT)),
        rotation=(_spun(yaw), _spun(pitch), _spun(roll)),
        arrives=_played(arrives),
        held=_played(held),
        goes=_played(goes),
        animkit=_played(kit),
    )


@dataclass
class ModelSources:
    """Every model-bearing table, keyed by its own row id.

    Attach models are resolved per kit because their table names the kit; the
    rest are resolved when the kit walk or a procedural row reaches them.
    """

    effect_name_fid: dict[int, int] = field(default_factory=dict)
    """SpellVisualEffectName.ID -> model file id."""

    effect_name_type: dict[int, int] = field(default_factory=dict)
    """SpellVisualEffectName.ID -> Type: how to reach the model at all."""

    effect_name_built: dict[int, int] = field(default_factory=dict)
    """SpellVisualEffectName.ID -> the size the model itself is."""

    area_model_fid: dict[int, int] = field(default_factory=dict)
    """SpellVisualKitAreaModel.ID -> model file id."""

    emission_fid: dict[int, int] = field(default_factory=dict)
    """SpellEffectEmission.ID -> the area model it spawns copies of."""

    barrage_fid: dict[int, int] = field(default_factory=dict)
    """BarrageEffect.ID -> the model the volley is made of."""

    barrage_attach: dict[int, int] = field(default_factory=dict)
    """BarrageEffect.ID -> where on the caster the volley spawns."""

    weapontrail_fid: dict[int, int] = field(default_factory=dict)
    """WeaponTrail.ID -> the trail model."""

    attach_models: dict[int, set[AttachModel]] = field(default_factory=dict)
    """Kit -> the models it attaches to a unit.

    The attachment is part of the key, so the same model at two points stays
    two rows. Routes with a single attach point put it in `source`; `ref` is
    the entity the model came from and the category says which id space that is
    in; `motion` belongs to missiles alone.
    """

    attach_anims: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the animations the attached model plays."""

    attach_animkits: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the anim kits the attached model plays."""


class EffectNames(NamedTuple):
    """`SpellVisualEffectName` as the columns every model route reads from it."""

    fid: dict[int, int]
    """Effect name -> the model file it names, or 0."""

    types: dict[int, int]
    """Effect name -> its Type, which says how to reach the model at all."""

    generic: dict[int, int]
    """Effect name -> the item or creature display its Type points at."""

    built: dict[int, int]
    """Effect name -> the size the model itself is, in `SCALE_UNIT`s.

    Apart from the scale an attachment asks for, and not folded into it: this
    is what the model is drawn at before anything places it, and how the two
    combine is a question about the client rather than about the data. A fifth
    of attached rows ask for no scale at all while naming a model whose own is
    not one, so reading the attachment's alone reports them as unscaled.
    """


def read_effect_names(tables: Tables, named: Callable[[set[int]], set[int]]) -> EffectNames:
    """`SpellVisualEffectName` as the columns the model routes read.

    The Type says how to reach the model: a file, an item id, a creature
    display id, or a weapon slot. `named` narrows file ids to those naming a
    real asset, and is asked once in bulk. An unnamed file id on a weapon row
    is the Classic placeholder and is rewritten to 0 here, so every route
    downstream takes its existing no-file branch; only weapon rows are touched.
    """
    fid: dict[int, int] = {}
    types: dict[int, int] = {}
    generic: dict[int, int] = {}
    built: dict[int, int] = {}
    for name_id, model_fid, type_id, generic_id, scale in tables.rows(
        "SpellVisualEffectName", ["ID", "ModelFileDataID", "Type", "GenericID", "Scale"]
    ):
        identifier = to_int(name_id)
        fid[identifier] = to_int(model_fid)
        types[identifier] = to_int(type_id)
        generic[identifier] = to_int(generic_id)
        built[identifier] = _fixed(scale, SCALE_UNIT)

    weapon_files = {file for name_id, file in fid.items() if file and types.get(name_id, 0) in EFFECT_NAME_TYPE_WEAPON}
    placeholders = weapon_files - named(weapon_files) if weapon_files else set()
    if placeholders:
        for effect_name, file in list(fid.items()):
            if file in placeholders and types.get(effect_name, 0) in EFFECT_NAME_TYPE_WEAPON:
                fid[effect_name] = 0
    return EffectNames(fid=fid, types=types, generic=generic, built=built)


def file_for_effect_name(models: ModelSources, name_id: int) -> int:
    """The model file an effect-name row resolves to, or 0 if it reaches none.

    A row with no file may still name a weapon SLOT, which resolves to the
    sentinel standing in for the caster's own weapon. Both the attached-model
    route and the missile route need that fallback, so it lives here rather
    than being decided twice.

    Args:
        models: the read effect-name columns.
        name_id: the `SpellVisualEffectName` row to resolve.

    Returns:
        A file id, a weapon sentinel, or 0.
    """
    if file := models.effect_name_fid.get(name_id, 0):
        return file
    return EFFECT_NAME_TYPE_WEAPON.get(models.effect_name_type.get(name_id, 0), 0)


def read_model_sources(
    tables: Tables, creatures: CreatureModels, items: ItemModels, named: Callable[[set[int]], set[int]]
) -> ModelSources:
    """Read every table that ends in a model file.

    `named` narrows a set of file ids to the ones that name a real asset.
    """
    names = read_effect_names(tables, named)
    fid, generic = names.fid, names.generic
    models = ModelSources(effect_name_fid=fid, effect_name_type=names.types, effect_name_built=names.built)

    attach_models: dict[int, set[AttachModel]] = {}
    attach_anims: dict[int, set[int]] = {}
    attach_animkits: dict[int, set[int]] = {}
    for kit_id, name_id, attach, *placed in tables.rows(
        "SpellVisualKitModelAttach",
        ["ParentSpellVisualKitID", "SpellVisualEffectNameID", "AttachmentID", *PLACEMENT_COLUMNS],
    ):
        kit = to_int(kit_id)
        if not kit:
            continue
        placement = read_placement(placed)
        row = _attached_model(to_int(name_id), to_int(attach), placement, models, creatures, items, generic)
        if row is not None:
            attach_models.setdefault(kit, set()).add(row)
        # The animations reach the anim column as well, which answers what a
        # spell plays rather than which of its models plays it. Both are wanted,
        # so the row carries them and these buckets keep them too. They are
        # indexed even when the model did not resolve, because the spell still
        # plays them.
        played = {value for value in (placement.arrives, placement.held, placement.goes) if value}
        if played:
            attach_anims.setdefault(kit, set()).update(played)
        if placement.animkit:
            attach_animkits.setdefault(kit, set()).add(placement.animkit)
    models.attach_models = attach_models
    models.attach_anims = attach_anims
    models.attach_animkits = attach_animkits

    # The area model carries its file directly, with no effect-name hop, and is
    # reached two ways: a kit's emission effect, and a procedural row.
    for area_id, model_fid in tables.rows("SpellVisualKitAreaModel", ["ID", "ModelFileDataID"]):
        models.area_model_fid[to_int(area_id)] = to_int(model_fid)
    for emission_id, area_id in tables.rows("SpellEffectEmission", ["ID", "AreaModelID"]):
        models.emission_fid[to_int(emission_id)] = models.area_model_fid.get(to_int(area_id), 0)

    # A barrage is a volley of copies of one model; the count and cone columns
    # describe the spread and nothing renders them.
    for barrage_id, name_id, attach in tables.rows(
        "BarrageEffect", ["ID", "SpellVisualEffectNameID", "AttachmentPoint"]
    ):
        models.barrage_fid[to_int(barrage_id)] = fid.get(to_int(name_id), 0)
        models.barrage_attach[to_int(barrage_id)] = to_int(attach)

    for trail_id, trail_fid in tables.rows("WeaponTrail", ["ID", "FileDataID"]):
        models.weapontrail_fid[to_int(trail_id)] = to_int(trail_fid)
    return models


def _attached_model(
    name_id: int,
    attach: int,
    placement: Placement,
    models: ModelSources,
    creatures: CreatureModels,
    items: ItemModels,
    generic: dict[int, int],
) -> AttachModel | None:
    """One `SpellVisualKitModelAttach` row as a model, or None if it reached none.

    The effect-name's Type picks between four sources of the file id. The
    placement rides whichever it picks, because it is a property of the row and
    not of the table the file came from.
    """
    name_type = models.effect_name_type.get(name_id, 0)
    built = models.effect_name_built.get(name_id, SCALE_UNIT)
    if name_type == EFFECT_NAME_TYPE_DISPLAY:
        # Resolving a creature display is pure client data, so it works on the
        # builds with no server dump.
        display = generic.get(name_id, 0)
        file = creatures.fid_for_display(display)
        return (
            AttachModel(file, MODEL_CAT_DISPLAY, attach, NO_ATTACHMENT, display, NO_MOTION, placement, built, name_id)
            if file
            else None
        )
    if name_type == EFFECT_NAME_TYPE_ITEM:
        # The row keeps the item as its ref even when the item has no name.
        item = generic.get(name_id, 0)
        file = items.model_fid.get(item, 0)
        return (
            AttachModel(file, MODEL_CAT_ITEM, attach, NO_ATTACHMENT, item, NO_MOTION, placement, built, name_id)
            if file
            else None
        )
    file = file_for_effect_name(models, name_id)
    if file:
        return AttachModel(file, MODEL_CAT_ATTACH, attach, NO_ATTACHMENT, 0, NO_MOTION, placement, built, name_id)
    return None
