"""What a pack's manifest says about its modules and what it lacks."""

from __future__ import annotations

from pack.emit.manifest import manifest
from pack.emit.module import absent_sections, assemble
from pack.model.section import Section


def a_section(name: str, module: str) -> Section:
    """A section carrying only what emit reads off it."""
    return Section(name=name, doc="", module=module, produce=lambda _: {}, columns=())


def test_the_manifest_names_each_module_file_and_its_size() -> None:
    """The size travels with the name so a deploy can be checked against what
    was built without fetching every module.
    """
    modules = assemble([a_section("animNames", "names")], {"animNames": ["Stand"]})
    entry = manifest("9.2.7.45745", modules)
    assert entry["pack"] == "9.2.7.45745"
    assert entry["modules"] == {
        "names": {"file": modules[0].filename, "bytes": len(modules[0].payload)}}


def test_what_the_build_lacks_is_read_from_the_one_place_that_knows() -> None:
    """`absent_sections` decides it and `assemble` acts on the same rule, so a
    manifest cannot report a section absent while a module carries it.
    """
    sections = [a_section("animNames", "names"), a_section("spellAreas", "core")]
    produced: dict[str, object] = {"animNames": ["Stand"]}
    entry = manifest("1.15.9.69109", assemble(sections, produced),
                     absent_sections(sections, produced))
    assert entry["absentSections"] == ["spellAreas"]


def test_two_packs_that_serialised_alike_name_the_same_file() -> None:
    """Sharing is a fact of the documents rather than of the declaration, and
    this is where it becomes visible: nothing else records that two packs have
    anything in common.
    """
    sections = [a_section("animNames", "names")]
    modules = assemble(sections, {"animNames": ["Stand"]})
    first = manifest("9.2.7.45745", modules)
    second = manifest("10.2.7.55664", modules)
    assert first["modules"] == second["modules"]
    assert first["pack"] != second["pack"]
