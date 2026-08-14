"""Animations: what the name list decides, and what belongs to a segment."""

from __future__ import annotations

from build_data import read_anim_emotes
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


# The emote columns come from a checked-in table rather than a game one, so
# these need no tables fixture. The name list only decides their length.
FULL_ANIM_NAMES = ["x"] * 1778


def test_an_emote_pair_lands_on_its_animation() -> None:
    """Animation 75 is the kneel, and it carries both kinds."""
    oneshots, loops = read_anim_emotes(FULL_ANIM_NAMES)
    assert (oneshots[75], loops[75]) == (2075, 4075)


def test_the_pairing_is_read_not_computed() -> None:
    """Most emotes sit at 2000 and 4000 above their animation, and a handful do
    not. Animation 1772 loops from 5933, while the id arithmetic would claim
    5772, which is a different animation's emote. Computing the pair instead of
    reading it would quietly name the wrong one.
    """
    oneshots, loops = read_anim_emotes(FULL_ANIM_NAMES)
    assert loops[1772] == 5933
    assert oneshots[1772] == 0


def test_an_animation_without_an_emote_gets_none() -> None:
    """Animation 1536 has no emote at all. The arithmetic would hand it 3536,
    which belongs to animation 1744, so a zero here is the point rather than a
    gap in the table.
    """
    oneshots, loops = read_anim_emotes(FULL_ANIM_NAMES)
    assert (oneshots[1536], loops[1536]) == (0, 0)
    assert (oneshots[1744], loops[1744]) == (3536, 5536)


def test_emotes_past_the_animation_table_are_dropped() -> None:
    """Older builds carry fewer animations, and the columns stay the length of
    the name list they parallel.
    """
    oneshots, loops = read_anim_emotes(["x"] * 100)
    assert len(oneshots) == len(loops) == 100
    assert max(oneshots) == 2099
