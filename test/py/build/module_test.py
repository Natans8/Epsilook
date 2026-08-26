"""Module assembly and content addressing, built from plain values.

No source is stood up here: emit is handed serialised sections and produces
bytes, which is what lets the sharing rule be tested by declaring two builds
rather than by running two.
"""

from __future__ import annotations

import gzip
import io
import json

import pytest

from pack.emit.module import DIGEST_LENGTH, absent_sections, assemble, serialize
from pack.model.section import Scope, Section


def a_section(
    name: str,
    module: str,
    scope: Scope = Scope.PER_BUILD,
    *,
    columns: tuple[str, ...] = (),
    localizable: tuple[str, ...] = (),
) -> Section:
    """A section carrying only what emit reads off it."""
    return Section(
        name=name, doc="", module=module, produce=lambda _: {}, columns=columns, localizable=localizable, scope=scope
    )


def test_a_module_is_named_by_its_own_bytes() -> None:
    modules = assemble([a_section("animNames", "core")], {"animNames": ["Stand"]})
    assert modules[0].filename == f"core-{modules[0].digest}.json.gz"
    assert len(modules[0].digest) == DIGEST_LENGTH


def test_two_builds_with_the_same_content_produce_the_same_file() -> None:
    """The whole sharing mechanism, and the case it has to get right: nothing
    arranges this and nothing declares it per pair of builds. Identical bytes
    name one file; different bytes name two, so a build that diverges keeps
    working with no special case.
    """
    sections = [a_section("animNames", "universal", Scope.UNIVERSAL)]
    agreed = assemble(sections, {"animNames": ["Stand", "Death"]})
    same = assemble(sections, {"animNames": ["Stand", "Death"]})
    diverged = assemble(sections, {"animNames": ["Stand", "Fidget"]})
    assert agreed[0].filename == same[0].filename
    assert agreed[0].payload == same[0].payload
    assert agreed[0].filename != diverged[0].filename


def test_sections_sharing_a_module_land_in_one_file() -> None:
    sections = [a_section("animNames", "core"), a_section("auraNames", "core")]
    modules = assemble(sections, {"animNames": ["Stand"], "auraNames": {"1": "Haste"}})
    assert len(modules) == 1
    # the payload is what ships, so read it back the way the app would
    with gzip.open(io.BytesIO(modules[0].payload), "rt", encoding="utf-8") as handle:
        assert json.load(handle) == {"animNames": ["Stand"], "auraNames": {"1": "Haste"}}


def test_a_section_its_build_lacks_is_left_out_rather_than_shipped_empty() -> None:
    """An empty column reads as "nothing matches", which is a different claim
    from "this build never had it".
    """
    sections = [a_section("animNames", "core"), a_section("spellAreas", "universal")]
    modules = assemble(sections, {"animNames": ["Stand"]})
    assert [module.name for module in modules] == ["core"]
    assert absent_sections(sections, {"animNames": ["Stand"]}) == ["spellAreas"]


def test_modules_keep_registry_order() -> None:
    sections = [a_section("b", "second"), a_section("a", "first")]
    modules = assemble(sections, {"a": [], "b": []})
    assert [module.name for module in modules] == ["second", "first"]


def test_a_produced_section_the_registry_does_not_declare_is_an_error() -> None:
    """Dropping it silently would lose a route's whole output with nothing to
    notice: the section would appear in no module and no manifest.
    """
    with pytest.raises(ValueError, match="spellAreas"):
        assemble([a_section("animNames", "core")], {"animNames": [], "spellAreas": [1, 2]})


def a_spoken_section(name: str, module: str = "core") -> Section:
    """A section whose names ship in one language and whose ids ship in all."""
    return a_section(name, module, columns=("ids", "names"), localizable=("names",))


def test_a_localizable_section_splits_between_its_module_and_the_language() -> None:
    """The ids stay with the structure and the names leave for the language, so
    a reader wanting Russian fetches one file rather than a second copy of every
    id.
    """
    modules = assemble(
        [a_spoken_section("mounts")], {"mounts": {"ids": [1, 2], "names": ["Steed", "Drake"]}}, locale="enUS"
    )
    held = {}
    for module in modules:
        with gzip.open(io.BytesIO(module.payload), "rt", encoding="utf-8") as handle:
            held[module.name] = json.load(handle)
    assert held == {"core": {"mounts": {"ids": [1, 2]}}, "names": {"mounts": {"names": ["Steed", "Drake"]}}}


def test_a_section_already_in_a_language_module_stays_whole() -> None:
    """Prose belongs with prose rather than with the names, and everything in it
    is language, so there is no structure half to leave behind.
    """
    modules = assemble(
        [a_section("spellText", "text", columns=("descriptions",), localizable=("descriptions",))],
        {"spellText": {"descriptions": ["burns"]}},
        locale="ruRU",
    )
    assert [module.name for module in modules] == ["text"]


def test_a_language_module_carries_the_language_and_a_structural_one_does_not() -> None:
    """Which file a language is in is said once, by the module itself: its own
    name is a content hash and says nothing about what is inside.
    """
    modules = assemble([a_spoken_section("mounts")], {"mounts": {"ids": [1], "names": ["Steed"]}}, locale="ruRU")
    assert {module.name: module.locale for module in modules} == {"core": "", "names": "ruRU"}


def test_a_language_module_assembled_without_a_language_is_an_error() -> None:
    """The manifest groups these by language, so an unstamped one would be a
    file no reader could ask for.
    """
    with pytest.raises(ValueError, match="names"):
        assemble([a_spoken_section("mounts")], {"mounts": {"ids": [1], "names": ["Steed"]}})


def test_two_languages_of_one_build_share_its_structure() -> None:
    """The point of the split, measured in files: the structure is assembled
    once and only the language is assembled twice.
    """
    sections = [a_spoken_section("mounts")]
    english = assemble(sections, {"mounts": {"ids": [1], "names": ["Steed"]}}, locale="enUS")
    russian = assemble(sections, {"mounts": {"names": ["Скакун"]}}, locale="ruRU")
    structure = {module.name: module.filename for module in english if not module.locale}
    assert structure == {"core": next(m.filename for m in english if m.name == "core")}
    assert [module.name for module in russian] == ["names"]
    assert russian[0].filename != next(m.filename for m in english if m.name == "names")


def test_the_same_payload_serialises_to_the_same_bytes() -> None:
    """The bytes name the file, so anything varying between runs -- a timestamp
    in the gzip header above all -- would rename every module on every rebuild
    and re-ship a pack that did not change.
    """
    assert serialize({"a": [1], "b": [2]}) == serialize({"a": [1], "b": [2]})


def test_the_streamed_bytes_are_the_document_the_encoder_would_have_built() -> None:
    """Sections go into the open stream one at a time to bound how much is held
    in memory, which only holds if the result is the same document. It names
    the file, so a difference here would be a silent re-ship.
    """
    payload = {"animNames": ["Stand", "Bogenschießen"], "auraNames": {"1": "Haste"}}
    one_shot = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    with gzip.open(io.BytesIO(serialize(payload)), "rt", encoding="utf-8") as handle:
        assert handle.read() == one_shot


def test_serialising_keeps_the_order_it_was_given() -> None:
    """Which is the registry's. Sorting instead would rename a module without
    changing what it holds, and would hide an unordered producer rather than
    make it fail.
    """
    with gzip.open(io.BytesIO(serialize({"b": [2], "a": [1]})), "rt", encoding="utf-8") as handle:
        assert list(json.load(handle)) == ["b", "a"]
