"""Item -> the name, quality, icon and model a spell visual holds up.

Pure client data. Reached when a `SpellVisualEffectName` names an `Item::ID`
rather than a file. Only `ItemSearchName` carries a name and many of these
items never appear there -- internal props that exist to be held in a spell
visual -- so a nameless item still resolves to a model and an icon.

The model hop is `ItemModifiedAppearance -> ItemAppearance -> ItemDisplayInfo
-> ModelResourcesID -> ModelFileData.FileDataID`. First appearance wins, which
is the item's base look rather than a transmog recolour, and the lowest file
of a model resource is its base model rather than a level of detail.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import NamedTuple


class ItemName(NamedTuple):
    """What the search table says about an item: its name and its quality."""

    name: str
    quality: int


@dataclass
class ItemModels:
    """What an item id resolves to, by the three things a pill needs."""

    names: Mapping[int, ItemName] = field(default_factory=dict)
    """Item id -> its display name and quality. Absent for the unnamed props."""

    icons: Mapping[int, int] = field(default_factory=dict)
    """Item id -> its inventory icon file id."""

    models: Mapping[int, int] = field(default_factory=dict)
    """Item id -> the model file the caster is seen holding."""

    def resolved(self, item_id: int) -> bool:
        """Whether this item reached a model at all."""
        return bool(self.models.get(item_id))
