"""The four ways an effect-name reaches a model, and the one that reaches none."""

from __future__ import annotations

from collections.abc import Callable

from pack.routes.attachments import NO_ATTACHMENT, NO_MOTION
from pack.routes.creatures import CreatureModels
from pack.routes.items import ItemModels
from pack.routes.models import (
    MODEL_CAT_ATTACH,
    MODEL_CAT_DISPLAY,
    MODEL_CAT_ITEM,
    SCALE_UNIT,
    UNPLACED,
    WEAPON_FID_MAIN,
    WEAPON_FID_OFF,
    AttachModel,
    KitAttachments,
    Placement,
    barrage_model,
    ground_model,
)
from pack.sources.gobs import read_gob_displays
from support import BuildTables, resolve

# Type 0 names a file, 1 an item, 2 a creature display, 3/4 a weapon slot.
# Name 5 is a weapon row whose file id names nothing -- the Classic placeholder.
# Name 1's model is built at half size, which is the case an attachment asking
# for no scale of its own would otherwise report as unscaled.
SPELL_VISUAL_EFFECT_NAME = """\
ID,ModelFileDataID,Type,GenericID,Scale
1,8000,0,0,0.5
2,0,1,700,1
3,0,2,50,1
4,0,3,0,1
5,6666,4,0,1
6,8000,0,0,1
"""

BUILT_HALF = 500
"""Name 1's own size, in `SCALE_UNIT`s."""

# Kit 900's first row carries a placement worth reading back: a scale, an offset
# holding a thousandth and a negative, a yaw written one step off a right angle,
# and an end animation the table spells as -1. Its second row leaves Scale empty,
# which is the case a native size has to survive.
SPELL_VISUAL_KIT_MODEL_ATTACH = """\
ParentSpellVisualKitID,SpellVisualEffectNameID,AttachmentID,StartAnimID,AnimID,\
EndAnimID,AnimKitID,Scale,Offset_0,Offset_1,Offset_2,Yaw,Pitch,Roll
900,1,5,0,17,-1,0,1.5,0.035,-5,3,1.5708,0,0
900,1,11,0,0,0,42,,0,0,0,0,0,0
901,2,5,0,0,0,0,1,0,0,0,0,0,0
902,3,5,0,0,0,0,1,0,0,0,0,0,0
903,4,5,0,0,0,0,1,0,0,0,0,0,0
904,5,5,0,0,0,0,1,0,0,0,0,0,0
0,1,5,0,0,0,0,1,0,0,0,0,0,0
"""

PLACED = Placement(scale=1500, offset=(35, -5000, 3000), rotation=(900, 0, 0), arrives=0, held=17, goes=0, animkit=0)
"""What kit 900's first row means once read."""

WORN = Placement(scale=SCALE_UNIT, offset=(0, 0, 0), rotation=(0, 0, 0), arrives=0, held=0, goes=0, animkit=42)
"""Its second row: no scale written, so native size, and an anim kit."""

SPELL_VISUAL_KIT_AREA_MODEL = """\
ID,ModelFileDataID
200,8300
"""

SPELL_EFFECT_EMISSION = """\
ID,AreaModelID
300,200
301,999
"""

BARRAGE_EFFECT = """\
ID,SpellVisualEffectNameID,AttachmentPoint
400,1,3
401,99,-1
"""

WEAPON_TRAIL = """\
ID,FileDataID
500,8400
"""

CREATURES = CreatureModels(display_model={50: 900}, model_fid={900: 8100})
ITEMS = ItemModels(models={700: 8200})


def all_named(files: set[int]) -> set[int]:
    """Every file id names a real asset."""
    return files


def none_named(files: set[int]) -> set[int]:
    """File id 6666 is the Classic placeholder and names nothing."""
    return {file for file in files if file != 6666}


def attachments(tables: BuildTables, named: Callable[[set[int]], set[int]] = none_named) -> KitAttachments:
    found = resolve(
        "attachments",
        tables(SpellVisualEffectName=SPELL_VISUAL_EFFECT_NAME, SpellVisualKitModelAttach=SPELL_VISUAL_KIT_MODEL_ATTACH),
        named=named,
        creatures=CREATURES,
        items=ITEMS,
    )
    if not isinstance(found, KitAttachments):
        raise TypeError("the attachments field is the kit attachment record")
    return found


def file_of(tables: BuildTables, text: str, named: Callable[[set[int]], set[int]]) -> dict[int, int]:
    """Each effect name's file, once the placeholder rule has run."""
    names = resolve("effect_names", tables(SpellVisualEffectName=text), named=named)
    assert isinstance(names, dict)
    return {name_id: name.file for name_id, name in names.items()}


def test_a_plain_row_attaches_its_own_file(tables: BuildTables) -> None:
    assert (
        AttachModel(8000, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION, PLACED, BUILT_HALF, 1)
        in attachments(tables).models[900]
    )


def test_the_attachment_is_part_of_the_key(tables: BuildTables) -> None:
    """The same model at two points stays two rows."""
    assert attachments(tables).models[900] == {
        AttachModel(8000, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION, PLACED, BUILT_HALF, 1),
        AttachModel(8000, MODEL_CAT_ATTACH, 11, NO_ATTACHMENT, 0, NO_MOTION, WORN, BUILT_HALF, 1),
    }


def test_an_item_row_carries_the_item_as_its_ref(tables: BuildTables) -> None:
    """The category says which id space the ref is in."""
    assert attachments(tables).models[901] == {
        AttachModel(8200, MODEL_CAT_ITEM, 5, NO_ATTACHMENT, 700, NO_MOTION, UNPLACED, SCALE_UNIT, 2)
    }


def test_a_display_row_resolves_through_the_creature_chain(tables: BuildTables) -> None:
    """Pure client data, so it works without a server dump."""
    assert attachments(tables).models[902] == {
        AttachModel(8100, MODEL_CAT_DISPLAY, 5, NO_ATTACHMENT, 50, NO_MOTION, UNPLACED, SCALE_UNIT, 3)
    }


def test_a_weapon_row_with_no_file_becomes_its_slot_sentinel(tables: BuildTables) -> None:
    assert attachments(tables).models[903] == {
        AttachModel(WEAPON_FID_MAIN, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT, 4)
    }


def test_an_unnamed_weapon_file_is_dropped_to_its_sentinel(tables: BuildTables) -> None:
    """The Classic placeholder: a file id on a weapon row naming no real
    asset."""
    assert attachments(tables).models[904] == {
        AttachModel(WEAPON_FID_OFF, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION, UNPLACED, SCALE_UNIT, 5)
    }


def test_a_named_file_on_a_weapon_row_is_left_alone(tables: BuildTables) -> None:
    """The drop is about files that name nothing, not about weapon rows."""
    assert file_of(tables, SPELL_VISUAL_EFFECT_NAME, all_named)[5] == 6666


def test_a_plain_row_sharing_the_placeholder_file_keeps_its_model(tables: BuildTables) -> None:
    """Only weapon rows are touched."""
    files = file_of(tables, SPELL_VISUAL_EFFECT_NAME + "7,6666,0,0,1\n", none_named)
    assert files[5] == 0
    assert files[7] == 6666


def test_a_kit_of_zero_is_skipped(tables: BuildTables) -> None:
    assert 0 not in attachments(tables).models


def test_the_attached_models_animations_are_indexed(tables: BuildTables) -> None:
    """Ordinary animation ids the kit plays, so they land even when the model
    did not resolve. Stand and unset are both skipped."""
    assert attachments(tables).anims == {900: {17}}
    assert attachments(tables).animkits == {900: {42}}


def test_an_unwritten_scale_is_native_size(tables: BuildTables) -> None:
    """Nought is not a size anything is drawn at, so an empty cell cannot read
    as one: it would draw every attached model at nothing, which looks like a
    rendering fault rather than a decoding one.
    """
    worn = next(row.placement for row in attachments(tables).models[900] if row.source == 11)
    assert worn.scale == SCALE_UNIT


def test_a_model_carries_the_size_it_was_built_at(tables: BuildTables) -> None:
    """Apart from the size the attachment asks for, because the two answer
    different questions and how the client combines them is not a fact this
    data holds. Kit 900's second row asks for no scale at all and its model is
    half size anyway -- reading the attachment's alone calls that unscaled.
    """
    worn = next(row for row in attachments(tables).models[900] if row.source == 11)
    assert worn.placement.scale == SCALE_UNIT, "the attachment asks for nothing"
    assert worn.built == BUILT_HALF, "and the model is half size regardless"


def test_an_emission_resolves_to_its_area_model(tables: BuildTables) -> None:
    """An emitter naming an area model this build lacks reaches no model and
    is absent, since a file of nought draws nothing."""
    found = resolve(
        "emissions",
        tables(SpellEffectEmission=SPELL_EFFECT_EMISSION, SpellVisualKitAreaModel=SPELL_VISUAL_KIT_AREA_MODEL),
    )
    assert found == {300: ground_model("8300")}


def test_a_barrage_resolves_through_the_effect_name(tables: BuildTables) -> None:
    found = resolve("barrages", tables(BarrageEffect=BARRAGE_EFFECT, SpellVisualEffectName=SPELL_VISUAL_EFFECT_NAME))
    assert found == {400: barrage_model(8000, 3)}


def test_a_weapon_trail_carries_its_file_directly(tables: BuildTables) -> None:
    assert resolve("weapon_trails", tables(WeaponTrail=WEAPON_TRAIL)) == {500: 8400}


# The gameobject-display route: a vendored table from a private server's own
# client, so these check the shape and the sign rather than any game data.
def test_a_model_gets_the_id_the_spawn_command_takes() -> None:
    """Verified in game: -192 places the Elwynn campfire, -9471 a map table."""
    displays = read_gob_displays()
    assert displays[189705] == -192
    assert displays[195620] == -9471


def test_every_display_is_negative() -> None:
    """The command reads the sign. A positive number is a gameobject_template
    entry, which is a different object, so a stray positive would silently
    place the wrong thing rather than fail.
    """
    displays = read_gob_displays()
    assert displays
    assert all(v < 0 for v in displays.values())


def test_a_model_without_a_display_is_absent_rather_than_zero() -> None:
    """Creature and item models from late expansions have no display; the
    reader omits them so the caller decides what a miss means.
    """
    displays = read_gob_displays()
    assert 1738226 not in displays  # babyturtle.m2, checked in game
