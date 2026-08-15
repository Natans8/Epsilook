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
from ...derive.kinds import ColumnRows, RowValue
from ...measure import numeric_domain
from ...routes.models import SYNTHETIC_MODEL_FILES
from ..registry import register
from ..section import (CountFamily, Domain, Layout, Scope, Section,
                       SectionColumns)

READS = ("spell_ids", "rows", "mounts", "visuals", "effects", "declared",
         "anim_replacements", "animkit_anims", "animkit_bonesets",
         "attributes", "vehicles", "areas", "fx", "procs", "paths",
         "references")
"""What the families map from, declared once: every row section reads the same
context, since which of it a column touches is the families' business."""

Placed = tuple[int, str, int]
"""One row as the counts see it: which spell, which kind, which pool slot.

A slot rather than the row's values, because materialising a mapping per row
allocates one dict for every (spell, row) pair in the column -- the largest of
which runs to hundreds of thousands -- and most counts read no value at all.
Whoever wants one reads it out of the column at the slot.
"""

Reader = Mapping[str, Mapping[str, Sequence[RowValue]]]
"""Per kind, its columns by name: the declared properties and the carried ones
together, which is what a count reads a placed row through."""


def columns_of(rows: ColumnRows) -> SectionColumns:
    """One column's rows as the artifact carries them.

    `sizes` is what lets a reader turn a reference back into a kind: the pools
    are numbered end to end, so the running sum of the sizes gives each kind its
    base. It ships rather than being implied by the value columns, because a
    kind carrying no property at all has no column whose length would say it.

    The property ORDER is the order of the value columns and is not shipped
    twice; a reader that needs it reads the keys.

    `carried` is apart from `values` and not merged into it, which is the whole
    point of the split: what the evaluator reads is exactly what the catalogue
    declares, and the bridge's own columns cannot be mistaken for a property.
    """
    return {
        "kinds": list(rows.kinds),
        "sizes": [rows.pools[kind].rows for kind in rows.kinds],
        "values": {kind: dict(rows.pools[kind].values) for kind in rows.kinds},
        "carried": {kind: dict(rows.pools[kind].extras) for kind in rows.kinds
                    if rows.pools[kind].carried},
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


def reading(columns: SectionColumns) -> Reader:
    """Each kind's columns, declared and carried, by name."""
    kinds = cast(Sequence[str], columns["kinds"])
    values = cast(Reader, columns["values"])
    carried = cast(Reader, columns["carried"])
    return {kind: {**values[kind], **carried.get(kind, {})} for kind in kinds}


def walk(columns: SectionColumns) -> Iterator[Placed]:
    """Every (spell, kind, slot) placement the produced table encodes.

    The counts run through this rather than over the pools, because a pool holds
    DISTINCT rows: counting it would answer how many different missiles the
    build has, not how many times a spell shows one.

    A row's carried columns arrive beside its properties, because that is what
    identifies the legacy row a count describes: which dissolve a row is decides
    whether two rows are one dissolve seen twice.
    """
    kinds = cast(Sequence[str], columns["kinds"])
    sizes = cast(Sequence[int], columns["sizes"])
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
            yield spell, kind, ref - base[kind]
        at += count


def counted(compute: Callable[[list[Placed], Reader], Mapping[str, int]]
            ) -> CountFamily:
    """One section's counts, all from a single walk of its rows."""
    return CountFamily(lambda columns, _reads: compute(*walked(columns)))


_WALKED: tuple[SectionColumns, list[Placed], Reader] | None = None
"""The last table walked, its placements, and how to read them.

One entry, holding the table ITSELF rather than its id: a section's counts and
its domains are handed the same object one after the other, and nothing else is
walked in between. Keeping the reference is what makes the identity test safe --
an id alone can be reused once the table it named is collected, which would hand
one section's placements to the next.
"""


def walked(columns: SectionColumns) -> tuple[list[Placed], Reader]:
    """The section's placements and column reader, made once per table.

    Counts and domains both want every row, and walking twice rebuilds the
    kind-per-reference array and re-reads every reference for an answer already
    in hand.
    """
    global _WALKED
    if _WALKED is None or _WALKED[0] is not columns:
        _WALKED = (columns, list(walk(columns)), reading(columns))
    return _WALKED[1], _WALKED[2]


def per_spell(rows: Sequence[Placed], kinds: frozenset[str]) -> Counter[int]:
    """How many rows of the named kinds each spell has, for a count domain."""
    return Counter(spell for spell, kind, _slot in rows if kind in kinds)


def per_spell_distinct(rows: Sequence[Placed], read: Reader, kind: str,
                       *keys: str) -> Counter[int]:
    """How many DISTINCT rows of one kind each spell reaches.

    What a domain over an expanded kind has to measure. A kit ships one row per
    animation and region, and three fx families one row per texture, so counting
    rows would describe how finely the build segments an effect rather than how
    many effects a spell wears -- and it is the second that every reader of
    these axes, and the count beside each of them, means.

    Read off the same keys the count uses, so a domain and the count it
    describes cannot come to disagree about what one row is.
    """
    return Counter(spell for spell, _key in entries(rows, read, kind, *keys))


MODEL_KINDS = frozenset({"missile", "barrage", "ground", "attached", "trail",
                         "display", "item", "equipped"})
"""The model kinds a visual reaches. A mount is the one that does not: it comes
from the mount table rather than through a visual, which is why it was never in
the `spellModels` count and is not in the model count domain."""


def points_at(read: Reader, kind: str, slot: int) -> RowValue:
    """The file one model row points at, whichever property names it.

    A carried weapon has no model of its own, so its file is the slot marker
    under `slot`; every other model kind names its asset under `file`.
    """
    columns = read[kind]
    column = columns.get("slot") or columns.get("file")
    return 0 if column is None else column[slot]


def model_counts(rows: Sequence[Placed], read: Reader) -> Mapping[str, int]:
    """The counts the retired model sections carried."""
    kinds = Counter(kind for _spell, kind, _slot in rows)
    return {
        "spellModels": sum(kinds[kind] for kind in MODEL_KINDS),
        "spellDisplayModels": kinds["display"],
        "spellItemModels": kinds["item"],
        # Every row pointing at a carried weapon rather than at an asset,
        # whichever kind it landed on: the sentinel turns up under the flying
        # and trailing categories too, and the count has always been about the
        # file, not about the kind that happens to show it.
        "spellWeaponModels": sum(
            1 for _spell, kind, slot in rows
            if points_at(read, kind, slot) in SYNTHETIC_MODEL_FILES),
        "spellMissileMotions": sum(
            1 for _spell, kind, slot in rows
            if kind == "missile" and read["missile"]["motion"][slot]),
        "spellMounts": kinds["mount"],
    }


def anim_counts(rows: Sequence[Placed], read: Reader) -> Mapping[str, int]:
    """The counts the retired animation sections carried.

    A kit is counted by its distinct (spell, kit) pairs, which is what the count
    has always reported: the rows outnumber the pairs now that a kit ships one
    row per animation and region.
    """
    kinds = Counter(kind for _spell, kind, _slot in rows)
    return {
        "spellAnimKits": len({(spell, read["kit"]["id"][slot])
                              for spell, kind, slot in rows if kind == "kit"}),
        "spellVisualAnims": kinds["loose"],
        "spellReplaceAnims": kinds["replace"],
        "spellPassengerAnims": kinds["passenger"],
    }


def entries(rows: Sequence[Placed], read: Reader, kind: str,
            *keys: str) -> set[tuple[int, tuple[RowValue, ...]]]:
    """The distinct rows of one kind the named columns identify, by spell.

    Three fx families expand one effect into a row per texture it paints with,
    so the rows outnumber the effects and a plain count would report how many
    textures the build has rather than how many effects a spell wears. The keys
    are what the retired section's rows were keyed by, which is the only thing
    that keeps the count meaning what it always meant.
    """
    columns = read[kind]
    return {(spell, tuple(columns[key][slot] for key in keys))
            for spell, word, slot in rows if word == kind}


CHAIN_KEYS = ("chain", "from", "to", "target")
"""What identifies one beam: which chain, drawn where, aimed at whom.

The whole of what the retired link section keyed a row by, so one chain drawn
between two different attachment pairs stays two answers and the textures it
paints with stay one.
"""


def fx_counts(rows: Sequence[Placed], read: Reader) -> Mapping[str, int]:
    """The counts the retired visual-effect sections carried."""
    kinds = Counter(kind for _spell, kind, _slot in rows)
    return {
        "spellFx": len(entries(rows, read, "chain", *CHAIN_KEYS)),
        "spellDissolves": len(entries(rows, read, "dissolve", "dissolve")),
        "spellScreens": len(entries(rows, read, "screen", "screen")),
        "spellGlows": kinds["glow"],
        "spellShadowies": kinds["shadowy"],
        "spellGhostMats": kinds["ghost"],
        "spellTints": kinds["tint"],
        "spellDesaturates": kinds["desaturate"],
        "spellTransparencies": kinds["transparency"],
        "spellFreezes": kinds["freeze"],
        "spellCamos": kinds["camo"],
        "spellMorphs": kinds["morph"],
        "spellShapeshifts": kinds["shapeshift"],
        "spellScales": kinds["scale"],
        "spellSummons": kinds["summon"],
        "spellObjects": kinds["object"],
    }


def mech_counts(rows: Sequence[Placed], read: Reader) -> Mapping[str, int]:
    """The counts the retired mechanics, gate and modifier sections carried.

    A vehicle is counted by its distinct (spell, vehicle) pairs: a seat is a row
    here, and the count has always been how many vehicles a spell puts its
    subject in.
    """
    kinds = Counter(kind for _spell, kind, _slot in rows)
    return {
        "spellMechanics": kinds["effect"],
        # One direction, which is what the retired section held: the other is
        # the same edges read from the far end and would count them twice.
        "spellLinks": kinds["triggers"],
        "spellAreas": kinds["location"],
        "spellInvis": kinds["invis"],
        "invisChannels": len({read["invis"]["channel"][slot]
                              for _spell, kind, slot in rows if kind == "invis"}),
        "spellDetects": kinds["detect"],
        "spellVehicles": len(entries(rows, read, "seats", "vehicle")),
        "spellSpeeds": kinds["speed"],
        "spellKeybinds": kinds["keybind"],
    }


def amounts(rows: Sequence[Placed], read: Reader, kind: str,
            prop: str) -> list[RowValue]:
    """One property's value on every row of one kind, for a numeric domain."""
    column = read[kind][prop]
    return [column[slot] for _spell, word, slot in rows if word == kind]


ROW_COLUMNS = ("kinds", "sizes", "values", "carried", "vocab", "absent",
               "counts", "refs")

MODEL_ROWS = register(Section(
    name="modelRows",
    doc="Every model a spell shows, as rows of the kind each one is.",
    module="core",
    produce=produce("model"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(model_counts),),
    domains=(Domain("count.model", lambda columns, _r: numeric_domain(
        per_spell(walked(columns)[0], MODEL_KINDS).values())),),
))

SOUND_ROWS = register(Section(
    name="soundRows",
    doc="Every sound a spell plays, as rows carrying the kit that plays it.",
    module="core",
    produce=produce("sound"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(lambda rows, _read: {"spellSounds": len(rows)}),),
    domains=(Domain("count.sound", lambda columns, _r: numeric_domain(
        per_spell(walked(columns)[0], frozenset({"sound"})).values())),),
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
        per_spell_distinct(*walked(columns), "kit", "id").values())),),
))

FX_ROWS = register(Section(
    name="fxRows",
    doc="Every visual effect a spell wears, as rows of the kind each one is.",
    module="core",
    produce=produce("fx"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(fx_counts),),
    domains=(
        # The beams alone, which is what this axis has always counted: the
        # other sixteen families are unrelated tables that happen to render
        # in one column, and folding them in would change what the control
        # measures rather than widen it.
        Domain("count.fx", lambda columns, _r: numeric_domain(
            per_spell_distinct(*walked(columns), "chain",
                               *CHAIN_KEYS).values())),
        Domain("desaturate", lambda columns, _r: numeric_domain(
            amounts(*walked(columns), "desaturate", "percent")), unit="%"),
        Domain("transparency", lambda columns, _r: numeric_domain(
            amounts(*walked(columns), "transparency", "percent")), unit="%"),
        Domain("scale", lambda columns, _r: numeric_domain(
            amounts(*walked(columns), "scale", "amount")), unit="%"),
    ),
))

MECH_ROWS = register(Section(
    name="mechRows",
    doc="Everything a spell DOES, as rows of the kind that does it.",
    module="core",
    produce=produce("mech"),
    columns=ROW_COLUMNS,
    reads=READS,
    counts=(counted(mech_counts),),
    domains=(
        Domain("count.mech", lambda columns, _r: numeric_domain(
            per_spell(walked(columns)[0], frozenset({"effect"})).values())),
        Domain("invis", lambda columns, _r: numeric_domain(
            amounts(*walked(columns), "invis", "channel"))),
        Domain("speed", lambda columns, _r: numeric_domain(
            amounts(*walked(columns), "speed", "amount")), unit="%"),
    ),
))

def equipped_slots(_reads: Reads) -> SectionColumns:
    """The weapon slot each fileless model marker stands for.

    The order is bound once and both columns built from it: two arrays are
    parallel because one ordering made them, never because two orderings agreed.
    """
    fids = sorted(SYNTHETIC_MODEL_FILES)
    return {"fids": fids,
            "slots": [SYNTHETIC_MODEL_FILES[fid].removeprefix("equipped ")
                      for fid in fids]}


EQUIPPED_SLOTS = register(Section(
    name="equippedSlots",
    doc="The weapon slot each fileless model marker stands for.",
    module="universal",
    produce=equipped_slots,
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
