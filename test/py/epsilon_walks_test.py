"""Deriving a path for a file that nothing reports a name for.

The chunk readers and the path shapes are pinned here because both fail
quietly. A chunk tag read in the wrong byte order matches nothing at all, so the
file reads as referencing no children and the walk reports a clean zero; and a
child numbered by the wrong convention produces a path that looks entirely
plausible and matches no file.
"""

from __future__ import annotations

import struct

import pytest

from epsilon_storage import chunks
from epsilon_walks import (MODEL_CHILDREN, WORLD_MODEL_CHILDREN, TILE_SLOTS,
                           stem_of, walk_parents)

FLOOR = 18_000_000


def chunk(tag: bytes, body: bytes, *, reversed_tags: bool = False) -> bytes:
    """One chunk, written the way the format under test stores it."""
    stored = tag[::-1] if reversed_tags else tag
    return stored + struct.pack("<I", len(body)) + body


def ids(*values: int) -> bytes:
    return struct.pack(f"<{len(values)}I", *values)


def test_chunks_walks_tag_and_body() -> None:
    raw = chunk(b"MD21", b"abc") + chunk(b"SFID", ids(7))
    assert list(chunks(raw)) == [(b"MD21", b"abc"), (b"SFID", ids(7))]


def test_a_reversed_format_is_read_in_reading_order() -> None:
    """A world model stores its tags back to front and nothing in the file
    says so, so the caller states which order it expects."""
    raw = chunk(b"GFID", ids(3), reversed_tags=True)
    assert list(chunks(raw, reversed_tags=True)) == [(b"GFID", ids(3))]


def test_reading_a_reversed_format_forward_finds_nothing_recognisable() -> None:
    """The failure this guards: no error, just a file that appears to
    reference nothing."""
    raw = chunk(b"GFID", ids(3), reversed_tags=True)
    assert [tag for tag, _ in chunks(raw)] == [b"DIFG"]


def test_a_truncated_chunk_ends_the_walk_rather_than_yielding_a_short_body() -> None:
    raw = b"SFID" + struct.pack("<I", 64) + b"only four"
    assert not list(chunks(raw))


def test_stem_of_takes_the_bare_filename() -> None:
    assert stem_of("world/expansion05/doodads/thing_a.m2") == "thing_a"
    assert stem_of(r"world\maps\thing.wmo") == "thing"


def test_only_the_kinds_the_game_names_predictably_sit_beside_their_parent() -> None:
    """Measured against the published listfile: a model's skins and animations
    and a world model's groups follow a convention; the rest do not."""
    assert MODEL_CHILDREN[b"SFID"].beside
    assert MODEL_CHILDREN[b"AFID"].beside
    assert WORLD_MODEL_CHILDREN[b"GFID"].beside
    for tag in (b"TXID", b"BFID", b"SKID", b"PFID"):
        assert not MODEL_CHILDREN[tag].beside
    assert not WORLD_MODEL_CHILDREN[b"MOMT"].beside


def test_every_tile_slot_is_a_path_the_game_would_look_up() -> None:
    for slot, shape in TILE_SLOTS.items():
        assert shape.format(stem="world/maps/m/m_1_2", directory="m", x=1, y=2)
        assert slot in range(8)


class FakeStorage:
    """A storage holding a fixed set of files, all of them local."""

    def __init__(self, files: dict[int, bytes]) -> None:
        self.files = files

    def encoding_keys(self, file_ids):
        return {fid: b"" for fid in file_ids if fid in self.files}

    def holds_locally(self, file_id: int) -> bool:
        return file_id in self.files

    def read(self, file_id: int, *, local_only: bool = False) -> bytes | None:
        return self.files.get(file_id)

    def prepare_network(self) -> None:
        """Nothing to prepare: every file here is already to hand."""


def model_walk(files: dict[int, bytes], known: dict[int, str], unnamed: set[int]):
    from epsilon_walks import _model_children  # pylint: disable=import-outside-toplevel

    return walk_parents(FakeStorage(files), known, unnamed, suffix=".m2",
                        reader=_model_children, kinds=MODEL_CHILDREN,
                        local_only=True, label="models")


def test_a_skin_takes_the_name_the_game_would_look_it_up_by() -> None:
    """Beside its model, as the model's name and a two-digit index."""
    parent = FLOOR + 1
    files = {parent: chunk(b"SFID", ids(FLOOR + 10, FLOOR + 11))}
    walk = model_walk(files, {parent: "world/expansion05/doodads/thing.m2"},
                      {FLOOR + 10, FLOOR + 11})
    assert walk.names == {
        FLOOR + 10: "world/expansion05/doodads/thing00.skin",
        FLOOR + 11: "world/expansion05/doodads/thing01.skin"}


def test_a_child_is_only_as_real_as_the_parent_that_names_it() -> None:
    """The convention is applied whatever the parent's path is, so a child of a
    derived parent stays under the derived root without a second rule."""
    parent = FLOOR + 1
    files = {parent: chunk(b"SFID", ids(FLOOR + 10))}
    walk = model_walk(files, {parent: "epsilon/object/theme/thing.m2"}, {FLOOR + 10})
    assert walk.names == {FLOOR + 10: "epsilon/object/theme/thing00.skin"}


def test_a_world_model_group_sits_beside_its_root() -> None:
    from epsilon_walks import (WORLD_MODEL_CHILDREN as KINDS,  # pylint: disable=import-outside-toplevel
                               _world_model_children)

    parent = FLOOR + 1
    files = {parent: chunk(b"GFID", ids(FLOOR + 10, FLOOR + 11), reversed_tags=True)}
    walk = walk_parents(FakeStorage(files), {parent: "world/wmo/azeroth/keep.wmo"},
                        {FLOOR + 10, FLOOR + 11}, suffix=".wmo",
                        reader=_world_model_children, kinds=KINDS,
                        local_only=True, label="world models")
    assert walk.names == {FLOOR + 10: "world/wmo/azeroth/keep_000.wmo",
                          FLOOR + 11: "world/wmo/azeroth/keep_001.wmo"}


def test_a_child_shared_between_parents_keeps_its_file_id() -> None:
    """Its position means nothing once two models disagree about it, so the
    parent directory carries the meaning and the id keeps the path unique."""
    shared = FLOOR + 10
    files = {FLOOR + 1: chunk(b"SFID", ids(shared)),
             FLOOR + 2: chunk(b"SFID", ids(shared))}
    walk = model_walk(files, {FLOOR + 1: "a/first.m2", FLOOR + 2: "a/second.m2"},
                      {shared})
    assert walk.names == {shared: f"epsilon/skin/first/{shared}.skin"}



def test_a_texture_always_keeps_its_file_id() -> None:
    parent = FLOOR + 1
    files = {parent: chunk(b"TXID", ids(FLOOR + 10))}
    walk = model_walk(files, {parent: "a/thing.m2"}, {FLOOR + 10})
    assert walk.names == {FLOOR + 10: f"epsilon/texture/thing/{FLOOR + 10}.blp"}


def test_an_animation_is_named_by_the_animation_it_holds() -> None:
    """The two fields ahead of the file id are the animation and its variation,
    and they are the name -- not padding to be skipped past. Reading the chunk
    as a bare array of ids also takes an animation number for a file id."""
    parent = FLOOR + 1
    body = struct.pack("<HHI", 42, 1, FLOOR + 10)
    walk = model_walk({parent: chunk(b"AFID", body)},
                      {parent: "character/bloodelf/female/bloodelffemale.m2"},
                      {FLOOR + 10})
    assert walk.names == {
        FLOOR + 10: "character/bloodelf/female/bloodelffemale0042-01.anim"}


def test_a_child_that_is_already_named_is_left_alone() -> None:
    parent = FLOOR + 1
    files = {parent: chunk(b"SFID", ids(FLOOR + 10))}
    assert model_walk(files, {parent: "a/thing.m2"}, set()).names == {}


def test_a_parent_of_the_wrong_kind_is_not_walked() -> None:
    """Parents are chosen by the extension of the name they already carry."""
    parent = FLOOR + 1
    files = {parent: chunk(b"SFID", ids(FLOOR + 10))}
    assert model_walk(files, {parent: "a/thing.wmo"}, {FLOOR + 10}).names == {}


TABLES: dict[str, tuple[list[str], list[tuple[str, ...]]]] = {
    "TextureFileData": (["FileDataID", "UsageType", "MaterialResourcesID"],
                        [(str(FLOOR + 1), "0", "500"), ("12", "0", "501")]),
    "ChrCustomizationMaterial": (["ID", "ChrModelTextureTargetID",
                                  "MaterialResourcesID"],
                                 [("70", "1", "500"), ("71", "1", "500")]),
    "ChrCustomizationElement": (["ID", "ChrCustomizationChoiceID",
                                 "ChrCustomizationMaterialID"],
                                [("1", "44", "70"), ("2", "43", "70")]),
    "ChrCustomizationChoice": (["Name_lang", "ID", "ChrCustomizationOptionID",
                                "OrderIndex"],
                               [("TrollMaleEyeColor04", "43", "9", "3")]),
    "ChrCustomizationOption": (["Name_lang", "ID", "ChrModelID"],
                               [("Eye Color", "9", "12")]),
}


def fake_tables(monkeypatch: pytest.MonkeyPatch,
                tables: dict[str, tuple[list[str], list[tuple[str, ...]]]]) -> None:
    """Serve the customization chain from literals instead of the client."""
    from epsilon_tables import Table  # pylint: disable=import-outside-toplevel
    import epsilon_tables  # pylint: disable=import-outside-toplevel

    built = {name: Table(columns, rows) for name, (columns, rows) in tables.items()}
    monkeypatch.setattr(epsilon_tables, "table_ids", dict)
    monkeypatch.setattr(epsilon_tables, "open_table",
                        lambda _storage, name, _ids: built.get(name))


def test_a_texture_is_named_by_what_it_customises(monkeypatch: pytest.MonkeyPatch) -> None:
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel

    fake_tables(monkeypatch, TABLES)
    assert customization_names(FakeStorage({}), FLOOR) == {
        FLOOR + 1: f"epsilon/chrcustomization/eye_color/trollmaleeyecolor04/{FLOOR + 1}.blp"}


def test_the_lowest_id_wins_where_a_join_is_many_to_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two materials share the resource and two elements share the material, so
    without this the path depends on which row the reader happened to see last."""
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel

    fake_tables(monkeypatch, TABLES)
    first = customization_names(FakeStorage({}), FLOOR)
    reversed_rows = {name: (columns, list(reversed(rows)))
                     for name, (columns, rows) in TABLES.items()}
    fake_tables(monkeypatch, reversed_rows)
    assert customization_names(FakeStorage({}), FLOOR) == first


def test_an_unreadable_table_names_nothing_rather_than_guessing(monkeypatch: pytest.MonkeyPatch) -> None:
    """A partial chain would name a texture after the wrong thing."""
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel

    fake_tables(monkeypatch, {k: v for k, v in TABLES.items()
                              if k != "ChrCustomizationOption"})
    assert customization_names(FakeStorage({}), FLOOR) == {}


def test_ids_below_the_floor_are_not_named(monkeypatch: pytest.MonkeyPatch) -> None:
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel

    fake_tables(monkeypatch, TABLES)
    assert 12 not in customization_names(FakeStorage({}), FLOOR)


@pytest.mark.parametrize("name, expected", [
    ("Eye Color", "eye_color"),
    ("Skin Color", "skin_color"),
    ("HumanMaleSkin01", "humanmaleskin01"),
    ("  Face  Markings ", "face_markings"),
    ("Horn Style / Colour", "horn_style_colour"),
])
def test_slug_makes_one_path_segment(name: str, expected: str) -> None:
    from epsilon_walks import slug  # pylint: disable=import-outside-toplevel

    assert slug(name) == expected


def test_a_nameless_choice_becomes_its_place_in_the_option(monkeypatch: pytest.MonkeyPatch) -> None:
    """Most choices this client adds carry no display name, and their position
    is what the character creator shows instead -- the numbered swatches. That
    is worth more than the row id and more than dropping the texture."""
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel

    nameless = dict(TABLES)
    nameless["ChrCustomizationChoice"] = (["Name_lang", "ID",
                                           "ChrCustomizationOptionID", "OrderIndex"],
                                          [("", "43", "9", "3")])
    fake_tables(monkeypatch, nameless)
    assert customization_names(FakeStorage({}), FLOOR) == {
        FLOOR + 1: f"epsilon/chrcustomization/eye_color/03/{FLOOR + 1}.blp"}


def test_a_texture_with_no_option_is_still_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """The option is the half worth having; without it there is nothing to say."""
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel

    nameless = dict(TABLES)
    nameless["ChrCustomizationOption"] = (["Name_lang", "ID", "ChrModelID"],
                                          [("", "9", "12")])
    fake_tables(monkeypatch, nameless)
    assert customization_names(FakeStorage({}), FLOOR) == {}


def world_model(wmo_id: int, *, header: bool = True) -> bytes:
    """A world model root declaring the retail model it came from.

    The header opens with seven counts and a four-byte ambient colour, so the
    id sits at byte thirty-two; writing the whole prefix rather than padding
    keeps the test honest about why that offset is what it is.
    """
    body = struct.pack("<7I", 0, 0, 0, 0, 0, 0, 0) + b"\xff\xff\xff\xff"
    body += struct.pack("<I", wmo_id) + b"\x00" * 28
    raw = chunk(b"MVER", struct.pack("<I", 17), reversed_tags=True)
    return raw + (chunk(b"MOHD", body, reversed_tags=True) if header else b"")


def test_a_world_model_reports_the_retail_id_it_carries() -> None:
    from epsilon_walks import world_model_id  # pylint: disable=import-outside-toplevel

    assert world_model_id(world_model(1375)) == 1375


def test_only_a_world_model_root_reports_one() -> None:
    """A group carries no MOHD, and a model is not chunked this way at all."""
    from epsilon_walks import world_model_id  # pylint: disable=import-outside-toplevel

    assert world_model_id(world_model(1375, header=False)) is None
    assert world_model_id(b"MD21" + b"\x00" * 64) is None
    assert world_model_id(None) is None
    assert world_model_id(b"") is None


def test_an_unset_retail_id_names_nothing() -> None:
    """Zero is absence, not a model. Treating it as one collapses every
    file that declares nothing onto whichever retail root also declares zero."""
    from epsilon_walks import world_model_id  # pylint: disable=import-outside-toplevel

    assert world_model_id(world_model(0)) is None


def test_a_reskin_is_named_after_the_root_sharing_its_id() -> None:
    from epsilon_walks import reskin_names  # pylint: disable=import-outside-toplevel

    custom = FLOOR + 5
    storage = FakeStorage({custom: world_model(1375), 900: world_model(1375),
                           901: world_model(42)})
    names = reskin_names(storage, {custom},
                         {900: "World/WMO/Kalimdor/WinterspringRockBridge.wmo",
                          901: "World/WMO/Elsewhere/Other.wmo"})
    assert names == {custom: f"epsilon/reskin/winterspringrockbridge/{custom}.wmo"}


def test_a_reskin_matching_no_retail_root_is_left_alone() -> None:
    """An unmatched id says nothing, and a guess would say something wrong."""
    from epsilon_walks import reskin_names  # pylint: disable=import-outside-toplevel

    custom = FLOOR + 5
    storage = FakeStorage({custom: world_model(7777), 900: world_model(1375)})
    assert reskin_names(storage, {custom},
                        {900: "World/WMO/Kalimdor/Bridge.wmo"}) == {}


def test_group_files_are_never_read_for_a_header_they_cannot_have() -> None:
    """Forty thousand groups sit in the listfile beside the roots, and reading
    one costs a fetch that can never contribute."""
    from epsilon_walks import reskin_names  # pylint: disable=import-outside-toplevel

    custom = FLOOR + 5
    storage = FakeStorage({custom: world_model(1375), 900: world_model(1375)})
    names = reskin_names(storage, {custom},
                         {900: "World/WMO/Kalimdor/Bridge.wmo",
                          901: "World/WMO/Kalimdor/Bridge_000.wmo"})
    assert names == {custom: f"epsilon/reskin/bridge/{custom}.wmo"}


def test_no_readable_retail_root_names_nothing_rather_than_silently_none() -> None:
    """Without the retail side there is nothing to match, and an empty result
    would otherwise read as the custom files carrying no id at all."""
    from epsilon_walks import reskin_names  # pylint: disable=import-outside-toplevel

    custom = FLOOR + 5
    storage = FakeStorage({custom: world_model(1375)})
    assert reskin_names(storage, {custom}, {900: "World/WMO/Absent.wmo"}) == {}


def model(name: bytes, *, chunked: bool = True) -> bytes:
    """A model carrying its own name, in either container shape."""
    header = struct.pack("<III", 272, len(name) + 1, 0)  # patched below
    body = b"MD20" + header + b"\x00" * 16 + name + b"\x00"
    offset = len(b"MD20" + header) + 16
    body = b"MD20" + struct.pack("<III", 272, len(name) + 1, offset) + b"\x00" * 16 \
           + name + b"\x00"
    return chunk(b"MD21", body) if chunked else body


def test_a_model_reports_the_name_it_carries() -> None:
    from epsilon_walks import model_name  # pylint: disable=import-outside-toplevel

    assert model_name(model(b"TheWorldTree")) == "TheWorldTree"


def test_both_container_shapes_read_the_same() -> None:
    """The modern wrapper keeps the old magic inside it, so the only difference
    is the chunk around it."""
    from epsilon_walks import model_name  # pylint: disable=import-outside-toplevel

    assert model_name(model(b"UI_Alliance", chunked=False)) == "UI_Alliance"
    assert model_name(model(b"UI_Alliance", chunked=True)) == "UI_Alliance"


def test_a_model_naming_a_texture_names_nothing() -> None:
    """Some models hold a texture path in the name field. Taking it would name
    the model after its own texture, which is a confident wrong answer."""
    from epsilon_walks import model_name  # pylint: disable=import-outside-toplevel

    assert model_name(model(rb"DUNGEONS\BUILDINGS\DARKPORTAL_STONE.BLP")) is None


def test_a_length_that_does_not_fit_is_refused() -> None:
    """A misread length would otherwise slice an arbitrary run of bytes out of
    the file and call it a name."""
    from epsilon_walks import model_name  # pylint: disable=import-outside-toplevel

    body = b"MD20" + struct.pack("<III", 272, 40, 9_000) + b"\x00" * 32
    assert model_name(chunk(b"MD21", body)) is None
    assert model_name(b"REVM" + b"\x00" * 32) is None
    assert model_name(None) is None


def test_models_sharing_a_name_are_told_apart_by_id() -> None:
    """A name is the artist's, not the file's, so several models legitimately
    share one -- but only those need the id."""
    from epsilon_walks import model_self_names  # pylint: disable=import-outside-toplevel

    a, b, alone = FLOOR + 1, FLOOR + 2, FLOOR + 3
    storage = FakeStorage({a: model(b"Cloak_A"), b: model(b"Cloak_A"),
                           alone: model(b"Banner_B")})
    assert model_self_names(storage, {a, b, alone}) == {
        a: f"epsilon/model/Cloak_A_{a}.m2",
        b: f"epsilon/model/Cloak_A_{b}.m2",
        alone: "epsilon/model/Banner_B.m2",
    }


def test_the_name_keeps_the_casing_it_was_written_with() -> None:
    """The listfile carries capitals because the names are shown to a person,
    and a name folded here would be the one row that disagrees."""
    from epsilon_walks import model_self_names  # pylint: disable=import-outside-toplevel

    fid = FLOOR + 7
    storage = FakeStorage({fid: model(b"Collections_Cloth_RaidMage_Q_01_Hu_M")})
    assert model_self_names(storage, {fid}) == {
        fid: "epsilon/model/Collections_Cloth_RaidMage_Q_01_Hu_M.m2"}
