"""The things a spell turns into, rides, summons or places in the world.

Five routes with one shape between them: a link from the spell to an entity,
and a payload naming that entity. They are separate sections because the id
spaces are separate -- a creature, a mount display, a form, an object entry --
and a pill has to say which one it is holding.
"""

from __future__ import annotations

from collections.abc import Callable

from ...derive import Reads
from ...routes.effects import MaskedIds
from ..registry import register
from ..section import (Count, Layout, Scope, Section,
                       SectionColumns)

NO_TYPE = -1
"""What an object with no resolved row carries, which is not type zero."""


def linked(payload: str, id_column: str) -> Callable[[Reads], SectionColumns]:
    """One entity route's spell-to-entity links, with who each was aimed at.

    The mask travels on the pair rather than beside it, since the pair is what
    becomes a chip: a spell reaching two creatures aims at each separately.
    """
    def produce(reads: Reads) -> SectionColumns:
        ids: MaskedIds = getattr(reads.effects, payload)
        rows = sorted((spell, entity) for spell, entities in ids.ids.items()
                      for entity in entities)
        return {"spellIds": [row[0] for row in rows],
                id_column: [row[1] for row in rows],
                "targets": [ids.masks.get(row, 0) for row in rows]}
    return produce


def display_rows(which: str) -> Callable[[Reads], SectionColumns]:
    """One display route flattened to (subject, display, model file) rows."""
    def produce(reads: Reads) -> SectionColumns:
        rows = getattr(reads.displays, which)
        return {"creatureIds" if which == "morphs" else "formIds":
                [row.subject for row in rows],
                "displayIds": [row.display for row in rows],
                "fids": [row.fid for row in rows]}
    return produce


def summons(reads: Reads) -> SectionColumns:
    """Which creature each summoning effect brings, and who controls it."""
    rows = sorted((spell, creature, control)
                  for spell, summoned in reads.effects.summons.items()
                  for creature, control in summoned)
    return {"spellIds": [row[0] for row in rows],
            "creatureIds": [row[1] for row in rows],
            "controls": [row[2] for row in rows],
            "targets": [reads.effects.summon_targets.get((row[0], row[1]), 0)
                        for row in rows]}


SPELL_MORPHS = register(Section(
    name="spellMorphs",
    doc="Which creature a transform aura turns its subject into.",
    module="core",
    produce=linked("morphs", "creatureIds"),
    columns=("spellIds", "creatureIds", "targets"),
    reads=("effects",),
    counts=(Count("spellMorphs", lambda columns, _r: len(columns["spellIds"])),),
))

MORPHS = register(Section(
    name="morphs",
    doc="The name of each creature a spell morphs into.",
    module="core",
    produce=lambda reads: {
        "creatureIds": sorted({creature for creatures
                               in reads.effects.morphs.ids.values()
                               for creature in creatures}),
        "names": [reads.creatures.names.get(creature, "")
                  for creature in sorted({c for cs
                                          in reads.effects.morphs.ids.values()
                                          for c in cs})]},
    columns=("creatureIds", "names"),
    reads=("effects", "creatures"),
    degraded_without=("creature_template",),
    counts=(Count("morphs", lambda columns, _r: len(columns["creatureIds"])),),
    localizable=('names',),
))

MORPH_DISPLAYS = register(Section(
    name="morphDisplays",
    doc="The models each morphed creature can wear.",
    module="core",
    produce=display_rows("morphs"),
    columns=("creatureIds", "displayIds", "fids"),
    reads=("displays",),
    counts=(Count("morphDisplays",
                  lambda columns, _r: len(columns["creatureIds"])),),
))

SPELL_MOUNTS = register(Section(
    name="spellMounts",
    doc="Which mount display a mount-granting spell reaches.",
    module="core",
    produce=lambda reads: {
        "spellIds": [spell for spell, _display in reads.mounts.links],
        "displayIds": [display for _spell, display in reads.mounts.links]},
    columns=("spellIds", "displayIds"),
    reads=("mounts",),
    counts=(Count("spellMounts", lambda columns, _r: len(columns["spellIds"])),),
))

MOUNTS = register(Section(
    name="mounts",
    doc="Each reached mount display's name and model file.",
    module="core",
    produce=lambda reads: {
        "displayIds": sorted(reads.references.mount_displays),
        "names": [reads.mounts.name.get(display, "")
                  for display in sorted(reads.references.mount_displays)],
        "fids": [reads.mounts.fid.get(display, 0)
                 for display in sorted(reads.references.mount_displays)]},
    columns=("displayIds", "names", "fids"),
    reads=("mounts", "references"),
    counts=(Count("mounts", lambda columns, _r: len(columns["displayIds"])),),
    localizable=('names',),
))

SPELL_SHAPESHIFTS = register(Section(
    name="spellShapeshifts",
    doc="Which shapeshift form a spell puts its subject in.",
    module="core",
    produce=linked("forms", "formIds"),
    columns=("spellIds", "formIds", "targets"),
    reads=("effects",),
    counts=(Count("spellShapeshifts",
                  lambda columns, _r: len(columns["spellIds"])),),
))

SHAPESHIFTS = register(Section(
    name="shapeshifts",
    doc="The name of each shapeshift form a spell reaches.",
    module="core",
    produce=lambda reads: {
        "ids": sorted({form for forms in reads.effects.forms.ids.values()
                       for form in forms}),
        "names": [reads.forms.names.get(form, "")
                  for form in sorted({f for fs in reads.effects.forms.ids.values()
                                      for f in fs})]},
    columns=("ids", "names"),
    reads=("effects", "forms"),
    localizable=('names',),
))

SHAPESHIFT_DISPLAYS = register(Section(
    name="shapeshiftDisplays",
    doc="The models each shapeshift form can wear.",
    module="core",
    produce=display_rows("forms"),
    columns=("formIds", "displayIds", "fids"),
    reads=("displays",),
    counts=(Count("shapeshiftDisplays",
                  lambda columns, _r: len(columns["formIds"])),),
))

SPELL_SUMMONS = register(Section(
    name="spellSummons",
    doc="Which creature a summoning effect brings, and who controls it.",
    module="core",
    produce=summons,
    columns=("spellIds", "creatureIds", "controls", "targets"),
    reads=("effects",),
    counts=(Count("spellSummons", lambda columns, _r: len(columns["spellIds"])),),
))

SUMMONS = register(Section(
    name="summons",
    doc="The name of each summoned creature.",
    module="core",
    produce=lambda reads: {
        "creatureIds": sorted({creature for summoned
                               in reads.effects.summons.values()
                               for creature, _control in summoned}),
        "names": [reads.creatures.names.get(creature, "") for creature
                  in sorted({c for s in reads.effects.summons.values()
                             for c, _ in s})]},
    columns=("creatureIds", "names"),
    reads=("effects", "creatures"),
    degraded_without=("creature_template",),
    counts=(Count("summons", lambda columns, _r: len(columns["creatureIds"])),),
    localizable=('names',),
))

SUMMON_CONTROL_NAMES = register(Section(
    name="summonControlNames",
    doc="The word each summon control value renders as.",
    module="universal",
    produce=lambda reads: {"names": reads.summon_control_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("summon_control_names",),
    scope=Scope.UNIVERSAL,
))

SPELL_OBJECTS = register(Section(
    name="spellObjects",
    doc="Which gameobject a spell places in the world.",
    module="core",
    produce=lambda reads: {
        "spellIds": [row[0] for row in reads.references.object_rows],
        "objectIds": [row[1] for row in reads.references.object_rows],
        "targets": [reads.effects.objects.masks.get(row, 0)
                    for row in reads.references.object_rows]},
    columns=("spellIds", "objectIds", "targets"),
    reads=("references", "effects"),
    counts=(Count("spellObjects", lambda columns, _r: len(columns["spellIds"])),),
))

OBJECTS = register(Section(
    name="objects",
    doc="Each placed object's name, model file and type.",
    module="core",
    produce=lambda reads: {
        "ids": sorted({entry for _spell, entry in reads.references.object_rows}),
        "names": [reads.objects.name.get(entry, "") for entry
                  in sorted({e for _s, e in reads.references.object_rows})],
        "fids": [reads.objects.fid.get(entry, 0) for entry
                 in sorted({e for _s, e in reads.references.object_rows})],
        # The type decides whether the pill offers an external link, since only
        # player-facing types are indexed anywhere.
        "types": [reads.objects.type.get(entry, NO_TYPE) for entry
                  in sorted({e for _s, e in reads.references.object_rows})]},
    columns=("ids", "names", "fids", "types"),
    reads=("references", "objects"),
    degraded_without=("gameobject_template",),
    counts=(Count("objects", lambda columns, _r: len(columns["ids"])),),
    localizable=('names',),
))
