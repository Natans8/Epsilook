"""Where a spell comes from: who teaches it, what grants it, and what carries it.

None of this is client data. A player is taught a spell by a trainer, given it
by a quest, or given an item that casts or teaches it, and that item is sold,
dropped or handed over -- every one of those edges lives in the server's world
tables. So this says what a stock server does rather than what Epsilon does,
the same footing the object types and the cast gates already stand on.

The chain has two halves and they are kept apart on purpose: a spell reaches an
item, and an item reaches whoever hands it over. Joining them here would make
one row per spell and source pair, which multiplies out past anything a reader
wants; a reader walks the two in turn instead.
"""

from __future__ import annotations

from typing import NamedTuple

POOL_KIND = 1
"""The `kind` of a loot line whose item column holds a pool."""


class LootRow(NamedTuple):
    """One loot line: what drops from an entry, or the pool it draws from.

    The releases spell a pool two ways and the row carries both as read: a
    `Reference` column of its own until Midnight, and from there a kind flag
    marking the item column as a pool instead. `pool` and `drops` are what a
    reader should ask.
    """

    entry: int
    """The creature, the gameobject, or the pool this line belongs to."""
    item: int
    """The item, or the pool where `kind` says so."""
    reference: int
    """The pool to draw from, on the releases with a column for it."""
    kind: int = 0
    """1 where the item column holds a pool, on the releases that mark it."""

    @property
    def pool(self) -> int:
        """The pool this line draws from, nought where it carries an item."""
        return self.reference or (self.item if self.kind == POOL_KIND else 0)

    @property
    def drops(self) -> int:
        """The item this line carries, nought where it draws from a pool."""
        return 0 if self.pool else self.item


class QuestRewards(NamedTuple):
    """One quest, and what completing it grants."""

    quest: int
    title: str
    spells: tuple[int, ...]
    """The spell it casts on completion and the ones it displays as rewards."""
    items: tuple[int, ...]
    """The items it hands over."""


def quest_rewards_of(
    quest: int,
    title: str,
    spell: int,
    display_one: int,
    display_two: int,
    display_three: int,
    item_one: int,
    item_two: int,
    item_three: int,
    item_four: int,
) -> QuestRewards:
    """One quest's rewards, gathered from the columns they sit in.

    The rewards are columns rather than rows in the source, so the nought that
    fills an unused slot is dropped here and a reader sees only what is given.
    """
    spells = (spell, display_one, display_two, display_three)
    items = (item_one, item_two, item_three, item_four)
    return QuestRewards(
        quest=quest,
        title=title,
        spells=tuple(dict.fromkeys(held for held in spells if held)),
        items=tuple(dict.fromkeys(held for held in items if held)),
    )


class SourceKind:
    """How a thing is come by, as the pack ships it.

    Numbers on the row and the words shipped once beside them, which is what
    every other vocabulary in the pack does.
    """

    TRAINER = 0
    """A creature teaches it across the counter."""
    QUEST = 1
    """A quest grants it on completion."""
    VENDOR = 2
    """A creature sells the item."""
    DROP = 3
    """A creature drops the item."""
    CONTAINER = 4
    """A gameobject holds the item: a chest, a herb, a vein."""


SOURCE_WORDS = {
    SourceKind.TRAINER: "trainer",
    SourceKind.QUEST: "quest",
    SourceKind.VENDOR: "vendor",
    SourceKind.DROP: "drop",
    SourceKind.CONTAINER: "container",
}
"""The word for each kind, shipped so no reader spells them itself."""
