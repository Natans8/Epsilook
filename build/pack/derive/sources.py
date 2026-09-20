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

from ..routes import LootRow, QuestRewards, SourceKind
from ..routes.names import SpellNames
from ..routes.route import route

POOL_HOPS = 2
"""How far a loot line's pool reference is followed.

A pool may name another pool. Two hops is what the world tables use; following
them unbounded would hang on a cycle, and stopping at one drops the
second-level pools the profession drops sit in.
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
        for _hop in range(POOL_HOPS + 1):
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
    """The first few sources of each kind, each row carrying the whole count."""
    rows: list[SpellSource] = []
    for (spell, kind), sources in sorted(found.items()):
        listed = sorted(sources)
        rows += [SpellSource(spell, kind, source, item, len(listed)) for source, item in listed[:TOP_SOURCES]]
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


SOURCE_TABLES = {
    SourceKind.TRAINER: "creature_template",
    SourceKind.VENDOR: "creature_template",
    SourceKind.DROP: "creature_template",
    SourceKind.CONTAINER: "gameobject_template",
}
"""Which table a row's source id belongs to, for the kinds that name an entity.

A quest is not here: it is named by its own section rather than through the
reference names, since nothing else in the pack points at one.
"""


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
