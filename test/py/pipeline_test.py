"""What the wiring decides per build: which sections ship, and which are thin.

Built from plain values -- a fake section, a stated absent set -- because what
is under test is the decision, not any route behind it.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import cast

from pack.build import Build
from pack.derive import DeriveContext
from pack.model.section import Section
from pack.pipeline import (degraded_sections, produce, switched_off,
                           unavailable_tables)
from pack.sources.tdb import TDB_TABLES


def a_section(name: str, *, needs: tuple[str, ...] = (),
              degraded_without: tuple[str, ...] = ()) -> Section:
    """A section carrying only what the shipping decision reads off it."""
    return Section(name=name, doc="", module="core",
                   produce=lambda _reads: {"ids": [1]}, columns=("ids",),
                   needs=needs, degraded_without=degraded_without)


def a_build(*absent: str) -> Build:
    return Build(version="9.9.9.99999", tdb="TDB999.1",
                 absent_tables=frozenset(absent), max_level=0)


class WorldWithout:
    """A world source lacking the named tables and holding every other.

    Only availability is ever asked of it here; the other two answers exist to
    satisfy the provider contract, not any case below.
    """

    def __init__(self, *absent: str) -> None:
        self.absent = set(absent)

    def available(self, table: str) -> bool:
        return table not in self.absent

    def header(self, table: str) -> list[str]:
        return []

    def rows(self, table: str,
             columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        return iter(())


def test_the_clients_probed_absences_carry_over() -> None:
    assert "Mount" in unavailable_tables(a_build("Mount"), WorldWithout())


def test_a_build_with_no_dump_lacks_every_world_table() -> None:
    """The four Classic re-releases ship TDB-less, and that is what makes a
    section naming a world table degrade there rather than nowhere."""
    absent = unavailable_tables(a_build(), None)
    assert set(TDB_TABLES["world"]) <= absent


def test_a_dump_answers_for_the_world_tables_it_has() -> None:
    absent = unavailable_tables(a_build(),
                                WorldWithout("creature_template_locale"))
    assert "creature_template_locale" in absent
    assert "creature_template" not in absent


def test_a_section_needing_an_absent_table_ships_absent_not_empty() -> None:
    """The whole point of `needs`: an empty column reads as "nothing matches",
    which is a different claim from "this build never had it"."""
    context = DeriveContext(build=cast(Build, None))
    sections = [a_section("keybinds", needs=("SpellKeyboundOverride",)),
                a_section("glows", needs=("EdgeGlowEffect",))]
    columns, encoded = produce(context, frozenset({"SpellKeyboundOverride"}),
                               sections=sections)
    assert "keybinds" not in encoded and "keybinds" not in columns
    assert "glows" in encoded


def test_needing_any_one_of_several_tables_is_enough_to_switch_off() -> None:
    section = a_section("vehicles", needs=("Vehicle", "VehicleSeat"))
    assert switched_off(section, frozenset({"VehicleSeat"}))
    assert not switched_off(section, frozenset({"Mount"}))


def test_a_shipped_section_reports_what_thinned_it() -> None:
    """The claim `absentSections` cannot make: the section is there, holding
    less than it would, and the manifest says why."""
    sections = [a_section("morphs", degraded_without=("creature_template",)),
                a_section("areas", degraded_without=("UiMap", "UiMapAssignment"))]
    degraded = degraded_sections(sections, {"morphs", "areas"},
                                 frozenset({"creature_template", "UiMap"}))
    assert degraded == {"morphs": ["creature_template"], "areas": ["UiMap"]}


def test_an_absent_section_is_not_also_reported_degraded() -> None:
    """It is already named where absence is; naming it twice would make the two
    lists read as disagreeing about what happened to it."""
    sections = [a_section("mounts", needs=("Mount",),
                          degraded_without=("MountXDisplay",))]
    degraded = degraded_sections(sections, set(),
                                 frozenset({"Mount", "MountXDisplay"}))
    assert degraded == {}


def test_a_whole_section_reports_nothing() -> None:
    sections = [a_section("morphs", degraded_without=("creature_template",))]
    assert degraded_sections(sections, {"morphs"}, frozenset()) == {}
