"""Every encoding decodes back to what the section produced.

The property the artifact rests on and nothing else states: a layout is a way of
spending fewer bytes on a column, so a layout that loses something is not a
layout. It is worth a test rather than a reading because the two halves are
easy to change one at a time.
"""

from __future__ import annotations

import pytest

from pack.encode import EMPTY_SLOT, decode_column, encode_column
from pack.model.section import Column, Encoding

COLUMNS: list[tuple[str, Column]] = [
    ("ints", [3, 1, 4, 1, 5, 9, 2, 6]),
    ("text", ["Fireball", "Frostbolt", "Fireball", ""]),
    ("one repeated value", ["cast"] * 40),
    ("every row distinct", [f"spell {n}" for n in range(40)]),
    ("mostly gaps", ["", "", "", "here", "", "", ""]),
    ("all gaps", ["", "", ""]),
    ("empty", []),
    ("floats", [1.5, -0.25, 0.0]),
    ("a keyed vocabulary", {"3": "Elite", "9": "Rare"}),
]


@pytest.mark.parametrize("encoding", list(Encoding))
@pytest.mark.parametrize(("what", "values"), COLUMNS, ids=[name for name, _ in COLUMNS])
def test_a_column_survives_its_layout(encoding: Encoding, what: str, values: Column) -> None:
    """Encode then decode is the identity, for every layout and every shape."""
    if isinstance(values, dict) and encoding is not Encoding.DENSE:
        pytest.skip(f"a {encoding.value} column is keyed by position, not by id")
    shipped = encode_column(values, encoding)
    assert decode_column(shipped, encoding, rows=len(values)) == values, what


def test_a_sparse_column_decodes_short_when_nobody_says_how_many_rows() -> None:
    """The one case the payload cannot state, said out loud rather than
    discovered: what ships is the rows that carry a value, so a column whose
    last rows carry none has no record of how many there were. The row count is
    the section's, not the column's, which is why it is asked for."""
    shipped = encode_column(["here", "", ""], Encoding.SPARSE)
    assert decode_column(shipped, Encoding.SPARSE) == ["here"]
    assert decode_column(shipped, Encoding.SPARSE, rows=3) == ["here", "", ""]


def test_a_sparse_column_keeps_a_filler_that_is_not_the_empty_string() -> None:
    """Zero is a real value in most columns and a gap in a few, so the filler
    travels with the column rather than being assumed."""
    shipped = encode_column([0, 7, 0, 9], Encoding.SPARSE, absent=0)
    assert shipped == {"at": [1, 3], "is": [7, 9]}
    assert decode_column(shipped, Encoding.SPARSE, absent=0) == [0, 7, 0, 9]


def test_a_deduped_pool_always_holds_the_empty_slot_first() -> None:
    """A row with nothing to say indexes slot 0, so the decode of an absent
    value is the filler and never an index error."""
    shipped = encode_column(["", "cast"], Encoding.DEDUP)
    assert shipped == {"text": [EMPTY_SLOT, "cast"], "of": [0, 1]}


@pytest.mark.parametrize("encoding", [Encoding.DEDUP, Encoding.SPARSE])
def test_a_payload_of_the_wrong_shape_is_refused(encoding: Encoding) -> None:
    """A reader handed a list where the encoding ships a mapping has been given
    a column encoded some other way, and guessing which is how a mirror starts
    disagreeing with the pack."""
    with pytest.raises(ValueError):
        decode_column([1, 2, 3], encoding)
