"""Base difficulty only, template indexing, and the zeroes that are not values."""

from __future__ import annotations

from pack.routes.values import read_spell_values
from support import BuildTables

SPELL_EFFECT = """\
SpellID,DifficultyID,EffectIndex,EffectBasePoints,EffectBasePointsF,EffectAuraPeriod,EffectRadiusIndex_0,EffectChainTargets,EffectMiscValue_0,Variance
100,0,0,50,,3000,7,4,12,0.5
100,0,1,25,,0,0,0,0,0
100,23,0,999,,0,0,0,0,0
"""

SPELL_RADIUS = "ID,Radius\n7,8.5\n"
SPELL_DURATION = "ID,Duration\n3,15000\n"
SPELL_RANGE = "ID,RangeMax_0\n5,40\n"
SPELL_MISC = """\
SpellID,DifficultyID,DurationIndex,RangeIndex
100,0,3,5
100,23,0,0
"""
SPELL_AURA_OPTIONS = """\
SpellID,DifficultyID,CumulativeAura,ProcCharges,ProcChance
100,0,5,0,101
100,23,99,99,99
"""
SPELL_TARGET_RESTRICTIONS = """\
SpellID,DifficultyID,MaxTargets,MaxTargetLevel
100,0,3,0
"""


def build(tables: BuildTables):
    return read_spell_values(tables(
        SpellEffect=SPELL_EFFECT, SpellRadius=SPELL_RADIUS,
        SpellDuration=SPELL_DURATION, SpellRange=SPELL_RANGE,
        SpellMisc=SPELL_MISC, SpellAuraOptions=SPELL_AURA_OPTIONS,
        SpellTargetRestrictions=SPELL_TARGET_RESTRICTIONS))


def test_a_template_counts_effects_from_one(tables: BuildTables) -> None:
    """The table counts from zero, so `$s1` is effect index 0."""
    assert build(tables).points[100] == {1: 50.0, 2: 25.0}


def test_only_the_base_difficulty_row_is_read(tables: BuildTables) -> None:
    """Taking whichever row arrived last would print mythic numbers."""
    values = build(tables)
    assert 999.0 not in values.points[100].values()
    assert values.duration == {100: 15000}


def test_an_index_resolves_to_the_value_it_names(tables: BuildTables) -> None:
    """Radius, duration and range are ids into their own tables, not values."""
    values = build(tables)
    assert values.radius[100] == {1: 8.5}
    assert values.range_max == {100: 40.0}


def test_a_zero_is_left_out_rather_than_recorded(tables: BuildTables) -> None:
    """Not a period, a radius, a chain count, a charge count or a cap, so the
    cooker elides the code instead of substituting nothing."""
    values = build(tables)
    assert values.period[100] == {1: 3000.0}
    assert values.chain_targets[100] == {1: 4.0}
    assert values.charges == {}
    assert values.max_target_level == {}


def test_the_variance_the_range_is_written_around_survives(
        tables: BuildTables) -> None:
    """Without it both ends of a `$m1 to $M1` range come out identical."""
    assert build(tables).variance[100] == {1: 0.5}


def test_a_build_lacking_a_table_leaves_its_dict_empty(
        tables: BuildTables) -> None:
    """How an optional table reports itself: the prose still cooks, without
    that number."""
    values = read_spell_values(tables(
        SpellEffect=SPELL_EFFECT, SpellMisc=SPELL_MISC,
        absent={"SpellRadius": "radii inside cooked descriptions",
                "SpellRange": "ranges inside cooked descriptions",
                "SpellDuration": "the channel duration",
                "SpellAuraOptions": "stack caps",
                "SpellTargetRestrictions": "max-target counts"}))
    assert values.radius == {}
    assert values.range_max == {}
    assert values.points[100] == {1: 50.0, 2: 25.0}
