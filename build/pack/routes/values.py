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

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..sources.scaling import scaled_amount
from ..tables import Tables
from .columns import BASE_DIFFICULTY, to_amount, to_int

FIRST_EFFECT_INDEX = 1
"""What a template calls a spell's first effect. The table counts from zero."""


@dataclass
class DescriptionValues:
    """Every number a description can ask for, keyed by spell.

    One flat bundle rather than a type per table, because the cooker looks each
    up the same way and an empty dict is how a missing table reports itself.

    The per-effect dicts are keyed by spell and then by the effect index a
    template uses. Floats throughout, counts included, since every one is read
    through one lookup and rendered by one formatter.
    """

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


def at_effect(into: dict[int, dict[int, float]], spell: int, index: int, value: float) -> None:
    """Record one per-effect value under the index a template would use."""
    into.setdefault(spell, {})[index] = value


def read_spell_values(
    tables: Tables, *, level: int = 0, scaling: Mapping[int, Mapping[str, float]] | None = None
) -> DescriptionValues:
    """Read every number the description cooker may substitute.

    Args:
        tables: the source to read from.
        level: the caster level to resolve at, stamped onto the result. It is
            the build's own level cap, since a pack has no caster and the level
            a reader cares about is the one they play at.
        scaling: the spell-scaling game table, which an effect declaring a
            `ScalingClass` gets its amount from instead of from its base
            points. Absent, such an effect keeps its base points -- which is
            what the artifact carried before this route could resolve them.

    Returns:
        The values, with a dict left empty wherever this build lacks the table
        behind it.
    """
    values = DescriptionValues(level=level)
    windows = (
        {
            to_int(spell): (to_int(low), to_int(high))
            for spell, low, high in tables.rows("SpellScaling", ["SpellID", "MinScalingLevel", "MaxScalingLevel"])
        }
        if tables.available("SpellScaling")
        else {}
    )
    radius = {to_int(row_id): to_amount(size) for row_id, size in tables.rows("SpellRadius", ["ID", "Radius"])}
    duration = {to_int(row_id): to_int(length) for row_id, length in tables.rows("SpellDuration", ["ID", "Duration"])}
    reach = {
        to_int(row_id): to_amount(distance) for row_id, distance in tables.rows("SpellRange", ["ID", "RangeMax_0"])
    }

    for row in tables.rows(
        "SpellEffect",
        [
            "SpellID",
            "DifficultyID",
            "EffectIndex",
            "EffectBasePoints",
            "EffectBasePointsF",
            "EffectAuraPeriod",
            "EffectRadiusIndex_0",
            "EffectChainTargets",
            "EffectMiscValue_0",
            "Variance",
            "ScalingClass",
            "Coefficient",
        ],
    ):
        if to_int(row[1]) != BASE_DIFFICULTY:
            continue
        spell = to_int(row[0])
        index = to_int(row[2]) + FIRST_EFFECT_INDEX
        # A scaled effect's base points are not its amount -- they are usually
        # zero. The amount is the game table read at the caster's level, and
        # only where that resolves does it replace them.
        low, high = windows.get(spell, (0, 0))
        amount = scaled_amount(scaling or {}, to_int(row[10]), to_amount(row[11]), level, low, high) if level else None
        at_effect(values.points, spell, index, amount if amount is not None else to_amount(row[3], row[4]))
        if spread := to_amount(row[9]):
            at_effect(values.variance, spell, index, spread)
        if ticks := to_int(row[5]):
            at_effect(values.period, spell, index, ticks)
        if reached := radius.get(to_int(row[6])):
            at_effect(values.radius, spell, index, reached)
        if chained := to_int(row[7]):
            at_effect(values.chain_targets, spell, index, chained)
        if misc := to_int(row[8]):
            at_effect(values.misc_value, spell, index, misc)

    for spell_id, difficulty, duration_id, range_id in tables.rows(
        "SpellMisc", ["SpellID", "DifficultyID", "DurationIndex", "RangeIndex"]
    ):
        if to_int(difficulty) != BASE_DIFFICULTY:
            continue
        spell = to_int(spell_id)
        if (lasts := duration.get(to_int(duration_id))) is not None:
            values.duration[spell] = lasts
        if distance := reach.get(to_int(range_id)):
            values.range_max[spell] = distance

    # Zero is not a cap, a charge count or a chance, so it is left out and the
    # cooker elides the code that would have read it.
    # Each column names the dict it fills, so the read order and the
    # destinations are one declaration rather than two lists that have to stay
    # index-aligned.
    caps: list[tuple[str, dict[str, dict[int, int]]]] = [
        (
            "SpellAuraOptions",
            {"CumulativeAura": values.max_stacks, "ProcCharges": values.charges, "ProcChance": values.proc_chance},
        ),
        ("SpellTargetRestrictions", {"MaxTargets": values.max_targets, "MaxTargetLevel": values.max_target_level}),
    ]
    for table, into in caps:
        for row in tables.rows(table, ["SpellID", "DifficultyID", *into]):
            if to_int(row[1]) != BASE_DIFFICULTY:
                continue
            spell = to_int(row[0])
            for text, target in zip(row[2:], into.values()):
                if count := to_int(text):
                    target[spell] = count
    return values
