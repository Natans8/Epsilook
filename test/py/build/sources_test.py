"""Where a spell comes from: the pools, the cap, and the two halves joined.

The loot tables are the hard part. A line either carries an item or draws from
a pool, a pool may draw from another pool, and reading only the first kind
silently loses most of the drops in the game.
"""

from __future__ import annotations

from pack.derive.sources import TOP_SOURCES, collect_sources, droppers, pooled, source_references
from pack.routes import LootRow, QuestRewards, SourceKind
from pack.routes.flows import Routes
from pack.routes.names import SpellNames
from support import BuildTables

QUEST_TEMPLATE = """ID,LogTitle,RewardSpell,RewardDisplaySpell1,RewardDisplaySpell2,RewardDisplaySpell3,RewardItem1,RewardItem2,RewardItem3,RewardItem4
9,A Later Slot,0,0,555,0,0,0,0,0
10,Nothing At All,0,0,0,0,0,0,0,0
"""

NAMES = SpellNames(names={100: "Summon Ram", 200: "Teach Fire"})


def test_a_pool_that_names_another_pool_still_reaches_its_items() -> None:
    """The profession drops sit one pool further out, so stopping at the first
    hop loses them."""
    pools = pooled([LootRow(1, 0, 2), LootRow(1, 50, 0), LootRow(2, 60, 0)])
    assert pools[1] == {50, 60}


def test_a_loot_line_drawing_from_a_pool_names_the_entry_that_drew() -> None:
    """The creature is what a reader wants, not the pool it read from."""
    pools = pooled([LootRow(7, 60, 0)])
    assert droppers([LootRow(900, 0, 7)], pools) == {60: {900}}


def test_the_newer_dumps_mark_a_pool_on_the_item_column_instead() -> None:
    """Midnight dropped the reference column and flags the item as a pool, so
    a reader of the column alone takes a pool id for an item id."""
    pools = pooled([LootRow(7, 60, 0)])
    assert droppers([LootRow(900, 7, 0, kind=1)], pools) == {60: {900}}


def test_the_two_halves_join_through_the_item() -> None:
    """A spell reaches an item and the item reaches whoever hands it over."""
    rows = collect_sources(
        names=NAMES,
        spell_trainers={200: {500}},
        quest_rewards={},
        item_spells={100: {10}},
        item_vendors={10: {600}},
        creature_drops=[LootRow(700, 10, 0)],
        object_drops=[],
        loot_references=[],
    )
    held = {(row.spell, row.kind, row.source, row.item) for row in rows}
    assert (200, SourceKind.TRAINER, 500, 0) in held
    assert (100, SourceKind.VENDOR, 600, 10) in held
    assert (100, SourceKind.DROP, 700, 10) in held


def test_a_quest_grants_a_spell_only_where_the_pack_lists_it() -> None:
    """A quest names spells this build may not carry at all."""
    quest = QuestRewards(quest=9, title="A Ram of Some Swiftness", spells=(100, 999), items=())
    rows = collect_sources(
        names=NAMES,
        spell_trainers={},
        quest_rewards={9: quest},
        item_spells={},
        item_vendors={},
        creature_drops=[],
        object_drops=[],
        loot_references=[],
    )
    assert [(row.spell, row.kind, row.source) for row in rows] == [(100, SourceKind.QUEST, 9)]


def test_a_quest_is_read_whichever_reward_slot_it_fills(tables: BuildTables) -> None:
    """The reward columns are four of each and the slots are not always filled
    in order, so a route testing only the first drops the quest whole."""
    read = Routes.quest_rewards.run(tables(quest_template=QUEST_TEMPLATE))
    assert set(read) == {9}
    assert read[9].spells == (555,)


def test_a_quest_granting_through_a_later_slot_is_still_read() -> None:
    """The reward columns are four of each, and a route testing only the first
    would drop a quest whose slots are filled out of order."""
    quest = QuestRewards(quest=9, title="A Later Slot", spells=(100,), items=(10,))
    rows = collect_sources(
        names=NAMES,
        spell_trainers={},
        quest_rewards={9: quest},
        item_spells={200: {10}},
        item_vendors={},
        creature_drops=[],
        object_drops=[],
        loot_references=[],
    )
    assert {(row.spell, row.kind, row.source) for row in rows} == {
        (100, SourceKind.QUEST, 9),
        (200, SourceKind.QUEST, 9),
    }


def test_one_quest_granting_a_spell_two_ways_counts_once() -> None:
    """A quest that grants the spell and hands over an item carrying it is one
    quest, whatever the rows say."""
    quest = QuestRewards(quest=9, title="Both Ways", spells=(100,), items=(10,))
    rows = collect_sources(
        names=NAMES,
        spell_trainers={},
        quest_rewards={9: quest},
        item_spells={100: {10}},
        item_vendors={},
        creature_drops=[],
        object_drops=[],
        loot_references=[],
    )
    assert {row.of for row in rows} == {1}


def test_a_spell_keeps_a_few_sources_and_counts_them_all() -> None:
    """A recipe's generic learn spell is reached by tens of thousands of loot
    lines, so the rows are the first few and the count is the truth."""
    rows = collect_sources(
        names=NAMES,
        spell_trainers={200: set(range(500, 540))},
        quest_rewards={},
        item_spells={},
        item_vendors={},
        creature_drops=[],
        object_drops=[],
        loot_references=[],
    )
    assert len(rows) == TOP_SOURCES
    assert {row.of for row in rows} == {40}


def test_the_entities_a_source_names_are_the_ones_the_pack_must_name() -> None:
    """A quest is named by its own section, so it is not a reference."""
    rows = collect_sources(
        names=NAMES,
        spell_trainers={200: {500}},
        quest_rewards={9: QuestRewards(quest=9, title="A Quest", spells=(100,), items=())},
        item_spells={100: {10}},
        item_vendors={10: {600}},
        creature_drops=[],
        object_drops=[LootRow(800, 10, 0)],
        loot_references=[],
    )
    found = source_references(rows)
    assert found["creature_template"] == {500, 600}
    assert found["gameobject_template"] == {800}
    assert found["Item"] == {10}
