"""Sound kits, and the files they actually play.

A kit is a named group: the kit is what a spell references, the files under it
are what the player hears. A kit with no entries is not shipped.
"""

from __future__ import annotations

from ..tables import Tables
from .columns import to_int

SOUNDKIT_NAME_TABLE = "SoundKitName"
"""The pinned build's table of human names for sound kits.

Read from `SOUNDKITNAME_BUILD` whatever pack is building: no later client ships
it, so the alternative to another build's copy is no names at all.
"""


def read_kit_names(pinned: Tables, used: set[int]) -> list[tuple[int, str]]:
    """The names of the sound kits this pack reaches, sorted.

    Purely additive: a kit keeps its id and its files, and one with no name
    renders exactly as it would without this. Kits added after the pinned build
    have no name anywhere and are left unnamed rather than given a made-up one.

    Args:
        pinned: the pinned build's tables, not the pack's own.
        used: the kit ids the pack actually reaches.
    """
    return sorted((kit, name.strip()) for kit, name in (
        (int(kit_id), name)
        for kit_id, name in pinned.rows(SOUNDKIT_NAME_TABLE, ["ID", "Name"]))
                  if name.strip() and kit in used)


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
