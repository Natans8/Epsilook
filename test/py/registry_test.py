"""What the section registry refuses to accept."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from pack.model.registry import SECTIONS, register
from pack.model.section import Scope, Section


def a_section(name: str, module: str, scope: Scope = Scope.PER_BUILD) -> Section:
    """A section carrying only what registration reads off it."""
    return Section(name=name, doc="", module=module,
                   produce=lambda _: {}, columns=(), scope=scope)


@pytest.fixture(autouse=True)
def _empty_registry() -> Iterator[None]:
    """The registry is module-level, so a test that adds to it has to put it
    back or the next one inherits its sections.
    """
    held = list(SECTIONS)
    SECTIONS.clear()
    yield
    SECTIONS[:] = held


def test_a_duplicate_name_is_refused() -> None:
    register(a_section("animNames", "names"))
    with pytest.raises(ValueError, match="duplicate section"):
        register(a_section("animNames", "core"))


def test_one_module_cannot_be_declared_two_scopes() -> None:
    """A module is one file, written once and referenced by whoever wants it,
    so it cannot be per-build for one section and universal for another. It is
    caught at registration rather than at assembly because it is a property of
    the declarations: a build that switched one of the two sections off would
    never reach it otherwise.
    """
    register(a_section("animNames", "names", Scope.UNIVERSAL))
    with pytest.raises(ValueError, match="names"):
        register(a_section("spells", "names", Scope.PER_BUILD))


def test_sections_agreeing_on_scope_share_a_module() -> None:
    register(a_section("animNames", "names", Scope.UNIVERSAL))
    register(a_section("auraNames", "names", Scope.UNIVERSAL))
    assert [section.name for section in SECTIONS] == ["animNames", "auraNames"]
