"""What a flow guarantees: its schema is data, its steps stream, and a column
named wrongly fails when the flow is written rather than when a build runs.
"""

from __future__ import annotations

from typing import NamedTuple

import pytest

from pack.routes.flow import (
    Join,
    When,
    amount,
    as_ids,
    as_lists,
    as_map,
    as_nested,
    as_rows,
    as_sets,
    any_of,
    bits_of,
    c,
    coalesce,
    compose,
    first_available,
    flag,
    flow,
    landing,
    real,
    reference,
    text,
    vocabulary,
    when,
)
from pack.routes import catalogue as T
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


def test_the_first_plan_whose_table_the_build_has_answers(tables: BuildTables) -> None:
    """One fact, two spellings: each alternative is its own plan, so the
    tables need not line up column for column."""
    names = first_available(
        flow("modern").read("SpellName", "ID", "Name_lang").into(as_map(c.ID, text(c.Name_lang))),
        flow("legacy").read("Spell", "ID", "Name_lang").into(as_map(c.ID, text(c.Name_lang))),
    )
    old = tables(Spell="ID,Name_lang\n1,Frostbolt\n", absent={"SpellName": "split out later"})
    assert names.run(old) == {1: "Frostbolt"}
    assert names.needs == frozenset()


def test_an_explode_may_carry_the_slot_a_value_came_from(tables: BuildTables) -> None:
    """Position counts every value fanned, a nought included, so a skipped
    column is a skipped slot rather than a shifted one."""
    slots = (
        flow("slots")
        .read("creature_template", "entry", "m1", "m2", "m3")
        .explode("m1", "m2", "m3", into="display", slot="slot")
    )
    rows = list(slots.rows(tables(creature_template="entry,m1,m2,m3\n300,50,0,51\n")))
    assert rows == [("300", "50", "0"), ("300", "51", "2")]


def test_a_lookup_is_a_join_through_a_field(tables: BuildTables) -> None:
    """The rows the field answers, carrying its answer; the rest are dropped."""
    seeds = (
        flow("seeds")
        .read("SpellVisualKitEffect", "ParentSpellVisualKitID", "Effect")
        .lookup(c.Effect, "proc_chains", into="chain")
    )
    rows = list(
        seeds.rows(
            tables(SpellVisualKitEffect="ParentSpellVisualKitID,Effect\n1,10\n2,11\n"), needs={"proc_chains": {10: 70}}
        )
    )
    assert rows == [("1", "10", "70")]
    assert seeds.needs == frozenset({"proc_chains"})


def test_among_is_membership_by_id(tables: BuildTables) -> None:
    chained = flow("chained").read("SpellProceduralEffect", "ID", "Type").where(c.Type.among((0, 26)))
    rows = list(chained.rows(tables(SpellProceduralEffect="ID,Type\n1,0\n2,26.0\n3,1\n")))
    assert [row[0] for row in rows] == ["1", "2"]


def test_a_list_keeps_the_order_met_and_a_nested_map_combines_two_paths(tables: BuildTables) -> None:
    """The shapes the spine lands in: events in table order, each once, and a
    visual's mask unioned where two paths reach it."""
    events = flow("events").read("SpellVisualEvent", "SpellVisualID", "SpellVisualKitID", "TargetType")
    source = tables(SpellVisualEvent="SpellVisualID,SpellVisualKitID,TargetType\n10,901,2\n10,900,1\n10,901,2\n")
    assert (events.into(as_lists(c.SpellVisualID, c.SpellVisualKitID, c.TargetType))).run(source) == {
        10: [(901, 2), (900, 1)]
    }
    reached = flow("reached").read("Reached", "SpellID", "Visual", "Bits")
    source = tables(Reached="SpellID,Visual,Bits\n100,20,1\n100,20,2\n100,21,0\n")
    assert (reached.into(as_nested(c.SpellID, c.Visual, c.Bits, reduce=lambda a, b: a | b))).run(source) == {
        100: {20: 3, 21: 0}
    }


EFFECTS = "SpellID,Effect,EffectAura,EffectMiscValue_0,ImplicitTarget_0,ImplicitTarget_1\n"
"""A tiny SpellEffect: a morph aimed at the caster, a summon, a row nothing selects."""


class Landed(NamedTuple):
    """Where a split of the tiny effect table lands."""

    morphs: dict[int, set[int]]
    summons: dict[int, set[int]]
    rows: list[tuple[int, int, bool, bool]]


def test_a_split_lands_one_read_in_many_shapes(tables: BuildTables) -> None:
    """Each branch keeps what its selector chooses, the landing keeps every
    row with a flag per selected column, and the trunk is read once."""
    source = tables(SpellEffect=EFFECTS + "100,6,56,900,1,0\n100,28,0,700,2,0\n100,3,0,0,1,0\n")
    plan = (
        flow("effects")
        .read(
            "SpellEffect",
            "SpellID",
            "Effect",
            "EffectAura",
            "EffectMiscValue_0",
            "ImplicitTarget_0",
            "ImplicitTarget_1",
        )
        .lookup(c.ImplicitTarget_0, {1: 1, 2: 2}, into="bit_a", default=0)
        .lookup(c.ImplicitTarget_1, {1: 1, 2: 2}, into="bit_b", default=0)
        .map("mask", bits_of(c.bit_a, c.bit_b))
        .split(
            Landed,
            morphs=flow("morphs")
            .when("EffectAura", 56, [reference("EffectMiscValue_0", "creature_template")])
            .into(as_sets(c.SpellID, c.EffectMiscValue_0)),
            summons=flow("summons")
            .when("Effect", 28, [reference("EffectMiscValue_0", "creature_template")])
            .into(as_sets(c.SpellID, c.EffectMiscValue_0)),
            rows=landing(
                flow("rows").into(
                    as_rows(lambda *v: v, c.Effect, c.mask, flag(c.consumed_Effect), flag(c.consumed_EffectAura))
                )
            ),
        )
    )
    landed = plan.run(source)
    assert landed.morphs == {100: {900}}
    assert landed.summons == {100: {700}}
    assert landed.rows == [(6, 1, False, True), (28, 2, True, False), (3, 1, False, False)]
    assert [chosen.values for chosen in plan.selectors] == [(56,), (28,)]


def test_a_split_checks_its_branches_against_the_trunk_when_written() -> None:
    trunk = flow("effects").read("SpellEffect", "SpellID", "Effect")
    with pytest.raises(KeyError, match="no column 'EffectAura'"):
        trunk.split(dict, morphs=flow("morphs").where(c.EffectAura == 56).into(as_ids(c.SpellID)))
    with pytest.raises(ValueError, match="cannot join"):
        flow("bad").join(c.SpellID, "Spell", c.Name_lang)


def test_any_of_selects_on_one_column_and_honours_each_retirement(tables: BuildTables) -> None:
    """The stable values and the retired ones are two selections landing in
    one place, and the retired one holds only before the patch that reused it."""
    source = tables(SpellEffect=EFFECTS + "100,50,0,7000,1,0\n100,105,0,7001,1,0\n")
    objects = (
        flow("objects")
        .read("SpellEffect", "SpellID", "Effect", "EffectMiscValue_0")
        .any_of(
            when("Effect", 50, [reference("EffectMiscValue_0", "gameobject_template")]),
            when("Effect", 105, [reference("EffectMiscValue_0", "gameobject_template")], until="4.0"),
        )
        .into(as_sets(c.SpellID, c.EffectMiscValue_0))
    )
    assert objects.run(source, "3.4.3.58936") == {100: {7000, 7001}}
    assert objects.run(source, "9.2.7.45745") == {100: {7000}}
    with pytest.raises(ValueError, match="one column"):
        any_of(when("Effect", 50, []), when("EffectAura", 50, []))


def test_coalesce_takes_the_first_spelling_that_says_something(tables: BuildTables) -> None:
    """An amount a build exports twice, one spelling left at nought; rounded
    where the spellings carry conversion noise."""
    amounts = (
        flow("amounts")
        .read("SpellEffect", "SpellID", "EffectBasePoints", "EffectBasePointsF")
        .map("amount", coalesce(c.EffectBasePoints, c.EffectBasePointsF, digits=1))
        .into(as_map(c.SpellID, real(c.amount)))
    )
    source = tables(SpellEffect="SpellID,EffectBasePoints,EffectBasePointsF\n1,0,12.34\n2,50,\n3,,\n")
    assert amounts.run(source) == {1: 12.3, 2: 50.0, 3: 0.0}


def test_a_lookup_may_keep_a_row_the_field_does_not_answer(tables: BuildTables) -> None:
    """With a default the row carries it; without one the row is dropped."""
    seats = flow("seats").read("Vehicle", "ID", "SeatID_0")
    source = tables(Vehicle="ID,SeatID_0\n1,10\n2,11\n")
    kept = seats.lookup(c.SeatID_0, {10: 5}, into="attachment", default=-1).into(as_map(c.ID, c.attachment))
    dropped = seats.lookup(c.SeatID_0, {10: 5}, into="attachment").into(as_map(c.ID, c.attachment))
    assert kept.run(source) == {1: 5, 2: -1}
    assert dropped.run(source) == {1: 5}


class Bundle(NamedTuple):
    """Two fields as one record."""

    names: dict[int, str]
    icons: dict[int, int]


def test_a_composed_field_is_built_from_other_fields_alone(tables: BuildTables) -> None:
    """Every parameter is a field, named for itself unless mapped."""
    bundle = compose(Bundle, names="spell_names")
    assert bundle.needs == frozenset({"spell_names", "icons"})
    assert bundle.run(tables(), needs={"spell_names": {1: "Frostbolt"}, "icons": {1: 9}}) == Bundle(
        {1: "Frostbolt"}, {1: 9}
    )
    with pytest.raises(ValueError, match="not a parameter"):
        compose(Bundle, colours="x")


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
    props = (
        flow("props")
        .read("SpellMisc", c.SpellID, c.DifficultyID, c.Attributes[:])
        .prefer(c.SpellID, base=c.DifficultyID == 0)
        .into(as_map(c.SpellID, text(c.DifficultyID)))
    )
    assert props.run(tables(SpellMisc=SPELL_MISC)) == {100: "0", 200: "0", 300: "0"}
    first = flow("first").read("SpellMisc", c.SpellID, c.DifficultyID).prefer(c.SpellID, base=c.DifficultyID == 99)
    assert list(first.rows(tables(SpellMisc=SPELL_MISC)))[0] == ("100", "23")


def test_an_array_column_reads_whole_and_a_bit_addresses_the_words(tables: BuildTables) -> None:
    """Every Attributes_N the build has, as one cell, and bit 34 is the third
    bit of the second word; the mythic copy's bits do not count."""
    words = (
        flow("words")
        .read("SpellMisc", c.SpellID, c.DifficultyID, c.Attributes[:])
        .prefer(c.SpellID, base=c.DifficultyID == 0)
        .where(c.Attributes[:].bit(0) | c.Attributes[:].bit(34))
        .into(as_ids(c.SpellID))
    )
    assert words.run(tables(SpellMisc=SPELL_MISC)) == {100}


def test_expand_walks_the_redirects_and_stops_on_the_cycle(tables: BuildTables) -> None:
    """Two visuals naming each other terminate, and the bits of the path
    union onto the reached row."""
    reach = (
        flow("reach")
        .read("SpellXSpellVisual", c.SpellID, c.SpellVisualID)
        .expand(
            c.SpellVisualID,
            "SpellVisual",
            {"CasterSpellVisualID": 1, "HostileSpellVisualID": 2},
            into="visual",
            bits="bits",
        )
        .into(as_sets(c.SpellID, text("visual")))
    )
    got = reach.run(tables(SpellXSpellVisual=X_VISUAL, SpellVisual=SPELL_VISUAL))
    assert got == {1: {"10", "20", "21"}}
    rows = list(reach.flow.rows(tables(SpellXSpellVisual=X_VISUAL, SpellVisual=SPELL_VISUAL)))
    assert ("1", "10", "21", "3") in rows and ("1", "10", "10", "0") in rows


def test_a_terminal_lands_the_rows_as_a_record_and_a_narrow_names_its_need(tables: BuildTables) -> None:
    class Kit(NamedTuple):
        kit: int
        file: int

    kits = (
        flow("kits")
        .read("SoundKitEntry", c.SoundKitID, c.FileDataID)
        .narrow(c.SoundKitID, "used_kits")
        .into(as_rows(Kit, c.SoundKitID, c.FileDataID))
    )
    assert kits.flow.needs == {"used_kits"}
    assert kits.run(tables(SoundKitEntry=SOUND_KIT_ENTRY), needs={"used_kits": {79829}}) == [
        Kit(79829, 500),
        Kit(79829, 501),
    ]


def test_a_table_is_its_class_and_a_column_carries_it() -> None:
    """The catalogue's classes are the tables, so a name a flow writes is one
    the checker resolves rather than one a build discovers; the flow carries
    the column qualified by its table, the source sees it bare."""
    assert T.SpellEffect.__tablename__ == "SpellEffect"
    assert repr(T.SpellEffect.SpellID) == "T.SpellEffect.SpellID"
    assert (T.creature_template.entry.name, T.creature_template.entry.base) == ("creature_template.entry", "entry")


def test_an_array_column_has_slots_and_a_scalar_refuses_one() -> None:
    """A slot is the export's own column, the whole is the starred name, and
    a column no build stores as an array cannot be indexed."""
    assert T.SpellEffect.EffectMiscValue[0].base == "EffectMiscValue_0"
    assert T.SpellMisc.Attributes[:].name == "SpellMisc.Attributes_*"
    with pytest.raises(ValueError, match="no array"):
        _ = T.SpellEffect.Effect[0]


def test_a_table_written_as_its_class_reads_as_its_name_does(tables: BuildTables) -> None:
    typed = (
        flow("factions")
        .read(T.SpellEffect, T.SpellEffect.SpellID, T.SpellEffect.EffectAura, T.SpellEffect.EffectMiscValue[0])
        .when(T.SpellEffect.EffectAura, 243, [reference(T.SpellEffect.EffectMiscValue[0], T.FactionTemplate)])
    )
    plain = (
        flow("factions")
        .read("SpellEffect", "SpellID", "EffectAura", "EffectMiscValue_0")
        .when("EffectAura", 243, [reference("EffectMiscValue_0", "FactionTemplate")])
    )
    assert typed.tables == plain.tables
    assert list(typed.rows(tables(SpellEffect=SPELL_EFFECT))) == list(plain.rows(tables(SpellEffect=SPELL_EFFECT)))


def test_an_open_read_is_settled_by_what_the_plan_names(tables: BuildTables) -> None:
    """A read listing no columns reads the ones its later steps and its
    terminal name, in the table's own order, as a lazy plan pushes its
    projection down to the scan."""
    plan = (
        flow("factions").read(T.SpellEffect).where(T.SpellEffect.EffectAura == 243).into(as_ids(T.SpellEffect.SpellID))
    )
    settled = plan.flow.settled(plan.terminal.taken())
    assert settled.origin.columns == ("SpellEffect.EffectAura", "SpellEffect.SpellID")
    assert plan.run(tables(SpellEffect=SPELL_EFFECT)) == {100, 101}


def test_a_bare_name_resolves_to_the_one_open_table_carrying_it(tables: BuildTables) -> None:
    plan = flow("misc").read(T.SpellEffect).where(c.EffectAura == 56).into(as_ids("SpellID"))
    assert plan.run(tables(SpellEffect=SPELL_EFFECT)) == {102}


def test_a_column_of_a_table_the_flow_does_not_read_fails_when_written() -> None:
    with pytest.raises(KeyError, match="SpellMisc.Speed"):
        _ = flow("bad").read(T.SpellEffect).where(T.SpellMisc.Speed > 0)


def test_a_bare_name_two_open_tables_carry_must_name_its_table() -> None:
    """Both tables carry ``ID``; only a qualified name says which is meant."""
    plan = (
        flow("mounts")
        .read(T.Mount)
        .join(T.Mount.ID, T.MountXDisplay, by=T.MountXDisplay.MountID, many=True)
        .into(as_ids("ID"))
    )
    with pytest.raises(ValueError, match="name its table"):
        plan.flow.settled(plan.terminal.taken())
