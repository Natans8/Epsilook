"""M2 attachment points: where on a model something is anchored.

One id space with four consumers: attached models, missile launch and impact,
beam endpoints, and vehicle seats. Every attachment column in the game data is
a raw id into the name table, except `VehicleSeat.AttachmentID`, which is an
index into an array hardcoded in the client binary. On seats the names read
oddly ("Breath", "ChestBloodBack") because artists reuse generic slots as seat
anchors.
"""

from __future__ import annotations

from ..sources import load_local_enum

M2_ATTACHMENT_NAMES = load_local_enum("m2_attachments")
"""Raw M2 attachment id -> the game's own name for it (wowdev.wiki/M2)."""

VEHICLE_GEO_COMPONENT_LINKS = [
    attach for _, attach in sorted(load_local_enum("vehicle_geo_component_links").items())
]
"""Seat AttachmentID (an index) -> the raw M2 attachment id it stands for.

Compiled into the client and in no db2, so it cannot be derived from data. It
is 6.0.1-era, so modern data has indices past its end; those stay unmapped.
"""

NO_ATTACHMENT = -1
"""What an attachment column holds when nothing is anchored. Missile columns
also use -2, which reads the same way: below zero is unset."""

NO_MOTION = 0
"""No flight path. Every non-missile model row holds this."""

DEFAULT_MISSILE_SOURCE = 56
"""Launch point for a missile whose row and visual both name none: M2
"VirtualSpellDirected". Verified in game."""


def attachment_name(attachment: int) -> str:
    """A raw M2 attachment id as a name, or "" when unset.

    An id the table does not name falls back to `attachment N`, since a blank
    would render as though the row had no anchor at all.
    """
    if attachment < 0:
        return ""
    return M2_ATTACHMENT_NAMES.get(attachment, f"attachment {attachment}")


def seat_attachment_name(index: int) -> str:
    """A seat's AttachmentID, which is an index, as an M2 attachment name.

    An index past the link array's end is labelled `idx N` rather than guessed.
    """
    if index < 0:
        return ""
    if index >= len(VEHICLE_GEO_COMPONENT_LINKS):
        return f"idx {index}"
    return attachment_name(VEHICLE_GEO_COMPONENT_LINKS[index])
