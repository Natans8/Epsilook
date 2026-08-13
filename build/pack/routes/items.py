"""Item -> the name, quality, icon and model a spell visual holds up.

Pure client data, so this route works on every build including the ones with no
server dump. Reached when a `SpellVisualEffectName` names an `Item::ID` rather
than a file: the spell hands the caster a real item and plays its model.

⛔ MOST OF THESE ITEMS HAVE NO NAME, and dropping the nameless ones would throw
away the majority of the route. Only `ItemSearchName` carries a name, and about
a third of the items this route reaches never appear there -- they are internal
props (unnamed potions, dynamite, gizmos) that exist purely to be held in a
spell visual. They still resolve to a model and an icon, which is what makes
them worth rendering without one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .columns import to_int


@dataclass
class ItemModels:
    """What an item id resolves to, by the four things a pill needs."""

    name: dict[int, str] = field(default_factory=dict)
    """Item id -> its display name. Absent for the unnamed props."""

    quality: dict[int, int] = field(default_factory=dict)
    """Item id -> quality. Only ever set alongside a name, since it is the
    name row that carries it."""

    icon_fid: dict[int, int] = field(default_factory=dict)
    """Item id -> its inventory icon file id."""

    model_fid: dict[int, int] = field(default_factory=dict)
    """Item id -> the model file the caster is seen holding."""

    def resolved(self, item_id: int) -> bool:
        """Whether this item reached a model at all."""
        return bool(self.model_fid.get(item_id))


def read_item_models(tables: Tables) -> ItemModels:
    """Read an item's name, quality, icon and model.

    The model hop is `ItemModifiedAppearance -> ItemAppearance ->
    ItemDisplayInfo -> ModelResourcesID -> ModelFileData.FileDataID`, four
    tables to cross what is conceptually one edge, because the game separates
    an item from the look it can be transmogrified into.

    ⛔ FIRST APPEARANCE WINS, and that is what makes the pill show the item's
    BASE look rather than an arbitrary recolour: an item carries one appearance
    row per transmog variant, they arrive in source order, and taking the first
    that yields a file is the only rule here that is stable across builds.
    """
    items = ItemModels()
    for item_id, display, quality in tables.rows(
            "ItemSearchName", ["ID", "Display_lang", "OverallQualityID"]):
        if display:
            items.name[to_int(item_id)] = display
            items.quality[to_int(item_id)] = to_int(quality)

    # A resources id names several files when the model ships with levels of
    # detail; the lowest file id is the base model.
    resource_fid: dict[int, int] = {}
    for file_id, resource_id in tables.rows(
            "ModelFileData", ["FileDataID", "ModelResourcesID"]):
        resource, file = to_int(resource_id), to_int(file_id)
        if resource and file and file < resource_fid.get(resource, file + 1):
            resource_fid[resource] = file

    # Slot 0 is the main model and slot 1 the second component of a paired item
    # (an off-hand, the other half of a set piece).
    display_resources: dict[int, tuple[int, int]] = {}
    for display_id, first, second in tables.rows(
            "ItemDisplayInfo", ["ID", "ModelResourcesID_0", "ModelResourcesID_1"]):
        display_resources[to_int(display_id)] = (to_int(first), to_int(second))

    appearances: dict[int, tuple[int, int]] = {}
    for appearance_id, display_id, icon in tables.rows(
            "ItemAppearance", ["ID", "ItemDisplayInfoID", "DefaultIconFileDataID"]):
        appearances[to_int(appearance_id)] = (to_int(display_id), to_int(icon))

    for item_id, appearance_id in tables.rows(
            "ItemModifiedAppearance", ["ItemID", "ItemAppearanceID"]):
        item, appearance = to_int(item_id), to_int(appearance_id)
        if not item or appearance not in appearances:
            continue
        display_info, icon_file = appearances[appearance]
        if icon_file and item not in items.icon_fid:
            items.icon_fid[item] = icon_file
        if item not in items.model_fid:
            file = next((resource_fid[resource]
                         for resource in display_resources.get(display_info, ())
                         if resource_fid.get(resource)), 0)
            if file:
                items.model_fid[item] = file
    return items
