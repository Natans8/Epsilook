"""The two sound tables a screen effect names, read to the kits they play."""

from __future__ import annotations

from pack.routes import flows
from pack.routes.sounds import Ambience, ZoneMusic
from support import BuildTables

ZONE_MUSIC = """\
ID,SetName,SilenceIntervalMin_0,SilenceIntervalMin_1,SilenceIntervalMax_0,SilenceIntervalMax_1,Sounds_0,Sounds_1
1,Zone-Forest,180000,180000,300000,300000,2523,2523
2,Zone-EvilForest,180000,180000,300000,300000,2524,2534
3, Trimmed ,0,0,0,0,0,9
"""

SOUND_AMBIENCE = """\
ID,Flags,SoundFilterID,FlavorSoundFilterID,AmbienceID_0,AmbienceID_1,AmbienceStartID_0,AmbienceStartID_1,AmbienceStopID_0,AmbienceStopID_1,SoundKitID_0,SoundKitID_1
21,0,0,0,4162,4162,0,0,0,0,0,0
22,0,0,0,4163,4204,5,6,7,8,9,10
"""


def test_a_music_set_is_its_name_and_its_day_and_night_kits(tables: BuildTables) -> None:
    assert flows.zone_music.run(tables(ZoneMusic=ZONE_MUSIC))[2] == ZoneMusic("Zone-EvilForest", 2524, 2534)


def test_a_music_set_may_lack_one_of_its_kits(tables: BuildTables) -> None:
    """Nought is the absence, and the name is stripped like every other name."""
    assert flows.zone_music.run(tables(ZoneMusic=ZONE_MUSIC))[3] == ZoneMusic("Trimmed", 0, 9)


def test_an_ambience_is_its_two_loops_and_nothing_else(tables: BuildTables) -> None:
    """The start, stop and wind kits are transitions and weather rather than
    the sound of the place, so they are not read."""
    assert flows.ambiences.run(tables(SoundAmbience=SOUND_AMBIENCE)) == {
        21: Ambience(4162, 4162),
        22: Ambience(4163, 4204),
    }
