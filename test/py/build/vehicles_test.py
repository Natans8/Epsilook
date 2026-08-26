"""Seats: the two absences, and why the animation sets stay apart."""

from __future__ import annotations

from pack.routes.vehicles import PASSENGER_ROLE_NAMES, SEAT_PASSENGER_ANIM_COLUMNS, read_vehicle_seats
from support import BuildTables

VEHICLE = """\
ID,SeatID_0,SeatID_1,SeatID_2,SeatID_3
1,10,11,0,0
2,12,0,0,0
3,0,0,0,0
"""

# Seat 10 anchors at index 0; seat 11 names a row that does not exist below.
VEHICLE_SEAT = """\
ID,AttachmentID,EnterAnimStart,RideAnimLoop,ExitAnimEnd,VehicleEnterAnim,VehicleRideAnimLoop,EnterAnimKitID,RideAnimKitID
10,0,20,21,0,30,31,40,0
12,14,0,0,0,0,0,0,41
"""


def test_the_seat_list_length_is_the_seat_count(tables: BuildTables) -> None:
    """Empty slots are dropped, so the list says how many seats there are."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=VEHICLE_SEAT))
    assert len(seats.seats[1]) == 2
    assert seats.seats[3] == []


def test_the_two_animation_sets_stay_apart(tables: BuildTables) -> None:
    """Folding them together would file a mount's own movement under what its
    passenger is doing."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=VEHICLE_SEAT))
    assert {anim for anim, _role in seats.passenger_anims[1]} == {20, 21}
    assert seats.vehicle_anims[1] == {30, 31}


def test_a_rider_animation_carries_the_role_it_plays_in(tables: BuildTables) -> None:
    """Entering and sitting are different acts, so the column a rider
    animation came from is kept rather than unioned away."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=VEHICLE_SEAT))
    # EnterAnimStart is the entering role, RideAnimLoop the seated one.
    assert seats.passenger_anims[1] == {(20, 0), (21, 1)}


def test_one_animation_in_two_roles_is_two_entries(tables: BuildTables) -> None:
    """Which act an animation belongs to is the question being asked, so the
    same animation entered and seated stays two answers."""
    seat = "ID,AttachmentID,EnterAnimStart,RideAnimLoop\n10,0,20,20\n"
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=seat))
    assert seats.passenger_anims[1] == {(20, 0), (20, 1)}


def test_the_anim_kits_join_one_group(tables: BuildTables) -> None:
    """Both sides' kits are ordinary anim kit ids."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=VEHICLE_SEAT))
    assert seats.animkits == {1: {40}, 2: {41}}


def test_a_seat_row_this_build_lacks_keeps_its_slot(tables: BuildTables) -> None:
    """The slot is still a seat; it loses its name, not its place."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=VEHICLE_SEAT))
    assert seats.seats[1][1] == ""


def test_a_seat_attachment_is_an_index_not_a_raw_id(tables: BuildTables) -> None:
    """The one attachment column in the game data that is indexed, not raw."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE, VehicleSeat=VEHICLE_SEAT))
    assert seats.seats[2] == ["VehicleSeat2"]


def test_with_no_seat_table_the_count_survives(tables: BuildTables) -> None:
    """A two-seat vehicle is still a two-seat vehicle when nothing can say
    where the seats are."""
    seats = read_vehicle_seats(tables(Vehicle=VEHICLE))
    assert seats.seats == {1: ["", ""], 2: [""], 3: []}
    assert seats.passenger_anims == {}


def test_with_no_vehicle_table_there_is_nothing(tables: BuildTables) -> None:
    seats = read_vehicle_seats(tables())
    assert seats.seats == {}


def test_every_rider_column_names_a_role_that_has_a_word() -> None:
    """The two declarations are the halves of one fact: a column maps to a
    role id and the pack ships that id's word. A role added to one and not the
    other ships rows nothing can name."""
    assert set(SEAT_PASSENGER_ANIM_COLUMNS.values()) == set(PASSENGER_ROLE_NAMES)
    assert all(word for word in PASSENGER_ROLE_NAMES.values())
