"""Module assembly and the manifest, built from plain values.

No source is stood up here: emit is handed encoded sections and produces bytes,
which is what lets the sharing rule be tested by declaring two builds rather
than by running two.
"""

from __future__ import annotations

import gzip
import io
import json

import pytest

from pack.emit.manifest import manifest, shared
from pack.emit.module import DIGEST_LENGTH, assemble, encode
from pack.model.section import Scope, Section


def a_section(name: str, module: str, scope: Scope = Scope.PER_BUILD) -> Section:
    """A section carrying only what emit reads off it."""
    return Section(name=name, doc="", module=module,
                   produce=lambda _: {}, columns=(), scope=scope)


def test_a_module_is_named_by_its_own_bytes() -> None:
    sections = [a_section("animNames", "names")]
    modules = assemble(sections, {"animNames": ["Stand"]})
    assert len(modules) == 1
    assert modules[0].filename == f"names-{modules[0].digest}.json.gz"
    assert len(modules[0].digest) == DIGEST_LENGTH


def test_two_builds_with_the_same_content_produce_the_same_file() -> None:
    """The whole sharing mechanism. Nothing arranges this and nothing declares
    it per pair of builds: identical bytes name one file, so it is written once
    and both manifests point at it.
    """
    sections = [a_section("animNames", "names", Scope.UNIVERSAL)]
    first = assemble(sections, {"animNames": ["Stand", "Death"]})
    second = assemble(sections, {"animNames": ["Stand", "Death"]})
    assert first[0].filename == second[0].filename
    assert first[0].payload == second[0].payload


def test_a_build_that_diverges_gets_its_own_file() -> None:
    """Sharing is not a promise the declaration makes. A section declared
    universal that stops agreeing across builds references its own variant,
    with no special case and no failure.
    """
    sections = [a_section("animNames", "names", Scope.UNIVERSAL)]
    first = assemble(sections, {"animNames": ["Stand"]})
    second = assemble(sections, {"animNames": ["Stand", "Fidget"]})
    assert first[0].filename != second[0].filename


def test_sections_sharing_a_module_land_in_one_file() -> None:
    sections = [a_section("animNames", "names"), a_section("auraNames", "names")]
    modules = assemble(sections, {"animNames": ["Stand"], "auraNames": {"1": "Haste"}})
    assert len(modules) == 1
    # the payload is what ships, so read it back the way the app would
    with gzip.open(io.BytesIO(modules[0].payload), "rt", encoding="utf-8") as handle:
        assert json.load(handle) == {"animNames": ["Stand"], "auraNames": {"1": "Haste"}}


def test_a_section_its_build_lacks_is_left_out_rather_than_shipped_empty() -> None:
    """An empty column reads as "nothing matches", which is a different claim
    from "this build never had it" -- the manifest carries the second.
    """
    sections = [a_section("animNames", "names"), a_section("spellAreas", "core")]
    modules = assemble(sections, {"animNames": ["Stand"]})
    assert [module.name for module in modules] == ["names"]


def test_modules_keep_registry_order() -> None:
    sections = [a_section("b", "second"), a_section("a", "first")]
    modules = assemble(sections, {"a": [], "b": []})
    assert [module.name for module in modules] == ["second", "first"]


def test_one_module_cannot_be_two_scopes() -> None:
    """It is written once and referenced by whoever wants it, so a module that
    is per-build for one section and universal for another has no meaning.
    """
    sections = [a_section("animNames", "names", Scope.UNIVERSAL),
                a_section("spells", "names", Scope.PER_BUILD)]
    with pytest.raises(ValueError, match="names"):
        assemble(sections, {"animNames": [], "spells": []})


def test_a_produced_section_the_registry_does_not_declare_is_an_error() -> None:
    """Dropping it silently would lose a route's whole output with nothing to
    notice: the section would simply never appear in any module.
    """
    with pytest.raises(ValueError, match="spellAreas"):
        assemble([a_section("animNames", "names")],
                 {"animNames": [], "spellAreas": [1, 2]})


def test_encoding_is_deterministic_whatever_order_the_keys_arrived_in() -> None:
    """The bytes name the file, so an encoder that varied would rename every
    module on every rebuild and re-ship a pack that did not change.
    """
    assert encode({"a": [1], "b": [2]}) == encode({"b": [2], "a": [1]})


def test_the_manifest_names_the_files_and_what_the_build_lacks() -> None:
    modules = assemble([a_section("animNames", "names")], {"animNames": []})
    entry = manifest("9.2.7.45745", modules, absent=["spellAreas", "areas"])
    assert entry["build"] == "9.2.7.45745"
    assert entry["modules"] == {"names": modules[0].filename}
    assert entry["absentSections"] == ["areas", "spellAreas"]


def test_sharing_is_read_back_off_the_manifests() -> None:
    """What is shared is a fact of the documents, not of the declaration, so it
    is measured the same way the app would see it.
    """
    sections = [a_section("animNames", "names", Scope.UNIVERSAL)]
    common = assemble(sections, {"animNames": ["Stand"]})
    lonely = assemble(sections, {"animNames": ["Stand", "Fidget"]})
    entries = [manifest("9.2.7", common), manifest("10.2.7", common),
               manifest("1.15.9", lonely)]
    assert shared(entries) == {common[0].filename: ["10.2.7", "9.2.7"]}
