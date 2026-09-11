"""The numbers a description template can ask for.

Six tables read for one purpose: substituting `$s1`, `$d`, `$A1` and friends
before a spell's prose ships. None of it reaches the pack; only the substituted
text does.

Base difficulty only, and non-base rows are skipped rather than losing to a
base row. A spell may carry one row per difficulty and the tooltip a player
reads is the base one, so taking whichever arrived last would print mythic
numbers over much of the raid corpus.

A build lacking one of these tables simply leaves that dict empty, and the
cooker elides a value it cannot look up exactly as it elides a
caster-dependent one.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from ..sources.scaling import scaled_amount
from .flow import Cell, key_of

FIRST_EFFECT_INDEX = 1
"""What a template calls a spell's first effect. The table counts from zero."""


def effect_number(cell: Cell) -> int:
    """An `EffectIndex` as the number a template calls that effect by."""
    return key_of(cell) + FIRST_EFFECT_INDEX


class PointRow(NamedTuple):
    """What one effect row says about its amount, before the level resolves it."""

    spell: int
    number: int
    """The template's number for the effect."""
    amount: float
    """The base points, in whichever of the two spellings this build exports."""
    scaling_class: int
    coefficient: float
    low: int
    high: int
    """The level window the scaled amount is clamped to, nought where the build has none."""


def resolve_points(
    rows: Iterable[PointRow], level: int, scaling: Mapping[int, Mapping[str, float]]
) -> dict[int, dict[int, float]]:
    """Each effect's amount, scaled to the caster level where its row declares a class.

    Args:
        rows: the effect rows' amounts.
        level: the caster level to resolve at, which is the build's own level
            cap, since a pack has no caster and the level a reader cares about
            is the one they play at. Nought leaves every amount its base points.
        scaling: the spell-scaling game table, which an effect declaring a
            `ScalingClass` gets its amount from instead of from its base
            points. Absent, such an effect keeps its base points.
    """
    points: dict[int, dict[int, float]] = {}
    for row in rows:
        amount = scaled_amount(scaling, row.scaling_class, row.coefficient, level, row.low, row.high) if level else None
        points.setdefault(row.spell, {})[row.number] = amount if amount is not None else row.amount
    return points


@dataclass
class EffectValues:
    """The numbers a template asks of one effect, by spell and then by the
    effect's template number. Floats throughout, counts included, since every
    one is read through one lookup and rendered by one formatter."""

    points: dict[int, dict[int, float]] = field(default_factory=dict)
    """The effect's amount."""
    variance: dict[int, dict[int, float]] = field(default_factory=dict)
    """The spread a `$m1 to $M1` range is written around.

    Without it both ends of such a range come out identical, since the modern
    tables carry no die-sides column.
    """
    period: dict[int, dict[int, float]] = field(default_factory=dict)
    """How often a periodic effect ticks, in milliseconds."""
    radius: dict[int, dict[int, float]] = field(default_factory=dict)
    """The effect's radius, in yards."""
    chain_targets: dict[int, dict[int, float]] = field(default_factory=dict)
    """How many further targets the effect chains to."""
    misc_value: dict[int, dict[int, float]] = field(default_factory=dict)
    """The effect's first misc value, where a template quotes it directly."""


@dataclass
class DescriptionValues:
    """Every number a description can ask for, keyed by spell.

    One flat bundle rather than a type per table, because the cooker looks each
    up the same way and an empty dict is how a missing table reports itself.
    """

    points: dict[int, dict[int, float]] = field(default_factory=dict)
    variance: dict[int, dict[int, float]] = field(default_factory=dict)
    period: dict[int, dict[int, float]] = field(default_factory=dict)
    radius: dict[int, dict[int, float]] = field(default_factory=dict)
    chain_targets: dict[int, dict[int, float]] = field(default_factory=dict)
    misc_value: dict[int, dict[int, float]] = field(default_factory=dict)
    """The per-effect numbers, as `EffectValues` spells them."""
    duration: dict[int, int] = field(default_factory=dict)
    """How long the spell lasts, in milliseconds."""
    max_stacks: dict[int, int] = field(default_factory=dict)
    charges: dict[int, int] = field(default_factory=dict)
    proc_chance: dict[int, int] = field(default_factory=dict)
    max_targets: dict[int, int] = field(default_factory=dict)
    max_target_level: dict[int, int] = field(default_factory=dict)
    level: int = 0
    """The caster level every value here was resolved at.

    It travels WITH the values rather than beside them because it is what they
    mean: an amount and the level it was computed at are one fact, and a reader
    handed the number alone cannot tell a flat value from a scaled one. Zero
    means no level was supplied, which is also what a code asking for the level
    itself reads as "unknown".
    """
    range_max: dict[int, float] = field(default_factory=dict)
    """The spell's maximum range, in yards."""
