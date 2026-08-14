"""The expansion ladder, oldest first: what `spells.eras` indexes into.

Everything the app needs to render and search an expansion travels here rather
than being restated in the frontend -- the display short, the words the search
accepts, the site that era's links go to, and any caveat about its data. Adding
an expansion is a row in the tool that writes the ladder and nothing here.

`UNIVERSAL` because the ladder is a fact about the game's history rather than
about the build being packed: every pack that ships it ships the same bytes, so
they name one file and fetch it once.
"""

from __future__ import annotations

from ...derive import Reads
from ..registry import register
from ..section import CountFamily, Scope, Section, SectionColumns

UNCLAIMED = "expansion.unknown"
"""The count key for spells no rung claims -- ids that postdate the newest one."""


def expansions(reads: Reads) -> SectionColumns:
    """One row per rung, in the order the ladder declares them."""
    rungs = reads.declared.expansions
    return {
        "keys": [rung["key"] for rung in rungs],
        "labels": [rung["label"] for rung in rungs],
        "shorts": [rung["short"] for rung in rungs],
        # The game major version. The app indexes its art and logo tables with
        # it, so which picture belongs to which expansion is named once in the
        # frontend's config and never here.
        "majors": [rung["major"] for rung in rungs],
        # The level cap the expansion shipped with. It is what a description's
        # level-dependent placeholders were cooked at, so it travels with the
        # rung rather than being a number the reader has to know.
        "maxLevels": [rung["maxLevel"] for rung in rungs],
        "aliases": [rung["aliases"] for rung in rungs],
        # "" where no era site exists, which the app reads as "use retail".
        "wowhead": [rung["wowhead"] for rung in rungs],
        "caveats": [rung.get("caveat", "") for rung in rungs],
    }


def era_counts(columns: SectionColumns, reads: Reads) -> dict[str, int]:
    """How many of this build's spells each rung claims.

    These DO partition the pack, so unlike most count families they sum to it.
    """
    keys = [f"expansion.{key}" for key in columns["keys"]]
    counted = dict.fromkeys([*keys, UNCLAIMED], 0)
    for spell in reads.spell_ids:
        rung = reads.declared.era_of.get(spell)
        counted[keys[rung] if rung is not None else UNCLAIMED] += 1
    return counted


EXPANSIONS = register(Section(
    name="expansions",
    doc="The expansion ladder oldest first, which spells.eras indexes into.",
    module="universal",
    produce=expansions,
    columns=("keys", "labels", "shorts", "majors", "maxLevels", "aliases",
             "wowhead", "caveats"),
    reads=("declared", "spell_ids"),
    counts=(CountFamily(era_counts),),
    scope=Scope.UNIVERSAL,
))
