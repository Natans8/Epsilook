"""What a resolved template expression is worth, and when it is worth nothing.

By the time a `${...}` body reaches arithmetic every code in it has been
substituted, so the body is digits and operators or it is a mistake. The
contract pinned here is that one: a body that is a sum evaluates to the sum,
and a body that merely looks like one -- a juxtaposition, a call, a division
by zero -- yields no number at all rather than a wrong one.
"""

from __future__ import annotations

import random
import warnings

import pytest
from pack.derive.spelltext import _arithmetic

# The characters the cooker admits into an expression body once every code has
# been substituted; anything outside this set never reaches arithmetic.
BODY_ALPHABET = "-+*/(). 0123456789"


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("1+2", 3),
        ("10-4", 6),
        ("3*4", 12),
        ("7/2", 3.5),
        ("2*(3+4)", 14),
        ("-5", -5),
        ("+5", 5),
        ("--5", 5),
        ("1.5+1.5", 3.0),
        ("0.4", 0.4),
        ("2**10", 1024),
        (" 1 + 2 ", 3),
    ],
)
def test_a_sum_evaluates_to_its_value(body: str, expected: float) -> None:
    assert _arithmetic(body) == expected


@pytest.mark.parametrize(
    "body",
    [
        "",
        " ",
        "1 2",  # juxtaposition: two expressions, not one
        "(1)(2)",  # a call, which the character filter alone would admit
        "1/0",  # ZeroDivisionError
        "1.0/0.0",
        "(1+2",  # unbalanced
        "1+",
        "*3",
        "()",
        ".",
    ],
)
def test_a_body_that_is_not_a_sum_is_worth_nothing(body: str) -> None:
    assert _arithmetic(body) is None


def test_integer_division_keeps_the_fraction() -> None:
    """The client shows a half, so the cooker must not floor one away."""
    assert _arithmetic("5/2") == 2.5


def test_no_name_resolves_even_when_the_grammar_would_allow_it() -> None:
    """Nothing in the body may reach a binding. A leftover code is a bug
    upstream, and it must fail closed here rather than name-resolve."""
    for body in ("pi", "sum([1])", "__import__", "x+1"):
        assert _arithmetic(body) is None


def test_a_boolean_is_not_a_quantity() -> None:
    """`True` is an int to Python and not a number to a template."""
    assert _arithmetic("True") is None
    assert _arithmetic("False") is None


def _expression(rng: random.Random, depth: int) -> str:
    """A random arithmetic expression drawn from the cooker's own grammar."""
    if depth <= 0 or rng.random() < 0.3:
        return rng.choice([str(rng.randint(0, 999)), f"{rng.uniform(0, 100):.2f}"])
    left = _expression(rng, depth - 1)
    right = _expression(rng, depth - 1)
    body = f"{left} {rng.choice('+-*/')} {right}"
    return f"({body})" if rng.random() < 0.5 else body


def test_it_answers_what_the_interpreter_answers() -> None:
    """Parity against Python's own arithmetic over the grammar the cooker
    admits. The evaluator replaced an `eval` call, and the value of every
    cooked description depends on the two agreeing exactly."""
    rng = random.Random(20260821)
    for _ in range(2000):
        body = _expression(rng, 4)
        try:
            expected = eval(body, {"__builtins__": {}}, {})  # noqa: S307
        except ZeroDivisionError:
            expected = None
        assert _arithmetic(body) == expected, body


def test_character_soup_never_evaluates_to_a_wrong_number() -> None:
    """Random strings over the admitted alphabet either parse as arithmetic and
    agree with the interpreter, or yield nothing. What must never happen is a
    number the interpreter would not have produced."""
    rng = random.Random(20260822)
    for _ in range(4000):
        body = "".join(rng.choice(BODY_ALPHABET) for _ in range(rng.randint(1, 12)))
        if "**" in body:
            continue  # a large exponent is a hang, not a disagreement
        try:
            with warnings.catch_warnings():
                # Soup such as "(1)(2)" is a call the interpreter warns about
                # on its way to refusing it; the refusal is the point.
                warnings.simplefilter("ignore", SyntaxWarning)
                expected = eval(body, {"__builtins__": {}}, {})  # noqa: S307
            if not isinstance(expected, (int, float)):
                expected = None
        except Exception:  # pylint: disable=broad-exception-caught
            expected = None
        assert _arithmetic(body) == expected, body
