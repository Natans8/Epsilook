"""Reading the shared listfile: which asset, the streaming filter, and how a
supplement extends it through the ordinary merge."""

from __future__ import annotations

from pathlib import Path

import pytest

from pack.routes.assets import resolve_paths
from pack.sources.listfile import (LISTFILE_ASSET, LISTFILE_DIR, SUPPLEMENT,
                                   SUPPLEMENT_FLOOR)
from pack.supplements import above
from pack.tables.listfile_tables import ID, PATH, TABLE, ListfileTables
from pack.tables.overlay import OverlaidTables, Overlay

LINES = """\
1;Interface/Cinematics/Logo_800.avi
53191;Sound/music/CityMusic/Ironforge/IronForge Intro.mp3
900;SPELLS/IMMOLATE_STATE_BASE_V2_FEL.M2
901;spells/textures/weapontrail_roguebloodgreen.blp
"""


def listfile(tmp_path: Path, text: str = LINES,
             name: str = "listfile.csv") -> ListfileTables:
    path = tmp_path / name
    path.write_text(text, encoding="utf-8", newline="")
    return ListfileTables(path)


def test_the_asset_is_the_capitalised_community_one() -> None:
    """The pack shows these paths to a reader, so casing is kept; community
    rather than verified, because a name we do not have is an asset nobody can
    find."""
    assert LISTFILE_ASSET == "community-listfile-withcapitals.csv"


def test_only_the_wanted_ids_come_back(tmp_path: Path) -> None:
    """The listfile covers the whole game, so a build keeps its own fraction
    rather than loading it."""
    assert resolve_paths(listfile(tmp_path), {1, 901}) == {
        1: "Interface/Cinematics/Logo_800.avi",
        901: "spells/textures/weapontrail_roguebloodgreen.blp",
    }


def test_casing_survives_the_read(tmp_path: Path) -> None:
    """The whole point of the asset choice; anything matching against these
    folds case at the comparison instead."""
    found = resolve_paths(listfile(tmp_path), {53191})
    assert found[53191] == "Sound/music/CityMusic/Ironforge/IronForge Intro.mp3"


def test_a_wanted_id_the_listfile_does_not_name_is_absent(
        tmp_path: Path) -> None:
    """Rather than present and empty, so a caller cannot mistake an unnamed
    asset for one named the empty string."""
    assert resolve_paths(listfile(tmp_path), {1, 4242}) == {
        1: "Interface/Cinematics/Logo_800.avi"}


def test_a_row_that_is_not_a_row_is_skipped(tmp_path: Path) -> None:
    """The file is not ours and its tail has been truncated before."""
    text = LINES + "not a row\n;\nxyz;path\n"
    assert set(resolve_paths(listfile(tmp_path, text), {1, 900})) == {1, 900}


def test_the_provider_serves_one_table_and_names_its_columns(
        tmp_path: Path) -> None:
    """The format carries no header, so the column names are the provider's."""
    tables = listfile(tmp_path)
    assert tables.available(TABLE)
    assert not tables.available("SpellName")
    assert tables.header(TABLE) == [ID, PATH]


def test_the_provider_projects_columns_in_the_order_asked_for(
        tmp_path: Path) -> None:
    """Part of the provider contract, pinned here because this provider serves
    one fixed table and so cannot join the parametrised suite as it stands."""
    tables = listfile(tmp_path)
    assert next(iter(tables.rows(TABLE, [PATH, ID]))) == (
        "Interface/Cinematics/Logo_800.avi", "1")
    assert next(iter(tables.rows(TABLE, [ID]))) == ("1",)


def test_the_provider_hands_back_the_source_text_and_the_route_trims_it(
        tmp_path: Path) -> None:
    """Text in, text out: a field's own whitespace is the source's, so the
    provider keeps it and the reader that turns it into a name is where it
    goes. Only the line terminator is the provider's to remove."""
    tables = listfile(tmp_path, "7;  Interface/Padded.blp  \n")
    assert next(iter(tables.rows(TABLE, [ID, PATH]))) == (
        "7", "  Interface/Padded.blp  ")
    assert resolve_paths(tables, {7}) == {7: "Interface/Padded.blp"}


def _supplemented(tmp_path: Path, supplement: str) -> OverlaidTables:
    """The community listfile with a supplement over it, wired as any two
    sources are."""
    return OverlaidTables(
        base=listfile(tmp_path, name="community.csv"),
        overlays={TABLE: Overlay(TABLE, {ID: ID, PATH: PATH}, key=ID,
                                 admits=above(SUPPLEMENT_FLOOR))},
        source=listfile(tmp_path, supplement, name="supplement.csv"),
    )


def test_a_supplement_names_what_the_community_listfile_cannot(
        tmp_path: Path) -> None:
    """The listfile is a table like any other, so extending it is the same
    merge that applies the server's hotfixes."""
    tables = _supplemented(tmp_path, "19602034;Interface/ICONS/eps_arc_armourblue.blp\n")
    assert resolve_paths(tables, {1, 19602034}) == {
        1: "Interface/Cinematics/Logo_800.avi",
        19602034: "Interface/ICONS/eps_arc_armourblue.blp",
    }


def test_a_supplement_may_not_rename_an_asset_the_base_already_names(
        tmp_path: Path) -> None:
    """Its rule confines it to ids beyond the base, so a regenerated supplement
    that grew a stock row cannot quietly replace a real name with its own
    spelling of one."""
    tables = _supplemented(tmp_path, "1;Interface/WRONG.avi\n")
    assert resolve_paths(tables, {1}) == {1: "Interface/Cinematics/Logo_800.avi"}


def test_the_vendored_supplement_loads_and_is_wholly_admitted() -> None:
    """The supplement ships in the repository, so this reads the real file: every
    row must be beyond the floor, or the rule that keeps it from shadowing a
    community name is not the rule this file needs."""
    tables = ListfileTables(SUPPLEMENT)
    assert tables.available(TABLE), f"{SUPPLEMENT} is not vendored"
    admits = above(SUPPLEMENT_FLOOR)
    ids = [int(fid) for fid, _path in tables.rows(TABLE, [ID, PATH])]
    assert ids, "the vendored supplement is empty"
    assert all(admits(str(fid)) for fid in ids), \
        "a vendored row sits at or below the floor and could shadow a real name"
    assert len(set(ids)) == len(ids), "the vendored supplement repeats a file id"
    assert ids == sorted(ids), "the vendored supplement is not sorted by file id"


def test_no_community_id_reaches_the_supplement_floor() -> None:
    """The other half of the floor rule, and the half a fixture cannot state.

    The supplement may only name ids above the floor, which keeps it from
    shadowing a community name exactly as long as everything Blizzard ships
    sits below the floor -- a claim about the real file. Read whole, because
    the one id that crossed is what a sample misses. Skipped when the cache is
    absent, which is every CI run."""
    cached = LISTFILE_DIR / LISTFILE_ASSET
    if not cached.exists():
        pytest.skip("the community listfile is not cached; build a pack first")
    ceiling = max(int(fid) for fid, _path
                  in ListfileTables(cached).rows(TABLE, [ID, PATH]))
    assert ceiling <= SUPPLEMENT_FLOOR, (
        f"community id {ceiling} sits at or above the supplement floor "
        f"{SUPPLEMENT_FLOOR}; the disjointness the floor rule promises is gone")
