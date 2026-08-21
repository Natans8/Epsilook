"""The spine: what the two hops must get right, cycles included."""

from __future__ import annotations

from pack.routes.visuals import VisualGraph, expand_redirects, read_visual_graph
from pack.targets import NO_TARGET, TARGET_CASTER, TARGET_MISSILE_DEST, TARGET_TARGET
from support import BuildTables

SPELL_X_SPELL_VISUAL = """\
ID,SpellID,SpellVisualID
1,100,10
2,100,11
3,101,12
"""

# Visual 10 redirects to 20 for the caster and 21 for a hostile target; 20
# redirects on again; 12 names ITSELF, which is a no-op the data really carries.
SPELL_VISUAL = """\
ID,AnimEventSoundID,CasterSpellVisualID,HostileSpellVisualID,LowViolenceSpellVisualID,ReducedUnexpectedCameraMovementSpellVisualID
10,700,20,21,0,0
11,0,0,0,0,0
12,0,12,0,0,0
20,0,22,0,0,0
21,0,0,0,0,0
22,0,0,0,0,0
"""

SPELL_VISUAL_EVENT = """\
SpellVisualID,SpellVisualKitID,TargetType,StartEvent
10,900,1,6
10,900,2,6
10,901,1,7
"""


def graph(tables: BuildTables) -> VisualGraph:
    return read_visual_graph(tables(SpellXSpellVisual=SPELL_X_SPELL_VISUAL,
                                    SpellVisual=SPELL_VISUAL,
                                    SpellVisualEvent=SPELL_VISUAL_EVENT))


def test_a_seed_visual_carries_no_extra_bits() -> None:
    """Its rows are already masked by their own event."""
    assert expand_redirects({10}, {}) == {10: NO_TARGET}


def test_a_redirect_carries_the_bit_of_the_column_it_came_through() -> None:
    reached = expand_redirects({10}, {10: [(20, TARGET_CASTER), (21, TARGET_TARGET)]})
    assert reached == {10: NO_TARGET, 20: TARGET_CASTER, 21: TARGET_TARGET}


def test_a_redirect_reached_through_a_redirect_carries_both() -> None:
    """Chains longer than one hop are real."""
    reached = expand_redirects(
        {10}, {10: [(20, TARGET_CASTER)], 20: [(22, TARGET_MISSILE_DEST)]})
    assert reached[22] == TARGET_CASTER | TARGET_MISSILE_DEST


def test_a_cycle_terminates_at_the_fixpoint() -> None:
    """Both visuals carry both bits, since each really is reachable through the
    other's column. The loop stops because a mask only ever gains bits."""
    reached = expand_redirects({1}, {1: [(2, TARGET_CASTER)], 2: [(1, TARGET_TARGET)]})
    assert reached == {1: TARGET_CASTER | TARGET_TARGET,
                       2: TARGET_CASTER | TARGET_TARGET}


def test_a_visual_naming_itself_is_dropped(tables: BuildTables) -> None:
    """A no-op redirect the data really carries."""
    assert graph(tables).spell_visuals[101] == {12: NO_TARGET}


def test_a_spell_reaches_every_visual_its_visuals_redirect_to(
        tables: BuildTables) -> None:
    assert graph(tables).spell_visuals[100] == {
        10: NO_TARGET, 11: NO_TARGET,
        20: TARGET_CASTER, 21: TARGET_TARGET, 22: TARGET_CASTER}


def test_the_kit_edge_splits_the_mask_by_phase(tables: BuildTables) -> None:
    """"Target" means a different unit in the two phases."""
    assert graph(tables).visual_kits[10] == {
        900: (NO_TARGET, TARGET_CASTER | TARGET_TARGET),  # impact, two rows
        901: (TARGET_CASTER, NO_TARGET),                  # aura start
    }


def test_a_visual_carries_its_own_animation_sound(tables: BuildTables) -> None:
    assert graph(tables).visual_sounds == {10: 700}
