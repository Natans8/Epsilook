"""Vehicles, their seats, and the animations riding one puts on both parties.

A spell reaches a vehicle's seats and animations through the vehicle, so the
hop is taken once here rather than by every reader. A vehicle with no seat
carries no pill and is dropped upstream, which is why nothing below tests for
one.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable

from ...derive import Reads, spell_rows
from ...measure import numeric_domain
from ..registry import register
from ..section import (Domain, Section, SectionColumns, size)


def seats(reads: Reads) -> SectionColumns:
    """One row per seat, in slot order, naming where on the model it sits.

    An empty attachment means the seat row was missing or its attachment
    unset, which is a different thing from a seat that sits nowhere.
    """
    return {"vehicleIds": [vehicle for vehicle, _name in reads.rows.seats],
            "attachments": [name for _vehicle, name in reads.rows.seats]}


def ridden(which: str, id_column: str,
           bounded: bool = True) -> Callable[[Reads], SectionColumns]:
    """One of the animation sets a spell reaches through its vehicle.

    Args:
        which: the seat bundle's field to flatten.
        id_column: what the flattened value is called in the artifact.
        bounded: whether ids past the animation name table are dropped, which
            every animation route does and no anim-kit route does.

    Returns:
        A producer flattening that set onto the spells that reach it. Computed
        once per call rather than per column, since both columns are two
        halves of the same rows.
    """

    def produce(reads: Reads) -> SectionColumns:
        limit = len(reads.declared.anim_names) if bounded else None
        rows = spell_rows(getattr(reads.vehicles, which), reads.rows.vehicles,
                          limit)
        return {"spellIds": [row[0] for row in rows],
                id_column: [row[1] for row in rows]}

    return produce


VEHICLES = register(Section(
    name="vehicles",
    doc="How many seats each reached vehicle has.",
    module="core",
    produce=lambda reads: {
        "vehicleIds": list(reads.rows.vehicle_ids),
        "seats": [len(reads.vehicles.seats[vehicle])
                  for vehicle in reads.rows.vehicle_ids]},
    columns=("vehicleIds", "seats"),
    reads=("rows", "vehicles"),
    counts=(size("vehicles", "vehicleIds"),),
))

VEHICLE_SEATS = register(Section(
    name="vehicleSeats",
    doc="One row per seat, naming where on the model it sits.",
    module="core",
    produce=seats,
    columns=("vehicleIds", "attachments"),
    reads=("rows",),
    counts=(size("vehicleSeats", "vehicleIds"),),
    domains=(Domain("seat", lambda columns, _r: numeric_domain(
        Counter(columns["vehicleIds"]).values())),),
))

SPELL_VEHICLE_ANIMS = register(Section(
    name="spellVehicleAnims",
    doc="The vehicle's own animations, which are not the rider's.",
    module="core",
    produce=ridden("vehicle_anims", "animIds"),
    columns=("spellIds", "animIds"),
    reads=("rows", "vehicles", "declared"),
    counts=(size("spellVehicleAnims", "spellIds"),),
))

SPELL_VEHICLE_ANIMKITS = register(Section(
    name="spellVehicleAnimKits",
    doc="The anim kits a seat names, which resolve like any other kit.",
    module="core",
    produce=ridden("animkits", "animKitIds", bounded=False),
    columns=("spellIds", "animKitIds"),
    reads=("rows", "vehicles"),
    counts=(size("spellVehicleAnimKits", "spellIds"),),
))
