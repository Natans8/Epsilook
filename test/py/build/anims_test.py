"""Animations: what the name list decides, and what belongs to a segment."""

from pack.routes.flows import Routes
from pack.routes.anims import read_anim_emotes
from support import BuildTables

ANIM_NAMES = ["Stand", "Death", "Spell", "Walk", "Run"]

# Anim 9 is past the end of the name list.
ANIM_KIT_SEGMENT = """\
ParentAnimKitID,AnimID,AnimKitConfigID,Speed
1,2,50,-1
1,3,51,1
1,2,52,-1
2,9,50,0.5
2,4,0,0.5
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
    assert Routes.animkit_anims.run(
        tables(AnimKitSegment=ANIM_KIT_SEGMENT), needs={"anim_ids": range(len(ANIM_NAMES))}
    ) == {1: {2, 3}, 2: {4}}


def test_the_default_region_is_never_shown(tables: BuildTables) -> None:
    bonesets = Routes.animkit_bonesets.run(
        tables(
            AnimKitSegment=ANIM_KIT_SEGMENT,
            AnimKitBoneSet=ANIM_KIT_BONE_SET,
            AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET,
        )
    )
    assert 3 not in bonesets.get(1, {})


def test_a_region_belongs_to_its_own_animation(tables: BuildTables) -> None:
    """Animation 2 is reached through two configs and keeps both regions;
    animation 3's config names only the default."""
    bonesets = Routes.animkit_bonesets.run(
        tables(
            AnimKitSegment=ANIM_KIT_SEGMENT,
            AnimKitBoneSet=ANIM_KIT_BONE_SET,
            AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET,
        )
    )
    assert bonesets[1] == {2: ["Right Hand", "Upper Body"]}


def test_the_regions_do_not_consult_the_name_list(tables: BuildTables) -> None:
    """A region is keyed by the animation it rides on, so an entry for an
    animation that never ships is never looked up."""
    bonesets = Routes.animkit_bonesets.run(
        tables(
            AnimKitSegment=ANIM_KIT_SEGMENT,
            AnimKitBoneSet=ANIM_KIT_BONE_SET,
            AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET,
        )
    )
    assert bonesets[2] == {9: ["Upper Body"]}


def test_a_nameless_boneset_names_no_region(tables: BuildTables) -> None:
    """Boneset 103 has no name, so config 52 contributes only its named half."""
    bonesets = Routes.animkit_bonesets.run(
        tables(
            AnimKitSegment=ANIM_KIT_SEGMENT,
            AnimKitBoneSet=ANIM_KIT_BONE_SET,
            AnimKitConfigBoneSet=ANIM_KIT_CONFIG_BONE_SET,
        )
    )
    assert bonesets[1][2] == ["Right Hand", "Upper Body"]


def test_a_swap_needs_both_ends_named(tables: BuildTables) -> None:
    assert Routes.anim_replacements.run(
        tables(AnimReplacement=ANIM_REPLACEMENT), needs={"anim_ids": range(len(ANIM_NAMES))}
    ) == {7: {(0, 2), (3, 4)}}


# The emote columns come from a checked-in table rather than a game one, so
# these need no tables fixture. The name list only decides their length.
FULL_ANIM_NAMES = ["x"] * 1778


def test_an_emote_pair_lands_on_its_animation() -> None:
    """Animation 75 is the kneel, and it carries both kinds."""
    oneshots, loops = read_anim_emotes(FULL_ANIM_NAMES)
    assert (oneshots[75], loops[75]) == (2075, 4075)


def test_a_downported_animation_carries_its_pair() -> None:
    """Animation 1772 is past stock 9.2.7's table, one Epsilon brought down from
    a later expansion, and it still takes the pair at 2000 and 4000 above it.
    """
    oneshots, loops = read_anim_emotes(FULL_ANIM_NAMES)
    assert (oneshots[1772], loops[1772]) == (3772, 5772)


def test_an_animation_without_an_emote_gets_none() -> None:
    """Animation 1536 has no emote at all. The arithmetic would hand it 3536,
    which plays animation 1744, so a zero here is the point rather than a gap in
    the table. Animation 1744 is reached by 3536 and 5536 as well as by its own
    pair, and the pair at its own slots is the one shipped.
    """
    oneshots, loops = read_anim_emotes(FULL_ANIM_NAMES)
    assert (oneshots[1536], loops[1536]) == (0, 0)
    assert (oneshots[1744], loops[1744]) == (3744, 5744)


def test_emotes_past_the_animation_table_are_dropped() -> None:
    """Older builds carry fewer animations, and the columns stay the length of
    the name list they parallel.
    """
    oneshots, loops = read_anim_emotes(["x"] * 100)
    assert len(oneshots) == len(loops) == 100
    assert max(oneshots) == 2099


def test_a_kits_pace_is_kept_per_animation_in_thousandths(tables: BuildTables) -> None:
    """Backwards, held and hurried are all real paces, and the first segment
    of an animation a kit plays twice is the one that speaks for it."""
    speeds = Routes.animkit_speeds.run(tables(AnimKitSegment=ANIM_KIT_SEGMENT))
    assert speeds[(1, 2)] == -1000
    assert speeds[(1, 3)] == 1000
    assert speeds[(2, 4)] == 500
