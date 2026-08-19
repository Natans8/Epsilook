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

from ..routes import (CreatureModels, FxPayloads, GameObjectData, ItemModels,
                      MountData, SpellEffectRows)
from ..routes.models import MODEL_CAT_DISPLAY, MODEL_CAT_ITEM
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

    displays: set[int] = field(default_factory=set)
    """Every creature display the pack names, whichever route reached it: a
    creature's, a form's, a mount's, or one an effect name attaches outright.
    What the skins section is keyed by."""

    object_rows: list[tuple[int, int]] = field(default_factory=list)
    """Sorted `(spell, entry)` pairs for the objects that survived.

    An entry the world dump has no row for spawns nothing in game, so it is
    dropped rather than shipped -- the same rule the other payloads follow.
    This also empties the route on the builds that ship without a dump, where
    nothing can be resolved at all.
    """

    @property
    def objects(self) -> list[int]:
        """The object entries some spell spawns, sorted and deduplicated."""
        return sorted({entry for _spell, entry in self.object_rows})

    @property
    def wanted(self) -> set[int]:
        """Every file id one pass over the listfile has to resolve."""
        return self.assets | self.icons


def collect_references(visuals: SpellVisuals, effects: SpellEffectRows,
                       fx: FxPayloads, displays: ResolvedDisplays,
                       mounts: MountData, objects: GameObjectData,
                       items: ItemModels, creatures: CreatureModels,
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
        creatures: the display chain, for the textures a display paints.
        spell_icons: spell to its icon's file id.

    Returns:
        The two file id sets, and the payload rows that survived resolution.
    """
    found = References()

    found.chains = {draw[0] for drawn in visuals.chains.values() for draw in drawn}
    found.dissolves = {row for rows in visuals.dissolves.values() for row in rows}
    # The two halves of the screen route meet here: an aura applies one with no
    # visual involved, a kit applies one with no aura. Unioned where they are
    # read, so neither pass writes into the other's bundle.
    found.screens = {row for source in (effects.screens.ids, visuals.screens)
                     for rows in source.values() for row in rows}

    # The models bucket is the largest the walk produces, and both a model's
    # own file and the inventory icon an item pill shows come out of it, so it
    # is visited once for the two.
    for models in visuals.models.values():
        for model in models:
            # A negative file id is the build's own equipped-weapon slot: it
            # stands for whatever the caster is holding and names no asset, so
            # asking the listfile about it would report a name missing forever.
            if model[0] > 0:
                found.assets.add(model[0])
            # An item pill shows the icon the game shows in the bag.
            if model[1] == MODEL_CAT_ITEM and model[4]:
                found.icons.add(items.icon_fid.get(model[4], 0))
            if model[1] == MODEL_CAT_DISPLAY:
                found.displays.add(model[4])
    for sounds in visuals.sounds.values():
        found.assets.update(file for _kit, file in sounds)
    for chain in found.chains:
        found.assets.update(fx.chains[chain][4])
    for dissolve in found.dissolves:
        found.assets.update(fx.dissolves[dissolve][1])
    for screen in found.screens:
        found.assets.update(file for file, _role in fx.screens[screen].textures)
    for row in (*displays.creatures, *displays.forms):
        if row.fid:
            found.assets.add(row.fid)
        found.displays.add(row.display)

    found.mount_displays = sorted({display for _spell, display in mounts.links})
    found.assets.update(file for display in found.mount_displays
                        if (file := mounts.fid.get(display, 0)))
    found.displays.update(found.mount_displays)
    found.displays.discard(0)
    # A display's skins are textures like a chain's: named so a reader can see
    # what a display paints, and only for the displays something reached.
    for display in found.displays:
        found.assets.update(creatures.display_skins.get(display, ()))

    found.object_rows = sorted(
        (spell, entry) for spell, entries in effects.objects.ids.items()
        for entry in entries if entry in objects.name)
    found.assets.update(file for entry in found.objects
                        if (file := objects.fid.get(entry, 0)))

    found.icons.update(spell_icons.values())
    found.icons.discard(0)
    return found
