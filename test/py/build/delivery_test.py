"""Delivery is not a partition, and every case here is one way of saying so.

A spell can carry a cast time and a channel at once, and both numbers have to
survive. The rest pins the two sentinels and the optional table.
"""

from __future__ import annotations

from pack.routes.delivery import BREAKS_ON_MOVE, CHANNELLED, read_spell_delivery
from pack.routes.spells import SpellProperties
from pack.tables import CsvTables
from support import BuildTables

CHANNEL_WORD = 1 << 2
"""Attribute bit 34 lives in the second word, at `1 << 2`."""

SELF_CHANNEL_WORD = 1 << 6
"""Attribute bit 38, the self-channelled flag, in the same word."""

MOVING = 1 << 3
"""`ChannelInterruptFlags` bit 3, the one tagged as movement."""

CAST_TIMES = "ID,Base\n3,1500\n4,-1000000\n"
DURATIONS = "ID,Duration\n5,8000\n6,-1\n7,100000001\n"


def properties(spells: dict[int, tuple[int, int, int]]) -> SpellProperties:
    """A `SpellProperties` holding just what delivery reads.

    Args:
        spells: spell id to its `(cast index, duration index, channel word)`.

    Returns:
        The bundle a real `SpellMisc` read would have produced.
    """
    built = SpellProperties()
    for spell, (cast, duration, word) in spells.items():
        built.cast_index[spell] = cast
        built.duration_index[spell] = duration
        built.attribute_words[spell] = (0, word)
    return built


def source(tables: BuildTables, interrupts: str | None = None) -> CsvTables:
    """The three tables delivery reads, with interrupts optional."""
    if interrupts is None:
        return tables(
            SpellCastTimes=CAST_TIMES, SpellDuration=DURATIONS, absent={"SpellInterrupts": "predates the table"}
        )
    return tables(SpellCastTimes=CAST_TIMES, SpellDuration=DURATIONS, SpellInterrupts=interrupts)


def test_a_cast_and_a_channel_both_survive_on_one_spell(tables: BuildTables) -> None:
    """The old rule let the channel win and threw the cast number away; in game
    such a spell shows a cast bar and then a draining channel bar."""
    rows = read_spell_delivery(source(tables), properties({100: (3, 5, CHANNEL_WORD)}))
    assert len(rows) == 1
    assert (rows[0].cast_ms, rows[0].duration_ms) == (1500, 8000)
    assert rows[0].flags & CHANNELLED


def test_a_plain_cast_carries_no_flags(tables: BuildTables) -> None:
    rows = read_spell_delivery(source(tables), properties({100: (3, 0, 0)}))
    assert (rows[0].cast_ms, rows[0].duration_ms, rows[0].flags) == (1500, 0, 0)


def test_a_spell_with_neither_is_omitted(tables: BuildTables) -> None:
    """Instant is the complement at load time rather than a third list, which
    is what also sweeps up the spells with no row at all."""
    assert read_spell_delivery(source(tables), properties({100: (0, 0, 0)})) == []


def test_the_weapon_speed_sentinel_reads_as_instant(tables: BuildTables) -> None:
    """A negative base is "use the caster's ranged weapon speed", not a
    duration, and Epsilon fires those with no cast bar."""
    assert read_spell_delivery(source(tables), properties({100: (4, 0, 0)})) == []


def test_an_unlimited_channel_is_recorded_as_such(tables: BuildTables) -> None:
    rows = read_spell_delivery(source(tables), properties({100: (0, 7, CHANNEL_WORD)}))
    assert rows[0].duration_ms == -1


def test_a_negative_duration_means_the_same(tables: BuildTables) -> None:
    rows = read_spell_delivery(source(tables), properties({100: (0, 6, CHANNEL_WORD)}))
    assert rows[0].duration_ms == -1


def test_a_channel_may_carry_no_duration_row(tables: BuildTables) -> None:
    """Which is why the channelled flag is explicit rather than inferred from
    a duration being present."""
    rows = read_spell_delivery(source(tables), properties({100: (0, 0, CHANNEL_WORD)}))
    assert (rows[0].duration_ms, rows[0].flags) == (0, CHANNELLED)


def test_the_self_channelled_flag_is_still_a_channel(tables: BuildTables) -> None:
    rows = read_spell_delivery(source(tables), properties({100: (0, 5, SELF_CHANNEL_WORD)}))
    assert rows[0].flags & CHANNELLED


def test_a_channel_broken_by_movement_says_so(tables: BuildTables) -> None:
    rows = read_spell_delivery(
        source(tables, f"SpellID,DifficultyID,ChannelInterruptFlags_0\n100,0,{MOVING}\n"),
        properties({100: (0, 5, CHANNEL_WORD)}),
    )
    assert rows[0].flags == CHANNELLED | BREAKS_ON_MOVE


def test_the_base_interrupt_row_overrides_a_difficulty_one(tables: BuildTables) -> None:
    rows = read_spell_delivery(
        source(tables, f"SpellID,DifficultyID,ChannelInterruptFlags_0\n100,23,{MOVING}\n100,0,0\n"),
        properties({100: (0, 5, CHANNEL_WORD)}),
    )
    assert not rows[0].flags & BREAKS_ON_MOVE


def test_a_build_without_the_interrupts_table_keeps_the_rest(tables: BuildTables) -> None:
    """A declared-absent table switches its half off; it does not switch the
    delivery line off."""
    rows = read_spell_delivery(source(tables), properties({100: (3, 5, CHANNEL_WORD)}))
    assert rows[0].flags == CHANNELLED
    assert rows[0].cast_ms == 1500


def test_movement_is_read_from_the_channel_column_only(tables: BuildTables) -> None:
    """The cast column is a different enum where movement is a different bit,
    so a spell flagged only there must not come back as breaking on move."""
    rows = read_spell_delivery(
        source(tables, "SpellID,DifficultyID,ChannelInterruptFlags_0\n100,0,1\n"),
        properties({100: (0, 5, CHANNEL_WORD)}),
    )
    assert not rows[0].flags & BREAKS_ON_MOVE


def test_the_rows_come_back_sorted(tables: BuildTables) -> None:
    rows = read_spell_delivery(source(tables), properties({300: (3, 0, 0), 100: (3, 0, 0)}))
    assert [row.spell for row in rows] == [100, 300]
