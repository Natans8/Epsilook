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

from ...derive import (COLUMN_FAMILIES, COLUMN_READS, VOCABULARIES, Reads,
                       build_column)
from ...derive.kinds import ColumnRows, RowValue
from ...measure import numeric_domain
from ...routes.models import SYNTHETIC_MODEL_FILES
from ..registry import register
from ..section import (CountFamily, Domain, Layout, Scope, Section,
                       SectionColumns)

Triple = tuple[int, str, Mapping[str, RowValue]]
"""One row as the counts see it: which spell, which kind, and its values."""


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


def walk(columns: SectionColumns) -> Iterator[Triple]:
    """Every (spell, kind, values) triple the produced table encodes.

    The counts run through this rather than over the pools, because a pool holds
    DISTINCT rows: counting it would answer how many different missiles the
    build has, not how many times a spell shows one.

    A row's carried columns arrive beside its properties, because that is what
    identifies the legacy row a count describes: which dissolve a row is decides
    whether two rows are one dissolve seen twice.
    """
    kinds = cast(Sequence[str], columns["kinds"])
    sizes = cast(Sequence[int], columns["sizes"])
    values = cast(Mapping[str, Mapping[str, Sequence[RowValue]]], columns["values"])
    carried = cast(Mapping[str, Mapping[str, Sequence[RowValue]]], columns["carried"])
    refs = cast(Sequence[int], columns["refs"])
    read = {kind: {**values[kind], **carried.get(kind, {})} for kind in kinds}

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
                                for name, column in read[kind].items()}
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


def per_spell_distinct(rows: Sequence[Triple], kind: str,
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
    return Counter(spell for spell, _key in entries(rows, kind, *keys))


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


def entries(rows: Sequence[Triple], kind: str,
            *keys: str) -> set[tuple[int, tuple[RowValue, ...]]]:
    """The distinct rows of one kind the named columns identify, by spell.

    Three fx families expand one effect into a row per texture it paints with,
    so the rows outnumber the effects and a plain count would report how many
    textures the build has rather than how many effects a spell wears. The keys
    are what the retired section's rows were keyed by, which is the only thing
    that keeps the count meaning what it always meant.
    """
    return {(spell, tuple(values[key] for key in keys))
            for spell, word, values in rows if word == kind}


CHAIN_KEYS = ("chain", "from", "to", "target")
"""What identifies one beam: which chain, drawn where, aimed at whom.

The whole of what the retired link section keyed a row by, so one chain drawn
between two different attachment pairs stays two answers and the textures it
paints with stay one.
"""


def fx_counts(rows: Sequence[Triple]) -> Mapping[str, int]:
    """The counts the retired visual-effect sections carried."""
    kinds = Counter(kind for _spell, kind, _values in rows)
    return {
        "spellFx": len(entries(rows, "chain", *CHAIN_KEYS)),
        "spellDissolves": len(entries(rows, "dissolve", "dissolve")),
        "spellScreens": len(entries(rows, "screen", "screen")),
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


def mech_counts(rows: Sequence[Triple]) -> Mapping[str, int]:
    """The counts the retired mechanics, gate and modifier sections carried.

    A vehicle is counted by its distinct (spell, vehicle) pairs: a seat is a row
    here, and the count has always been how many vehicles a spell puts its
    subject in.
    """
    kinds = Counter(kind for _spell, kind, _values in rows)
    return {
        "spellMechanics": kinds["effect"],
        # One direction, which is what the retired section held: the other is
        # the same edges read from the far end and would count them twice.
        "spellLinks": kinds["triggers"],
        "spellAreas": kinds["location"],
        "spellInvis": kinds["invis"],
        "invisChannels": len({values["channel"] for _spell, kind, values in rows
                              if kind == "invis"}),
        "spellDetects": kinds["detect"],
        "spellVehicles": len(entries(rows, "seats", "vehicle")),
        "spellSpeeds": kinds["speed"],
        "spellKeybinds": kinds["keybind"],
    }


def amounts(rows: Sequence[Triple], kind: str, prop: str) -> list[RowValue]:
    """One property's value on every row of one kind, for a numeric domain."""
    return [values[prop] for _spell, word, values in rows if word == kind]


ROW_COLUMNS = ("kinds", "sizes", "values", "carried", "vocab", "absent",
               "counts", "refs")

MODEL_ROWS = register(Section(
    name="modelRows",
    doc="Every model a spell shows, as rows of the kind each one is.",
    module="core",
    produce=produce("model"),
    columns=ROW_COLUMNS,
    reads=COLUMN_READS["model"],
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
    reads=COLUMN_READS["sound"],
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
    reads=COLUMN_READS["anim"],
    counts=(counted(anim_counts),),
    domains=(Domain("count.anim", lambda columns, _r: numeric_domain(
        per_spell_distinct(walked(columns), "kit", "id").values())),),
))

FX_ROWS = register(Section(
    name="fxRows",
    doc="Every visual effect a spell wears, as rows of the kind each one is.",
    module="core",
    produce=produce("fx"),
    columns=ROW_COLUMNS,
    reads=COLUMN_READS["fx"],
    counts=(counted(fx_counts),),
    domains=(
        # The beams alone, which is what this axis has always counted: the
        # other sixteen families are unrelated tables that happen to render
        # in one column, and folding them in would change what the control
        # measures rather than widen it.
        Domain("count.fx", lambda columns, _r: numeric_domain(
            per_spell_distinct(walked(columns), "chain",
                               *CHAIN_KEYS).values())),
        Domain("desaturate", lambda columns, _r: numeric_domain(
            amounts(walked(columns), "desaturate", "percent")), unit="%"),
        Domain("transparency", lambda columns, _r: numeric_domain(
            amounts(walked(columns), "transparency", "percent")), unit="%"),
        Domain("scale", lambda columns, _r: numeric_domain(
            amounts(walked(columns), "scale", "amount")), unit="%"),
    ),
))

MECH_ROWS = register(Section(
    name="mechRows",
    doc="Everything a spell DOES, as rows of the kind that does it.",
    module="core",
    produce=produce("mech"),
    columns=ROW_COLUMNS,
    reads=COLUMN_READS["mech"],
    counts=(counted(mech_counts),),
    domains=(
        Domain("count.mech", lambda columns, _r: numeric_domain(
            per_spell(walked(columns), frozenset({"effect"})).values())),
        Domain("invis", lambda columns, _r: numeric_domain(
            amounts(walked(columns), "invis", "channel"))),
        Domain("speed", lambda columns, _r: numeric_domain(
            amounts(walked(columns), "speed", "amount")), unit="%"),
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
