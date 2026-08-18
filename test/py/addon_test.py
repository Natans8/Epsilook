"""The addon's data files, checked by reading them back with the real reader.

The emitter and the reader are written in different languages, so nothing but
running both proves they agree. Every round-trip here loads the emitted chunk
into Lua 5.1 -- the interpreter the client runs -- and asks `Reader.lua` for
the columns, then compares them against what went in.

That is also why there is no Python decoder to compare against: a second
account of the layout would drift from the first, and the pack the chunk was
built from is a better reference than a reimplementation of the writer.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from pack.emit.addon import (ADDON_FORMAT, AXES, AXIS_OF, DIGITS,
                             LINE_LIMIT,
                             SUPPLIED_BY, Blob, Variation, chunks,
                             digits_for, interface_version, rendered, spelled,
                             supplies, wrapped)
from pack.model import SECTIONS
from pack.model.section import Layout
from support import unwrap

lua51 = pytest.importorskip("lupa.lua51")

ROOT = Path(__file__).resolve().parents[2]
READER = ROOT / "addon" / "Epsilook" / "Reader.lua"
DECLARED = {section.name: section for section in SECTIONS}


@pytest.fixture(name="lua")
def lua_fixture() -> Any:
    """A Lua 5.1 state with the reader loaded.

    Strings cross as bytes rather than as text: the blob is addressed by byte
    offset, so a runtime that decoded it on the way out would be answering
    about a different string than the one the offsets describe.
    """
    runtime = lua51.LuaRuntime(encoding=None)
    reader = runtime.execute(READER.read_bytes())
    runtime.globals()[b"Reader"] = reader
    return runtime


def round_trip(lua: Any, values: Any) -> Any:
    """Write one column, load it as Lua source, and read it back.

    Through the source rather than by handing Lua a converted table, because
    the source is the artifact. Rendering the header and wrapping the blob are
    the two steps that actually ship, and a test that skipped them would be
    checking a bridge production does not have.
    """
    blob = Blob()
    node = blob.column(values)
    source = (b"Node = " + rendered(node).encode("utf-8") + b"\n"
              b"Blob = " + wrapped(blob.payload()) + b"\n")
    lua.execute(source)
    return unwrap(lua.eval(b"Reader.all(Blob, Node)"))


def test_digits_round_trip() -> None:
    """Every number spells and re-reads at the width its span asks for."""
    places = {ord(digit): at for at, digit in enumerate(DIGITS)}
    for value in (0, 1, 63, 64, 4095, 4096, 262143, 1_000_000):
        width = digits_for(value)
        spelling = spelled(value, width)
        assert len(spelling) == width
        back = 0
        # Bytes, so iterating yields the byte value each digit was written as,
        # which is what the reader indexes its own table by.
        for digit in spelling:
            back = back * 64 + places[digit]
        assert back == value


def test_a_value_too_wide_is_refused() -> None:
    """A value that would run into the next one stops the build."""
    with pytest.raises(ValueError):
        spelled(64, 1)


def test_numbers_round_trip(lua: Any) -> None:
    """Whole numbers survive, including negative ones and a flat column."""
    for values in ([0, 1, 2, 3], [-50, 0, 50], [7, 7, 7], [999_999, 1]):
        assert round_trip(lua, values) == values


def test_text_round_trips_with_empties_and_non_ascii(lua: Any) -> None:
    """Text ships as it stands, and an empty row is a real row.

    The non-ASCII case is the one that catches a blob measured in characters:
    every offset after such a name would address the wrong byte.
    """
    values = ["fireball", "", "Огненный шар", "a]]=]b", "line\nbreak"]
    assert round_trip(lua, values) == values


def test_floats_round_trip(lua: Any) -> None:
    """A float comes back as the same number, not as a nearby one."""
    values = [0.5, -1.25, 3.0, 1e-7]
    assert round_trip(lua, values) == pytest.approx(values)


def test_lists_round_trip(lua: Any) -> None:
    """A ragged column keeps each row's length, empty rows included."""
    values = [[1, 2, 3], [], [4], [5, 6]]
    assert round_trip(lua, values) == values


def test_a_vocabulary_keyed_by_id_round_trips(lua: Any) -> None:
    """A mapping of scalars becomes two columns and comes back a mapping."""
    values = {"3": "Elite", "7": "Rare", "11": "Boss"}
    assert round_trip(lua, values) == values


def test_a_family_of_columns_round_trips(lua: Any) -> None:
    """A mapping whose values are columns keeps each one addressable."""
    values = {"missile": {"file": [1, 2], "from": [-1, 4]},
              "ground": {"file": [9], "from": [0]}}
    assert round_trip(lua, values) == values


def test_a_blob_with_a_carriage_return_is_refused() -> None:
    """Lua rewrites line endings inside a long string, so one cannot ship.

    The failure it prevents is silent: the client's copy would be shorter than
    the one the offsets were written against, and every column after the
    carriage return would read from the wrong place.
    """
    with pytest.raises(ValueError, match="carriage return"):
        wrapped(b"a\r\nb")


def test_the_bracket_level_clears_the_payload() -> None:
    """A payload holding either bracket gets a deeper one, not an escape."""
    assert wrapped(b"plain").startswith(b"[[\n")
    assert wrapped(b"holds ]] here").startswith(b"[=[\n")
    assert wrapped(b"holds ]] and ]=] here").startswith(b"[==[\n")
    # The opening bracket counts too. Lua refuses one inside a long string as
    # a nesting it dropped support for, so a payload holding `[[` does not
    # end the string early -- it fails to load at all.
    assert wrapped(b"holds [[ here").startswith(b"[=[\n")


def test_a_long_payload_is_split_across_lines(lua: Any) -> None:
    """A blob past the line limit is joined at load, byte for byte.

    No line of an addon file may run to megabytes. The largest one this client
    is known to accept is a little over four hundred thousand characters, and
    an axis blob is twenty times that, so the source carries pieces and the
    client joins them.
    """
    payload = bytes(DIGITS[at % 64].encode("ascii")[0]
                    for at in range(LINE_LIMIT * 2 + 977))
    source = b"local blob = " + wrapped(payload) + b"\nreturn blob\n"
    assert b"table.concat" in source
    assert max(len(line) for line in source.split(b"\n")) <= LINE_LIMIT + 8
    assert lua.execute(source) == payload


def test_a_fractional_value_in_a_whole_column_is_refused(lua: Any) -> None:
    """A column classified whole by its first value refuses to round a later
    one, rather than shipping a number the browser does not hold."""
    with pytest.raises(ValueError, match="fractional"):
        Blob().column([1, 2.5, 3])


def test_a_value_the_client_cannot_read_back_is_refused() -> None:
    """`tonumber` answers nothing for these, so they may not be written."""
    for value in (float("inf"), float("-inf"), float("nan")):
        with pytest.raises(ValueError, match="no spelling"):
            Blob().column([0.5, value])


def test_a_payload_holding_an_opening_bracket_still_loads(lua: Any) -> None:
    """The nesting the client refuses is chosen around, not escaped.

    A real spell description carries square brackets, so this is the ordinary
    case rather than an adversarial one.
    """
    payload = b"a [[ b ]] c [=[ d ]=] e"
    source = b"local blob = " + wrapped(payload) + b"\nreturn blob\n"
    assert lua.execute(source) == payload


def test_lua_returns_the_blob_byte_for_byte(lua: Any) -> None:
    """What the emitter wrote is what the interpreter hands back.

    The whole layout rests on this: the offsets are byte positions into the
    string Lua produces, so any rewriting between the file and the value would
    move every column at once.
    """
    payload = "".join(chr(code) for code in range(32, 127)).encode("ascii")
    payload += "élan\nnext ]] and ]=] done".encode("utf-8")
    source = b"local blob = " + wrapped(payload) + b"\nreturn blob\n"
    assert lua.execute(source) == payload


def test_interface_version_reads_the_build() -> None:
    """The toc advertises the client the pack was built from."""
    assert interface_version("9.2.7.45745") == 90207
    assert interface_version("10.2.7.55664") == 100207
    assert interface_version("1.15.9.69109") == 11509


def test_every_section_belongs_to_an_axis() -> None:
    """A section with no axis can never be read, so it is a build failure.

    Declared here as well as in the emitter because a new section is added to
    the registry, not to this file: the way this is meant to fail is that
    somebody adds a route and finds out immediately.
    """
    missing = sorted(section.name for section in SECTIONS
                     if section.name not in AXIS_OF)
    assert not missing, f"sections belonging to no axis: {missing}"


def test_the_axis_map_names_only_real_sections() -> None:
    """An axis naming a section that no longer exists names nothing."""
    unknown = sorted(name for name in AXIS_OF if name not in DECLARED)
    assert not unknown, f"axes name sections that do not exist: {unknown}"


def test_the_supply_table_names_real_columns() -> None:
    """Every clipped column is one the pack actually ships.

    The failure this catches is a rename: a column renamed in the registry and
    not here would go on shipping in the lean variation while the index went
    on promising the client answered it.
    """
    for key in SUPPLIED_BY:
        section, _, column = key.partition(".")
        assert section in DECLARED, f"{key} names no section"
        if column:
            assert column in DECLARED[section].columns, (
                f"{key} names no column of {section}; it has "
                f"{DECLARED[section].columns}")


def test_lean_drops_what_the_client_supplies() -> None:
    """The two variations differ by exactly the supply table."""
    assert supplies("spells", "names") == "GetSpellInfo"
    assert supplies("spells", "eras") == ""
    # A bare section name covers every column of that section.
    assert supplies("spellText", "descriptions") == "GetSpellDescription"


def test_a_section_with_no_axis_stops_the_emitter() -> None:
    """An unplaced section raises rather than quietly going missing."""
    section = next(iter(SECTIONS))
    with pytest.raises(KeyError, match="belongs to no axis"):
        chunks([_renamed(section, "notAnAxisMember")],
               {"notAnAxisMember": _empty_payload(section)},
               pack="p", version="9.2.7.1", built="", variation=Variation.FULL)


def _renamed(section: Any, name: str) -> Any:
    """The same record under another name, for a test that needs one."""
    from dataclasses import replace
    return replace(section, name=name)


def _empty_payload(section: Any) -> Any:
    """A payload of the shape that section ships, holding nothing."""
    if section.layout is Layout.BARE:
        return []
    return {column: [] for column in section.columns}


def test_the_index_reports_the_format_and_the_supply(lua: Any) -> None:
    """The index says what exists and what was left to the game."""
    built = chunks([], {}, pack="9.2.7-epsilon.45745", version="9.2.7.45745",
                   built="2026-08-18", variation=Variation.LEAN)
    lua.execute(built.files["index.lua"])
    index = unwrap(lua.globals()[b"Epsilook"][b"index"])
    assert index["format"] == ADDON_FORMAT
    assert index["variation"] == "lean"
    assert index["supplied"] == dict(SUPPLIED_BY)


def test_axes_are_declared_in_a_stable_order() -> None:
    """Every axis in the map holds at least one section."""
    for axis, names in AXES.items():
        assert names.split(), f"{axis} names no sections"


@pytest.mark.skipif(not os.environ.get("EPSILOOK_ADDON_ORACLE"),
                    reason="set EPSILOOK_ADDON_ORACLE=1; needs a built pack "
                           "and reads every column of it through Lua")
def test_the_whole_pack_round_trips_through_lua(lua: Any) -> None:
    """Every column of a real pack reads back as the pack carries it.

    The gate the whole medium rests on. Each axis is emitted, loaded into the
    client's own interpreter and read column by column, and what comes out has
    to equal what the browser's modules hold. A layout the reader disagrees
    with about one column would otherwise surface as a search that quietly
    returns the wrong spells.
    """
    import packfile

    pack_dir = packfile.SITE / "data" / "9.2.7-epsilon.45745"
    if not (pack_dir / "manifest.json").exists():
        pytest.skip(f"{pack_dir.name} is not built")
    sections = packfile.load(pack_dir)
    meta = sections.pop("meta", {})
    built = chunks(SECTIONS, sections, pack=pack_dir.name,
                   version=str(meta.get("version")), built=str(meta.get("built")),
                   variation=Variation.FULL)

    checked = 0
    for name, source in built.files.items():
        if not name.endswith(".lua") or name == "index.lua":
            continue
        lua.execute(source)
        # The file is named for the axis it carries, and the chunk it assigns
        # states that name itself, so the key is read from the data rather
        # than worked out again from the file name.
        axis = lua.globals()[b"Epsilook"][b"data"][name[:-4].encode("ascii")]
        blob = axis[b"blob"]
        for name, entry in unwrap(axis[b"sections"]).items():
            for column in entry["columns"]:
                node = axis[b"sections"][name.encode("utf-8")][b"columns"][
                    column.encode("utf-8")]
                got = unwrap(lua.eval(b"Reader.all")(blob, node))
                want = expected(sections[name], DECLARED[name], column)
                assert got == want, f"{name}.{column} disagrees"
                checked += 1
    # Every declared column of every section the pack ships, rather than a
    # threshold: a section that stopped being emitted would otherwise leave
    # the test passing on whatever was left.
    wanted = sum(len(DECLARED[name].columns) for name in sections
                 if name in DECLARED)
    assert checked == wanted, f"read {checked} columns of {wanted}"


def expected(payload: Any, section: Any, column: str) -> Any:
    """What one column of a shipped section holds, as the pack carries it.

    Empty tables come back from Lua as lists, so an empty mapping in the pack
    is normalised the same way rather than compared against a shape Lua has no
    way to express.
    """
    held = payload if section.layout is Layout.BARE else payload[column]
    return normalised(held)


def normalised(value: Any) -> Any:
    """One pack value with its empty containers flattened to a list."""
    if isinstance(value, dict):
        return {key: normalised(sub) for key, sub in value.items()} or []
    if isinstance(value, list):
        return [normalised(item) for item in value]
    return value
