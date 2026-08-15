"""The rows a reader evaluates, as the pack ships them.

Everywhere else the build produces a column: one array per field, one entry per
(spell, row) pair, with the spell repeated beside every value. That shape says
what the game table held; it does not say what a row IS, so whoever reads it has
to put the row back together -- join the file id to its path, decide from a
category number which noun the row is, and allocate the result again on every
query.

This layer says it instead. A `Family` is one mapping from spells to rows of one
kind: which properties the row carries, where each property's value comes from,
and what value means it has none. The kind and the property names are the
reader's own vocabulary, so a row arrives already being the thing it is.

Two decisions make it cheap. The distinct rows are pooled, because a row repeats
across spells far more often than not -- measured on Shadowlands, 1.73 million
(spell, row) pairs are 379 thousand distinct rows -- so the values ship once and
a spell refers to them. And a spell's rows are found by a COUNT rather than an
offset: the counts are almost all nought, one or two and compress to nothing,
where a running offset is a rising six-digit number gzip cannot fold. The reader
prefix-sums them once.

A property's value is stored as the number its vocabulary is keyed by, never as
text. What that number means is the vocabulary's job, and the vocabularies are
the tables the pack already ships -- so a path, an attachment word and an
animation name each stay in the one place they were already written, and the row
costs an integer to point at them.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from ..routes.models import (MODEL_CAT_AREA, MODEL_CAT_ATTACH, MODEL_CAT_BARRAGE,
                             MODEL_CAT_DISPLAY, MODEL_CAT_ITEM, MODEL_CAT_MISSILE,
                             MODEL_CAT_TRAIL)
from ..routes.vehicles import PASSENGER_ROLE_NAMES
from .context import Reads
from .rows import (boneset_rows, replacement_rows, spell_role_rows,
                   spell_rows)

RowValues = tuple[int, ...]
"""One row's property values, in the family's declared property order."""

SpellRow = tuple[int, RowValues]
"""One row and the spell that has it."""

ABSENT = -1
"""The stored value meaning a property has no value, where nought is real.

An animation id, an attachment point and a boneset all number from nought, so a
column of theirs cannot use it as a gap. Declared per property rather than
guessed, because the columns where nought IS the gap -- a file id, a target mask
-- outnumber these and would be silently emptied by the opposite guess.
"""


@dataclass(frozen=True)
class Family:
    """One mapping from spells to rows of one kind.

    The record states the whole mapping: its codomain (the kind and its
    properties), how each property resolves (its vocabulary), what absence looks
    like, and the domain it maps from (`rows`). Nothing about a family lives
    anywhere else, so adding an axis is a record here and a declaration in the
    reader's catalogue -- and the check that reconciles the two names any
    property one of them has and the other does not.
    """

    kind: str
    """The catalogue's word for this kind, inside its column."""

    props: tuple[str, ...]
    """The property names, in the order the values arrive."""

    rows: Callable[[Reads], Iterable[SpellRow]]
    """Every (spell, values) pair this family maps, in any order."""

    vocab: Mapping[str, str] = field(default_factory=dict)
    """Per property, the vocabulary its stored number is keyed by.

    A property absent from this carries the number itself: a percent, a colour,
    a target mask, an identity with no name to resolve.
    """

    absent: Mapping[str, int] = field(default_factory=dict)
    """Per property, the stored value meaning it has none. Defaults to nought."""


@dataclass(frozen=True)
class KindPool:
    """One kind's distinct rows, held column-major.

    Column-major because that is what the artifact wants: like values sit
    together, which is most of why the pooled table is smaller than the columns
    it replaces rather than merely differently shaped.
    """

    props: tuple[str, ...]
    columns: tuple[list[int], ...]
    vocab: Mapping[str, str]
    absent: Mapping[str, int]

    rows: int
    """How many rows the pool holds.

    Carried rather than read off a column, because a valueless kind -- a pose,
    a freeze -- has no column to count and still has exactly one row: the empty
    one every spell that has it refers to.
    """


@dataclass(frozen=True)
class ColumnRows:
    """One query column's rows: the pools, and which spell refers to which.

    `refs` numbers rows across the whole column, so one integer names both the
    kind and the row. The bases are the running sum of the pool sizes, which the
    reader recomputes rather than being told -- a shipped base could disagree
    with the pools it indexes.
    """

    kinds: tuple[str, ...]
    pools: Mapping[str, KindPool]
    counts: list[int]
    refs: list[int]


def _pool(family: Family, rows: Iterable[SpellRow],
          into: dict[int, list[int]], base: int) -> KindPool:
    """One family's rows pooled, and every spell's references recorded.

    Insertion order is the pool's order, which keeps the encoding deterministic
    without a sort that would have to order tuples of unrelated meanings.
    """
    slots: dict[RowValues, int] = {}
    for spell, values in rows:
        slot = slots.setdefault(values, len(slots))
        into.setdefault(spell, []).append(base + slot)
    columns = tuple([values[at] for values in slots]
                    for at in range(len(family.props)))
    return KindPool(props=family.props, columns=columns, vocab=family.vocab,
                    absent=family.absent, rows=len(slots))


def build_column(families: Sequence[Family], reads: Reads,
                 spell_ids: Sequence[int]) -> ColumnRows:
    """Every family of one column, pooled and indexed by spell.

    A spell's references are sorted, so equal runs sit together and a reader
    that stops early on an ordered scan sees the pools in the order they ship.

    Raises:
        ValueError: a family names a vocabulary nothing declares. Left to the
            reader it is silent -- the lookup misses, the property keeps the raw
            number a name was meant to replace, and every query on it answers
            nothing forever.
    """
    per_spell: dict[int, list[int]] = {}
    pools: dict[str, KindPool] = {}
    base = 0
    for family in families:
        unknown = sorted(set(family.vocab.values()) - set(VOCABULARIES))
        if unknown:
            raise ValueError(
                f"{family.kind} resolves {', '.join(unknown)}, which no "
                f"vocabulary declares")
        pools[family.kind] = _pool(family, family.rows(reads), per_spell, base)
        base += pools[family.kind].rows

    counts, refs = [], []
    for spell in spell_ids:
        mine = sorted(per_spell.get(spell, ()))
        counts.append(len(mine))
        refs.extend(mine)
    return ColumnRows(kinds=tuple(family.kind for family in families),
                      pools=pools, counts=counts, refs=refs)


# The model column.

def _models(kind: str, cat: int, props: tuple[str, ...],
            pick: Callable[[tuple[int, ...]], RowValues],
            worn: bool | None = None) -> Family:
    """One model category as its own kind.

    A weapon the caster already carries has no model of its own: its file id is
    a sentinel naming a slot. That splits the plain attached category in two --
    the model it draws, and the weapon it points at -- and splits only that one.
    The sentinel also turns up under the other categories, where it stays with
    its own kind and reads as the label the file table gives it, because what
    the game did there is show the carried weapon flying or trailing rather than
    name a slot.

    Args:
        worn: which half of the attached category this kind takes -- `True` the
            sentinels, `False` the real models, `None` every row of the
            category. Only the attached category passes anything but `None`.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for row in reads.rows.models:
            if row[2] != cat or (worn is not None and (row[1] < 0) is not worn):
                continue
            yield row[0], pick(row)

    return Family(
        kind=kind, props=props, rows=rows,
        vocab={"file": "files", "slot": "slots", "attach": "attachments",
               "from": "attachments", "to": "attachments",
               "motion": "motions", "name": "items"},
        absent={"attach": ABSENT, "from": ABSENT, "to": ABSENT})


def _mounts(reads: Reads) -> Iterable[SpellRow]:
    """The mounts a spell puts its target on.

    The display's own file is resolved here rather than shipped as a second hop:
    a mount row names one model, and making a reader join two tables to learn
    which would be the reassembly this layer exists to stop.
    """
    for spell, display in reads.mounts.links:
        yield spell, (display, reads.mounts.fid.get(display, 0))


MODEL_FAMILIES: tuple[Family, ...] = (
    _models("missile", MODEL_CAT_MISSILE, ("file", "from", "to", "motion", "target"),
            lambda row: (row[1], row[4], row[5], row[7], row[3])),
    _models("barrage", MODEL_CAT_BARRAGE, ("file", "attach", "target"),
            lambda row: (row[1], row[4], row[3])),
    _models("ground", MODEL_CAT_AREA, ("file", "target"), lambda row: (row[1], row[3])),
    _models("attached", MODEL_CAT_ATTACH, ("file", "attach", "target"),
            lambda row: (row[1], row[4], row[3]), worn=False),
    _models("trail", MODEL_CAT_TRAIL, ("file", "target"), lambda row: (row[1], row[3])),
    _models("display", MODEL_CAT_DISPLAY, ("id", "file", "attach", "target"),
            lambda row: (row[6], row[1], row[4], row[3])),
    _models("item", MODEL_CAT_ITEM, ("file", "id", "name", "attach", "target"),
            lambda row: (row[1], row[6], row[6], row[4], row[3])),
    _models("equipped", MODEL_CAT_ATTACH, ("slot", "attach", "target"),
            lambda row: (row[1], row[4], row[3]), worn=True),
    Family(kind="mount", props=("name", "file"), rows=_mounts,
           vocab={"name": "mounts", "file": "files"}),
)


# The sound column.

def _sounds(reads: Reads) -> Iterable[SpellRow]:
    """Every sound file a spell plays, under the kit that plays it."""
    for spell, kit, fid, mask in reads.rows.sounds:
        yield spell, (fid, kit, mask)


SOUND_FAMILIES: tuple[Family, ...] = (
    Family(kind="sound", props=("file", "kit", "target"), rows=_sounds,
           vocab={"file": "files", "kit": "kits"}),
)


# The anim column.

def _animkits(reads: Reads) -> Iterable[SpellRow]:
    """One row per animation a kit plays, and per region that animation moves.

    The expansion happens here rather than in the reader because a region is
    answered by one row: asking which spells animate the head must not be
    answered by a row that merely joined every region its kit touches.
    """
    _rows, names = boneset_rows(reads.animkit_bonesets, reads.rows.used_animkits)
    pool = {name: at for at, name in enumerate(names)}
    for spell, kit, mask in reads.rows.animkits:
        anims = sorted(reads.animkit_anims.get(kit, ()))
        if not anims:
            yield spell, (kit, ABSENT, ABSENT, mask)
            continue
        for anim in anims:
            regions = reads.animkit_bonesets.get(kit, {}).get(anim) or []
            if not regions:
                yield spell, (kit, anim, ABSENT, mask)
            for region in regions:
                yield spell, (kit, anim, pool[region], mask)


def _loose(reads: Reads) -> Iterable[SpellRow]:
    """Every animation played on the unit directly, from both routes.

    A vehicle's OWN animations are loose too -- they are the vehicle's
    behaviour rather than the rider's, so they belong beside the animations a
    kit plays and not under the passenger kind. They carry no mask, and one
    already reached through a visual is not repeated: the two routes describe
    the same animation playing, and a reader asking which spells play it wants
    one row, not one per route that found it.
    """
    limit = len(reads.declared.anim_names)
    seen: dict[int, set[int]] = {}
    for spell, anims in reads.visuals.visual_anims.items():
        for anim, mask in anims.items():
            if anim < limit:
                seen.setdefault(spell, set()).add(anim)
                yield spell, (anim, mask)
    for spell, anim in spell_rows(reads.vehicles.vehicle_anims,
                                  reads.rows.vehicles, limit):
        if anim not in seen.get(spell, ()):
            yield spell, (anim, 0)


def _replacements(reads: Reads) -> Iterable[SpellRow]:
    """Every animation a spell wears in place of another."""
    for spell, source, destination, mask in replacement_rows(
            reads.visuals, reads.effects, reads.anim_replacements,
            len(reads.declared.anim_names)):
        yield spell, (source, destination, mask)


def _poses(reads: Reads) -> Iterable[SpellRow]:
    """The spells that hold a pose by suppressing their own animation."""
    for spell in reads.attributes.get("preventsanim", ()):
        yield spell, ()


_ROLES: tuple[str, ...] = tuple(
    PASSENGER_ROLE_NAMES[role] for role in sorted(PASSENGER_ROLE_NAMES))
"""The rider's roles as property names, in role order.

Read off the route's own declaration so a role added there becomes a property
here with no second list to remember.
"""


def _passengers(reads: Reads) -> Iterable[SpellRow]:
    """A rider's animations, each under the role it plays in.

    One property per role rather than one row carrying all three, because a
    query asking what a rider does on the way in must not be answered by the
    animation it holds once seated.
    """
    for spell, anim, role in spell_role_rows(
            reads.vehicles.passenger_anims, reads.rows.vehicles,
            len(reads.declared.anim_names)):
        values = [ABSENT] * len(PASSENGER_ROLE_NAMES)
        values[role] = anim
        yield spell, tuple(values)


ANIM_FAMILIES: tuple[Family, ...] = (
    Family(kind="kit", props=("id", "anim", "boneset", "target"), rows=_animkits,
           vocab={"anim": "anims", "boneset": "bonesets"},
           absent={"anim": ABSENT, "boneset": ABSENT}),
    Family(kind="loose", props=("anim", "target"), rows=_loose,
           vocab={"anim": "anims"}, absent={"anim": ABSENT}),
    Family(kind="replace", props=("from", "to", "target"), rows=_replacements,
           vocab={"from": "anims", "to": "anims"},
           absent={"from": ABSENT, "to": ABSENT}),
    Family(kind="pose", props=(), rows=_poses),
    Family(kind="passenger", props=_ROLES, rows=_passengers,
           vocab={role: "anims" for role in _ROLES},
           absent={role: ABSENT for role in _ROLES}),
)


COLUMN_FAMILIES: Mapping[str, tuple[Family, ...]] = {
    "model": MODEL_FAMILIES,
    "sound": SOUND_FAMILIES,
    "anim": ANIM_FAMILIES,
}
"""Every column that ships rows, and the families that fill it.

The columns absent from this still ship the per-spell sections they always did;
their reader reassembles rows the old way until their families are written.
"""

VOCABULARIES: Mapping[str, Mapping[str, str]] = {
    "files": {"in": "files", "keys": "fids", "values": "paths"},
    "attachments": {"in": "attachmentNames"},
    "motions": {"in": "missileMotions", "keys": "ids", "values": "names"},
    "items": {"in": "items", "keys": "ids", "values": "names"},
    "mounts": {"in": "mounts", "keys": "displayIds", "values": "names"},
    "kits": {"in": "soundKitNames", "keys": "soundKitIds", "values": "names"},
    "anims": {"in": "animNames"},
    "bonesets": {"in": "bonesetNames"},
    "slots": {"in": "equippedSlots", "keys": "fids", "values": "slots"},
}
"""Where each vocabulary lives, and how it is keyed.

A vocabulary naming no keys is indexed by the stored number itself -- a bare
array, or an object whose keys are the numbers. One naming keys is two parallel
columns a reader pairs into a map. Those are the only two shapes the pack has,
and saying which a vocabulary is here is what lets one reader resolve every
property without knowing what any of them mean.
"""
