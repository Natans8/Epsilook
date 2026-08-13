"""Sound kits, and the files they actually play.

A sound kit is a named group rather than a sound: the kit is what a spell
references, and the files under it are what the player hears. A kit with no
entries plays nothing and is not a kit worth shipping.
"""

from __future__ import annotations

from ..tables import Tables
from .columns import to_int


def read_soundkit_files(tables: Tables) -> dict[int, set[int]]:
    """Sound kit -> the sound files it plays.

    A kit routinely names several: variations the client picks between, so all
    of them are the kit's content rather than one being canonical.
    """
    files: dict[int, set[int]] = {}
    for kit_id, file_id in tables.rows("SoundKitEntry", ["SoundKitID", "FileDataID"]):
        kit, file = to_int(kit_id), to_int(file_id)
        if kit and file:
            files.setdefault(kit, set()).add(file)
    return files
