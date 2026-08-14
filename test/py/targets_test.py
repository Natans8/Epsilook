"""Who a spell is aimed at: the classification, and how the two phases fold.

The implicit-target names are the game's own and there are ~150 of them, so the
classification is by substring and the ORDER of the tests is the rule. These
pin the order rather than the list -- a new name is data, a reordering is a
behaviour change.
"""

from __future__ import annotations

from pack.targets import NO_TARGET, TARGET_AREA, TARGET_CASTER, TARGET_TARGET, implicit_target_bit, resolve_target_mask


def test_a_place_beats_the_unit_it_is_anchored_to() -> None:
    """A spread, a cone or a ground point is somewhere rather than someone,
    whoever it hangs off -- which is why the area hints are tested first."""
    assert implicit_target_bit("TARGET_UNIT_TARGET_AREA_ENEMY_DST") == TARGET_AREA
    assert implicit_target_bit("TARGET_UNIT_CONE_ENEMY_24") == TARGET_AREA
    assert implicit_target_bit("TARGET_DEST_CASTER_FRONT") == TARGET_AREA


def test_the_selected_unit_beats_the_casters_own_sphere() -> None:
    assert implicit_target_bit("TARGET_UNIT_TARGET_ALLY") == TARGET_TARGET
    assert implicit_target_bit("TARGET_UNIT_NEARBY_ENEMY") == TARGET_TARGET


def test_the_caster_and_what_belongs_to_them() -> None:
    assert implicit_target_bit("TARGET_UNIT_CASTER") == TARGET_CASTER
    assert implicit_target_bit("TARGET_UNIT_PET") == TARGET_CASTER
    assert implicit_target_bit("TARGET_UNIT_VEHICLE") == TARGET_CASTER


def test_a_bare_destination_is_a_place() -> None:
    """Tested last, because the word appears inside names the rows above have
    already claimed."""
    assert implicit_target_bit("TARGET_DEST_DEST") == TARGET_AREA
    assert implicit_target_bit("TARGET_DEST_DB") == TARGET_AREA


def test_a_name_that_names_no_anchor_contributes_no_bit() -> None:
    """The classification is near-total on 9.2.7 -- 133 of the enum's 134 names
    reach a bit, and the one that does not is `NONE`. So this is the guard on
    an absent value rather than on a long tail: anything without the prefix
    anchors to nothing, and inventing a bit for it would put an icon on a pill
    with nothing to point at.
    """
    assert implicit_target_bit("NONE") == NO_TARGET
    assert implicit_target_bit("") == NO_TARGET


def test_a_word_anywhere_in_the_name_counts() -> None:
    """Substrings, not tokens: `TARGET_GAMEOBJECT_ITEM_TARGET` is a selected
    thing because the word is in there, wherever it sits."""
    assert implicit_target_bit("TARGET_GAMEOBJECT_ITEM_TARGET") == TARGET_TARGET


def test_the_bits_are_the_visual_graphs_own() -> None:
    """Not a parallel vocabulary: an effect's implicit target and a visual
    event's TargetType answer the same question of different tables, and
    resolve_target_mask can only compare them because they share bits."""
    assert implicit_target_bit("TARGET_UNIT_CASTER") == TARGET_CASTER


def test_a_self_cast_spell_reads_target_as_caster() -> None:
    """The client writes "Target" whenever a spell is cast at a unit, including
    when that unit is the caster, so a self-buff would otherwise show a target
    icon for content that plays on the caster."""
    assert resolve_target_mask(TARGET_TARGET, NO_TARGET,
                               TARGET_CASTER, TARGET_CASTER) == TARGET_CASTER


def test_the_aura_phase_is_judged_on_its_own_effects() -> None:
    """An aura-phase visual belongs to the aura, so it plays on whoever carries
    it -- even where the spell as a whole is aimed elsewhere."""
    assert resolve_target_mask(TARGET_TARGET, NO_TARGET, TARGET_CASTER,
                               TARGET_CASTER | TARGET_TARGET) == TARGET_CASTER


def test_a_mixed_spell_keeps_both_readings() -> None:
    """The reason the two phases are carried apart at all: a self-aura riding
    alongside effects aimed at someone else."""
    assert resolve_target_mask(TARGET_TARGET, TARGET_TARGET, TARGET_CASTER,
                               TARGET_CASTER | TARGET_TARGET) == (
        TARGET_CASTER | TARGET_TARGET)
