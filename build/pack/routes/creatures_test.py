"""The creature chain: what survives when the server dump does not."""

from __future__ import annotations

from ..drift import TDB_OPTIONAL_COLUMNS, TDB_OPTIONAL_TABLES
from .conftest import BuildTables
from .creatures import read_creature_models

CREATURE_DISPLAY_INFO = """\
ID,ModelID
50,900
51,901
52,999
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
    """Several displays share one model, which is why the file id lives a table
    further down than the look does."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.fid_for_display(50) == 7000
    assert creatures.fid_for_display(51) == 7001


def test_a_display_whose_model_has_no_file_resolves_to_nothing(
        tables: BuildTables) -> None:
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.fid_for_display(52) == 0
    assert creatures.fid_for_display(999) == 0


def test_without_a_server_dump_the_models_still_resolve(tables: BuildTables) -> None:
    """The half that degrades is the naming half, and only that half: a build
    with no dump renders a morph's model and loses the word for it."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA), None)
    assert creatures.names == {}
    assert creatures.displays == {}
    assert creatures.fid_for_display(50) == 7000


def test_a_name_is_trimmed(tables: BuildTables) -> None:
    """The dump reader decodes faithfully; a display name is the one thing that
    wants its stray whitespace gone."""
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
    """⛔ The reason the two spellings share one output: in the legacy shape the
    COLUMN POSITION is the slot, so an empty column is a skipped slot rather
    than a display of zero."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA),
        tables(creature_template=CREATURE_TEMPLATE_LEGACY))
    assert creatures.displays == {300: [(0, 50), (2, 51)]}


def test_a_dump_carrying_no_display_columns_degrades_rather_than_failing(
        tables: BuildTables) -> None:
    """The server-side drift declarations at work: a release with neither the
    display table nor the legacy columns keeps its names and loses only the
    morphs, instead of failing the build."""
    creatures = read_creature_models(
        tables(CreatureDisplayInfo=CREATURE_DISPLAY_INFO,
               CreatureModelData=CREATURE_MODEL_DATA),
        tables(absent=TDB_OPTIONAL_TABLES, defaults=TDB_OPTIONAL_COLUMNS,
               creature_template=CREATURE_TEMPLATE))
    assert creatures.displays == {}
    assert creatures.names == {300: "Sunwell Guardian"}
