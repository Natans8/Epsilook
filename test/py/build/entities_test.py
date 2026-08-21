"""Keybinds, mounts, objects and forms: what each keeps when its source is thin."""

from __future__ import annotations

from pack.drift import TDB_OPTIONAL_COLUMNS, TDB_OPTIONAL_TABLES
from pack.routes.creatures import CreatureModels
from pack.routes.gameobjects import read_gameobjects
from pack.routes.keybinds import read_keybound_overrides
from pack.routes.mounts import read_mounts
from pack.routes.shapeshifts import read_shapeshift_forms
from support import BuildTables

SPELL_KEYBOUND_OVERRIDE = """\
ID,Function,Type,Data
1,  JUMP  ,1,100
2,MOVEFORWARD,0,101
3,JUMP,7,999
"""

MOUNT = """\
ID,Name_lang,SourceSpellID
10,  Swift Ram  ,100
11,Unreachable,999
12,,101
"""

MOUNT_X_DISPLAY = """\
CreatureDisplayInfoID,MountID
50,10
51,10
52,12
"""

CREATURES = CreatureModels(display_model={50: 900, 51: 901, 52: 902},
                           model_fid={900: 8000, 901: 8001})

GAMEOBJECT_TEMPLATE = """\
entry,name,displayId,type
200,  Campfire  ,300,5
201,Unmodelled,999,3
"""

GAME_OBJECT_DISPLAY_INFO = """\
ID,FileDataID
300,8100
"""

SPELL_SHAPESHIFT_FORM = """\
ID,Name_lang,CreatureDisplayID_0,CreatureDisplayID_1,CreatureDisplayID_2,CreatureDisplayID_3
1,Bear Form,50,0,0,0
2,Shadowform,0,0,0,0
3,Two Looks,50,51,0,0
"""


def test_the_ordinary_press_gets_no_word(tables: BuildTables) -> None:
    overrides = read_keybound_overrides(
        tables(SpellKeyboundOverride=SPELL_KEYBOUND_OVERRIDE))
    assert overrides[2].when == ""
    assert overrides[1].when == "mid-air"


def test_an_unknown_type_names_its_number(tables: BuildTables) -> None:
    assert read_keybound_overrides(
        tables(SpellKeyboundOverride=SPELL_KEYBOUND_OVERRIDE))[3].when == "type 7"


def test_an_override_keeps_a_spell_this_build_does_not_ship(
        tables: BuildTables) -> None:
    assert read_keybound_overrides(
        tables(SpellKeyboundOverride=SPELL_KEYBOUND_OVERRIDE))[3].spell == 999


def test_a_mount_reaches_every_display_it_wears(tables: BuildTables) -> None:
    """Faction and gender variants, so several per mount."""
    mounts = read_mounts(tables(Mount=MOUNT, MountXDisplay=MOUNT_X_DISPLAY),
                         {100: "Summon Ram", 101: "Summon Nothing"}, CREATURES)
    assert mounts.links == [(100, 50), (100, 51), (101, 52)]


def test_a_mount_whose_spell_this_build_lacks_is_skipped(
        tables: BuildTables) -> None:
    """The spell list decides a build's population."""
    mounts = read_mounts(tables(Mount=MOUNT, MountXDisplay=MOUNT_X_DISPLAY),
                         {100: "Summon Ram", 101: "Summon Nothing"}, CREATURES)
    assert all(spell != 999 for spell, _ in mounts.links)


def test_a_mount_display_resolves_without_a_server_dump(
        tables: BuildTables) -> None:
    """Both halves are client data."""
    mounts = read_mounts(tables(Mount=MOUNT, MountXDisplay=MOUNT_X_DISPLAY),
                         {100: "Summon Ram", 101: "Summon Nothing"}, CREATURES)
    assert mounts.name[50] == "Swift Ram"
    assert mounts.fid[50] == 8000
    assert mounts.fid[52] == 0


def test_an_object_resolves_its_model_through_its_display(
        tables: BuildTables) -> None:
    objects = read_gameobjects(
        tables(GameObjectDisplayInfo=GAME_OBJECT_DISPLAY_INFO),
        tables(absent=TDB_OPTIONAL_TABLES, defaults=TDB_OPTIONAL_COLUMNS,
               gameobject_template=GAMEOBJECT_TEMPLATE))
    assert objects.name[200] == "Campfire"
    assert objects.fid == {200: 8100, 201: 0}
    assert objects.type[200] == 5


def test_without_a_server_dump_an_object_has_nothing(
        tables: BuildTables) -> None:
    """The display id the model needs is itself server-side."""
    objects = read_gameobjects(
        tables(GameObjectDisplayInfo=GAME_OBJECT_DISPLAY_INFO), None)
    assert (objects.name, objects.fid, objects.type) == ({}, {}, {})


def test_a_form_with_no_creature_keeps_its_name(tables: BuildTables) -> None:
    """Most forms are this: they change what a character can do, not how it
    looks."""
    forms = read_shapeshift_forms(tables(SpellShapeshiftForm=SPELL_SHAPESHIFT_FORM))
    assert forms.names[2] == "Shadowform"
    assert forms.displays[2] == []


def test_a_form_keeps_its_displays_in_slot_order(tables: BuildTables) -> None:
    forms = read_shapeshift_forms(tables(SpellShapeshiftForm=SPELL_SHAPESHIFT_FORM))
    assert forms.displays[3] == [50, 51]


def test_a_build_predating_the_form_table_ships_no_forms(
        tables: BuildTables) -> None:
    """Reading the header to learn the array's shape must not turn a declared
    absence into a failed build."""
    forms = read_shapeshift_forms(tables())
    assert (forms.names, forms.displays) == ({}, {})


def test_a_form_display_array_may_have_collapsed_to_a_scalar(
        tables: BuildTables) -> None:
    """The header states which spelling a build uses, so one reader serves
    both."""
    forms = read_shapeshift_forms(tables(SpellShapeshiftForm="""\
ID,Name_lang,CreatureDisplayID
1,Bear Form,50
2,Shadowform,0
"""))
    assert forms.displays == {1: [50], 2: []}
