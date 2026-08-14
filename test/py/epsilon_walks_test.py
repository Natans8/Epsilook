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


def test_a_model_skin_is_numbered_the_way_the_game_numbers_skins() -> None:
    assert MODEL_CHILDREN[b"SFID"].numbering == "{stem}{index:02d}"


def test_a_world_model_group_is_numbered_the_way_the_game_numbers_groups() -> None:
    """Two digits and no separator would look right and match no file."""
    assert WORLD_MODEL_CHILDREN[b"GFID"].numbering == "{stem}_{index:03d}"


def test_a_texture_carries_no_position() -> None:
    """A texture's slot is a material property, not part of any filename."""
    assert MODEL_CHILDREN[b"TXID"].numbering is None
    assert WORLD_MODEL_CHILDREN[b"MOMT"].numbering is None


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


def model_walk(files: dict[int, bytes], known: dict[int, str], unnamed: set[int]):
    from epsilon_walks import _model_children  # pylint: disable=import-outside-toplevel

    return walk_parents(FakeStorage(files), known, unnamed, suffix=".m2",
                        reader=_model_children, kinds=MODEL_CHILDREN,
                        local_only=True, label="models")


def test_a_child_claimed_by_one_parent_is_numbered_by_its_position() -> None:
    parent = FLOOR + 1
    files = {parent: chunk(b"SFID", ids(FLOOR + 10, FLOOR + 11))}
    walk = model_walk(files, {parent: "epsilon/object/theme/thing.m2"},
                      {FLOOR + 10, FLOOR + 11})
    assert walk.names == {FLOOR + 10: "epsilon/skin/thing00.skin",
                          FLOOR + 11: "epsilon/skin/thing01.skin"}


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


def test_an_animation_entry_is_read_past_its_two_leading_fields() -> None:
    """An animation reference is an id and a variation before the file id, so
    reading it as a bare array yields animation numbers as file ids."""
    parent = FLOOR + 1
    body = struct.pack("<HHI", 3, 0, FLOOR + 10)
    walk = model_walk({parent: chunk(b"AFID", body)}, {parent: "a/thing.m2"},
                      {FLOOR + 10})
    assert walk.names == {FLOOR + 10: "epsilon/anim/thing00.anim"}


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
    "ChrCustomizationChoice": (["Name_lang", "ID", "ChrCustomizationOptionID"],
                               [("TrollMaleEyeColor04", "43", "9")]),
    "ChrCustomizationOption": (["Name_lang", "ID"], [("Eye Color", "9")]),
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
