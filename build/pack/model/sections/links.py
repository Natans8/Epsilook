"""The graph of spells that reach other spells.

An edge exists because some effect row on the source triggers the target, and
what the edge SAYS is the word that row's effect or aura prints. Its own
section rather than a column on the mechanics rows, because a spell's edges are
what a reader follows, not what a row describes.
"""

from __future__ import annotations

from ...derive import Reads
from ...derive.links import link_kind_word
from ..registry import register
from ..section import Count, Section, SectionColumns


def spell_links(reads: Reads) -> SectionColumns:
    """Every edge from a spell to one it triggers, and the word it prints.

    One direction only: "triggered by" is these same edges read backwards, so
    the app inverts the index at load rather than the pack carrying it twice.

    A pair joined in two different ways stays two rows, since those are two
    distinct facts; the renderer merges them into one chip listing both words.
    """
    kinds: dict[str, int] = {}
    rows = []
    for source, destination, effect, aura in sorted(reads.effects.links):
        word = link_kind_word(effect, aura, reads.declared.effect_names, reads.declared.aura_names)
        rows.append((source, destination, kinds.setdefault(word, len(kinds))))
    # Two effect rows differing only in a column the pack does not ship are one
    # edge once the word is what identifies it.
    rows = sorted(set(rows))
    return {"srcIds": [row[0] for row in rows],
            "dstIds": [row[1] for row in rows],
            "kinds": [row[2] for row in rows],
            # Who the effect carrying the trigger is aimed at, so a link chip
            # wears the same target icons as the pills beside it.
            "targets": [reads.effects.link_targets.get((row[0], row[1]), 0)
                        for row in rows],
            "kindNames": list(kinds)}


SPELL_LINKS = register(Section(
    name="spellLinks",
    doc="Every edge from a spell to one it triggers, and the word that edge prints.",
    module="core",
    produce=spell_links,
    columns=("srcIds", "dstIds", "kinds", "targets", "kindNames"),
    reads=("effects", "declared"),
    counts=(Count("spellLinks", lambda columns, _r: len(columns["srcIds"])),
            Count("linkKinds", lambda columns, _r: len(columns["kindNames"]))),
))
