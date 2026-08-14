"""The name-cleaning and path-derivation rules the asset-name supplement runs on.

Every rule here was recovered by reproducing a known-good output rather than
from a specification, so each one is pinned by a case that would otherwise
regress silently: the shapes are rare enough that a whole run can look right
while a hundred rows are wrong.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from epsilon_names import (bucket_of, clean, derived_path, icon_names,
                           object_names, read_saved_table, split_extension,
                           unescape)

FLOOR = 18_000_000


@pytest.mark.parametrize("body, expected", [
    (r"plain", "plain"),
    (r"trailing\r", "trailing\r"),
    (r"a\\b", r"a\b"),
    (r"say \"this\"", 'say "this"'),
    (r"\65\66", "AB"),
])
def test_unescape_resolves_lua_escapes(body: str, expected: str) -> None:
    assert unescape(body) == expected


@pytest.mark.parametrize("reported, expected", [
    ("chest02.m2\r", "chest02.m2"),
    ("foo.m2 [Door]", "foo.m2"),
    ("[BFA 801-820]  buildingtile_worgen_woodfence_01.m2",
     "buildingtile_worgen_woodfence_01.m2"),
    ("[9270100] chest02.m2", "chest02.m2"),
    ("[9270100] [SL 9.0] thing.m2", "thing.m2"),
    (r"world\expansion05\doodads\thing.m2", "world/expansion05/doodads/thing.m2"),
])
def test_clean_strips_what_is_not_part_of_the_name(reported: str, expected: str) -> None:
    assert clean(reported) == expected


@pytest.mark.parametrize("name, stem, extension", [
    ("chest02.m2", "chest02", "m2"),
    ("EPS_Gilneas_towerpost_v1", "EPS_Gilneas_towerpost_v1", "wmo"),
    ("eps_timegarden_fern_a02.m2.m2", "eps_timegarden_fern_a02", "m2"),
    ("buildingtile_7du_wall_courtroom04_.m2", "buildingtile_7du_wall_courtroom04", "m2"),
    ("buildingtile_uldum_loamysoil .m2", "buildingtile_uldum_loamysoil", "m2"),
])
def test_split_extension(name: str, stem: str, extension: str) -> None:
    assert split_extension(name) == (stem, extension)


def test_a_name_with_no_extension_is_called_a_world_model() -> None:
    """Measured from the files themselves, not inferred from the naming."""
    assert split_extension("emptywmo_draenei_medical")[1] == "wmo"


@pytest.mark.parametrize("stem, bucket, sub", [
    ("buildingtile_ce_lavawall2", "buildingtile", None),
    ("buildingplane_thing", "buildingplane", None),
    ("emptywmo_draenei_medical", "emptywmo", None),
    ("laketile_891_backup", "watertile", None),
    ("oceantile_3_magma", "watertile", None),
    ("EPS_Gilneas_garrison_towerpost_v1", "object", "gilneas"),
    ("eps_snowtree01", "object", "snowtree01"),
    ("EPS_buildingtile_stormwind_wall", "object", "buildingtile/stormwind"),
    ("EPS_oceantile_deep_thing", "object", "watertile/deep"),
    ("loner", "object", None),
])
def test_bucket_of(stem: str, bucket: str, sub: str | None) -> None:
    assert bucket_of(stem) == (bucket, sub)


def test_tiles_and_planes_stay_separate_buckets() -> None:
    """Declared apart although bare planes are currently empty.

    They are different kinds of object, so a later capture that does report a
    bare plane must not have it merged into the tiles.
    """
    assert bucket_of("buildingtile_x_y")[0] != bucket_of("buildingplane_x_y")[0]


def test_derived_path_places_a_bare_name_under_the_derived_root() -> None:
    assert derived_path("EPS_Gilneas_garrison_stair_v1") == (
        "epsilon/object/gilneas/EPS_Gilneas_garrison_stair_v1.wmo")


def test_a_reported_path_is_kept_as_the_client_gave_it() -> None:
    rows = object_names({FLOOR + 1: "world/expansion05/doodads/thing.m2\r"}, FLOOR)
    assert rows == {FLOOR + 1: "world/expansion05/doodads/thing.m2"}


def test_ids_below_the_floor_are_not_this_client_to_name() -> None:
    assert object_names({12: "stock.m2", FLOOR + 1: "own.m2"}, FLOOR).keys() == {FLOOR + 1}


def test_two_bare_names_deriving_one_path_keep_their_file_ids() -> None:
    """Otherwise one asset would silently take the other's name."""
    rows = object_names({FLOOR + 1: "[BFA 801-820] buildingtile_a.m2\r",
                         FLOOR + 2: "buildingtile_a.m2\r"}, FLOOR)
    assert sorted(rows.values()) == [f"epsilon/buildingtile/buildingtile_a_{FLOOR + 1}.m2",
                                     f"epsilon/buildingtile/buildingtile_a_{FLOOR + 2}.m2"]


def test_a_lone_bare_name_keeps_the_plain_path() -> None:
    rows = object_names({FLOOR + 1: "buildingtile_a.m2\r"}, FLOOR)
    assert rows == {FLOOR + 1: "epsilon/buildingtile/buildingtile_a.m2"}


SAVED_VARIABLES = '''
EpsilonDumpDB = {
\t["gobCount"] = 3,
\t["gob"] = {
\t\t["18000001"] = "first.m2\\r",
\t\t["18000002"] = "second.wmo\\r",
\t},
\t["gobDisplay"] = {
\t\t["-141417"] = 19301810,
\t\t["-141482"] = 19301809,
\t},
\t["spells"] = {
\t\t["12"] = "Fireball",
\t},
}
'''


@pytest.fixture(name="saved")
def saved_variables(tmp_path: Path) -> Path:
    """A SavedVariables file of the shape the dumping addon writes."""
    path = tmp_path / "EpsilonDump.lua"
    path.write_text(SAVED_VARIABLES, encoding="utf-8")
    return path


def test_read_saved_table_reads_one_flat_section(saved: Path) -> None:
    assert read_saved_table(saved, "gob") == {"18000001": "first.m2\r",
                                              "18000002": "second.wmo\r"}


def test_read_saved_table_stops_at_the_section_it_was_asked_for(saved: Path) -> None:
    assert read_saved_table(saved, "spells") == {"12": "Fireball"}


def test_a_missing_section_reads_as_absent_rather_than_failing(saved: Path) -> None:
    assert read_saved_table(saved, "sound") == {}


def test_a_section_of_bare_numbers_reads_as_values_not_as_nothing(saved: Path) -> None:
    """The client hands the addon a name as a string and an id as a number, and
    the writer passes both through. Matching only the quoted form makes a whole
    section look like an empty table."""
    assert read_saved_table(saved, "gobDisplay") == {"-141417": "19301810",
                                                     "-141482": "19301809"}


ICON_LIBRARY = '''
local icons = LibRPMedia:NewDatabase("icons", DATABASE_VERSION);
    file = {101,102,103,104},
    name = LibRPMedia:LoadFrontCodedStringList({0,"spell_fire_flame",11,"frost",0,"ability_rogue"})
local music = LibRPMedia:NewDatabase("music", DATABASE_VERSION);
'''


def test_icon_names_decodes_the_front_coded_list(tmp_path: Path) -> None:
    """Each name is a prefix of the previous one plus a suffix."""
    library = tmp_path / "LibRPMedia-Retail-1.0.lua"
    library.write_text(ICON_LIBRARY, encoding="utf-8")
    assert icon_names(library) == {
        101: "Interface/ICONS/spell_fire_flame.blp",
        102: "Interface/ICONS/spell_fire_frost.blp",
        103: "Interface/ICONS/ability_rogue.blp",
    }


def test_file_ids_past_the_last_name_are_dropped(tmp_path: Path) -> None:
    """The library's two arrays do not pair to the end, and its own generator
    records that as a defect. A name is never guessed for the excess."""
    library = tmp_path / "LibRPMedia-Retail-1.0.lua"
    library.write_text(ICON_LIBRARY, encoding="utf-8")
    assert 104 not in icon_names(library)


def test_a_library_of_an_unknown_shape_is_refused(tmp_path: Path) -> None:
    library = tmp_path / "LibRPMedia-Retail-1.0.lua"
    library.write_text("local nothing = true\n", encoding="utf-8")
    with pytest.raises(ValueError):
        icon_names(library)


class CatalogueStorage:
    """A storage holding the client's shipped name list and nothing else."""

    def __init__(self, raw: bytes | None) -> None:
        self.raw = raw

    def encoding_keys(self, file_ids):
        return {}

    def read(self, file_id: int, *, local_only: bool = False) -> bytes | None:
        from epsilon_names import OBJECT_CATALOGUE  # pylint: disable=import-outside-toplevel
        return self.raw if file_id == OBJECT_CATALOGUE else None


def test_the_shipped_catalogue_is_read_without_a_capture() -> None:
    """It is what the client API reads, so no route needs anybody logged in."""
    from epsilon_names import read_object_dump  # pylint: disable=import-outside-toplevel

    storage = CatalogueStorage(b"106679;altarofstorms.wmo\n18000012;EPS_Thing.wmo\n")
    assert read_object_dump(cached=None, storage=storage) == {
        106679: "altarofstorms.wmo", 18000012: "EPS_Thing.wmo"}


def test_a_catalogue_row_keeps_the_bytes_it_was_written_with() -> None:
    """The capture route returned this name as mojibake through the addon's
    chat layer; reading the file skips the round trip that mangled it."""
    from epsilon_names import read_object_dump  # pylint: disable=import-outside-toplevel

    storage = CatalogueStorage("341891;Катапульта\n".encode("utf-8"))
    assert read_object_dump(cached=None, storage=storage) == {341891: "Катапульта"}


def test_an_unreadable_catalogue_falls_through_rather_than_returning_empty() -> None:
    """An empty result would look like a client that names nothing."""
    from epsilon_names import read_object_dump  # pylint: disable=import-outside-toplevel

    with pytest.raises(FileNotFoundError):
        read_object_dump(cached=None, storage=CatalogueStorage(None))
