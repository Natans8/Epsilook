"""Animations: what the name list decides, and what belongs to a segment."""

from __future__ import annotations

from pack.routes.anims import read_anim_replacements, read_animkit_anims, read_animkit_bonesets
from support import BuildTables

ANIM_NAMES = ["Stand", "Death", "Spell", "Walk", "Run"]

# Anim 9 is past the end of the name list.
ANIM_KIT_SEGMENT = """\
ParentAnimKitID,AnimID,AnimKitConfigID
1,2,50
1,3,51
1,2,52
2,9,50
2,4,0
"""

ANIM_KIT_BONE_SET = """\
ID,Name
100,Full Body
101,Upper Body
102,Right Hand
103,
"""

# Config 50 names one specific region, 51 names only the default, 52 adds a
# second region to an animation config 50 already covered.
ANIM_KIT_CONFIG_BONE_SET = """\
ParentAnimKitConfigID,AnimKitBoneSetID
50,101
51,100
52,102
52,103
"""

ANIM_REPLACEMENT = """\
ParentAnimReplacementSetID,SrcAnimID,DstAnimID
7,0,2
7,3,4
8,0,9
9,9,0
0,0,2
"""


def test_an_anim_past_the_name_list_is_dropped(tables: BuildTables) -> None:
    assert read_animkit_anims(
        tables(AnimKitSegment=ANIM_KIT_SEGMENT), ANIM_NAMES) == {1: {2, 3}, 2: {4}}


def test_the_default_region_is_never_shown(tables: BuildTables) -> None:
    bonesets = read_animkit_bonesets(
        tables(AnimKitSegment=ANIM_KIT_SEGMENT,
               AnimKitBoneSet=ANIM_KIT_BONE_SET,
               AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET))
    assert 3 not in bonesets.get(1, {})


def test_a_region_belongs_to_its_own_animation(tables: BuildTables) -> None:
    """Animation 2 is reached through two configs and keeps both regions;
    animation 3's config names only the default."""
    bonesets = read_animkit_bonesets(
        tables(AnimKitSegment=ANIM_KIT_SEGMENT,
               AnimKitBoneSet=ANIM_KIT_BONE_SET,
               AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET))
    assert bonesets[1] == {2: ["Right Hand", "Upper Body"]}


def test_the_regions_do_not_consult_the_name_list(tables: BuildTables) -> None:
    """A region is keyed by the animation it rides on, so an entry for an
    animation that never ships is never looked up."""
    bonesets = read_animkit_bonesets(
        tables(AnimKitSegment=ANIM_KIT_SEGMENT,
               AnimKitBoneSet=ANIM_KIT_BONE_SET,
               AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET))
    assert bonesets[2] == {9: ["Upper Body"]}


def test_a_nameless_boneset_names_no_region(tables: BuildTables) -> None:
    """Boneset 103 has no name, so config 52 contributes only its named half."""
    bonesets = read_animkit_bonesets(
        tables(AnimKitSegment=ANIM_KIT_SEGMENT,
               AnimKitBoneSet=ANIM_KIT_BONE_SET,
               AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET))
    assert bonesets[1][2] == ["Right Hand", "Upper Body"]


def test_a_swap_needs_both_ends_named(tables: BuildTables) -> None:
    assert read_anim_replacements(
        tables(AnimReplacement=ANIM_REPLACEMENT), ANIM_NAMES) == {
            7: {(0, 2), (3, 4)}}
