"""Every route that ends in a model file, and the categories they land in.

Seven ways a spell puts geometry on the screen, and they share almost nothing
upstream: a model attached to a unit, a projectile in flight, a model laid on
the ground, a weapon trail, a barrage volley, a creature's own display, and an
item held in hand. What they share is the END -- a file id and a category word
-- so they are collected here and the differences stay in how each is reached.

The category is not decoration. It says which id space a row's `ref` is in,
so a display id and an item id can share one field instead of each adding
their own, and it is what the next Type-N route extends rather than rewrites.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from ..sources import enum_id_where, load_local_enum
from ..tables import Tables
from .attachments import NO_ATTACHMENT, NO_MOTION
from .columns import to_int
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
    # Attach models have no category word: they are the plain "this model plays
    # on a unit" case, and which unit is said by the target icon instead. An
    # empty name is the frontend's signal to render the category as loose pills
    # with no head.
    MODEL_CAT_ATTACH: "",
    MODEL_CAT_MISSILE: "missile",
    # "ground", not "area": the target vocabulary already spends "area" on a
    # different thing, and only 42% of this category's rows carry an area
    # target bit. Sharing the word made a model search silently mean the target.
    MODEL_CAT_AREA: "ground",
    MODEL_CAT_TRAIL: "trail",
    MODEL_CAT_BARRAGE: "barrage",
    # "display", not "creature": these resolve to files under creature/, so
    # "creature" collides with ~21% of the model-file corpus by the
    # filename-substring rule and would drown the category in noise. "display"
    # collides with ~0 and matches how the audience says CreatureDisplayID.
    MODEL_CAT_DISPLAY: "display",
    # "item" collides with ~4.3% of the corpus -- well under the ~21% that
    # ruled out "creature", and coherent rather than confusing, because the
    # files it also matches ARE item models.
    MODEL_CAT_ITEM: "item",
}
"""Category -> the word it answers to in search and renders under."""

_EFFECT_NAME_TYPES = load_local_enum("spell_visual_effect_name_types")
EFFECT_NAME_TYPE_DISPLAY = enum_id_where(_EFFECT_NAME_TYPES, "display")
EFFECT_NAME_TYPE_ITEM = enum_id_where(_EFFECT_NAME_TYPES, "item")

# Sentinel file ids for a model that has no file because the caster already
# owns it. One per slot, not per type: the eight weapon types make four pills,
# because 8/9/10 repeat 3/4/5 with "(ignore disarmed)" -- a visibility rule for
# a disarmed caster, not a different weapon -- and 6/7 are basic against
# preferred ammo. Both distinctions say which item the client picks, not what a
# pill can show, so they collapse.
WEAPON_FID_MAIN = -1
WEAPON_FID_OFF = -2
WEAPON_FID_RANGED = -3
WEAPON_FID_AMMO = -4
_WEAPON_SLOT_FID = {"main hand": WEAPON_FID_MAIN, "off hand": WEAPON_FID_OFF,
                    "ranged": WEAPON_FID_RANGED, "ammo": WEAPON_FID_AMMO}
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
markers are findable as a set and narrow to one slot by ordinary filename
matching. Deliberately no per-slot category word: the slots are values, and
only meta words belong in autocomplete.
"""

# (file id, category, source attachment, destination attachment, ref, motion)
AttachModel = tuple[int, int, int, int, int, int]


@dataclass
class ModelSources:
    """Every model-bearing table, keyed by its own row id.

    The attach models are resolved per kit here because their table names the
    kit directly. The rest stay keyed by their own id and are resolved when the
    kit walk or a procedural row reaches them.
    """

    effect_name_fid: dict[int, int] = field(default_factory=dict)
    """SpellVisualEffectName.ID -> model file id."""

    effect_name_type: dict[int, int] = field(default_factory=dict)
    """SpellVisualEffectName.ID -> Type: how to reach the model at all."""

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

    The attachment is part of the key, so the same model at two different
    points stays two rows and renders as two pills rather than merging: 10.5%
    of (kit, effect name) pairs carry more than one distinct attachment.

    Routes with a single attach point put it in `source` and leave `destination`
    unset; `ref` is the id of the entity the model came FROM and the category
    says which id space that is in; `motion` belongs to missiles alone and
    describes how the model TRAVELS rather than what it came from.
    """

    attach_anims: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the animations the attached model plays."""

    attach_animkits: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the anim kits the attached model plays."""


def read_effect_names(tables: Tables, named: Callable[[set[int]], set[int]]
                      ) -> tuple[dict[int, int], dict[int, int], dict[int, int]]:
    """`SpellVisualEffectName` as its three columns: file, type, and generic id.

    The Type says HOW to reach the model -- a file directly, an item id, a
    creature display id, or a weapon slot -- and only the type tells the three
    apart, because all four spellings put something in the same columns.

    The placeholder drop happens here and nowhere else. The Classic clients
    leave an unnamed file id on their weapon rows, which is not a model anyone
    can render. Rewriting it to 0 at the one place the column is read leaves
    every route downstream to take the "no file -> sentinel" branch it already
    has.

    `named` takes the whole candidate set and returns the subset that names a
    real asset. A route cannot resolve a path itself, so the question is asked
    of the caller -- and it is asked ONCE, in bulk, because the only thing that
    can answer it is a pass over an index far larger than this table.

    Only weapon rows are touched: a plain row naming the same file id keeps its
    ordinary model.
    """
    fid: dict[int, int] = {}
    types: dict[int, int] = {}
    generic: dict[int, int] = {}
    for name_id, model_fid, type_id, generic_id in tables.rows(
            "SpellVisualEffectName", ["ID", "ModelFileDataID", "Type", "GenericID"]):
        identifier = to_int(name_id)
        fid[identifier] = to_int(model_fid)
        types[identifier] = to_int(type_id)
        generic[identifier] = to_int(generic_id)

    weapon_files = {file for name_id, file in fid.items()
                    if file and types.get(name_id, 0) in EFFECT_NAME_TYPE_WEAPON}
    placeholders = weapon_files - named(weapon_files) if weapon_files else set()
    if placeholders:
        for effect_name, file in list(fid.items()):
            if file in placeholders \
                    and types.get(effect_name, 0) in EFFECT_NAME_TYPE_WEAPON:
                fid[effect_name] = 0
    return fid, types, generic


def read_model_sources(tables: Tables, creatures: CreatureModels, items: ItemModels,
                       named: Callable[[set[int]], set[int]]) -> ModelSources:
    """Read every table that ends in a model file.

    `named` narrows a set of file ids to the ones that name a real asset -- see
    `read_effect_names`, the one place it is consulted.
    """
    fid, types, generic = read_effect_names(tables, named)
    models = ModelSources(effect_name_fid=fid, effect_name_type=types)

    attach_models: dict[int, set[AttachModel]] = {}
    attach_anims: dict[int, set[int]] = {}
    attach_animkits: dict[int, set[int]] = {}
    for kit_id, name_id, attach, start, loop, end, animkit in tables.rows(
            "SpellVisualKitModelAttach",
            ["ParentSpellVisualKitID", "SpellVisualEffectNameID", "AttachmentID",
             "StartAnimID", "AnimID", "EndAnimID", "AnimKitID"]):
        kit = to_int(kit_id)
        if not kit:
            continue
        row = _attached_model(to_int(name_id), to_int(attach), models, creatures, items,
                              generic)
        if row is not None:
            attach_models.setdefault(kit, set()).add(row)
        # The start/loop/end anims animate the attached model, but they are
        # ordinary animation ids the spell's kit plays, so they are indexed even
        # when the model itself did not resolve. 0 is Stand and -1 is unset;
        # both are skipped, the same rule the animation route follows.
        played = {value for value in (to_int(start), to_int(loop), to_int(end))
                  if value > 0}
        if played:
            attach_anims.setdefault(kit, set()).update(played)
        if to_int(animkit) > 0:
            attach_animkits.setdefault(kit, set()).add(to_int(animkit))
    models.attach_models = attach_models
    models.attach_anims = attach_anims
    models.attach_animkits = attach_animkits

    # The area model carries its file directly, with no effect-name hop, and is
    # reached two ways: a kit's emission effect spawning copies of it, and a
    # procedural row naming it outright.
    for area_id, model_fid in tables.rows(
            "SpellVisualKitAreaModel", ["ID", "ModelFileDataID"]):
        models.area_model_fid[to_int(area_id)] = to_int(model_fid)
    for emission_id, area_id in tables.rows(
            "SpellEffectEmission", ["ID", "AreaModelID"]):
        models.emission_fid[to_int(emission_id)] = models.area_model_fid.get(
            to_int(area_id), 0)

    # A barrage is a volley of N copies of one model; the count and cone columns
    # describe the spread and nothing renders them. The attachment is a raw
    # point on the caster, and unset reads as no attach segment like any other.
    for barrage_id, name_id, attach in tables.rows(
            "BarrageEffect", ["ID", "SpellVisualEffectNameID", "AttachmentPoint"]):
        models.barrage_fid[to_int(barrage_id)] = fid.get(to_int(name_id), 0)
        models.barrage_attach[to_int(barrage_id)] = to_int(attach)

    for trail_id, trail_fid in tables.rows("WeaponTrail", ["ID", "FileDataID"]):
        models.weapontrail_fid[to_int(trail_id)] = to_int(trail_fid)
    return models


def _attached_model(name_id: int, attach: int, models: ModelSources,
                    creatures: CreatureModels, items: ItemModels,
                    generic: dict[int, int]) -> AttachModel | None:
    """One `SpellVisualKitModelAttach` row as a model, or None if it reached none.

    The four cases are what the effect-name's Type distinguishes, and each ends
    at a file id from a different place: a creature display resolved through the
    creature chain, an item resolved through its appearance, a plain file, or a
    weapon slot with no file at all.
    """
    name_type = models.effect_name_type.get(name_id, 0)
    if name_type == EFFECT_NAME_TYPE_DISPLAY:
        # The effect-name names a creature display rather than a file. Resolving
        # it is pure client data, so it works on the builds with no server dump,
        # and the display id is carried so the pill can name what it came from.
        display = generic.get(name_id, 0)
        file = creatures.fid_for_display(display)
        return ((file, MODEL_CAT_DISPLAY, attach, NO_ATTACHMENT, display, NO_MOTION)
                if file else None)
    if name_type == EFFECT_NAME_TYPE_ITEM:
        # The item carries its own model through the appearance chain, plus the
        # name, quality and icon the pill is built from. The row keeps the ITEM
        # as its ref even when the item has no name: a nameless item still
        # renders, just without the half of the pill a name buys.
        item = generic.get(name_id, 0)
        file = items.model_fid.get(item, 0)
        return ((file, MODEL_CAT_ITEM, attach, NO_ATTACHMENT, item, NO_MOTION)
                if file else None)
    file = models.effect_name_fid.get(name_id, 0)
    if file:
        return (file, MODEL_CAT_ATTACH, attach, NO_ATTACHMENT, 0, NO_MOTION)
    weapon_fid = EFFECT_NAME_TYPE_WEAPON.get(name_type, 0)
    if weapon_fid:
        # A weapon the caster already has, held at this point. The sentinel
        # renders as a per-slot marker pill.
        return (weapon_fid, MODEL_CAT_ATTACH, attach, NO_ATTACHMENT, 0, NO_MOTION)
    return None
