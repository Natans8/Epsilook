"""Sound kits, and the files they actually play.

A kit is a named group: the kit is what a spell references, the files under it
are what the player hears. A kit with no entries is not shipped.
"""

from __future__ import annotations

from typing import NamedTuple

from ..sources.enums import load_local_enum
from .route import route


class ZoneMusic(NamedTuple):
    """One `ZoneMusic` row: a named pair of kits the client plays over a place.

    The two kits are the day's and the night's, and most rows name the same kit
    twice. A screen effect that carries one plays it while its aura holds, so
    the kits reach a spell exactly as a kit named on a visual does.
    """

    name: str
    """The set's own internal name, `Zone-Forest`."""

    day: int
    night: int
    """The sound kits, either of which may be zero."""


class Ambience(NamedTuple):
    """One `SoundAmbience` row: the looping kits a place is heard through.

    The day's and the night's loops. The row also names the kits that play as
    one ambience gives way to another and a wind loop beside them; none of
    those is what a reader means by the sound of a place, so they are not read.
    """

    day: int
    night: int


SOUND_TYPE_ENUM = "sound_types"
"""The checked-in names for `SoundKit.SoundType`.

Every build the roster packs carries the column, so this is not optional and no
version declares itself out of it. A value the enum does not name is read as no
type at all rather than shipped as a number nobody can read.
"""

SOUNDKIT_NAME_TABLE = "SoundKitName"
"""The pinned build's table of human names for sound kits.

Read from `SOUNDKITNAME_BUILD` whatever pack is building: no later client ships
it, so the alternative to another build's copy is no names at all.
"""


@route("sound_type_names")
def sound_type_names() -> dict[int, str]:
    """What each `SoundKit.SoundType` value is called.

    The names are published in the WoWDBDefs definition's column comment rather
    than in a `.dbde`, so they are checked in rather than fetched.
    """
    return {value: str(name) for value, name in load_local_enum(SOUND_TYPE_ENUM).items()}
