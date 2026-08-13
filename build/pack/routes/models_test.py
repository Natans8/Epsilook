"""The four ways an effect-name reaches a model, and the one that reaches none."""

from __future__ import annotations

from .conftest import BuildTables
from .creatures import CreatureModels
from .items import ItemModels
from .models import (MODEL_CAT_ATTACH, MODEL_CAT_DISPLAY, MODEL_CAT_ITEM,
                     WEAPON_FID_MAIN, WEAPON_FID_OFF, read_effect_names,
                     read_model_sources)
from .attachments import NO_ATTACHMENT, NO_MOTION

# Type 0 names a file, 1 an item, 2 a creature display, 3/4 a weapon slot.
# Name 5 is a weapon row whose file id names nothing -- the Classic placeholder.
SPELL_VISUAL_EFFECT_NAME = """\
ID,ModelFileDataID,Type,GenericID
1,8000,0,0
2,0,1,700
3,0,2,50
4,0,3,0
5,6666,4,0
6,8000,0,0
"""

SPELL_VISUAL_KIT_MODEL_ATTACH = """\
ParentSpellVisualKitID,SpellVisualEffectNameID,AttachmentID,StartAnimID,AnimID,EndAnimID,AnimKitID
900,1,5,0,17,-1,0
900,1,11,0,0,0,42
901,2,5,0,0,0,0
902,3,5,0,0,0,0
903,4,5,0,0,0,0
904,5,5,0,0,0,0
0,1,5,0,0,0,0
"""

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
ITEMS = ItemModels(model_fid={700: 8200})


def all_named(files: set[int]) -> set[int]:
    """Every file id names a real asset."""
    return files


def none_named(files: set[int]) -> set[int]:
    """File id 6666 is the Classic placeholder and names nothing."""
    return {file for file in files if file != 6666}


def sources(tables: BuildTables, named=none_named):
    return read_model_sources(
        tables(SpellVisualEffectName=SPELL_VISUAL_EFFECT_NAME,
               SpellVisualKitModelAttach=SPELL_VISUAL_KIT_MODEL_ATTACH,
               SpellVisualKitAreaModel=SPELL_VISUAL_KIT_AREA_MODEL,
               SpellEffectEmission=SPELL_EFFECT_EMISSION,
               BarrageEffect=BARRAGE_EFFECT,
               WeaponTrail=WEAPON_TRAIL),
        CREATURES, ITEMS, named)


def test_a_plain_row_attaches_its_own_file(tables: BuildTables) -> None:
    assert (8000, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION) \
        in sources(tables).attach_models[900]


def test_the_attachment_is_part_of_the_key(tables: BuildTables) -> None:
    """⛔ The same model at two points stays two rows and renders as two pills,
    rather than merging into one that cannot say where it played."""
    assert sources(tables).attach_models[900] == {
        (8000, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION),
        (8000, MODEL_CAT_ATTACH, 11, NO_ATTACHMENT, 0, NO_MOTION),
    }


def test_an_item_row_carries_the_item_as_its_ref(tables: BuildTables) -> None:
    """The category is what says which id space the ref is in, so a display id
    and an item id can share one field."""
    assert sources(tables).attach_models[901] == {
        (8200, MODEL_CAT_ITEM, 5, NO_ATTACHMENT, 700, NO_MOTION)}


def test_a_display_row_resolves_through_the_creature_chain(
        tables: BuildTables) -> None:
    """Pure client data, so it works on the builds with no server dump."""
    assert sources(tables).attach_models[902] == {
        (8100, MODEL_CAT_DISPLAY, 5, NO_ATTACHMENT, 50, NO_MOTION)}


def test_a_weapon_row_with_no_file_becomes_its_slot_sentinel(
        tables: BuildTables) -> None:
    assert sources(tables).attach_models[903] == {
        (WEAPON_FID_MAIN, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION)}


def test_an_unnamed_weapon_file_is_dropped_to_its_sentinel(
        tables: BuildTables) -> None:
    """⛔ The Classic placeholder: a file id on a weapon row that names no real
    asset. Rewriting it to 0 where the column is read leaves every route
    downstream to take the branch it already has."""
    assert sources(tables).attach_models[904] == {
        (WEAPON_FID_OFF, MODEL_CAT_ATTACH, 5, NO_ATTACHMENT, 0, NO_MOTION)}


def test_a_named_file_on_a_weapon_row_is_left_alone(tables: BuildTables) -> None:
    """The drop is about files that name nothing, not about weapon rows."""
    fid, _, _ = read_effect_names(
        tables(SpellVisualEffectName=SPELL_VISUAL_EFFECT_NAME), all_named)
    assert fid[5] == 6666


def test_a_plain_row_sharing_the_placeholder_file_keeps_its_model(
        tables: BuildTables) -> None:
    """Only weapon rows are touched. A Type-0 row naming the same file id is an
    ordinary model and stays one."""
    text = SPELL_VISUAL_EFFECT_NAME + "7,6666,0,0\n"
    fid, _, _ = read_effect_names(tables(SpellVisualEffectName=text), none_named)
    assert fid[5] == 0
    assert fid[7] == 6666


def test_a_kit_of_zero_is_skipped(tables: BuildTables) -> None:
    assert 0 not in sources(tables).attach_models


def test_the_attached_models_animations_are_indexed(tables: BuildTables) -> None:
    """They are ordinary animation ids the kit plays, so they land even when the
    model itself did not resolve. Stand and unset are both skipped."""
    assert sources(tables).attach_anims == {900: {17}}
    assert sources(tables).attach_animkits == {900: {42}}


def test_an_emission_resolves_to_its_area_model(tables: BuildTables) -> None:
    assert sources(tables).emission_fid == {300: 8300, 301: 0}


def test_a_barrage_resolves_through_the_effect_name(tables: BuildTables) -> None:
    resolved = sources(tables)
    assert resolved.barrage_fid == {400: 8000, 401: 0}
    assert resolved.barrage_attach == {400: 3, 401: -1}


def test_a_weapon_trail_carries_its_file_directly(tables: BuildTables) -> None:
    assert sources(tables).weapontrail_fid == {500: 8400}
