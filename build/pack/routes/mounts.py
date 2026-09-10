"""Mounts: the display a mount-granting spell puts you on.

Reached from the mount table by the spell that grants it, then out to the
displays it can wear -- faction and gender variants, so several per mount. Both
halves are client data, so this needs no server dump.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .columns import to_int
from .creatures import CreatureModels
from .route import route


@dataclass
class MountData:
    """Which spell puts you on which display, and what that display is."""

    links: list[tuple[int, int]] = field(default_factory=list)
    """(spell, display) pairs, sorted so the pack is stable across builds."""

    name: dict[int, str] = field(default_factory=dict)
    """Display -> the mount's name, empty where it has none."""

    fid: dict[int, int] = field(default_factory=dict)
    """Display -> its model file, 0 where it does not resolve."""

    flavour: dict[int, str] = field(default_factory=dict)
    """Granting spell -> the mount's own flavour text, for the spells that carry one.

    Prose about the mount rather than about the spell, which is why it joins
    the description corpus instead of becoming an axis: nearly every mount
    spell's own description is one line of boilerplate.
    """


@route("mounts", spell_names="names.names")
def read_mounts(tables: Tables, spell_names: dict[int, str], creatures: CreatureModels) -> MountData:
    """Read the mount displays each mount-granting spell reaches.

    A mount whose granting spell this build does not ship is skipped. The first
    mount to claim a display names it.
    """
    displays: dict[int, list[int]] = {}
    for display_id, mount_id in tables.rows("MountXDisplay", ["CreatureDisplayInfoID", "MountID"]):
        displays.setdefault(to_int(mount_id), []).append(to_int(display_id))

    mounts = MountData()
    links: set[tuple[int, int]] = set()
    for mount_id, name, source, flavour in tables.rows(
        "Mount", ["ID", "Name_lang", "SourceSpellID", "Description_lang"]
    ):
        spell = to_int(source)
        if spell not in spell_names:
            continue
        if (prose := (flavour or "").strip()) and spell not in mounts.flavour:
            mounts.flavour[spell] = prose
        for display in displays.get(to_int(mount_id), ()):
            links.add((spell, display))
            mounts.name.setdefault(display, (name or "").strip())
            mounts.fid.setdefault(display, creatures.fid_for_display(display))
    mounts.links = sorted(links)
    return mounts
