"""Vehicles and their seats: where a rider sits and what both of them animate.

A vehicle names up to eight seats by slot, and each seat carries the animations
the rider plays and, separately, the ones the vehicle plays. The two sets stay
apart; everything but the seat order is unioned per vehicle.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables
from .attachments import seat_attachment_name
from .columns import to_int

PASSENGER_ROLE_NAMES = {0: "enter", 1: "sit", 2: "exit"}
"""What a rider is doing while an animation plays, by role id.

Three roles rather than nine columns: the game spells each one as a start, a
loop and sometimes an end, which are stages of one act and not three things a
reader would ask about apart.
"""

SEAT_PASSENGER_ANIM_COLUMNS = {
    "EnterAnimStart": 0,
    "EnterAnimLoop": 0,
    "RideAnimStart": 1,
    "RideAnimLoop": 1,
    "RideUpperAnimStart": 1,
    "RideUpperAnimLoop": 1,
    "ExitAnimStart": 2,
    "ExitAnimLoop": 2,
    "ExitAnimEnd": 2,
}
"""The rider's animation columns, each under the role it plays in."""
SEAT_VEHICLE_ANIM_COLUMNS = ["VehicleEnterAnim", "VehicleExitAnim", "VehicleRideAnimLoop"]
SEAT_ANIMKIT_COLUMNS = [
    "EnterAnimKitID",
    "RideAnimKitID",
    "ExitAnimKitID",
    "VehicleEnterAnimKitID",
    "VehicleRideAnimKitID",
    "VehicleExitAnimKitID",
]
"""The seat's anim kits. Ordinary anim kit ids, so they join that group."""


@dataclass
class VehicleSeats:
    """Each vehicle's seats and the animations they reach."""

    seats: dict[int, list[str]] = field(default_factory=dict)
    """Vehicle -> the attachment name of each seat, in slot order. Empty slots
    are dropped, so the list length is the seat count."""

    passenger_anims: dict[int, set[tuple[int, int]]] = field(default_factory=dict)
    """Vehicle -> the animations its riders play, each with the role it plays
    in. One animation used for two roles is two entries, because which act it
    belongs to is what a reader is asking about."""

    vehicle_anims: dict[int, set[int]] = field(default_factory=dict)
    """Vehicle -> the animations the vehicle itself plays."""

    animkits: dict[int, set[int]] = field(default_factory=dict)
    """Vehicle -> the anim kits either of them plays."""


def read_vehicle_seats(tables: Tables) -> VehicleSeats:
    """Walk each vehicle to its seats and collect what they carry.

    The two absences are checked separately: with vehicles but no seat table
    the slot positions still give the seat count. The seat columns are read
    from the header, because which of them a build carries varies.
    """
    vehicles = VehicleSeats()
    if not tables.available("Vehicle"):
        return vehicles
    seat_columns = sorted(
        (column for column in tables.header("Vehicle") if column.startswith("SeatID_")),
        key=lambda column: int(column.split("_")[1]),
    )
    slots: dict[int, list[int]] = {}
    for vehicle_id, *declared in tables.rows("Vehicle", ["ID", *seat_columns]):
        slots[to_int(vehicle_id)] = [seat for seat in (to_int(value) for value in declared) if seat > 0]

    if not tables.available("VehicleSeat"):
        vehicles.seats = {vehicle: [""] * len(seats) for vehicle, seats in slots.items()}
        return vehicles

    present = set(tables.header("VehicleSeat"))
    rider_columns = [column for column in SEAT_PASSENGER_ANIM_COLUMNS if column in present]
    vehicle_columns = [column for column in SEAT_VEHICLE_ANIM_COLUMNS if column in present]
    kit_columns = [column for column in SEAT_ANIMKIT_COLUMNS if column in present]
    riders, driven = len(rider_columns), len(vehicle_columns)
    seat_rows: dict[int, tuple[int, list[int], list[int], list[int]]] = {}
    for row in tables.rows("VehicleSeat", ["ID", "AttachmentID", *rider_columns, *vehicle_columns, *kit_columns]):
        values = [to_int(value) for value in row]
        rest = values[2:]
        seat_rows[values[0]] = (values[1], rest[:riders], rest[riders : riders + driven], rest[riders + driven :])

    for vehicle, seat_ids in slots.items():
        names: list[str] = []
        for seat_id in seat_ids:
            seat = seat_rows.get(seat_id)
            if seat is None:
                # The vehicle names a seat row this build does not have; the
                # slot keeps its place and loses its name.
                names.append("")
                continue
            attachment, rider_anims, vehicle_anims, seat_kits = seat
            names.append(seat_attachment_name(attachment))
            roled = {
                (value, SEAT_PASSENGER_ANIM_COLUMNS[column])
                for column, value in zip(rider_columns, rider_anims)
                if value > 0
            }
            if roled:
                vehicles.passenger_anims.setdefault(vehicle, set()).update(roled)
            for values, into in ((vehicle_anims, vehicles.vehicle_anims), (seat_kits, vehicles.animkits)):
                played = {value for value in values if value > 0}
                if played:
                    into.setdefault(vehicle, set()).update(played)
        vehicles.seats[vehicle] = names
    return vehicles
