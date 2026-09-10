"""Sound kits, and the files they actually play.

A kit is a named group: the kit is what a spell references, the files under it
are what the player hears. A kit with no entries is not shipped.
"""

from __future__ import annotations

from typing import NamedTuple

from ..sources.enums import load_local_enum
from ..tables import Tables
from .columns import to_int
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


@route("zone_music")
def read_zone_music(tables: Tables) -> dict[int, ZoneMusic]:
    """Every music set, by its own id."""
    return {
        to_int(row_id): ZoneMusic(name=(name or "").strip(), day=to_int(day), night=to_int(night))
        for row_id, name, day, night in tables.rows("ZoneMusic", ["ID", "SetName", "Sounds_0", "Sounds_1"])
    }


@route("ambiences")
def read_ambiences(tables: Tables) -> dict[int, Ambience]:
    """Every ambience, by its own id."""
    return {
        to_int(row_id): Ambience(day=to_int(day), night=to_int(night))
        for row_id, day, night in tables.rows("SoundAmbience", ["ID", "AmbienceID_0", "AmbienceID_1"])
    }


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


@route("kit_names", used="used_kits")
def read_kit_names(pinned: Tables, used: set[int]) -> list[tuple[int, str]]:
    """The names of the sound kits this pack reaches, sorted.

    Purely additive: a kit keeps its id and its files, and one with no name
    renders exactly as it would without this. Kits added after the pinned build
    have no name anywhere and are left unnamed rather than given a made-up one.

    Args:
        pinned: the pinned build's tables, not the pack's own.
        used: the kit ids the pack actually reaches.
    """
    return sorted(
        (kit, name.strip())
        for kit, name in ((int(kit_id), name) for kit_id, name in pinned.rows(SOUNDKIT_NAME_TABLE, ["ID", "Name"]))
        if name.strip() and kit in used
    )


@route("soundkit_files")
def read_soundkit_files(tables: Tables) -> dict[int, set[int]]:
    """Sound kit -> the sound files it plays.

    A kit routinely names several variations the client picks between.
    """
    files: dict[int, set[int]] = {}
    for kit_id, file_id in tables.rows("SoundKitEntry", ["SoundKitID", "FileDataID"]):
        kit, file = to_int(kit_id), to_int(file_id)
        if kit and file:
            files.setdefault(kit, set()).add(file)
    return files


@route("sound_type_names")
def sound_type_names() -> dict[int, str]:
    """What each `SoundKit.SoundType` value is called.

    The names are published in the WoWDBDefs definition's column comment rather
    than in a `.dbde`, so they are checked in rather than fetched.
    """
    return {value: str(name) for value, name in load_local_enum(SOUND_TYPE_ENUM).items()}


@route("kit_types", used="used_kits")
def read_kit_types(tables: Tables, used: set[int]) -> dict[int, int]:
    """Sound kit -> what the kit is for, for the kits this pack reaches.

    The type is a property of the KIT, so it is read once per kit rather than
    once per row. A kit whose type the enum does not name is left out, which is
    how the one undocumented value stays off the pill.

    Args:
        tables: the pack's own tables.
        used: the kit ids the pack actually reaches.
    """
    named = sound_type_names()
    types: dict[int, int] = {}
    for kit_id, sound_type in tables.rows("SoundKit", ["ID", "SoundType"]):
        kit = to_int(kit_id)
        value = to_int(sound_type)
        if kit in used and value in named:
            types[kit] = value
    return types
