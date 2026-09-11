"""Every route that ends in a model file, and the categories they land in.

Seven ways a spell puts geometry on screen -- attached model, projectile,
ground model, weapon trail, barrage volley, creature display, held item --
sharing only a file id and a category word. The category says which id space a
row's `ref` is in, so a display id and an item id can share one field.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from math import degrees
from typing import NamedTuple

from ..sources import enum_id_where, load_local_enum
from .attachments import NO_ATTACHMENT, NO_MOTION
from .columns import to_float, to_int
from .creatures import CreatureModels
from .flow import Cell, key_of
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


class EffectName(NamedTuple):
    """`SpellVisualEffectName` as the columns every model route reads from it.

    The Type says how to reach the model: a file, an item id, a creature
    display id, or a weapon slot.
    """

    file: int
    """The model file it names, or 0."""
    type: int
    """How to reach the model at all."""
    generic: int
    """The item or creature display its Type points at."""
    built: int
    """The size the model itself is, in `SCALE_UNIT`s.

    Apart from the scale an attachment asks for, and not folded into it: this
    is what the model is drawn at before anything places it, and how the two
    combine is a question about the client rather than about the data. A fifth
    of attached rows ask for no scale at all while naming a model whose own is
    not one, so reading the attachment's alone reports them as unscaled.
    """


def ground_model(cell: Cell) -> AttachModel:
    """A resolved area-model file as the ground model a kit or a procedure puts on screen."""
    return AttachModel(key_of(cell), MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT)


def trail_model(cell: Cell) -> AttachModel:
    """A resolved trail file as the weapon trail a procedure draws."""
    return AttachModel(key_of(cell), MODEL_CAT_TRAIL, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT)


def barrage_model(file: int, attachment: int) -> AttachModel:
    """A barrage as the model it volleys copies of, spawned where on the
    caster its row says. The count and cone columns describe the spread and
    nothing renders them."""
    return AttachModel(file, MODEL_CAT_BARRAGE, attachment, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT)


def without_placeholders(
    names: Mapping[int, EffectName], named: Callable[[set[int]], set[int]]
) -> dict[int, EffectName]:
    """The effect names with the Classic placeholder file dropped to nought.

    `named` narrows file ids to those naming a real asset, and is asked once
    in bulk. An unnamed file id on a weapon row is the placeholder, and is
    rewritten to 0 so every route downstream takes its existing no-file
    branch; only weapon rows are touched.
    """
    weapon_files = {name.file for name in names.values() if name.file and name.type in EFFECT_NAME_TYPE_WEAPON}
    placeholders = weapon_files - named(weapon_files) if weapon_files else set()
    return {
        name_id: name._replace(file=0) if name.file in placeholders and name.type in EFFECT_NAME_TYPE_WEAPON else name
        for name_id, name in names.items()
    }


def file_for_effect_name(names: Mapping[int, EffectName], name_id: int) -> int:
    """The model file an effect-name row resolves to, or 0 if it reaches none.

    A row with no file may still name a weapon SLOT, which resolves to the
    sentinel standing in for the caster's own weapon. Both the attached-model
    route and the missile route need that fallback, so it lives here rather
    than being decided twice.
    """
    name = names.get(name_id)
    if name is None:
        return 0
    return name.file or EFFECT_NAME_TYPE_WEAPON.get(name.type, 0)


class AttachRow(NamedTuple):
    """One `SpellVisualKitModelAttach` row: which kit, through which effect
    name, at which attachment, placed how."""

    kit: int
    name: int
    attachment: int
    placement: Placement

    @classmethod
    def of(cls, kit: int, name: int, attachment: int, *placed: str) -> AttachRow:
        """A row from its three ids and its `PLACEMENT_COLUMNS`, in that order."""
        return cls(kit, name, attachment, read_placement(placed))


@dataclass
class KitAttachments:
    """What the attach table gives each kit: models, and the animations they play."""

    models: dict[int, set[AttachModel]] = field(default_factory=dict)
    """Kit -> the models it attaches to a unit.

    The attachment is part of the key, so the same model at two points stays
    two rows. `ref` is the entity the model came from and the category says
    which id space that is in; `motion` belongs to missiles alone.
    """

    anims: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the animations the attached model plays.

    Indexed even when the model did not resolve, because the spell still
    plays them: they answer what a spell plays rather than which of its
    models plays it.
    """

    animkits: dict[int, set[int]] = field(default_factory=dict)
    """Kit -> the anim kits the attached model plays."""

    @classmethod
    def assemble(
        cls, rows: Iterable[AttachRow], names: Mapping[int, EffectName], creatures: CreatureModels, items: ItemModels
    ) -> KitAttachments:
        """Resolve each row's model through its effect name's Type."""
        found = cls()
        for row in rows:
            if (model := attached_model(row, names, creatures, items)) is not None:
                found.models.setdefault(row.kit, set()).add(model)
            placed = row.placement
            if played := {value for value in (placed.arrives, placed.held, placed.goes) if value}:
                found.anims.setdefault(row.kit, set()).update(played)
            if placed.animkit:
                found.animkits.setdefault(row.kit, set()).add(placed.animkit)
        return found


def attached_model(
    row: AttachRow, names: Mapping[int, EffectName], creatures: CreatureModels, items: ItemModels
) -> AttachModel | None:
    """One attach row as a model, or None if it reached none.

    The effect-name's Type picks between four sources of the file id. The
    placement rides whichever it picks, because it is a property of the row and
    not of the table the file came from.
    """
    name = names.get(row.name, EffectName(0, 0, 0, SCALE_UNIT))
    if name.type == EFFECT_NAME_TYPE_DISPLAY:
        # Resolving a creature display is pure client data, so it works on the
        # builds with no server dump.
        file = creatures.fid_for_display(name.generic)
        category, ref = MODEL_CAT_DISPLAY, name.generic
    elif name.type == EFFECT_NAME_TYPE_ITEM:
        # The row keeps the item as its ref even when the item has no name.
        file = items.models.get(name.generic, 0)
        category, ref = MODEL_CAT_ITEM, name.generic
    else:
        file = file_for_effect_name(names, row.name)
        category, ref = MODEL_CAT_ATTACH, 0
    if not file:
        return None
    return AttachModel(
        file, category, row.attachment, NO_ATTACHMENT, ref, NO_MOTION, row.placement, name.built, row.name
    )


def built_size(text: str) -> int:
    """An effect name's own scale column, in `SCALE_UNIT`s."""
    return _fixed(text, SCALE_UNIT)
