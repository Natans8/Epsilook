"""M2 attachment points: where on a model something is anchored.

One id space with four consumers -- attached models, missile launch and impact,
beam endpoints, and vehicle seats -- which is why the names live here rather
than with any one of them. The names are the game's own, and on seats they read
oddly ("Breath", "ChestBloodBack") because artists reuse generic slots as seat
anchors. That is the data, not a decode error.

One consumer is indexed and the rest are raw, and confusing the two is the
trap this module exists to hold. Every attachment column in the game data is a
raw id into the name table -- except `VehicleSeat.AttachmentID`, which is an
index into an array hardcoded in the client binary. Reading a seat's value as a
raw id is wrong 57.6% of the time.
"""

from __future__ import annotations

from ..sources import load_local_enum

M2_ATTACHMENT_NAMES = load_local_enum("m2_attachments")
"""Raw M2 attachment id -> the game's own name for it (wowdev.wiki/M2 §8.5)."""

VEHICLE_GEO_COMPONENT_LINKS = [
    attach for _, attach in sorted(load_local_enum("vehicle_geo_component_links").items())
]
"""Seat AttachmentID (an index) -> the raw M2 attachment id it stands for.

The array exists in no db2 -- it is compiled into the client -- so it cannot be
derived from data. wowdev.wiki quotes it but hedges it with a "?", so it was
VERIFIED rather than trusted: 138 vehicle M2s were fetched and their attachment
arrays read, then each seat checked against the model of its own vehicle. The
decoded id is present on the model 91.2% of the time against 42.4% for the raw
value, and the indices where the two hypotheses disagree are decisive -- index
14 decodes to VehicleSeat2, present on 100% of the models that use it, while
raw 14 (ShoulderFlapLeft) is present on 0%.

The array is 6.0.1-era and modern data has indices past its end. Those stay
unmapped on purpose.
"""

NO_ATTACHMENT = -1
"""What an attachment column holds when nothing is anchored. Missile columns
also use -2, which reads the same way: below zero is unset."""

NO_MOTION = 0
"""What a missile row holds when it declares no flight path -- and what every
non-missile model row holds, since only a missile has one."""

DEFAULT_MISSILE_SOURCE = 56
"""Where a missile launches from when nothing says: M2 "VirtualSpellDirected".

Needed for 47.3% of missile rows on 9.2.7, where neither the missile row nor
its visual names a launch point. Verified in game on two independent models:
a blank Fireball is indistinguishable from one that declares this explicitly on
the same model, and Shadow Bolt agreed. "Virtual" is the client's own word for
a COMPUTED point, which is exactly what a fallback is. Materialised here rather
than left blank so the pill, the search and the exports all agree.
"""


def attachment_name(attachment: int) -> str:
    """A raw M2 attachment id as a name, or "" when unset.

    An id the table does not name falls back to `attachment N` rather than the
    empty string: an unknown point is still a point, and a blank would render
    as though the row had no anchor at all.
    """
    if attachment < 0:
        return ""
    return M2_ATTACHMENT_NAMES.get(attachment, f"attachment {attachment}")


def seat_attachment_name(index: int) -> str:
    """A seat's AttachmentID -- an INDEX -- as an M2 attachment name.

    Out of range is labelled `idx N` rather than guessed at: the link array is
    6.0.1-era and modern data has grown past it, so a value beyond its end is a
    seat anchor nobody has decoded, not a seat anchor we know.
    """
    if index < 0:
        return ""
    if index >= len(VEHICLE_GEO_COMPONENT_LINKS):
        return f"idx {index}"
    return attachment_name(VEHICLE_GEO_COMPONENT_LINKS[index])
