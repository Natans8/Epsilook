"""What an item resolves to, including the two thirds that have no name."""

from __future__ import annotations

from .conftest import BuildTables
from .items import read_item_models

# Item 10 is named; item 11 is one of the unnamed props.
ITEM_SEARCH_NAME = """\
ID,Display_lang,OverallQualityID
10,Flask of the Titans,4
12,,3
"""

# Two levels of detail on one resources id, and the lowest is the base model.
MODEL_FILE_DATA = """\
FileDataID,ModelResourcesID
8100,500
8099,500
8200,501
"""

ITEM_DISPLAY_INFO = """\
ID,ModelResourcesID_0,ModelResourcesID_1
600,500,0
601,0,501
602,0,0
"""

ITEM_APPEARANCE = """\
ID,ItemDisplayInfoID,DefaultIconFileDataID
700,600,9000
701,601,9001
702,602,9002
"""

# Item 10 carries two appearances: the base look first, a transmog variant
# second. Item 11 has no name row at all. Item 13 reaches no model.
ITEM_MODIFIED_APPEARANCE = """\
ItemID,ItemAppearanceID
10,700
10,701
11,701
13,702
"""


def items(tables: BuildTables):
    return read_item_models(tables(ItemSearchName=ITEM_SEARCH_NAME,
                                   ModelFileData=MODEL_FILE_DATA,
                                   ItemDisplayInfo=ITEM_DISPLAY_INFO,
                                   ItemAppearance=ITEM_APPEARANCE,
                                   ItemModifiedAppearance=ITEM_MODIFIED_APPEARANCE))


def test_the_first_appearance_wins(tables: BuildTables) -> None:
    """⛔ What makes the pill show the item's BASE look rather than an arbitrary
    recolour: appearances arrive in source order and the first that yields a
    file is taken."""
    assert items(tables).model_fid[10] == 8099
    assert items(tables).icon_fid[10] == 9000


def test_the_lowest_file_of_a_resources_id_is_the_base_model(
        tables: BuildTables) -> None:
    """A resources id names several files when the model ships with levels of
    detail, and they do not arrive in order."""
    assert items(tables).model_fid[10] == 8099


def test_the_second_model_slot_is_reached_when_the_first_is_unset(
        tables: BuildTables) -> None:
    """A paired item carries its second component in slot 1."""
    assert items(tables).model_fid[11] == 8200


def test_an_unnamed_item_still_resolves(tables: BuildTables) -> None:
    """⛔ The majority of this route: internal props that exist purely to be
    held in a spell visual. Dropping them for having no name would throw the
    route away."""
    resolved = items(tables)
    assert 11 not in resolved.name
    assert resolved.resolved(11)


def test_an_empty_display_name_is_not_a_name(tables: BuildTables) -> None:
    """The column exists on every row; only a non-empty one is a name, and
    quality rides with it rather than standing alone."""
    resolved = items(tables)
    assert 12 not in resolved.name
    assert 12 not in resolved.quality


def test_an_item_reaching_no_model_is_unresolved(tables: BuildTables) -> None:
    """Its icon still lands: the icon comes off the appearance and does not
    depend on the model hop succeeding."""
    resolved = items(tables)
    assert not resolved.resolved(13)
    assert resolved.icon_fid[13] == 9002


def test_quality_rides_with_the_name(tables: BuildTables) -> None:
    assert items(tables).quality[10] == 4
