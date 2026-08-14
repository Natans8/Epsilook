"""Which file ids the pack has to find names for.

The walk says what each spell reaches, but a payload names its files one table
further in -- a chain's textures, a dissolve's, a screen effect's, a mount's
model. This gathers every file id any shipped row can reach, so the listfile is
streamed once for the whole build instead of consulted per lookup.

The split between the two sets is what the pack does with a name, not where it
came from. An asset's path is shipped in the files table and is searchable; an
icon's is reduced to a name and shipped as the icon table, so its file id never
appears in the files table at all.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..routes import (FxPayloads, GameObjectData, ItemModels, MountData,
                      SpellEffectRows)
from ..routes.models import MODEL_CAT_ITEM
from .displays import ResolvedDisplays
from .walk import SpellVisuals


@dataclass
class References:
    """Everything a build reaches, once the payload tables are followed."""

    assets: set[int] = field(default_factory=set)
    """File ids whose path the pack ships and a reader can search."""

    icons: set[int] = field(default_factory=set)
    """File ids resolved only to name an icon, which the files table omits."""

    chains: set[int] = field(default_factory=set)
    """The chain rows some spell draws."""

    dissolves: set[int] = field(default_factory=set)
    """The dissolve rows some spell applies."""

    screens: set[int] = field(default_factory=set)
    """The screen effects some spell grades the frame with."""

    mount_displays: list[int] = field(default_factory=list)
    """The mount displays some spell seats a rider on, sorted."""

    objects: list[int] = field(default_factory=list)
    """The object entries some spell spawns and the world dump names, sorted."""

    object_rows: list[tuple[int, int]] = field(default_factory=list)
    """Sorted `(spell, entry)` pairs for the objects that survived.

    An entry the world dump has no row for spawns nothing in game, so it is
    dropped rather than shipped -- the same rule the other payloads follow.
    This also empties the route on the builds that ship without a dump, where
    nothing can be resolved at all.
    """

    @property
    def wanted(self) -> set[int]:
        """Every file id one pass over the listfile has to resolve."""
        return self.assets | self.icons


def collect_references(visuals: SpellVisuals, effects: SpellEffectRows,
                       fx: FxPayloads, displays: ResolvedDisplays,
                       mounts: MountData, objects: GameObjectData,
                       items: ItemModels,
                       spell_icons: Mapping[int, int]) -> References:
    """Gather every file id the build must resolve, split by what names it.

    Args:
        visuals: what the graph walk attributed to each spell.
        effects: the per-spell payloads read from the effect rows.
        fx: the payload tables the walk's ids point into.
        displays: the flattened morph and form rows.
        mounts: the mount links and their models.
        objects: the spawnable objects and their models.
        items: the item tables, for the inventory icon an item pill shows.
        spell_icons: spell to its icon's file id.

    Returns:
        The two file id sets, and the payload rows that survived resolution.
    """
    found = References()

    found.chains = {draw[0] for drawn in visuals.chains.values() for draw in drawn}
    found.dissolves = {row for rows in visuals.dissolves.values() for row in rows}
    found.screens = {row for rows in effects.screens.ids.values() for row in rows}

    for models in visuals.models.values():
        # A negative file id is the build's own equipped-weapon slot: it stands
        # for whatever the caster is holding and names no asset, so asking the
        # listfile about it would report a name missing forever.
        found.assets.update(model[0] for model in models if model[0] > 0)
    for sounds in visuals.sounds.values():
        found.assets.update(file for _kit, file in sounds)
    for chain in found.chains:
        found.assets.update(fx.chains[chain][4])
    for dissolve in found.dissolves:
        found.assets.update(fx.dissolves[dissolve][1])
    for screen in found.screens:
        found.assets.update(file for file, _role in fx.screens[screen].textures)
    for row in (*displays.morphs, *displays.forms):
        if row.fid:
            found.assets.add(row.fid)

    found.mount_displays = sorted({display for _spell, display in mounts.links})
    found.assets.update(file for display in found.mount_displays
                        if (file := mounts.fid.get(display, 0)))

    found.object_rows = sorted(
        (spell, entry) for spell, entries in effects.objects.ids.items()
        for entry in entries if entry in objects.name)
    found.objects = sorted({entry for _spell, entry in found.object_rows})
    found.assets.update(file for entry in found.objects
                        if (file := objects.fid.get(entry, 0)))

    found.icons = set(spell_icons.values())
    # An item pill shows the icon the game shows in the bag, which the same
    # pass resolves.
    found.icons.update(
        items.icon_fid.get(model[4], 0)
        for models in visuals.models.values() for model in models
        if model[1] == MODEL_CAT_ITEM and model[4])
    found.icons.discard(0)
    return found
