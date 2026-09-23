"""The route reference: every field and section is described once, drawn in full
once, and every link in it lands.

The graph laws are pinned on plain values, a few fields and sections written
out, because what is under test is where a field is drawn and not any route
behind it. The document laws are pinned on the real registries, since what
matters there is that the page the build writes holds together.
"""

from __future__ import annotations

import importlib
import re
import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

import pytest

from pack.emit.reference import (
    OTHER,
    SHARED_AT,
    Chapter,
    Field,
    Node,
    Reference,
    Shipped,
    attribute_notes,
    document,
    drawn,
    homed,
    slug,
    split_doc,
    table,
)
from pack.pipeline import route_reference


def field(name: str, needs: Sequence[str] = (), tables: Sequence[str] = ()) -> Field:
    """A field reading the tables and fields named, and nothing else."""
    return Field(name, name, "", False, "map", tuple(tables), (), tuple(needs), (), (), "routes/flows.py")


def section(name: str, family: str, reads: Sequence[str]) -> Shipped:
    """A section of one family, mapping from the fields named."""
    return Shipped(name, name, family, "core", tuple(reads), False, (), (), ())


def graph(
    fields: Sequence[Field], sections: Sequence[Shipped], families: Sequence[str]
) -> tuple[dict[str, Field], dict[str, Shipped], dict[str, str], tuple[Chapter, ...]]:
    """The two registries by name, and where `homed` puts each field."""
    by_field = {each.name: each for each in fields}
    by_section = {each.name: each for each in sections}
    homes, groups = homed(by_field, by_section, families)
    return by_field, by_section, homes, groups


def test_a_field_one_family_reads_is_drawn_in_that_family() -> None:
    _, _, homes, groups = graph(
        [field("names", tables=["SpellName"])],
        [section("spells", "spells family", ["names"])],
        ["spells family"],
    )
    assert homes == {"names": "spells family"}
    assert groups == ()


def test_a_section_made_of_one_field_outweighs_one_gathering_many() -> None:
    """Two families read the field once each; the section built from it alone
    claims it over the section that gathers it with two others."""
    _, _, homes, _ = graph(
        [field("kit_names"), field("factions"), field("skills")],
        [
            section("referenceNames", "mechanics family", ["kit_names", "factions", "skills"]),
            section("soundKitNames", "sounds family", ["kit_names"]),
        ],
        ["mechanics family", "sounds family"],
    )
    assert homes["kit_names"] == "sounds family"


def test_a_field_reaching_many_families_is_shared_and_drawn_with_what_it_feeds() -> None:
    families = [f"f{at} family" for at in range(SHARED_AT)]
    fields = [field("kit_glows", tables=["SpellVisualKitEffect"]), field("kits", needs=["kit_glows"])]
    sections = [section(f"s{at}", family, ["kits"]) for at, family in enumerate(families)]
    _, _, homes, groups = graph(fields, sections, families)
    assert homes == {"kit_glows": "kits group", "kits": "kits group"}
    assert [chapter.heading for chapter in groups] == ["kits group"]


def test_a_shared_field_alone_in_its_group_joins_the_others_like_it() -> None:
    families = [f"f{at} family" for at in range(SHARED_AT)]
    sections = [section(f"s{at}", family, ["names", "icons"]) for at, family in enumerate(families)]
    _, _, homes, groups = graph([field("names"), field("icons")], sections, families)
    assert homes == {"icons": OTHER, "names": OTHER}
    assert [chapter.fields for chapter in groups] == [("icons", "names")]


def test_a_field_no_section_reaches_has_no_home() -> None:
    _, _, homes, _ = graph([field("weapon_trails")], [], [])
    assert homes == {}


def test_a_stub_is_drawn_without_what_it_reads() -> None:
    """A field at home elsewhere stands in for its chapter: drawing its tables
    here too would draw the trunk in every family that touches it."""
    fields, sections, homes, groups = graph(
        [field("shared", tables=["Hidden"]), field("other"), field("local", ["shared", "other"], ["Shown"])],
        [section("one", "a family", ["local"]), section("two", "b family", ["shared"])],
        ["a family", "b family"],
    )
    assert homes == {"local": "a family", "other": "a family", "shared": "b family"}
    ref = Reference(fields, sections, (), groups, {"Hidden": "client", "Shown": "client"}, homes, {}, "test")
    diagram = drawn(ref, Chapter("a family", "", "", ("one",), ()))
    assert "t_Shown --> f_local" in diagram
    assert "f_shared --> f_local" in diagram
    assert "Hidden" not in diagram
    assert "class f_shared elsewhere" in diagram


def test_a_field_and_a_section_of_one_name_are_two_nodes() -> None:
    fields, sections, homes, groups = graph(
        [field("creatures", tables=["creature_template"])],
        [section("creatures", "entities family", ["creatures"])],
        ["entities family"],
    )
    ref = Reference(fields, sections, (), groups, {"creature_template": "server"}, homes, {}, "test")
    diagram = drawn(ref, Chapter("entities family", "", "", ("creatures",), ()))
    assert "f_creatures --> s_creatures" in diagram
    assert "class t_creature_template server" in diagram


def test_the_graph_walks_both_ways() -> None:
    fields, sections, homes, groups = graph(
        [field("kits", tables=["SpellVisualKit"]), field("visuals", needs=["kits.rows"])],
        [section("fxRows", "rows family", ["visuals"])],
        ["rows family"],
    )
    ref = Reference(fields, sections, (), groups, {"SpellVisualKit": "client"}, homes, {}, "test")
    assert ref.upstream(Node("section", "fxRows")) == [
        Node("field", "visuals"),
        Node("field", "kits"),
        Node("table", "SpellVisualKit"),
    ]
    assert ref.downstream(Node("table", "SpellVisualKit"))[-1] == Node("section", "fxRows")


def test_a_docstring_documents_the_run_of_assignments_written_above_it(tmp_path: Path) -> None:
    source = tmp_path / "declared_fixture.py"
    source.write_text(
        'lone = 1\n"""The lone one."""\n\nleft = 2\nright = 3\n"""The pair."""\n\nbare = 4\n\nafter = 5\n',
        encoding="utf-8",
    )
    sys.path.insert(0, str(tmp_path))
    try:
        notes = attribute_notes(importlib.import_module("declared_fixture"))
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("declared_fixture", None)
    assert notes == {"lone": "The lone one.", "left": "The pair.", "right": "The pair."}


def test_a_docstring_opens_with_its_first_sentence_and_stops_at_its_arguments() -> None:
    title, rest = split_doc(
        """Animations: the kits, and how to perform one.

        Four routes reach an animation.

        Args:
            version: the build.
        """
    )
    assert title == "Animations: the kits, and how to perform one."
    assert rest == "Four routes reach an animation."


def test_a_table_is_padded_to_its_widest_cell() -> None:
    lines = table(("name", "count"), [("a", "1"), ("longer", "12,345")], right=(1,)).splitlines()
    assert len({len(line) for line in lines}) == 1
    assert lines[1].endswith(":|")


@pytest.fixture(scope="module")
def reference() -> Reference:
    """The reference over the real registries, with numbers nobody reads."""
    return route_reference({}, "test")


@pytest.fixture(scope="module")
def written(reference: Reference) -> str:
    return document(reference)


def diagrams(text: str) -> Iterator[str]:
    """Every diagram's source in a document."""
    yield from re.findall(r"```mermaid\n(.*?)```", text, re.S)


def test_every_field_has_one_entry_and_every_section_one_row(reference: Reference, written: str) -> None:
    entries = re.findall(r"^#### `(\w+)`$", written, re.M)
    assert sorted(entries) == sorted(reference.fields)
    for name in reference.sections:
        rows = re.findall(rf"^\| `{name}` +\|", written, re.M)
        assert len(rows) == 1, f"{name} has {len(rows)} rows"


def test_every_reached_field_is_drawn_in_full_exactly_once(reference: Reference, written: str) -> None:
    """Drawn in full means drawn in the field colour; a stub is grey. Once and
    only once, or a reader cannot tell which diagram to trust."""
    drawn_in_full: list[str] = []
    for source in diagrams(written):
        for line in re.findall(r"^    class (\S+) field$", source, re.M):
            drawn_in_full += [member.removeprefix("f_") for member in line.split(",") if member.startswith("f_")]
    legend = {"flow", "computed"}
    counted = [name for name in drawn_in_full if name not in legend]
    assert sorted(counted) == sorted(reference.homes)


def test_every_link_in_the_page_lands_on_a_heading(written: str) -> None:
    anchors = {slug(heading) for heading in re.findall(r"^#+ (.+)$", written, re.M)}
    anchors |= {slug(heading.strip("`")) for heading in re.findall(r"^#### (`\w+`)$", written, re.M)}
    targets = set(re.findall(r"\]\(#([\w-]+)\)", written))
    assert targets - anchors == set()


def test_no_prose_line_runs_past_the_markdown_width(written: str) -> None:
    """Tables and diagrams excepted: a table is as wide as its widest cell, and
    a diagram line is code."""
    fenced = False
    for line in written.splitlines():
        if line.startswith("```"):
            fenced = not fenced
            continue
        if not fenced and not line.startswith("|"):
            assert len(line) <= 120 or " " not in line, line


def test_a_description_ends_its_sentence_once(written: str) -> None:
    """A computation's docstring ends its own first sentence and a flow's
    description does not; the page ends both exactly once."""
    assert re.search(r"[\w`]\.\.(\s|$)", written) is None


def test_the_page_is_the_same_page_every_time(reference: Reference, written: str) -> None:
    assert document(reference) == written
