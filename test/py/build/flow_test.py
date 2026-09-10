"""What a flow guarantees: its schema is data, its steps stream, and a column
named wrongly fails when the flow is written rather than when a build runs.
"""

from __future__ import annotations

from typing import NamedTuple

import pytest

from pack.routes.flow import (
    Join,
    Read,
    When,
    amount,
    as_ids,
    as_map,
    as_rows,
    as_sets,
    c,
    flow,
    reference,
    text,
    vocabulary,
)
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
    names = flow("names").first_of(Read("SpellName", ("ID", "Name_lang")), Read("Spell", ("ID", "Name_lang")))
    assert names.schema().columns == ("ID", "Name_lang")
    old = tables(Spell="ID,Name_lang\n1,Frostbolt\n", absent={"SpellName": "split out later"})
    assert list(names.rows(old)) == [("1", "Frostbolt")]
    assert names.tables == ["SpellName", "Spell"]


def test_an_alternative_must_line_up_positionally() -> None:
    with pytest.raises(ValueError, match="same number of columns"):
        flow("bad").first_of(Read("SpellName", ("ID", "Name_lang")), Read("Spell", ("ID",)))


def test_where_and_narrow_keep_what_they_say(tables: BuildTables) -> None:
    kept = (
        flow("kept")
        .read("ScreenEffect", "ID", "ZoneMusicID", "SoundAmbienceID")
        .where(c.ZoneMusicID != 0)
        .narrow(c.ID, {30, 31})
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
    hop = Join("Faction", "Faction", ("Name_lang",))
    route = flow("route").read("FactionTemplate", "ID", "Faction") | hop
    assert route.schema().columns == ("ID", "Faction", "Name_lang")


SPELL_MISC = """SpellID,DifficultyID,Speed,LaunchDelay,Attributes_0,Attributes_1
100,23,45,0,0,4
100,0,45,0,1,0
200,0,0,0.5,0,0
300,0,0,0,2,0
"""

X_VISUAL = """SpellID,SpellVisualID
1,10
"""

SPELL_VISUAL = """ID,CasterSpellVisualID,HostileSpellVisualID
10,20,0
20,0,21
21,20,0
"""


def test_a_condition_is_an_expression_that_prints_as_itself() -> None:
    """A lambda in a plan is opaque; a comparison built on a column is data a
    reader, a document and a second executor can all see."""
    asked = (c.Speed > 0) | (c.LaunchDelay > 0)
    assert repr(asked) == "(c.Speed > 0) | (c.LaunchDelay > 0)"
    assert asked.columns() == {"Speed", "LaunchDelay"}
    assert repr(~c.Name_lang.is_empty()) == "~(c.Name_lang == '')"


def test_prefer_keeps_the_base_row_wherever_it_comes(tables: BuildTables) -> None:
    """The mythic copy arrives first and must not stand for the spell; a key
    with no base row keeps its first."""
    props = flow("props").read("SpellMisc", c.SpellID, c.DifficultyID, c.Attributes[:]).prefer(
        c.SpellID, base=c.DifficultyID == 0
    ) >> as_map(c.SpellID, text(c.DifficultyID))
    assert props.run(tables(SpellMisc=SPELL_MISC)) == {100: "0", 200: "0", 300: "0"}
    first = flow("first").read("SpellMisc", c.SpellID, c.DifficultyID).prefer(c.SpellID, base=c.DifficultyID == 99)
    assert list(first.rows(tables(SpellMisc=SPELL_MISC)))[0] == ("100", "23")


def test_an_array_column_reads_whole_and_a_bit_addresses_the_words(tables: BuildTables) -> None:
    """Every Attributes_N the build has, as one cell, and bit 34 is the third
    bit of the second word; the mythic copy's bits do not count."""
    words = flow("words").read("SpellMisc", c.SpellID, c.DifficultyID, c.Attributes[:]).prefer(
        c.SpellID, base=c.DifficultyID == 0
    ).where(c.Attributes[:].bit(0) | c.Attributes[:].bit(34)) >> as_ids(c.SpellID)
    assert words.run(tables(SpellMisc=SPELL_MISC)) == {100}


def test_expand_walks_the_redirects_and_stops_on_the_cycle(tables: BuildTables) -> None:
    """Two visuals naming each other terminate, and the bits of the path
    union onto the reached row."""
    reach = flow("reach").read("SpellXSpellVisual", c.SpellID, c.SpellVisualID).expand(
        c.SpellVisualID,
        "SpellVisual",
        {"CasterSpellVisualID": 1, "HostileSpellVisualID": 2},
        into="visual",
        bits="bits",
    ) >> as_sets(c.SpellID, text("visual"))
    got = reach.run(tables(SpellXSpellVisual=X_VISUAL, SpellVisual=SPELL_VISUAL))
    assert got == {1: {"10", "20", "21"}}
    rows = list(reach.flow.rows(tables(SpellXSpellVisual=X_VISUAL, SpellVisual=SPELL_VISUAL)))
    assert ("1", "10", "21", "3") in rows and ("1", "10", "10", "0") in rows


def test_a_terminal_lands_the_rows_as_a_record_and_a_narrow_names_its_need(tables: BuildTables) -> None:
    class Kit(NamedTuple):
        kit: int
        file: int

    kits = flow("kits").read("SoundKitEntry", c.SoundKitID, c.FileDataID).narrow(c.SoundKitID, "used_kits") >> as_rows(
        Kit, c.SoundKitID, c.FileDataID
    )
    assert kits.flow.needs == {"used_kits"}
    assert kits.run(tables(SoundKitEntry=SOUND_KIT_ENTRY), needs={"used_kits": {79829}}) == [
        Kit(79829, 500),
        Kit(79829, 501),
    ]
