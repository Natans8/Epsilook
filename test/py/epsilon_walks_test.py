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
