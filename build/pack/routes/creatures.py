"""Creature -> name and displays, and display -> the model file it wears.

Two halves with different sources, and the split is what decides how much of a
pack degrades when a build has no server dump. The creature's NAME and the
displays it can wear are SERVER data, carried only by the TrinityCore world
tables; the display -> model chain is CLIENT data and is always there. So a
TDB-less build still resolves a morph's MODEL and only loses the word for it.

The chain is `CreatureDisplayInfo.ModelID -> CreatureModelData.FileDataID`, and
it is shared rather than duplicated: morphs, shapeshift forms, mounts and the
Type-2 effect names all end at a `CreatureDisplayID` and all resolve it here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..drift import CREATURE_DISPLAY_SOURCES
from ..progress import log
from ..tables import Tables
from .columns import to_int


@dataclass
class CreatureModels:
    """The creature chain, from an NPC entry down to a model file."""

    names: dict[int, str] = field(default_factory=dict)
    """Creature entry -> its NPC name. Empty without a server dump."""

    displays: dict[int, list[tuple[int, int]]] = field(default_factory=dict)
    """Creature entry -> [(slot, CreatureDisplayID)], slot order.

    A creature wears several displays (gender and faction variants), and the
    slot is what orders them, so the first is the one the pill shows. Empty
    without a server dump.
    """

    display_model: dict[int, int] = field(default_factory=dict)
    """CreatureDisplayInfo.ID -> CreatureModelData.ID."""

    model_fid: dict[int, int] = field(default_factory=dict)
    """CreatureModelData.ID -> the model's file id."""

    def fid_for_display(self, display_id: int) -> int:
        """A display id resolved to its model file id, or 0 when unknown.

        Two hops rather than one because the game separates the LOOK from the
        GEOMETRY: several displays (a recolour, a scaled variant) share one
        model, so the file id lives one table further down.
        """
        return self.model_fid.get(self.display_model.get(display_id, 0), 0)


def read_creature_displays(world: Tables, into: dict[int, list[tuple[int, int]]]) -> None:
    """Fill `into` with each creature's displays, whichever shape they arrive in.

    The server moved these between releases -- a Legion-era dump keeps up to
    four display ids as columns ON the creature row, later releases give them
    their own table -- so this is the first candidate the release actually has,
    exactly like the spell-name sources. In the legacy shape the COLUMN
    POSITION stands in for the slot the modern table carries, which is why the
    two spellings can share one output.

    A release with neither is not fatal: morphs stay unresolved and say so.
    """
    source = next(((table, columns) for table, columns in CREATURE_DISPLAY_SOURCES
                   if world.available(table)), None)
    if source is None:
        log("  TDB: no creature-display source in this release -- morphs stay unresolved")
        return
    table, columns = source
    if len(columns) == 3:
        for creature, slot, display in world.rows(table, columns):
            into.setdefault(to_int(creature), []).append((to_int(slot), to_int(display)))
        return
    for creature, *legacy in world.rows(table, columns):
        for position, display_id in enumerate(to_int(value) for value in legacy):
            if display_id:
                into.setdefault(to_int(creature), []).append((position, display_id))


def read_creature_models(tables: Tables, world: Tables | None) -> CreatureModels:
    """Read the creature chain morphs, forms and mounts all end at.

    `world` is the server dump and is None for the builds that have none. Only
    the naming half depends on it; the model half is client data, so the
    absence costs words rather than models.
    """
    creatures = CreatureModels()
    if world is not None:
        for entry, name in world.rows("creature_template", ["entry", "name"]):
            # Trimmed here rather than in the dump reader, which decodes
            # faithfully: a display name is the one thing that wants its stray
            # whitespace gone.
            creatures.names[to_int(entry)] = name.strip()
        displays: dict[int, list[tuple[int, int]]] = {}
        read_creature_displays(world, displays)
        creatures.displays = {creature: sorted(rows)
                              for creature, rows in displays.items()}

    for display_id, model_id in tables.rows("CreatureDisplayInfo", ["ID", "ModelID"]):
        creatures.display_model[to_int(display_id)] = to_int(model_id)
    for model_id, file_id in tables.rows("CreatureModelData", ["ID", "FileDataID"]):
        creatures.model_fid[to_int(model_id)] = to_int(file_id)
    return creatures
