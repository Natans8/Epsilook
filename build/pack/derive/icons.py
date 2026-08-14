"""The deduped icon table, and each spell's place in it.

An icon is stored as a file id, but what the app needs is the name the icon CDN
serves it under, so the path is resolved and reduced to its base name. Names
repeat heavily across spells, so they are deduped into one table and each spell
carries an index into it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

ICON_DIRECTORY = "interface/icons/"
"""Where an icon lives. Compared against a folded path, since the listfile is
taken with its own casing and only the comparison may assume one."""

NO_ICON = 0
"""The index meaning the spell has no icon, which is why the table is 1-based."""


@dataclass
class IconIndex:
    """The icon table and the spells' references into it."""

    names: list[str] = field(default_factory=list)
    """Each distinct icon name, lowercased: the key the CDN serves it under."""

    fids: list[int] = field(default_factory=list)
    """The file id each name was first claimed by, parallel to `names`.

    Kept beside the name rather than replacing it. The name is what the CDN url
    is built from and what a person recognises; the file id is the icon's
    identity, what resolves to its own page, and a number a reader can paste
    back into a search.
    """

    spells: list[int] = field(default_factory=list)
    """Each spell's 1-based index into `names`, or `NO_ICON`."""


def build_icon_index(spells: Sequence[int],
                     icon_fid: Mapping[int, int],
                     paths: Mapping[int, str]) -> IconIndex:
    """Reduce every spell's icon to an index into one deduped name table.

    A name can outlive a file id: the same name resolves through several ids
    across builds, and within one build two ids can carry the same base name
    from different folders. The first id to claim a name keeps it, which
    matches how the table is deduped -- the picture shown is the same either
    way.

    Args:
        spells: the spells to index, in the order the pack lists them.
        icon_fid: spell to its icon's file id.
        paths: file id to its asset path, in the listfile's own casing.

    Returns:
        The deduped table and one index per spell, in the order given.
    """
    index = IconIndex()
    seen: dict[str, int] = {}
    for spell in spells:
        fid = icon_fid.get(spell, 0)
        path = paths.get(fid, "")
        # Both folds are the comparison's, not the data's: the directory test
        # cannot assume a casing, and the name is lowercased because it is a
        # url key rather than something read.
        name = (path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()
                if path.lower().startswith(ICON_DIRECTORY) else "")
        if not name:
            index.spells.append(NO_ICON)
            continue
        at = seen.get(name)
        if at is None:
            at = seen[name] = len(index.names)
            index.names.append(name)
            index.fids.append(fid)
        index.spells.append(at + 1)
    return index


def icon_name(path: str) -> str:
    """The name an icon path is served under, or "" if it is not an icon.

    An icon is identified by where it lives rather than by what references it,
    since the same file id can be reached as a model and as a picture.
    """
    if not path.lower().startswith(ICON_DIRECTORY):
        return ""
    return path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()


def build_item_icons(items: Sequence[int], icon_fid: Mapping[int, int],
                     paths: Mapping[int, str]) -> tuple[list[str], list[int]]:
    """The item icon table, and each item's 1-based place in it.

    The same shape as the spell icon index and for the same reason: a handful
    of names serve many rows. Kept apart from the spell table because the two
    are reached differently -- one is the spell's own icon, the other is what
    the game shows in a bag -- and joining them would make either one's absence
    depend on the other's population.
    """
    names: list[str] = []
    index: dict[str, int] = {}
    per_item: list[int] = []
    for item in items:
        name = icon_name(paths.get(icon_fid.get(item, 0), ""))
        if not name:
            per_item.append(NO_ICON)
            continue
        if name not in index:
            index[name] = len(names)
            names.append(name)
        per_item.append(index[name] + 1)
    return names, per_item
