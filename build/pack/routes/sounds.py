"""Sound kits, and the files they actually play.

A kit is a named group: the kit is what a spell references, the files under it
are what the player hears. A kit with no entries is not shipped.
"""

from __future__ import annotations

from ..tables import Tables
from .columns import to_int


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
