"""What a pack's manifest says about its modules, its languages and what it lacks."""

from __future__ import annotations

import json

from pack.emit.manifest import carry_forward, manifest, rendered
from pack.emit.module import Module, absent_sections, assemble
from pack.model.section import Section


def a_section(name: str, module: str, *, columns: tuple[str, ...] = (), localizable: tuple[str, ...] = ()) -> Section:
    """A section carrying only what emit reads off it."""
    return Section(name=name, doc="", module=module, produce=lambda _: {}, columns=columns, localizable=localizable)


def a_spoken_section(name: str) -> Section:
    """A section whose names ship in one language and whose ids ship in all."""
    return a_section(name, "core", columns=("ids", "names"), localizable=("names",))


def a_pack(locale: str = "enUS", name: str = "Steed") -> list[Module]:
    """One build's modules: a structure module and one language's names."""
    return assemble([a_spoken_section("mounts")], {"mounts": {"ids": [1], "names": [name]}}, locale=locale)


def spoken_only(locale: str, name: str) -> list[Module]:
    """The same build read in another language: its names alone."""
    return [module for module in a_pack(locale, name) if module.locale]


def test_the_manifest_names_each_module_file_and_its_size() -> None:
    """The size travels with the name so a deploy can be checked against what
    was built without fetching every module.
    """
    modules = assemble([a_section("animNames", "core")], {"animNames": ["Stand"]})
    entry = manifest("9.2.7.45745", modules)
    assert entry["pack"] == "9.2.7.45745"
    assert entry["modules"] == {"core": {"file": modules[0].filename, "bytes": len(modules[0].payload)}}


def test_a_module_is_named_where_it_was_written() -> None:
    """The writer chooses the layout, so the manifest states it rather than
    leaving a reader to rebuild the same path from a constant of its own.
    """
    modules = assemble([a_section("animNames", "core")], {"animNames": ["Stand"]})
    entry = manifest("9.2.7.45745", modules, location="data/modules")
    named = entry["modules"]
    assert isinstance(named, dict)
    assert named["core"]["file"] == f"data/modules/{modules[0].filename}"


def test_the_manifest_states_the_pack_before_anything_is_fetched() -> None:
    """The format decides whether a reader can use the pack at all, so learning
    it must not cost the download it would rule out.
    """
    modules = assemble([a_section("animNames", "core")], {"animNames": ["Stand"]})
    entry = manifest("9.2.7.45745", modules, {"format": 53, "built": "2026-08-15"})
    assert entry["meta"] == {"format": 53, "built": "2026-08-15"}


def test_a_language_is_named_apart_from_the_structure() -> None:
    """Choosing a language is choosing one entry of `locales` and changes
    nothing about `modules`, which is what makes the structure fetched once.
    """
    entry = manifest("9.2.7.45745", [*a_pack("enUS"), *spoken_only("ruRU", "Скакун")])
    modules, locales = entry["modules"], entry["locales"]
    assert isinstance(modules, dict) and isinstance(locales, dict)
    assert list(modules) == ["core"]
    assert sorted(locales) == ["enUS", "ruRU"]
    assert list(locales["enUS"]) == ["names"]
    assert locales["enUS"]["names"]["file"] != locales["ruRU"]["names"]["file"]


def test_two_languages_that_serialised_alike_name_one_file() -> None:
    """The sharing rule does not stop at the language boundary, and it should
    not: a module is named by what is in it, and two languages holding the same
    words hold the same file.
    """
    entry = manifest("1.15.9.69109", [*a_pack("enUS"), *spoken_only("ruRU", "Steed")])
    locales = entry["locales"]
    assert isinstance(locales, dict)
    assert locales["enUS"]["names"]["file"] == locales["ruRU"]["names"]["file"]


def test_a_pack_in_one_language_names_that_one() -> None:
    """A build whose translated tables never came back ships the default alone
    rather than an empty entry a reader would have to test for.
    """
    locales = manifest("3.4.3.58936", a_pack("enUS"))["locales"]
    assert isinstance(locales, dict)
    assert list(locales) == ["enUS"]


def test_two_packs_on_one_build_differ_only_in_the_manifest() -> None:
    """What separates a test line from the live line it shadows is its label,
    and the label is meta -- so keeping meta out of the modules is what lets
    the two share the largest file there is instead of copying it.
    """
    modules = a_pack()
    live = manifest("12.1.0.69273", modules, {"label": "Midnight 12.1.0"})
    test = manifest("12.1.0-ptr.69273", modules, {"label": "Midnight PTR 12.1.0"})
    assert live["modules"] == test["modules"]
    assert live["locales"] == test["locales"]
    assert live["meta"] != test["meta"]


def test_what_the_build_lacks_is_read_from_the_one_place_that_knows() -> None:
    """`absent_sections` decides it and `assemble` acts on the same rule, so a
    manifest cannot report a section absent while a module carries it.
    """
    sections = [a_section("animNames", "core"), a_section("spellAreas", "universal")]
    produced: dict[str, object] = {"animNames": ["Stand"]}
    entry = manifest("1.15.9.69109", assemble(sections, produced), absent=absent_sections(sections, produced))
    assert entry["absentSections"] == ["spellAreas"]


WHOLE = {
    "pack": "9.2.7.45745",
    "meta": {
        "format": 54,
        "built": "2026-08-01",
        "counts": {"spells": 276332, "spellDescriptions": 128374},
        "domains": {"casttime": {"min": 0}},
        "degradedSections": {"morphs": ["creature_template"], "spellText": ["SpellScaling"]},
    },
    "modules": {
        "core": {"file": "core-aa.json.gz", "bytes": 7},
        "universal": {"file": "universal-bb.json.gz", "bytes": 3},
    },
    "locales": {
        "enUS": {"names": {"file": "names-cc.json.gz", "bytes": 2}, "text": {"file": "text-dd.json.gz", "bytes": 4}}
    },
    "absentSections": ["keybinds", "spellText"],
}
"""A whole pack's manifest, as a partial build would find it on disk."""

HOME = {"keybinds": "core", "spellText": "text", "morphs": "core", "spells": "core"}
"""Which module each section ships in, as the registry would answer."""


def test_a_partial_build_keeps_every_claim_about_what_it_did_not_touch() -> None:
    """The unbuilt modules' files are untouched on disk, so their entries, their
    counts and what is absent or thin in them are all still true and must all
    survive -- writing the partial manifest alone would replace a whole pack
    with a partial one."""
    fresh = {
        "pack": "9.2.7.45745",
        "meta": {
            "format": 54,
            "built": "2026-08-16",
            "counts": {"spellDescriptions": 130000},
            "domains": {},
            "degradedSections": {},
        },
        "modules": {},
        "locales": {"enUS": {"text": {"file": "text-ee.json.gz", "bytes": 5}}},
        "absentSections": [],
    }
    merged = carry_forward(fresh, WHOLE, frozenset({"text"}), HOME)
    assert merged["modules"] == WHOLE["modules"]
    locales = merged["locales"]
    assert isinstance(locales, dict)
    assert locales["enUS"]["names"]["file"] == "names-cc.json.gz"
    assert locales["enUS"]["text"]["file"] == "text-ee.json.gz"
    meta = merged["meta"]
    assert isinstance(meta, dict)
    assert meta["built"] == "2026-08-16"
    assert meta["counts"] == {"spells": 276332, "spellDescriptions": 130000}
    assert meta["domains"] == {"casttime": {"min": 0}}
    # The morphs claim stands -- core was not rebuilt -- and the spellText one
    # is the fresh pass's to make, which made none.
    assert meta["degradedSections"] == {"morphs": ["creature_template"]}
    # keybinds ships in core, untouched, so its absence is carried; spellText
    # was just rebuilt and produced, so its absence is gone.
    assert merged["absentSections"] == ["keybinds"]


def test_a_rebuilt_module_speaks_for_itself() -> None:
    """Whatever the fresh pass says about a module it built replaces the old
    claim outright, absence included."""
    fresh = {
        "pack": "9.2.7.45745",
        "meta": {
            "format": 54,
            "counts": {},
            "domains": {},
            "degradedSections": {"morphs": ["creature_template", "GameObjectDisplayInfo"]},
        },
        "modules": {"core": {"file": "core-ff.json.gz", "bytes": 9}},
        "locales": {"enUS": {"names": {"file": "names-gg.json.gz", "bytes": 1}}},
        "absentSections": ["morphDisplays"],
    }
    merged = carry_forward(fresh, WHOLE, frozenset({"core", "names"}), HOME)
    modules = merged["modules"]
    assert isinstance(modules, dict)
    assert modules["core"]["file"] == "core-ff.json.gz"
    assert modules["universal"]["file"] == "universal-bb.json.gz"
    meta = merged["meta"]
    assert isinstance(meta, dict)
    assert meta["degradedSections"]["morphs"] == ["creature_template", "GameObjectDisplayInfo"]
    # keybinds ships in the rebuilt core and the fresh pass did not call it
    # absent, so the carried claim is dropped; spellText's module was untouched.
    assert merged["absentSections"] == ["morphDisplays", "spellText"]


def test_the_rendered_manifest_parses_back_to_the_same_document() -> None:
    """The shape on disk is a presentation choice and nothing else: a reader
    must get the identical document however it was laid out."""
    entry = manifest(
        "9.2.7.45745",
        a_pack("enUS"),
        {"format": 54, "counts": {"spells": 276332, "morphs": 9}, "domains": {"scale": {"min": -99, "max": 900}}},
    )
    assert json.loads(rendered(entry)) == entry


def test_a_leaf_sits_on_one_line_and_the_skeleton_is_still_indented() -> None:
    """The manifest is the one artifact file the repository diffs, so a rebuild
    must show one changed line per entry that moved -- not hundreds of lines of
    re-indented counts. The skeleton stays open so the file is still a document
    a person can skim."""
    entry = manifest(
        "9.2.7.45745",
        a_pack("enUS"),
        {
            "format": 54,
            "counts": {"spells": 276332, "morphs": 9},
            "domains": {"scale": {"min": -99}, "speed": {"min": 0}},
        },
    )
    lines = rendered(entry).splitlines()
    (counts,) = (line for line in lines if '"counts"' in line)
    assert '"spells": 276332' in counts and '"morphs": 9' in counts
    (core,) = (line for line in lines if '"core"' in line)
    assert '"file"' in core and '"bytes"' in core
    assert sum(1 for line in lines if '"min"' in line) == 2
    assert '"meta": {' in "\n".join(lines)


def test_two_packs_that_serialised_alike_name_the_same_file() -> None:
    """Sharing is a fact of the documents rather than of the declaration, and
    this is where it becomes visible: nothing else records that two packs have
    anything in common.
    """
    modules = a_pack()
    first = manifest("9.2.7.45745", modules)
    second = manifest("10.2.7.55664", modules)
    assert first["modules"] == second["modules"]
    assert first["locales"] == second["locales"]
    assert first["pack"] != second["pack"]
