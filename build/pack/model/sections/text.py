"""What a spell says it does, cooked to placeholder-free prose.

Three bodies of text under one section because they answer one question -- what
does this spell say -- from three places: the cast's own tooltip, the buff's
line while it is on you, and the dungeon journal's note on a boss ability.

Every column is deduped. Nineteen thousand descriptions on the product's build
are a bare redirect, so cooking them yields the same string as their target;
storing one copy per spell would ship the same prose over and over and, more to
the point, make the browser hold it that way too.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence

from ...derive import Reads
from ..registry import register
from ..section import Count, Encoding, Section, SectionColumns


def aligned(by_spell: Mapping[int, str], ids: Sequence[int]) -> list[str]:
    """One string per spell in row order, empty where the spell has none."""
    return [by_spell.get(spell, "") for spell in ids]


def spell_text(reads: Reads) -> SectionColumns:
    """Each body of prose, aligned to the spell list."""
    ids = reads.spell_ids
    prose = reads.prose
    return {"descriptions": aligned(prose.descriptions, ids),
            "auras": aligned(prose.auras, ids),
            "encounters": aligned(prose.encounters, ids)}


def distinct(column: str) -> Callable[[SectionColumns, Reads], int]:
    """How many distinct strings one body cooked to.

    Counted off the produced column so it describes what shipped. The empty
    string is the absence of text rather than one of its values, which is why
    it is excluded here and holds slot zero of the pool once encoded.
    """
    def count(columns: SectionColumns, _reads: Reads) -> int:
        return len({text for text in columns[column] if text})
    return count


def carrying(column: str) -> Callable[[SectionColumns, Reads], int]:
    """How many spells carry this body of text at all.

    Kept beside the distinct count because the gap between them IS the redirect
    population: a bare `$@spelldescNNN` cooks to the same prose as its target.
    """
    def count(columns: SectionColumns, _reads: Reads) -> int:
        return sum(1 for text in columns[column] if text)
    return count


SPELL_TEXT = register(Section(
    name="spellText",
    doc="Every spell's cooked description, aura line and encounter note.",
    module="text",
    produce=spell_text,
    columns=("descriptions", "auras", "encounters"),
    encoding={"descriptions": Encoding.DEDUP,
              "auras": Encoding.DEDUP,
              "encounters": Encoding.DEDUP},
    reads=("spell_ids", "prose"),
    localizable=("descriptions", "auras", "encounters"),
    counts=(Count("spellDescriptions", carrying("descriptions")),
            Count("descriptionTexts", distinct("descriptions")),
            Count("spellEncounterNotes", carrying("encounters")),
            Count("spellAuraTexts", carrying("auras")),
            Count("auraTexts", distinct("auras")),
            Count("encounterTexts", distinct("encounters"))),
))
