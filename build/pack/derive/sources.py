"""Where a spell comes from, assembled once from the two halves the routes read.

A spell reaches an item and an item reaches whoever hands it over, and joining
the two is this module's whole job. It sits here rather than in a section
because two sections read the answer: the rows themselves, and the names of the
creatures, objects and items they point at.

Everything is the server's, so it says what a stock TrinityCore world does.
Epsilon runs its own, and a trainer it has moved is not visible from here --
the caveat the cast gates already carry.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from typing import NamedTuple

from ..routes import SOURCE_TABLES, LootRow, QuestRewards, SourceKind
from ..routes.names import SpellNames
from ..routes.route import route

POOL_LEVELS = 3
"""How many levels of pool a loot line is followed through.

A pool may name another pool. Three levels is what the world tables use;
following them unbounded would hang on a cycle, and stopping at one drops the
nested pools the profession drops sit in.
"""

TOP_SOURCES = 8
"""How many sources of one kind a spell keeps.

Half the spells with a source have exactly one, and the tail is a recipe's
generic learn spell reached by eighty thousand loot lines. Keeping the first
few and counting the rest is what a reader wants: "sold by 8 of 312" is an
answer, and three hundred rows is not.
"""


class SpellSource(NamedTuple):
    """One way a spell is come by."""

    spell: int
    kind: int
    """A `SourceKind`: taught, granted, sold, dropped, held."""
    source: int
    """A creature, a gameobject or a quest, by the kind beside it."""
    item: int
    """The item that carries the spell, nought where it is come by directly."""
    of: int
    """How many sources of this kind the spell has, kept or not."""


def pooled(references: Iterable[LootRow]) -> dict[int, set[int]]:
    """Each loot pool's items, following a pool that names another pool."""
    lines: dict[int, list[LootRow]] = defaultdict(list)
    for row in references:
        lines[row.entry].append(row)
    held: dict[int, set[int]] = {}
    for pool in lines:
        items: set[int] = set()
        seen = {pool}
        edge = [pool]
        for _level in range(POOL_LEVELS):
            following: list[int] = []
            for entry in edge:
                for row in lines.get(entry, ()):
                    if row.drops:
                        items.add(row.drops)
                    elif row.pool and row.pool not in seen:
                        seen.add(row.pool)
                        following.append(row.pool)
            edge = following
        held[pool] = items
    return held


def droppers(loot: Iterable[LootRow], pools: Mapping[int, set[int]]) -> dict[int, set[int]]:
    """Item -> the entries whose loot holds it, pools followed."""
    found: dict[int, set[int]] = defaultdict(set)
    for row in loot:
        items = {row.drops} if row.drops else pools.get(row.pool, set())
        for item in items:
            found[item].add(row.entry)
    return found


def kept(found: Mapping[tuple[int, int], set[tuple[int, int]]]) -> list[SpellSource]:
    """The first few sources of each kind, each row carrying the whole count.

    The count is of SOURCES rather than of the pairs they appear in: a quest
    that both grants a spell and hands over an item carrying it is one quest,
    and telling a reader it is two would be a lie about the world rather than
    about the rows.
    """
    rows: list[SpellSource] = []
    for (spell, kind), sources in sorted(found.items()):
        listed = sorted(sources)
        total = len({source for source, _item in listed})
        rows += [SpellSource(spell, kind, source, item, total) for source, item in listed[:TOP_SOURCES]]
    return rows


@route("spell_sources")
def collect_sources(
    names: SpellNames,
    spell_trainers: Mapping[int, set[int]],
    quest_rewards: Mapping[int, QuestRewards],
    item_spells: Mapping[int, set[int]],
    item_vendors: Mapping[int, set[int]],
    creature_drops: Sequence[LootRow],
    object_drops: Sequence[LootRow],
    loot_references: Sequence[LootRow],
) -> list[SpellSource]:
    """Every way the world tables say a spell is come by, capped per kind."""
    found: dict[tuple[int, int], set[tuple[int, int]]] = defaultdict(set)
    for spell, creatures in spell_trainers.items():
        found[(spell, SourceKind.TRAINER)].update((creature, 0) for creature in creatures)
    for quest in quest_rewards.values():
        for spell in quest.spells:
            if spell in names.names:
                found[(spell, SourceKind.QUEST)].add((quest.quest, 0))

    pools = pooled(loot_references)
    from_quests: dict[int, set[int]] = defaultdict(set)
    for quest in quest_rewards.values():
        for item in quest.items:
            from_quests[item].add(quest.quest)
    handed = (
        (SourceKind.VENDOR, item_vendors),
        (SourceKind.DROP, droppers(creature_drops, pools)),
        (SourceKind.CONTAINER, droppers(object_drops, pools)),
        (SourceKind.QUEST, from_quests),
    )
    for spell, items in item_spells.items():
        for item in items:
            for kind, where in handed:
                found[(spell, kind)].update((source, item) for source in where.get(item, ()))
    return kept({key: sources for key, sources in found.items() if sources})


def source_references(rows: Iterable[SpellSource]) -> dict[str, set[int]]:
    """The ids the source rows point at, by the table that names them."""
    found: dict[str, set[int]] = defaultdict(set)
    for row in rows:
        table = SOURCE_TABLES.get(row.kind)
        if table:
            found[table].add(row.source)
        if row.item:
            found["Item"].add(row.item)
    return found
