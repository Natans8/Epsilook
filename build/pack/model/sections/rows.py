"""The row tables: what a spell HAS, shipped as rows rather than as columns.

One section per query column. Each holds every kind that column can carry, the
distinct rows of each kind pooled, and -- per spell -- how many rows it has and
which pooled rows they are. That is the whole per-spell payload for the column,
so a reader walks it instead of joining the half-dozen tables the same facts used
to arrive in.

The counts are the ones the retired per-spell sections carried, recomputed from
the rows that replaced them and kept to the letter of what they meant.
`spellAnimKits` is still the number of (spell, kit) pairs even though a kit now
ships expanded into one row per animation it plays, because a count that quietly
changed meaning is worse than one that disappeared. They are computed as a
family: one walk answers all of a section's counts, where one walk each would
re-read every reference six times over.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import cast

from ...derive import COLUMN_FAMILIES, VOCABULARIES, Reads, build_column
from ...derive.kinds import ColumnRows
from ...measure import numeric_domain
from ...routes.models import SYNTHETIC_MODEL_FILES
from ..registry import register
from ..section import (CountFamily, Domain, Layout, Scope, Section,
                       SectionColumns)

READS = ("spell_ids", "rows", "mounts", "visuals", "effects", "declared",
         "anim_replacements", "animkit_anims", "animkit_bonesets",
         "attributes", "vehicles")
"""What the families map from, declared once: every row section reads the same
context, since which of it a column touches is the families' business."""

Triple = tuple[int, str, Mapping[str, int]]
"""One row as the counts see it: which spell, which kind, and its values."""


def columns_of(rows: ColumnRows) -> SectionColumns:
    """One column's rows as the artifact carries them.

    `sizes` is what lets a reader turn a reference back into a kind: the pools
    are numbered end to end, so the running sum of the sizes gives each kind its
    base. It ships rather than being implied by the value columns, because a
    kind carrying no property at all has no column whose length would say it.

    The property ORDER is the order of the value columns and is not shipped
    twice; a reader that needs it reads the keys.
    """
    return {
        "kinds": list(rows.kinds),
        "sizes": [rows.pools[kind].rows for kind in rows.kinds],
        "values": {kind: dict(zip(rows.pools[kind].props,
                                  rows.pools[kind].columns))
                   for kind in rows.kinds},
        "vocab": {kind: dict(rows.pools[kind].vocab) for kind in rows.kinds},
        "absent": {kind: dict(rows.pools[kind].absent) for kind in rows.kinds},
        "counts": rows.counts,
        "refs": rows.refs,
    }


def produce(column: str) -> Callable[[Reads], SectionColumns]:
    """One column's row table, built from the families that fill it."""

    def run(reads: Reads) -> SectionColumns:
        return columns_of(build_column(COLUMN_FAMILIES[column], reads,
                                       reads.spell_ids))

    return run


def walk(columns: SectionColumns) -> Iterator[Triple]:
    """Every (spell, kind, values) triple the produced table encodes.

    The counts run through this rather than over the pools, because a pool holds
    DISTINCT rows: counting it would answer how many different missiles the
    build has, not how many times a spell shows one.
    """
    kinds = cast(Sequence[str], columns["kinds"])
    sizes = cast(Sequence[int], columns["sizes"])
    values = cast(Mapping[str, Mapping[str, Sequence[int]]], columns["values"])
    refs = cast(Sequence[int], columns["refs"])

    # Reference to kind by position: the pools are numbered end to end, so one
    # array as long as the pools answers it without a search per reference.
    owner: list[str] = []
    for kind, size in zip(kinds, sizes):
        owner.extend([kind] * size)
    base = {kind: at for kind, at in
            zip(kinds, [sum(sizes[:k]) for k in range(len(kinds))])}

    at = 0
    for spell, count in enumerate(cast(Sequence[int], columns["counts"])):
        for ref in refs[at:at + count]:
            kind = owner[ref]
            slot = ref - base[kind]
            yield spell, kind, {name: column[slot]
                                for name, column in values[kind].items()}
        at += count


def counted(compute: Callable[[list[Triple]], Mapping[str, int]]) -> CountFamily:
    """One section's counts, all from a single walk of its rows."""
    return CountFamily(lambda columns, _reads: compute(walked(columns)))


_WALKED: tuple[SectionColumns, list[Triple]] | None = None
"""The last table walked, and its triples.

One entry, holding the table ITSELF rather than its id: a section's counts and
its domains are handed the same object one after the other, and nothing else is
walked in between. Keeping the reference is what makes the identity test safe --
an id alone can be reused once the table it named is collected, which would hand
one section's triples to the next.
"""


def walked(columns: SectionColumns) -> list[Triple]:
    """The section's triples, materialised once per produced table.

    Counts and domains both want every row, and walking twice rebuilds the
    kind-per-reference array and re-reads every reference for an answer already
    in hand.
    """
    global _WALKED
    if _WALKED is None or _WALKED[0] is not columns:
        _WALKED = (columns, list(walk(columns)))
    return _WALKED[1]


def per_spell(rows: Sequence[Triple], kinds: frozenset[str]) -> Counter[int]:
    """How many rows of the named kinds each spell has, for a count domain."""
    return Counter(spell for spell, kind, _values in rows if kind in kinds)


MODEL_KINDS = frozenset({"missile", "barrage", "ground", "attached", "trail",
                         "display", "item", "equipped"})
"""The model kinds a visual reaches. A mount is the one that does not: it comes
from the mount table rather than through a visual, which is why it was never in
the `spellModels` count and is not in the model count domain."""


def model_counts(rows: Sequence[Triple]) -> Mapping[str, int]:
    """The counts the retired model sections carried."""
    kinds = Counter(kind for _spell, kind, _values in rows)
    return {
        "spellModels": sum(kinds[kind] for kind in MODEL_KINDS),
        "spellDisplayModels": kinds["display"],
        "spellItemModels": kinds["item"],
        # Every row pointing at a carried weapon rather than at an asset,
        # whichever kind it landed on: the sentinel turns up under the flying
        # and trailing categories too, and the count has always been about the
        # file, not about the kind that happens to show it.
        "spellWeaponModels": sum(
            1 for _spell, _kind, values in rows
            if values.get("slot", values.get("file", 0)) in SYNTHETIC_MODEL_FILES),
        "spellMissileMotions": sum(1 for _spell, kind, values in rows
                                   if kind == "missile" and values["motion"]),
        "spellMounts": kinds["mount"],
    }


def anim_counts(rows: Sequence[Triple]) -> Mapping[str, int]:
    """The counts the retired animation sections carried.

    A kit is counted by its distinct (spell, kit) pairs, which is what the count
    has always reported: the rows outnumber the pairs now that a kit ships one
    row per animation and region.
    """
    kinds = Counter(kind for _spell, kind, _values in rows)
    return {
        "spellAnimKits": len({(spell, values["id"])
                              for spell, kind, values in rows if kind == "kit"}),
        "spellVisualAnims": kinds["loose"],
        "spellReplaceAnims": kinds["replace"],
        "spellPassengerAnims": kinds["passenger"],
    }


ROW_COLUMNS = ("kinds", "sizes", "values", "vocab", "absent", "counts", "refs")

MODEL_ROWS = register(Section(
    name="modelRows",
    doc="Every model a spell shows, as rows of the kind each one is.",
    module="core",
    produce=produce("model"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(model_counts),),
    domains=(Domain("count.model", lambda columns, _r: numeric_domain(
        per_spell(walked(columns), MODEL_KINDS).values())),),
))

SOUND_ROWS = register(Section(
    name="soundRows",
    doc="Every sound a spell plays, as rows carrying the kit that plays it.",
    module="core",
    produce=produce("sound"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(lambda rows: {"spellSounds": len(rows)}),),
    domains=(Domain("count.sound", lambda columns, _r: numeric_domain(
        per_spell(walked(columns), frozenset({"sound"})).values())),),
))

ANIM_ROWS = register(Section(
    name="animRows",
    doc="Every animation a spell reaches, as rows of the kind that reaches it.",
    module="core",
    produce=produce("anim"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(anim_counts),),
    domains=(Domain("count.anim", lambda columns, _r: numeric_domain(
        per_spell(walked(columns), frozenset({"kit"})).values())),),
))

EQUIPPED_SLOTS = register(Section(
    name="equippedSlots",
    doc="The weapon slot each fileless model marker stands for.",
    module="universal",
    produce=lambda _reads: {
        "fids": sorted(SYNTHETIC_MODEL_FILES),
        "slots": [SYNTHETIC_MODEL_FILES[fid].removeprefix("equipped ")
                  for fid in sorted(SYNTHETIC_MODEL_FILES)]},
    columns=("fids", "slots"),
    scope=Scope.UNIVERSAL,
))

ROW_VOCABULARIES = register(Section(
    name="rowVocabs",
    doc="Where each row property's vocabulary lives, and how it is keyed.",
    module="universal",
    produce=lambda _reads: {"vocabs": {name: dict(where)
                                       for name, where in VOCABULARIES.items()}},
    columns=("vocabs",),
    layout=Layout.BARE,
    scope=Scope.UNIVERSAL,
))
