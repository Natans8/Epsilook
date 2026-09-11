"""Vehicles and their seats: where a rider sits and what both of them animate.

A vehicle names up to eight seats by slot, and each seat carries the animations
the rider plays and, separately, the ones the vehicle plays. The two sets stay
apart; everything but the seat order is unioned per vehicle.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import NamedTuple

from .attachments import seat_attachment_name

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

SEAT_COLUMNS = (*SEAT_PASSENGER_ANIM_COLUMNS, *SEAT_VEHICLE_ANIM_COLUMNS, *SEAT_ANIMKIT_COLUMNS)
"""Every animation column of a seat, in the order `Seat.of` unpacks them."""


class Seat(NamedTuple):
    """One seat: where it attaches, and what its rider and its vehicle play."""

    name: str
    """The attachment's name, since the seat's column is an index rather than a raw id."""
    rider: tuple[tuple[int, int], ...]
    """The rider's animations, each with the role it plays in. One animation
    used for two roles is two entries, because which act it belongs to is
    what a reader is asking about."""
    driven: tuple[int, ...]
    """The animations the vehicle itself plays."""
    kits: tuple[int, ...]
    """The anim kits either of them plays."""

    @classmethod
    def of(cls, attachment: int, *played: int) -> Seat:
        """A seat from its attachment and its `SEAT_COLUMNS`, in that order."""
        riders = len(SEAT_PASSENGER_ANIM_COLUMNS)
        driven = riders + len(SEAT_VEHICLE_ANIM_COLUMNS)
        return cls(
            seat_attachment_name(attachment),
            tuple(
                (anim, role) for anim, role in zip(played[:riders], SEAT_PASSENGER_ANIM_COLUMNS.values()) if anim > 0
            ),
            tuple(anim for anim in played[riders:driven] if anim > 0),
            tuple(kit for kit in played[driven:] if kit > 0),
        )


@dataclass
class VehicleSeats:
    """Each vehicle's seats and the animations they reach."""

    seats: dict[int, list[str]] = field(default_factory=dict)
    """Vehicle -> the attachment name of each seat, in slot order. Empty slots
    are dropped, so the list length is the seat count."""

    passenger_anims: dict[int, set[tuple[int, int]]] = field(default_factory=dict)
    """Vehicle -> the animations its riders play, each with the role it plays in."""

    vehicle_anims: dict[int, set[int]] = field(default_factory=dict)
    """Vehicle -> the animations the vehicle itself plays."""

    animkits: dict[int, set[int]] = field(default_factory=dict)
    """Vehicle -> the anim kits either of them plays."""

    @classmethod
    def assemble(cls, slots: Mapping[int, Sequence[int]], seats: Mapping[int, Seat]) -> VehicleSeats:
        """Walk each vehicle's seat slots into what the seats carry.

        A seat the build has no row for keeps its slot and loses its name,
        so with a vehicle table and no seat table the slot positions still
        give the seat count.
        """
        vehicles = cls()
        for vehicle, seat_ids in slots.items():
            names: list[str] = []
            for seat_id in seat_ids:
                seat = seats.get(seat_id)
                names.append(seat.name if seat is not None else "")
                if seat is None:
                    continue
                if seat.rider:
                    vehicles.passenger_anims.setdefault(vehicle, set()).update(seat.rider)
                if seat.driven:
                    vehicles.vehicle_anims.setdefault(vehicle, set()).update(seat.driven)
                if seat.kits:
                    vehicles.animkits.setdefault(vehicle, set()).update(seat.kits)
            vehicles.seats[vehicle] = names
        return vehicles
