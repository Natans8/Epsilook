"""The spine: what the two hops must get right, cycles included."""

from __future__ import annotations

from pack.routes.visuals import KitEvent, VisualGraph, phase_words
from pack.targets import NO_TARGET, TARGET_CASTER, TARGET_TARGET
from support import BuildTables, resolve

SPELL_X_SPELL_VISUAL = """\
ID,SpellID,SpellVisualID
1,100,10
2,100,11
3,101,12
4,102,30
5,102,31
6,103,40
"""

# Visual 10 redirects to 20 for the caster and 21 for a hostile target; 20
# redirects on again; 12 names ITSELF, which is a no-op the data really
# carries. Spell 102 reaches 31 directly and again through 30's caster column;
# 40 and 41 name each other.
SPELL_VISUAL = """\
ID,AnimEventSoundID,CasterSpellVisualID,HostileSpellVisualID,LowViolenceSpellVisualID,ReducedUnexpectedCameraMovementSpellVisualID
10,700,20,21,0,0
11,0,0,0,0,0
12,0,12,0,0,0
20,0,0,0,0,22
21,0,0,0,0,0
22,0,0,0,0,0
30,0,31,0,0,0
31,0,0,0,0,0
40,0,41,0,0,0
41,0,0,40,0,0
"""

SPELL_VISUAL_EVENT = """\
SpellVisualID,SpellVisualKitID,TargetType,StartEvent
10,900,1,6
10,900,2,6
10,900,1,6
10,901,1,7
0,902,1,7
"""


def graph(tables: BuildTables) -> VisualGraph:
    found = resolve(
        "graph",
        tables(SpellXSpellVisual=SPELL_X_SPELL_VISUAL, SpellVisual=SPELL_VISUAL, SpellVisualEvent=SPELL_VISUAL_EVENT),
    )
    if not isinstance(found, VisualGraph):
        raise TypeError("the graph field is the visual graph")
    return found


def test_a_visual_naming_itself_is_dropped(tables: BuildTables) -> None:
    """A no-op redirect the data really carries."""
    assert graph(tables).spell_visuals[101] == {12: NO_TARGET}


def test_a_spell_reaches_every_visual_its_visuals_redirect_to(tables: BuildTables) -> None:
    """A seed carries no extra bits, a redirect the bit of its column, and a
    redirect reached through a redirect both: chains longer than one hop are
    real, and a column carrying no bit adds none."""
    assert graph(tables).spell_visuals[100] == {
        10: NO_TARGET,
        11: NO_TARGET,
        20: TARGET_CASTER,
        21: TARGET_TARGET,
        22: TARGET_CASTER,
    }


def test_a_visual_reached_two_ways_carries_both_paths_bits(tables: BuildTables) -> None:
    """Direct and through a caster redirect: the masks union rather than the
    last path standing."""
    assert graph(tables).spell_visuals[102] == {30: NO_TARGET, 31: TARGET_CASTER}


def test_a_cycle_terminates_at_the_fixpoint(tables: BuildTables) -> None:
    """Both visuals carry both bits, since each really is reachable through the
    other's column. The expansion stops because a mask only ever gains bits."""
    assert graph(tables).spell_visuals[103] == {
        40: TARGET_CASTER | TARGET_TARGET,
        41: TARGET_CASTER | TARGET_TARGET,
    }


def test_the_kit_edge_keeps_one_entry_per_event(tables: BuildTables) -> None:
    """A kit playing for two audiences at one phase is two events, each with
    its own bit, and the phase rides on each rather than being folded; a row
    repeated in the source is one event, and a row naming no visual none."""
    assert graph(tables).visual_events[10] == [
        KitEvent(900, 6, TARGET_CASTER),
        KitEvent(900, 6, TARGET_TARGET),
        KitEvent(901, 7, TARGET_CASTER),
    ]
    assert 0 not in graph(tables).visual_events


def test_a_visual_carries_its_own_animation_sound(tables: BuildTables) -> None:
    assert graph(tables).visual_sounds == {10: 700}


def test_the_phase_words_index_by_event_and_leave_the_unnamed_blank() -> None:
    """A row stores the event id, so the word must sit at that index; an event
    the enum leaves unnamed reads as no word rather than as a neighbour's."""
    words = phase_words()
    assert words[3] == "cast" and words[6] == "impact" and words[7] == "aura"
    assert words[0] == "none"
    # The enum runs to 24 and names 14 of them; the rest are real events
    # the data does carry, so they index an entry rather than nothing.
    assert len(words) == 25
    assert all(words[event] for event in range(14)) and not any(words[event] for event in range(14, 25))
