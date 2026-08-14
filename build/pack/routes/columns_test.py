"""Why each column decode is a decode and not a cast."""

from __future__ import annotations

import pytest

from .columns import to_amount, to_int, to_int_from_float


@pytest.mark.parametrize(("text", "value"), [("7", 7), ("-1", -1), ("0", 0), ("", 0)])
def test_an_empty_cell_is_zero(text: str, value: int) -> None:
    """The game writes an empty cell where it means zero, so `int()` would
    raise on data that is perfectly ordinary."""
    assert to_int(text) == value


@pytest.mark.parametrize("text", ["2", "2.0", "2.00"])
def test_an_id_survives_being_exported_as_a_float(text: str) -> None:
    """Some builds type an id column float. It is still an id."""
    assert to_int_from_float(text) == 2


def test_the_first_nonzero_spelling_wins() -> None:
    """The rule that keeps three builds from shipping blank.

    Vanilla, TBC and MoP export BOTH spellings of an effect's amount with the
    float left at zero, so "first nonempty" is not enough -- it has to be
    "first nonempty AND nonzero", with callers passing the int spelling first.
    """
    assert to_amount("50", "") == 50.0
    assert to_amount("", "50") == 50.0
    assert to_amount("0", "50") == 50.0
    assert to_amount("50", "0") == 50.0


def test_nothing_set_is_zero() -> None:
    assert to_amount("", "") == 0.0


def test_float32_noise_is_rounded_away_but_real_fractions_are_not() -> None:
    """The modern builds carry conversion noise; 47.5 is not noise."""
    assert to_amount("14.27999973297") == 14.3
    assert to_amount("47.5") == 47.5
