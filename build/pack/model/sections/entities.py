"""The things a spell turns into, rides, summons or places in the world.

Five routes with one shape between them: a link from the spell to an entity,
and a payload naming that entity. They are separate sections because the id
spaces are separate -- a creature, a mount display, a form, an object entry --
and a pill has to say which one it is holding.
"""

from __future__ import annotations

from collections.abc import Callable

from ...derive import Reads
from ..registry import register
from ..section import (Count, Layout, Scope, Section,
                       SectionColumns)

NO_TYPE = -1
"""What an object with no resolved row carries, which is not type zero."""


def display_rows(which: str, id_column: str) -> Callable[[Reads], SectionColumns]:
    """One display route flattened to (subject, display, model file) rows."""

    def produce(reads: Reads) -> SectionColumns:
        rows = getattr(reads.displays, which)
        return {id_column: [row.subject for row in rows],
                "displayIds": [row.display for row in rows],
                "fids": [row.fid for row in rows]}

    return produce


def morphs(reads: Reads) -> SectionColumns:
    """The name of each creature a spell morphs into.

    The id order is bound once and every column built from it, which is what
    makes these arrays parallel rather than merely alike: recomputing the
    ordering per column would leave them agreeing by luck, and any narrowing of
    one comprehension would misalign the rest with nothing to say so.
    """
    ids = sorted({creature for creatures in reads.effects.morphs.ids.values()
                  for creature in creatures})
    return {"creatureIds": ids,
            "names": [reads.creatures.names.get(creature, "")
                      for creature in ids]}


def mounts(reads: Reads) -> SectionColumns:
    """Each reached mount display's name and model file."""
    ids = sorted(reads.references.mount_displays)
    return {"displayIds": ids,
            "names": [reads.mounts.name.get(display, "") for display in ids],
            "fids": [reads.mounts.fid.get(display, 0) for display in ids]}


def shapeshifts(reads: Reads) -> SectionColumns:
    """The name of each shapeshift form a spell reaches."""
    ids = sorted({form for forms in reads.effects.forms.ids.values()
                  for form in forms})
    return {"ids": ids,
            "names": [reads.forms.names.get(form, "") for form in ids]}


def summons(reads: Reads) -> SectionColumns:
    """The name of each summoned creature."""
    ids = sorted({creature for summoned in reads.effects.summons.values()
                  for creature, _control in summoned})
    return {"creatureIds": ids,
            "names": [reads.creatures.names.get(creature, "")
                      for creature in ids]}


def objects(reads: Reads) -> SectionColumns:
    """Each placed object's name, model file and type."""
    ids = reads.references.objects
    return {"ids": ids,
            "names": [reads.objects.name.get(entry, "") for entry in ids],
            "fids": [reads.objects.fid.get(entry, 0) for entry in ids],
            # The type decides whether the pill offers an external link, since
            # only player-facing types are indexed anywhere.
            "types": [reads.objects.type.get(entry, NO_TYPE) for entry in ids]}


MORPHS = register(Section(
    name="morphs",
    doc="The name of each creature a spell morphs into.",
    module="core",
    produce=morphs,
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
    produce=display_rows("morphs", "creatureIds"),
    columns=("creatureIds", "displayIds", "fids"),
    reads=("displays",),
    counts=(Count("morphDisplays",
                  lambda columns, _r: len(columns["creatureIds"])),),
))

MOUNTS = register(Section(
    name="mounts",
    doc="Each reached mount display's name and model file.",
    module="core",
    produce=mounts,
    columns=("displayIds", "names", "fids"),
    reads=("mounts", "references"),
    counts=(Count("mounts", lambda columns, _r: len(columns["displayIds"])),),
    localizable=('names',),
))

SHAPESHIFTS = register(Section(
    name="shapeshifts",
    doc="The name of each shapeshift form a spell reaches.",
    module="core",
    produce=shapeshifts,
    columns=("ids", "names"),
    reads=("effects", "forms"),
    localizable=('names',),
))

SHAPESHIFT_DISPLAYS = register(Section(
    name="shapeshiftDisplays",
    doc="The models each shapeshift form can wear.",
    module="core",
    produce=display_rows("forms", "formIds"),
    columns=("formIds", "displayIds", "fids"),
    reads=("displays",),
    counts=(Count("shapeshiftDisplays",
                  lambda columns, _r: len(columns["formIds"])),),
))

SUMMONS = register(Section(
    name="summons",
    doc="The name of each summoned creature.",
    module="core",
    produce=summons,
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
    produce=lambda reads: {"names": reads.declared.summon_control_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))

OBJECTS = register(Section(
    name="objects",
    doc="Each placed object's name, model file and type.",
    module="core",
    produce=objects,
    columns=("ids", "names", "fids", "types"),
    reads=("references", "objects"),
    degraded_without=("gameobject_template",),
    counts=(Count("objects", lambda columns, _r: len(columns["ids"])),),
    localizable=('names',),
))
