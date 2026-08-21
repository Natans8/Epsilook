"""The rules that decide which of a supplementary source's rows count."""

from __future__ import annotations

from pack.supplements import above, always, at_least


def test_always_admits_anything_including_nonsense() -> None:
    """A supplement whose rows are all in scope declares no rule, so the
    permissive one must not inspect what it is handed."""
    for text in ("900", "", "not a number", "-1"):
        assert always(text)


def test_at_least_is_inclusive() -> None:
    """A hotfix verified against exactly the build being packed describes that
    build, so it counts."""
    admits = at_least(900)
    assert admits("900")
    assert admits("901")
    assert not admits("899")


def test_above_is_the_inclusive_rule_a_step_up() -> None:
    """An id at the boundary belongs to the base, so a supplement confined to
    what lies beyond it must not claim the boundary itself."""
    admits = above(8_284_174)
    assert admits("8284175")
    assert not admits("8284174")
    assert not admits("1")


def test_an_unreadable_field_is_refused() -> None:
    """A field that cannot be compared is not evidence that the row belongs,
    and admitting it would let a malformed row through as though it meant
    always."""
    admits = at_least(900)
    for text in ("", "  ", "none", "9.0.1", "1e3"):
        assert not admits(text)
