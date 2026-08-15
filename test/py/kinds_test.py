"""What pooling rows guarantees, and what a family may not quietly change.

Built from plain values with no source stood up, which is the derive layer's
whole point: a family is a mapping, and a mapping can be checked against the
pairs it was given.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import cast

import pytest

from pack.derive.context import Reads
from pack.derive.kinds import ABSENT, Family, SpellRow, build_column
from pack.model.sections.rows import columns_of, entries, walk


NO_READS = cast(Reads, None)
"""What a family built from a fixed list of pairs is handed.

Every family here closes over its rows, so the context is never touched; naming
that here is what keeps each test free of a source it does not need.
"""


def family(kind: str, props: tuple[str, ...],
           rows: Iterable[SpellRow], **extra: object) -> Family:
    """One family over a fixed list of pairs, ignoring the read context."""
    given = list(rows)
    return Family(kind=kind, props=props, rows=lambda _reads: given, **extra)  # type: ignore[arg-type]


def test_a_row_repeated_across_spells_is_pooled_once() -> None:
    """The whole reason the table is smaller than the columns it replaced."""
    rows = build_column([family("sound", ("file",), [(1, (7,)), (2, (7,)), (3, (7,))])],
                        reads=NO_READS, spell_ids=[1, 2, 3])
    assert rows.pools["sound"].rows == 1
    assert rows.pools["sound"].columns == ([7],)
    assert rows.counts == [1, 1, 1]
    assert rows.refs == [0, 0, 0]


def test_a_spell_with_no_rows_costs_one_zero() -> None:
    """Counts rather than offsets: the spells with nothing are what most of the
    column is, and they have to be free."""
    rows = build_column([family("sound", ("file",), [(2, (7,))])],
                        reads=NO_READS, spell_ids=[1, 2, 3])
    assert rows.counts == [0, 1, 0]
    assert rows.refs == [0]


def test_references_number_across_kinds_end_to_end() -> None:
    """One integer names both the kind and the row, which is what lets a spell's
    references be one flat array."""
    rows = build_column(
        [family("loose", ("anim",), [(1, (4,)), (1, (5,))]),
         family("pose", (), [(1, ())])],
        reads=NO_READS, spell_ids=[1])
    assert rows.pools["loose"].rows == 2
    assert rows.pools["pose"].rows == 1
    # The pose pool starts where the loose pool ends.
    assert sorted(rows.refs) == [0, 1, 2]


def test_a_valueless_kind_still_has_exactly_one_row() -> None:
    """A pose has no column to take a length from, and every spell that holds
    one refers to the same empty row."""
    rows = build_column([family("pose", (), [(1, ()), (2, ()), (3, ())])],
                        reads=NO_READS, spell_ids=[1, 2, 3])
    assert rows.pools["pose"].rows == 1
    assert rows.pools["pose"].columns == ()
    assert rows.refs == [0, 0, 0]


def test_a_spells_references_are_sorted() -> None:
    """So equal runs sit together rather than arriving in walk order."""
    rows = build_column(
        [family("loose", ("anim",), [(1, (9,)), (1, (3,)), (1, (5,))])],
        reads=NO_READS, spell_ids=[1])
    assert rows.refs == sorted(rows.refs)


def test_every_pair_survives_the_pooling() -> None:
    """Pooling is a change of storage, never of content: as many references come
    out as pairs went in."""
    pairs = [(1, (7,)), (1, (8,)), (2, (7,)), (3, (9,)), (3, (7,))]
    rows = build_column([family("sound", ("file",), pairs)],
                        reads=NO_READS, spell_ids=[1, 2, 3])
    assert len(rows.refs) == len(pairs)
    assert sum(rows.counts) == len(pairs)


def test_a_column_holds_only_the_spells_it_was_given() -> None:
    """A family naming a spell the pack does not list contributes nothing, and
    does not shift the spells that follow."""
    rows = build_column([family("sound", ("file",), [(1, (7,)), (99, (7,))])],
                        reads=NO_READS, spell_ids=[1, 2])
    assert rows.counts == [1, 0]
    assert len(rows.refs) == 1


def test_the_absent_marker_is_not_zero_where_zero_is_real() -> None:
    """An animation, an attachment and a boneset all number from zero, so the
    value meaning "none" cannot be zero for them."""
    assert ABSENT == -1


@pytest.mark.parametrize("props", [("a",), ("a", "b"), ("a", "b", "c")])
def test_the_pool_keeps_one_column_per_property(props: tuple[str, ...]) -> None:
    """Column-major, so the artifact ships like values together."""
    values = tuple(range(len(props)))
    rows = build_column([family("k", props, [(1, values)])],
                        reads=NO_READS, spell_ids=[1])
    assert len(rows.pools["k"].columns) == len(props)
    assert rows.pools["k"].props == props


def test_a_carried_column_is_not_one_of_the_properties() -> None:
    """The whole point of the split: what the evaluator reads is exactly what
    the catalogue declares, and a bridge column cannot pass for a property."""
    rows = build_column(
        [family("dissolve", ("texture",), [(1, (70, 40))], carried=("dissolve",))],
        reads=NO_READS, spell_ids=[1])
    pool = rows.pools["dissolve"]
    assert dict(pool.values) == {"texture": [70]}
    assert dict(pool.extras) == {"dissolve": [40]}


def test_a_carried_column_still_keys_the_row() -> None:
    """Two effects that look alike stay two rows, which is what keeps a pooled
    row and the legacy row it replaced one to one."""
    rows = build_column(
        [family("dissolve", ("texture",),
                [(1, (70, 40)), (1, (70, 41))], carried=("dissolve",))],
        reads=NO_READS, spell_ids=[1])
    assert rows.pools["dissolve"].rows == 2
    assert dict(rows.pools["dissolve"].extras) == {"dissolve": [40, 41]}


def test_a_float_survives_the_pooling() -> None:
    """A size change and a movement change are signed percentages, and
    forty-four of them carry a fraction."""
    rows = build_column([family("scale", ("amount",), [(1, (-99.5,))])],
                        reads=NO_READS, spell_ids=[1])
    assert rows.pools["scale"].columns == ([-99.5],)


def test_a_family_naming_an_undeclared_vocabulary_fails_the_build() -> None:
    """Left to the reader it is silent: the lookup misses, the property keeps
    the raw number, and every query on it answers nothing forever."""
    with pytest.raises(ValueError, match="nowhere"):
        build_column(
            [family("tint", ("colour",), [(1, (5,))], vocab={"colour": "nowhere"})],
            reads=NO_READS, spell_ids=[1])


def test_a_count_reads_the_effect_rather_than_the_texture() -> None:
    """One dissolve painting two textures is two rows and one dissolve, and the
    count the section carried has always been the second."""
    table = columns_of(build_column(
        [family("dissolve", ("texture",),
                [(1, (70, 40)), (1, (71, 40)), (2, (70, 40))],
                carried=("dissolve",))],
        reads=NO_READS, spell_ids=[1, 2]))
    rows = list(walk(table))
    assert len(rows) == 3
    assert len(entries(rows, "dissolve", "dissolve")) == 2
