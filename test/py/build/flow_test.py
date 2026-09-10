"""What a flow guarantees: its schema is data, its steps stream, and a column
named wrongly fails when the flow is written rather than when a build runs.
"""

from __future__ import annotations

import pytest

from pack.routes.flow import Join, When, amount, flow, join, nonzero, read, reference, vocabulary
from support import BuildTables

SCREEN_EFFECT = """\
ID,Name,ZoneMusicID,SoundAmbienceID
30,Hex,1807,0
31,Grade,0,22
32,Bare,0,0
"""

ZONE_MUSIC = """\
ID,SetName,Sounds_0,Sounds_1
1807,Zone-Laughter,79829,79829
1808,Zone-Silence,0,0
"""

SOUND_KIT_ENTRY = """\
SoundKitID,FileDataID
79829,500
79829,501
"""

SPELL_EFFECT = """\
SpellID,Effect,EffectAura,EffectMiscValue_0,EffectMiscValue_1
100,6,243,35,0
101,6,243,0,0
102,6,56,900,0
103,28,0,900,7
"""


def test_the_schema_is_the_columns_the_steps_declare() -> None:
    music = (
        flow("music")
        .read("ScreenEffect", "ID", "ZoneMusicID")
        .join("ZoneMusicID", "ZoneMusic", "SetName", "Sounds_0", "Sounds_1")
        .explode("Sounds_0", "Sounds_1", into="kit")
    )
    assert music.schema().columns == ("ID", "ZoneMusicID", "SetName", "kit")
    assert music.at("kit") == 3
    assert music.tables == ["ScreenEffect", "ZoneMusic"]


def test_a_step_naming_a_column_the_flow_lacks_fails_when_written() -> None:
    with pytest.raises(KeyError, match="no column 'Nope'"):
        _ = flow("bad").read("ScreenEffect", "ID").join("Nope", "ZoneMusic", "SetName")


def test_a_flow_must_start_by_reading() -> None:
    with pytest.raises(ValueError, match="must start by reading"):
        _ = flow("bad").join("ID", "ZoneMusic", "SetName")


def test_a_join_fills_blank_where_the_key_finds_nothing(tables: BuildTables) -> None:
    """A missing name is a name to print blank, not a row to drop."""
    music = flow("music").read("ScreenEffect", "ID", "ZoneMusicID").join("ZoneMusicID", "ZoneMusic", "SetName")
    rows = list(music.rows(tables(ScreenEffect=SCREEN_EFFECT, ZoneMusic=ZONE_MUSIC)))
    assert rows == [("30", "1807", "Zone-Laughter"), ("31", "0", ""), ("32", "0", "")]


def test_an_inner_join_drops_what_it_cannot_find(tables: BuildTables) -> None:
    music = (
        flow("music").read("ScreenEffect", "ID", "ZoneMusicID").join("ZoneMusicID", "ZoneMusic", "SetName", inner=True)
    )
    assert list(music.rows(tables(ScreenEffect=SCREEN_EFFECT, ZoneMusic=ZONE_MUSIC))) == [
        ("30", "1807", "Zone-Laughter")
    ]


def test_an_explode_is_one_row_per_value_and_none_for_nought(tables: BuildTables) -> None:
    kits = (
        flow("kits")
        .read("ZoneMusic", "ID", "Sounds_0", "Sounds_1")
        .explode("Sounds_0", "Sounds_1", into="kit")
        .join("kit", "SoundKitEntry", "FileDataID", by="SoundKitID", inner=True)
    )
    rows = list(kits.rows(tables(ZoneMusic=ZONE_MUSIC, SoundKitEntry=SOUND_KIT_ENTRY)))
    # The join indexes one row per key, so a kit with two files keeps the last;
    # a fan-out over the files is what a route wanting every file writes.
    assert rows == [("1807", "79829", "501"), ("1807", "79829", "501")]


def test_a_selector_keeps_the_rows_it_names_and_drops_a_nought_reference(tables: BuildTables) -> None:
    factions = (
        flow("factions")
        .read("SpellEffect", "SpellID", "EffectAura", "EffectMiscValue_0")
        .when("EffectAura", 243, [reference("EffectMiscValue_0", "FactionTemplate")])
    )
    assert list(factions.rows(tables(SpellEffect=SPELL_EFFECT))) == [("100", "243", "35")]


def test_a_selector_over_several_slots_reads_them_all(tables: BuildTables) -> None:
    summons = (
        flow("summons")
        .read("SpellEffect", "SpellID", "Effect", "EffectMiscValue_0", "EffectMiscValue_1")
        .when(
            "Effect",
            28,
            [reference("EffectMiscValue_0", "creature_template"), reference("EffectMiscValue_1", "SummonProperties")],
        )
    )
    assert list(summons.rows(tables(SpellEffect=SPELL_EFFECT))) == [("103", "28", "900", "7")]


def test_a_vocabulary_slot_may_declare_nought_a_value(tables: BuildTables) -> None:
    """Channel nought is general invisibility, so the ordinary rule would delete it."""
    channels = (
        flow("channels")
        .read("SpellEffect", "SpellID", "EffectAura", "EffectMiscValue_0")
        .when("EffectAura", 243, [vocabulary("EffectMiscValue_0", "channels", zero_is_a_value=True)])
    )
    assert len(list(channels.rows(tables(SpellEffect=SPELL_EFFECT)))) == 2


def test_a_retired_selector_holds_only_before_the_patch_that_reused_it(tables: BuildTables) -> None:
    spawns = (
        flow("spawns")
        .read("SpellEffect", "SpellID", "Effect", "EffectMiscValue_0")
        .when("Effect", 28, [amount("EffectMiscValue_0")], until="4.0")
    )
    assert list(spawns.rows(tables(SpellEffect=SPELL_EFFECT), "3.4.3.58936")) == [("103", "28", "900")]
    assert list(spawns.rows(tables(SpellEffect=SPELL_EFFECT), "9.2.7.45745")) == []


def test_the_first_available_table_answers(tables: BuildTables) -> None:
    names = flow("names").first_of(read("SpellName", "ID", "Name_lang"), read("Spell", "ID", "Name_lang"))
    assert names.schema().columns == ("ID", "Name_lang")
    old = tables(Spell="ID,Name_lang\n1,Frostbolt\n", absent={"SpellName": "split out later"})
    assert list(names.rows(old)) == [("1", "Frostbolt")]
    assert names.tables == ["SpellName", "Spell"]


def test_an_alternative_must_line_up_positionally() -> None:
    with pytest.raises(ValueError, match="same number of columns"):
        flow("bad").first_of(read("SpellName", "ID", "Name_lang"), read("Spell", "ID"))


def test_where_and_narrow_keep_what_they_say(tables: BuildTables) -> None:
    kept = (
        flow("kept")
        .read("ScreenEffect", "ID", "ZoneMusicID", "SoundAmbienceID")
        .where("ZoneMusicID", nonzero)
        .narrow("ID", {30, 31})
    )
    assert list(kept.rows(tables(ScreenEffect=SCREEN_EFFECT))) == [("30", "1807", "0")]


def test_the_steps_of_one_kind_are_readable_off_the_flow() -> None:
    """The joins table and the selector table are read from the declarations."""
    route = (
        flow("route")
        .read("SpellEffect", "SpellID", "EffectAura", "EffectMiscValue_0")
        .when("EffectAura", 243, [reference("EffectMiscValue_0", "FactionTemplate")])
        .join("EffectMiscValue_0", "FactionTemplate", "Faction", "FactionGroup")
        .join("Faction", "Faction", "Name_lang")
    )
    assert [step.table for step in route.of_kind(Join) if isinstance(step, Join)] == ["FactionTemplate", "Faction"]
    (chosen,) = route.of_kind(When)
    assert isinstance(chosen, When) and chosen.values == (243,)


def test_a_step_built_elsewhere_is_appended_with_the_operator() -> None:
    """The methods are spellings of the one append; a step held in a variable
    joins the same way."""
    hop = join("Faction", "Faction", "Name_lang")
    route = flow("route").read("FactionTemplate", "ID", "Faction") | hop
    assert route.schema().columns == ("ID", "Faction", "Name_lang")
