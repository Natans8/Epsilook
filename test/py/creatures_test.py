"""The creature chain: what survives when the server dump does not."""

from __future__ import annotations

from pack.drift import TDB_OPTIONAL_COLUMNS, TDB_OPTIONAL_TABLES
from pack.routes.creatures import read_creature_models
from support import BuildTables

CREATURE_DISPLAY_INFO = """\
ID,ModelID
50,900
51,901
52,999
"""

# A client's display table carries as many texture slots as its build has;
# the pair is the first two, the unpainted third is the gap a skin can leave.
CREATURE_DISPLAY_INFO_SKINNED = """\
ID,ModelID,TextureVariationFileDataID_0,TextureVariationFileDataID_2,TextureVariationFileDataID_1
50,900,7100,0,7101
51,901,0,0,0
52,999,0,7102,7102
"""

CREATURE_MODEL_DATA = """\
ID,FileDataID
900,7000
901,7001
"""

# Two displays for one creature, out of slot order on purpose.
CREATURE_TEMPLATE_MODEL = """\
CreatureID,Idx,CreatureDisplayID
300,1,51
300,0,50
"""

CREATURE_TEMPLATE = """\
entry,name
300,  Sunwell Guardian
"""

# The legacy shape: up to four display ids as columns, position standing in for
# the slot the modern table carries.
CREATURE_TEMPLATE_LEGACY = """\
entry,name,modelid1,modelid2,modelid3,modelid4
300,Sunwell Guardian,50,0,51,0
"""


def test_a_display_resolves_through_two_hops(tables: BuildTables) -> None:
    """Several displays share one model, so the file id lives a table down."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.fid_for_display(50) == 7000
    assert creatures.fid_for_display(51) == 7001


def test_a_displays_skins_are_read_by_name_in_slot_order(tables: BuildTables) -> None:
    """The slots are found off the header and ordered by their number, so a
    build with four reads the same as one with three; a display painting
    nothing is absent rather than empty, and one texture in two slots is one
    skin."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO_SKINNED,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.display_skins == {50: (7100, 7101), 52: (7102,)}


def test_a_display_table_without_skin_columns_reads_as_unpainted(
        tables: BuildTables) -> None:
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.display_skins == {}


def test_a_display_whose_model_has_no_file_resolves_to_nothing(
        tables: BuildTables) -> None:
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.fid_for_display(52) == 0
    assert creatures.fid_for_display(999) == 0


def test_without_a_server_dump_the_models_still_resolve(tables: BuildTables) -> None:
    """Only the naming half degrades."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.names == {}
    assert creatures.displays == {}
    assert creatures.fid_for_display(50) == 7000


def test_a_name_is_trimmed(tables: BuildTables) -> None:
    """The dump reader decodes faithfully, so the trim happens in the route."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA),
        tables(creature_template=CREATURE_TEMPLATE,
               creature_template_model=CREATURE_TEMPLATE_MODEL))
    assert creatures.names == {300: "Sunwell Guardian"}


def test_displays_come_out_in_slot_order(tables: BuildTables) -> None:
    """The first is the one the pill shows, so source order is not enough."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA),
        tables(creature_template=CREATURE_TEMPLATE,
               creature_template_model=CREATURE_TEMPLATE_MODEL))
    assert creatures.displays == {300: [(0, 50), (1, 51)]}


def test_the_legacy_column_shape_yields_the_same_displays(
        tables: BuildTables) -> None:
    """In the legacy shape the column position is the slot, so an empty column
    is a skipped slot rather than a display of zero."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA),
        tables(creature_template=CREATURE_TEMPLATE_LEGACY))
    assert creatures.displays == {300: [(0, 50), (2, 51)]}


def test_a_dump_carrying_no_display_columns_degrades_rather_than_failing(
        tables: BuildTables) -> None:
    """A release with neither the display table nor the legacy columns keeps
    its names and loses only the morphs."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA),
        tables(absent=TDB_OPTIONAL_TABLES, defaults=TDB_OPTIONAL_COLUMNS,
               creature_template=CREATURE_TEMPLATE))
    assert creatures.displays == {}
    assert creatures.names == {300: "Sunwell Guardian"}
