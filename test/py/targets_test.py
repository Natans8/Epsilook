"""Building one module must produce the module the whole pack ships.

The build derives what the selected sections declared reading, and everything
those derivations need comes with them because one asks another by name. This
pins the two things that can break: a section naming a field nothing produces,
and the closure quietly coming out short.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from pack import pipeline
from pack.derive import CONTEXT_FIELDS
from pack.model import SECTIONS
from pack.sources.cache import CACHE_DIR

MODULES = sorted({section.module for section in SECTIONS})


def test_every_declared_read_is_a_field_the_build_can_derive() -> None:
    """The failure this replaces is an AttributeError forty seconds into a
    build, naming a property rather than the section that asked for it."""
    for section in SECTIONS:
        for name in section.reads:
            assert name in CONTEXT_FIELDS, f"{section.name} reads {name!r}"
            assert name == "build" or hasattr(pipeline.Derivations, name), (
                f"{section.name} reads {name!r}, which no derivation produces")


def test_every_module_selects_at_least_one_section() -> None:
    """A module nothing ships in would build empty and report success."""
    for module in MODULES:
        assert pipeline.selected((module,)), module


def test_selecting_everything_is_selecting_nothing() -> None:
    """Naming every module and naming none must be the same build."""
    assert pipeline.selected(tuple(MODULES)) == pipeline.selected()


def test_an_unknown_module_is_refused() -> None:
    """Rather than producing nothing and calling it a build."""
    with pytest.raises(ValueError, match="no section ships in"):
        pipeline.selected(("prose",))


def test_a_narrower_selection_reads_no_more_than_a_wider_one() -> None:
    """The union is monotone, which is what makes a partial build a subset of
    the whole one rather than a different one."""
    everything = pipeline.declared_reads(pipeline.selected())
    for module in MODULES:
        assert pipeline.declared_reads(pipeline.selected((module,))) <= everything


def test_text_reads_far_less_than_the_whole_pack() -> None:
    """The claim the whole item rests on: prose does not need the visual graph.

    Asserted as a gap rather than an exact set, since the point is that one is
    much smaller and a new section may legitimately widen either.
    """
    text = pipeline.declared_reads(pipeline.selected(("text",)))
    everything = pipeline.declared_reads(pipeline.selected())
    assert len(text) * 3 < len(everything), f"text reads {sorted(text)}"


PACK = "9.2.7.45745"
MANIFEST = Path(__file__).resolve().parents[2] / "site" / "data" / PACK / "manifest.json"


@pytest.mark.skipif(
    not os.environ.get("EPSILOOK_MODULE_TARGETS")
    or not (CACHE_DIR / PACK).is_dir() or not MANIFEST.exists(),
    reason="set EPSILOOK_MODULE_TARGETS=1 with a warm cache; it builds a pack")
def test_building_text_alone_reproduces_the_shipped_text_modules() -> None:
    """The end-to-end proof, opt-in because it is a real build.

    A module is named by the hash of its own content, so an equal name IS equal
    bytes: if a skipped derivation had mattered, the name would move.
    """
    shipped = json.loads(MANIFEST.read_text(encoding="utf-8"))
    _modules, manifest = pipeline.modules(PACK, "Shadowlands 9.2.7",
                                          location="data/modules", want=("text",))
    built = manifest["locales"]
    assert isinstance(built, dict)
    for code, kinds in shipped["locales"].items():
        assert built[code]["text"]["file"] == kinds["text"]["file"], code
