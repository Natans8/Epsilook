"""Seats: the two absences, and why the animation sets stay apart."""

from __future__ import annotations

from pack.routes.vehicles import PASSENGER_ROLE_NAMES, SEAT_COLUMNS, SEAT_PASSENGER_ANIM_COLUMNS, VehicleSeats
from support import BuildTables, resolve

VEHICLE = """\
ID,SeatID_0,SeatID_1,SeatID_2,SeatID_3
1,10,11,0,0
2,12,0,0,0
3,0,0,0,0
"""


def seat_table(*rows: dict[str, int]) -> str:
    """A `VehicleSeat` table carrying every animation column, the ones a row
    leaves unsaid at nought."""
    header = ["ID", "AttachmentID", *SEAT_COLUMNS]
    lines = [",".join(header)]
    lines.extend(",".join(str(row.get(column, 0)) for column in header) for row in rows)
    return "\n".join(lines) + "\n"


# Seat 10 anchors at index 0; seat 11 names a row that does not exist below.
VEHICLE_SEAT = seat_table(
    {
        "ID": 10,
        "EnterAnimStart": 20,
        "RideAnimLoop": 21,
        "VehicleEnterAnim": 30,
        "VehicleRideAnimLoop": 31,
        "EnterAnimKitID": 40,
    },
    {"ID": 12, "AttachmentID": 14, "RideAnimKitID": 41},
)


def vehicles(tables: BuildTables, seats: str | None = VEHICLE_SEAT, vehicle: str | None = VEHICLE) -> VehicleSeats:
    held = {name: text for name, text in (("Vehicle", vehicle), ("VehicleSeat", seats)) if text is not None}
    found = resolve("vehicles", tables(**held))
    if not isinstance(found, VehicleSeats):
        raise TypeError("the vehicles field is the seat record")
    return found


def test_the_seat_list_length_is_the_seat_count(tables: BuildTables) -> None:
    """Empty slots are dropped, so the list says how many seats there are."""
    seats = vehicles(tables)
    assert len(seats.seats[1]) == 2
    assert seats.seats[3] == []


def test_the_two_animation_sets_stay_apart(tables: BuildTables) -> None:
    """Folding them together would file a mount's own movement under what its
    passenger is doing."""
    seats = vehicles(tables)
    assert {anim for anim, _role in seats.passenger_anims[1]} == {20, 21}
    assert seats.vehicle_anims[1] == {30, 31}


def test_a_rider_animation_carries_the_role_it_plays_in(tables: BuildTables) -> None:
    """Entering and sitting are different acts, so the column a rider
    animation came from is kept rather than unioned away."""
    # EnterAnimStart is the entering role, RideAnimLoop the seated one.
    assert vehicles(tables).passenger_anims[1] == {(20, 0), (21, 1)}


def test_one_animation_in_two_roles_is_two_entries(tables: BuildTables) -> None:
    """Which act an animation belongs to is the question being asked, so the
    same animation entered and seated stays two answers."""
    seats = vehicles(tables, seat_table({"ID": 10, "EnterAnimStart": 20, "RideAnimLoop": 20}))
    assert seats.passenger_anims[1] == {(20, 0), (20, 1)}


def test_the_anim_kits_join_one_group(tables: BuildTables) -> None:
    """Both sides' kits are ordinary anim kit ids."""
    assert vehicles(tables).animkits == {1: {40}, 2: {41}}


def test_a_seat_row_this_build_lacks_keeps_its_slot(tables: BuildTables) -> None:
    """The slot is still a seat; it loses its name, not its place."""
    assert vehicles(tables).seats[1][1] == ""


def test_a_seat_attachment_is_an_index_not_a_raw_id(tables: BuildTables) -> None:
    """The one attachment column in the game data that is indexed, not raw."""
    assert vehicles(tables).seats[2] == ["VehicleSeat2"]


def test_with_no_seat_table_the_count_survives(tables: BuildTables) -> None:
    """A two-seat vehicle is still a two-seat vehicle when nothing can say
    where the seats are."""
    seats = vehicles(tables, seats=None)
    assert seats.seats == {1: ["", ""], 2: [""], 3: []}
    assert seats.passenger_anims == {}


def test_with_no_vehicle_table_there_is_nothing(tables: BuildTables) -> None:
    assert vehicles(tables, seats=None, vehicle=None).seats == {}


def test_every_rider_column_names_a_role_that_has_a_word() -> None:
    """The two declarations are the halves of one fact: a column maps to a
    role id and the pack ships that id's word. A role added to one and not the
    other ships rows nothing can name."""
    assert set(SEAT_PASSENGER_ANIM_COLUMNS.values()) == set(PASSENGER_ROLE_NAMES)
    assert all(word for word in PASSENGER_ROLE_NAMES.values())
