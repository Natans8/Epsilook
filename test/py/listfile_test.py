"""Reading the shared listfile: which asset, and the streaming filter."""

from __future__ import annotations

from pathlib import Path

from pack.sources.listfile import LISTFILE_ASSET, resolve_paths

LINES = """\
1;Interface/Cinematics/Logo_800.avi
53191;Sound/music/CityMusic/Ironforge/IronForge Intro.mp3
900;SPELLS/IMMOLATE_STATE_BASE_V2_FEL.M2
901;spells/textures/weapontrail_roguebloodgreen.blp
"""


def listfile(tmp_path: Path, text: str = LINES) -> Path:
    path = tmp_path / "listfile.csv"
    path.write_text(text, encoding="utf-8", newline="")
    return path


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
