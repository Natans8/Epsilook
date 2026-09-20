"""Where a spell comes from, as rows a reader can walk.

The assembly lives in `derive/sources.py`, because two sections read it: the
rows themselves, and the names of what they point at. Here they only become
columns.
"""

from __future__ import annotations

from ...derive import Reads
from ...routes import SOURCE_WORDS, SourceKind
from ..registry import register
from ..section import Scope, Section, SectionColumns, size


def spell_sources(reads: Reads) -> SectionColumns:
    """Every way a spell is come by, as five parallel columns."""
    rows = reads.spell_sources
    return {
        "spellIds": [row.spell for row in rows],
        "kinds": [row.kind for row in rows],
        # a creature, a gameobject or a quest, by the kind beside it
        "ids": [row.source for row in rows],
        # the item that carries the spell, nought where it is come by directly
        "itemIds": [row.item for row in rows],
        # how many sources of this kind the spell has, kept or not
        "counts": [row.of for row in rows],
    }


def source_kind_names(reads: Reads) -> SectionColumns:
    """The word for each way a spell is come by."""
    del reads  # a declaration, the same on every build
    listed = sorted(SOURCE_WORDS)
    return {"ids": listed, "words": [SOURCE_WORDS[kind] for kind in listed]}


def quest_names(reads: Reads) -> SectionColumns:
    """The title of every quest a spell is come by through.

    Only the quests the rows point at: the dump holds tens of thousands, and
    the rest name nothing a reader of this pack can reach.
    """
    wanted = {row.source for row in reads.spell_sources if row.kind == SourceKind.QUEST}
    quests = reads.quest_rewards
    listed = sorted(wanted & set(quests))
    return {"ids": listed, "titles": [quests[quest].title for quest in listed]}


SPELL_SOURCES = register(
    Section(
        name="spellSources",
        doc="Where each spell is come by: taught, granted, or carried by an item somebody hands over.",
        module="core",
        produce=spell_sources,
        columns=("spellIds", "kinds", "ids", "itemIds", "counts"),
        reads=("spell_sources",),
        needs=("trainer_spell",),
        counts=(size("spellSources", "spellIds"),),
    )
)

QUEST_NAMES = register(
    Section(
        name="questNames",
        doc="The title of every quest a spell is come by through.",
        module="core",
        produce=quest_names,
        columns=("ids", "titles"),
        reads=("spell_sources", "quest_rewards"),
        needs=("quest_template",),
        counts=(size("questNames", "ids"),),
    )
)

SOURCE_KIND_NAMES = register(
    Section(
        name="sourceKindNames",
        doc="The word for each way a spell is come by.",
        module="universal",
        produce=source_kind_names,
        columns=("ids", "words"),
        reads=(),
        scope=Scope.UNIVERSAL,
    )
)
