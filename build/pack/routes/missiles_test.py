"""Projectiles, and the attachment rule the game settled."""

from __future__ import annotations

from .attachments import DEFAULT_MISSILE_SOURCE
from .conftest import BuildTables
from .missiles import read_missile_motions, read_missiles
from .models import WEAPON_FID_RANGED

# Visual 10 declares both attach points and names a base set and a raid set.
# Visual 11 declares neither. Visual 12 has no missile set at all.
SPELL_VISUAL = """\
ID,SpellVisualMissileSetID,RaidSpellVisualMissileSetID,MissileAttachment,MissileDestinationAttachment
10,20,21,5,6
11,22,0,-1,-1
12,0,0,-1,-1
"""

# Row 1 declares its own points, row 2 declares neither, row 3 declares only a
# source. Row 5 names an effect-name with no file but a ranged weapon type.
SPELL_VISUAL_MISSILE = """\
ID,SpellVisualMissileSetID,SpellVisualEffectNameID,SoundEntriesID,AnimKitID,SpellMissileMotionID,Attachment,DestinationAttachment
1,20,1,300,400,7,1,2
2,20,1,0,0,7,-1,-1
3,21,1,0,0,8,9,-1
4,22,1,0,0,0,-1,-1
5,22,2,0,0,0,-1,-1
6,0,1,0,0,0,-1,-1
"""

SPELL_MISSILE_MOTION = """\
ID,Name
7,Arc
8,Straight
9,
"""

EFFECT_NAME_FID = {1: 8000, 2: 0}
EFFECT_NAME_TYPE = {1: 0, 2: 5}


def missiles(tables: BuildTables):
    return read_missiles(tables(SpellVisual=SPELL_VISUAL,
                                SpellVisualMissile=SPELL_VISUAL_MISSILE),
                         EFFECT_NAME_FID, EFFECT_NAME_TYPE)


def test_the_row_wins_where_it_says_anything(tables: BuildTables) -> None:
    """⛔ The two disagree on 24% of rows, and the case was settled in game:
    the visual said Chest, the row said Base, and it launched from the BASE."""
    assert (8000, 7, 1, 2) in missiles(tables)[10].models


def test_the_visual_fills_in_what_the_row_leaves_unset(
        tables: BuildTables) -> None:
    """Complementary rather than redundant, which is why both are read."""
    assert (8000, 7, 5, 6) in missiles(tables)[10].models


def test_a_row_declaring_only_a_source_takes_the_visuals_destination(
        tables: BuildTables) -> None:
    """The two ends resolve independently: a row can win one and defer on the
    other."""
    assert (8000, 8, 9, 6) in missiles(tables)[10].models


def test_with_neither_declaring_a_source_the_default_stands_in(
        tables: BuildTables) -> None:
    """Needed for 47.3% of missile rows, and materialised here rather than left
    blank so the pill, the search and the exports all agree."""
    assert (8000, 0, DEFAULT_MISSILE_SOURCE, -1) in missiles(tables)[11].models


def test_the_raid_set_merges_with_the_base_set(tables: BuildTables) -> None:
    assert len(missiles(tables)[10].models) == 3


def test_the_motion_pairs_with_the_projectile_not_the_set(
        tables: BuildTables) -> None:
    """It rides the same row as the model, so a set naming several motions
    becomes several rows rather than one row with an ambiguous path."""
    assert {motion for _, motion, _, _ in missiles(tables)[10].models} == {7, 8}


def test_a_weapon_type_with_no_file_is_thrown_as_its_sentinel(
        tables: BuildTables) -> None:
    """The caster's own weapon as the projectile."""
    assert any(fid == WEAPON_FID_RANGED
               for fid, _, _, _ in missiles(tables)[11].models)


def test_a_launch_sound_and_animkit_ride_the_set(tables: BuildTables) -> None:
    resolved = missiles(tables)[10]
    assert resolved.soundkits == {300}
    assert resolved.animkits == {400}


def test_a_visual_with_no_missile_set_contributes_nothing(
        tables: BuildTables) -> None:
    assert 12 not in missiles(tables)


def test_a_missile_row_belonging_to_no_set_is_skipped(
        tables: BuildTables) -> None:
    """Set 0 is not a set, so the row reaches no visual."""
    assert all(8000 != fid or motion != 0 or source != DEFAULT_MISSILE_SOURCE
               for fid, motion, source, _ in missiles(tables)[10].models)


def test_a_motion_with_no_name_is_not_a_motion(tables: BuildTables) -> None:
    """Name only: the table's other real column is a script nothing renders."""
    assert read_missile_motions(
        tables(SpellMissileMotion=SPELL_MISSILE_MOTION)) == {7: "Arc", 8: "Straight"}
