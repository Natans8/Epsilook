"""Creature -> name and displays, and display -> the model file it wears.

The name and the displays come only from the TrinityCore world tables; the
`CreatureDisplayInfo.ModelID -> CreatureModelData.FileDataID` chain is client
data, so a build with no server dump still resolves a morph's model and loses
only the word for it. Morphs, shapeshift forms, mounts and the Type-2 effect
names all end at a `CreatureDisplayID` and all resolve it here.
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
    """Creature entry -> [(slot, CreatureDisplayID)] in slot order, the first
    being the one the pill shows. Empty without a server dump."""

    display_model: dict[int, int] = field(default_factory=dict)
    """CreatureDisplayInfo.ID -> CreatureModelData.ID."""

    model_fid: dict[int, int] = field(default_factory=dict)
    """CreatureModelData.ID -> the model's file id."""

    totem_displays: dict[int, tuple[int, ...]] = field(default_factory=dict)
    """Spell -> the displays its totem wears, one per caster race, deduplicated
    and in display order. Empty without a server dump.

    Keyed by the SPELL rather than by the creature, unlike `displays`, because
    that is how the table keys it: the summoned creature carries one display
    and the race decides which model stands in for it. Several races share a
    model, so this is shorter than the row count.
    """

    display_skins: dict[int, tuple[int, ...]] = field(default_factory=dict)
    """CreatureDisplayInfo.ID -> the texture files it paints its model with, in
    slot order, for the displays that carry any. A display with none paints
    the model's own textures, and a humanoid display's skin is a baked
    customization rather than a file, so both are absent here."""

    def fid_for_display(self, display_id: int) -> int:
        """A display id resolved to its model file id, or 0 when unknown.

        Two hops: several displays share one model, so the file id lives one
        table further down.
        """
        return self.model_fid.get(self.display_model.get(display_id, 0), 0)


def read_creature_displays(world: Tables, into: dict[int, list[tuple[int, int]]]) -> None:
    """Fill `into` with each creature's displays, whichever shape they arrive in.

    Older dumps keep up to four display ids as columns on the creature row,
    where the column position stands in for the slot; later releases give them
    their own table. A release with neither leaves morphs unresolved.
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


def read_totem_displays(world: Tables, into: dict[int, tuple[int, ...]]) -> None:
    """Fill `into` with each totem spell's per-race displays.

    A release without the table leaves it empty, and every totem spell then
    shows the single display its summoned creature carries.
    """
    if not world.available("spell_totem_model"):
        log("  TDB: no spell_totem_model in this release -- totems keep one display")
        return
    found: dict[int, list[int]] = {}
    for spell, _race, display in world.rows(
            "spell_totem_model", ["SpellID", "RaceID", "DisplayID"]):
        if display_id := to_int(display):
            found.setdefault(to_int(spell), []).append(display_id)
    into.update((spell, tuple(sorted(set(displays))))
                for spell, displays in found.items())


SKIN_COLUMN = "TextureVariationFileDataID_"
"""The stem of a display's texture columns, one per slot. How many a client has
varies by build, so they are read by name off the header rather than declared."""


def skin_columns(tables: Tables) -> list[str]:
    """The texture-variation columns this build's display table has, in slot order."""
    found = [column for column in tables.header("CreatureDisplayInfo")
             if column.startswith(SKIN_COLUMN)]
    return sorted(found, key=lambda column: int(column[len(SKIN_COLUMN):]))


def read_creature_models(tables: Tables, world: Tables | None) -> CreatureModels:
    """Read the creature chain morphs, forms and mounts all end at.

    `world` is the server dump, None for builds that have none; only the naming
    half depends on it.
    """
    creatures = CreatureModels()
    if world is not None:
        for entry, name in world.rows("creature_template", ["entry", "name"]):
            # Trimmed here rather than in the dump reader, which decodes
            # faithfully.
            creatures.names[to_int(entry)] = name.strip()
        displays: dict[int, list[tuple[int, int]]] = {}
        read_creature_displays(world, displays)
        creatures.displays = {creature: sorted(rows)
                              for creature, rows in displays.items()}
        read_totem_displays(world, creatures.totem_displays)

    for display_id, model_id, *skins in tables.rows(
            "CreatureDisplayInfo", ["ID", "ModelID", *skin_columns(tables)]):
        creatures.display_model[to_int(display_id)] = to_int(model_id)
        # One texture named in two slots is one skin; the order is the slots'.
        if painted := tuple(dict.fromkeys(fid for fid in map(to_int, skins) if fid)):
            creatures.display_skins[to_int(display_id)] = painted
    for model_id, file_id in tables.rows("CreatureModelData", ["ID", "FileDataID"]):
        creatures.model_fid[to_int(model_id)] = to_int(file_id)
    return creatures
