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

from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from ..routes.colors import pack_rgb
from ..routes.effects import MOVEMENT_NAMES
from ..routes.models import (MODEL_CAT_AREA, MODEL_CAT_ATTACH, MODEL_CAT_BARRAGE,
                             MODEL_CAT_DISPLAY, MODEL_CAT_ITEM, MODEL_CAT_MISSILE,
                             MODEL_CAT_TRAIL)
from ..routes.vehicles import PASSENGER_ROLE_NAMES
from .context import Reads
from .rows import (ModelRow, boneset_rows, id_rows, masked_rows,
                   replacement_rows, spell_role_rows, spell_rows)

RowValue = int | float
"""One stored value.

Float because two axes are genuinely fractional: a size change and a movement
change are signed percentages, and forty-four of them carry a fraction. Every
other column holds an integer, which the artifact writes the same way either
way.
"""

RowValues = tuple[RowValue, ...]
"""One row's values: its declared properties, then whatever it carries."""

SpellRow = tuple[int, RowValues]
"""One row and the spell that has it."""

ABSENT = -1
"""The stored value meaning a property has no value, where nought is real.

An animation id, an attachment point and a boneset all number from nought, so a
column of theirs cannot use it as a gap. Declared per property rather than
guessed, because the columns where nought IS the gap -- a file id, a target mask
-- outnumber these and would be silently emptied by the opposite guess.
"""

WHOLE_MODEL = -1
"""What an overlay's anchor holds when it covers the model rather than a point.

A real answer with a word of its own, which is why an overlay's anchor cannot
spell absence the way an attached model's does.
"""

NO_ANCHOR = -2
"""The gap for an anchor, which is neither a point nor the whole model."""

UNTINTED = 0xFFFFFF
"""The colour a chain carries when it is drawn in its texture's own.

White is how the game spells "do not tint", so it is no colour to search by and
the row stores none. The chain still ships on the column that carries which
chain it is, which is what a colour cannot do for the fifth of them drawn
untinted.
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
    """Every (spell, values) pair this family maps, in any order.

    Each pair's values are the declared properties followed by whatever the
    family `carried`, in that order.
    """

    vocab: Mapping[str, str] = field(default_factory=dict)
    """Per property, the vocabulary its stored number is keyed by.

    A property absent from this carries the number itself: a percent, a colour,
    a target mask, an identity with no name to resolve.
    """

    absent: Mapping[str, int] = field(default_factory=dict)
    """Per property, the stored value meaning it has none. Defaults to nought."""

    carried: tuple[str, ...] = ()
    """Columns the row ships that no property of the kind declares.

    What the shipped app still needs to rebuild the per-spell section this
    family replaced, where no property of the kind can answer it: which
    dissolve a row is, which vehicle a seat belongs to, the aura sharing an
    effect's row. They ship apart from the properties and the evaluator never
    sees them, so a query cannot select on one -- they exist for the bridge
    that puts the old arrays back, and they leave when it does.

    They are still part of the row KEY, which is what keeps a pooled row and a
    legacy row one-to-one: two dissolves that look alike stay two rows.
    """


@dataclass(frozen=True)
class KindPool:
    """One kind's distinct rows, held column-major.

    Column-major because that is what the artifact wants: like values sit
    together, which is most of why the pooled table is smaller than the columns
    it replaces rather than merely differently shaped.
    """

    props: tuple[str, ...]
    columns: tuple[list[RowValue], ...]
    vocab: Mapping[str, str]
    absent: Mapping[str, int]

    rows: int
    """How many rows the pool holds.

    Carried rather than read off a column, because a valueless kind -- a pose,
    a freeze -- has no column to count and still has exactly one row: the empty
    one every spell that has it refers to.
    """

    carried: tuple[str, ...] = ()
    """The family's carried column names, in the order they follow the props."""

    @property
    def values(self) -> Mapping[str, list[RowValue]]:
        """The declared properties' columns, by property name."""
        return dict(zip(self.props, self.columns))

    @property
    def extras(self) -> Mapping[str, list[RowValue]]:
        """The carried columns, by name. Empty for most kinds."""
        return dict(zip(self.carried, self.columns[len(self.props):]))


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
                    for at in range(len(family.props) + len(family.carried)))
    return KindPool(props=family.props, columns=columns, vocab=family.vocab,
                    absent=family.absent, rows=len(slots),
                    carried=family.carried)


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

    # Most spells carry no row at all in a given column, so the empty case skips
    # the sort rather than building a throwaway list a quarter of a million
    # times over.
    counts, refs = [], []
    for spell in spell_ids:
        mine = per_spell.get(spell)
        if not mine:
            counts.append(0)
            continue
        ordered = sorted(mine)
        counts.append(len(ordered))
        refs.extend(ordered)
    return ColumnRows(kinds=tuple(family.kind for family in families),
                      pools=pools, counts=counts, refs=refs)


# The model column.

def _models(kind: str, cat: int, props: tuple[str, ...],
            pick: Callable[[ModelRow], RowValues],
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
            if row.category != cat or (worn is not None
                                       and (row.file < 0) is not worn):
                continue
            yield row.spell, pick(row)

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
            lambda row: (row.file, row.source, row.destination, row.motion, row.mask)),
    _models("barrage", MODEL_CAT_BARRAGE, ("file", "attach", "target"),
            lambda row: (row.file, row.source, row.mask)),
    _models("ground", MODEL_CAT_AREA, ("file", "target"),
            lambda row: (row.file, row.mask)),
    _models("attached", MODEL_CAT_ATTACH, ("file", "attach", "target"),
            lambda row: (row.file, row.source, row.mask), worn=False),
    _models("trail", MODEL_CAT_TRAIL, ("file", "target"),
            lambda row: (row.file, row.mask)),
    _models("display", MODEL_CAT_DISPLAY, ("id", "file", "attach", "target"),
            lambda row: (row.ref, row.file, row.source, row.mask)),
    _models("item", MODEL_CAT_ITEM, ("file", "id", "name", "attach", "target"),
            lambda row: (row.file, row.ref, row.ref, row.source, row.mask)),
    _models("equipped", MODEL_CAT_ATTACH, ("slot", "attach", "target"),
            lambda row: (row.file, row.source, row.mask), worn=True),
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


# The fx column.

def _painted(reads: Reads, fids: Iterable[int]) -> list[int]:
    """The textures among `fids` the listfile names, in order.

    A file the listfile cannot name is dropped rather than shipped nameless:
    the property is a path, and a row carrying a number where a reader expects
    a path is worse than a row carrying nothing.
    """
    return [fid for fid in fids if reads.paths.get(fid)]


def _per_texture(painted: Sequence[int]) -> Iterable[int]:
    """One texture per row, or one textureless row where none is named.

    The expansion happens here rather than in the reader because a texture is
    answered by one row: asking which spells draw a given texture must not be
    answered by a row that merely joined every texture its effect paints with.
    """
    return painted or (0,)


def _chains(reads: Reads) -> Iterable[SpellRow]:
    """The beams a spell draws, one row per texture each paints with."""
    for spell, chain, mask, source, destination in reads.rows.chains:
        payload = reads.fx.chains[chain]
        tint = 0 if pack_rgb(*payload[:3]) == UNTINTED else chain
        for texture in _per_texture(_painted(reads, payload[4])):
            yield spell, (texture, source, destination, tint, mask, chain)


def _dissolves(reads: Reads) -> Iterable[SpellRow]:
    """The dissolves a spell applies, one row per texture each blends."""
    for spell, dissolve, mask in masked_rows(reads.visuals.dissolves):
        _duration, textures, attach = reads.fx.dissolves[dissolve]
        for texture in _per_texture(_painted(reads, textures)):
            yield spell, (attach, texture, mask, dissolve)


def _shadowies(reads: Reads) -> Iterable[SpellRow]:
    """The shadow passes a spell wears.

    The colour stores which shadowy row it is and the vocabulary resolves the
    PRIMARY of its two colours: the secondary is the pass's falloff, not a
    second answer to what colour it is.
    """
    for spell, shadowy, mask in masked_rows(reads.visuals.shadowies):
        yield spell, (reads.fx.shadowies[shadowy][2], shadowy, mask)


def _coloured(bucket: str) -> Callable[[Reads], Iterable[SpellRow]]:
    """One colour-only family: the row is which recolour, and who it plays on."""

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for spell, row, mask in masked_rows(getattr(reads.visuals, bucket)):
            yield spell, (row, mask)

    return rows


def _percents(bucket: str, value_of: Callable[[Reads, int], int]
              ) -> Callable[[Reads], Iterable[SpellRow]]:
    """A percent-only family: the percent IS the row, so there is no id table.

    Two rows resolving to one percent are one row wearing both audiences, so
    the masks union rather than splitting the percent in two.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        masks: dict[tuple[int, int], int] = {}
        for spell, values in getattr(reads.visuals, bucket).items():
            for row, mask in values.items():
                key = (spell, value_of(reads, row))
                masks[key] = masks.get(key, 0) | mask
        for (spell, percent), mask in sorted(masks.items()):
            yield spell, (percent, mask)

    return rows


def _flagged(bucket: str) -> Callable[[Reads], Iterable[SpellRow]]:
    """A valueless family the walk records as a bare set of spells."""

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for spell in sorted(getattr(reads.visuals, bucket)):
            yield spell, ()

    return rows


def _attributed(flag: str) -> Callable[[Reads], Iterable[SpellRow]]:
    """A valueless family that is one attribute flag on the spell."""

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for spell in reads.attributes.get(flag, ()):
            yield spell, ()

    return rows


def _entities(payload: str) -> Callable[[Reads], Iterable[SpellRow]]:
    """One entity route: which thing a spell reaches, and who it was aimed at."""

    def rows(reads: Reads) -> Iterable[SpellRow]:
        ids = getattr(reads.effects, payload)
        for spell, entity in id_rows(ids):
            yield spell, (entity, ids.masks.get((spell, entity), 0))

    return rows


def _scales(reads: Reads) -> Iterable[SpellRow]:
    """Every size change a spell applies, as a signed percentage."""
    for spell, percents in sorted(reads.effects.scales.items()):
        for percent in sorted(percents):
            yield spell, (percent,
                          reads.effects.scale_targets.get((spell, percent), 0))


def _summons(reads: Reads) -> Iterable[SpellRow]:
    """The creatures a spell brings, and who commands each.

    The audience belongs to the creature alone: one creature summoned under two
    control words is one thing summoned, aimed once.
    """
    for spell, summoned in sorted(reads.effects.summons.items()):
        for creature, control in sorted(summoned):
            yield spell, (creature, control,
                          reads.effects.summon_targets.get((spell, creature), 0))


def _objects(reads: Reads) -> Iterable[SpellRow]:
    """The gameobjects a spell places in the world."""
    for spell, entry in reads.references.object_rows:
        yield spell, (entry, reads.effects.objects.masks.get((spell, entry), 0))


def _screens(reads: Reads) -> Iterable[SpellRow]:
    """The screen effects a spell grades the frame with.

    Two routes reach one -- an aura naming the effect, and a visual kit playing
    it -- and they union here because they are the same fact about the spell.
    The audience comes from the aura, which is the route that records one.
    """
    reached = {(spell, screen)
               for spell, ids in reads.effects.screens.ids.items()
               for screen in ids}
    reached |= {(spell, screen)
                for spell, screens_of in reads.visuals.screens.items()
                for screen in screens_of}
    for spell, screen in sorted(reached):
        payload = reads.fx.screens.get(screen)
        drawn = sorted((role, fid) for fid, role in payload.textures) if payload else []
        mask = reads.effects.screens.masks.get((spell, screen), 0)
        for texture in _per_texture(_painted(reads, [fid for _role, fid in drawn])):
            yield spell, (texture, mask, screen)


FX_FAMILIES: tuple[Family, ...] = (
    Family(kind="chain", props=("texture", "from", "to", "colour", "target"),
           rows=_chains, carried=("chain",),
           vocab={"texture": "files", "from": "attachments", "to": "attachments",
                  "colour": "chainColours"},
           absent={"from": ABSENT, "to": ABSENT}),
    Family(kind="dissolve", props=("attach", "texture", "target"),
           rows=_dissolves, carried=("dissolve",),
           vocab={"attach": "anchors", "texture": "files"},
           absent={"attach": NO_ANCHOR}),
    Family(kind="shadowy", props=("attach", "colour", "target"), rows=_shadowies,
           vocab={"attach": "anchors", "colour": "shadowyColours"},
           absent={"attach": NO_ANCHOR}),
    Family(kind="ghost", props=("colour", "target"), rows=_coloured("ghost_mats"),
           vocab={"colour": "ghostColours"}),
    Family(kind="glow", props=("colour", "target"), rows=_coloured("glows"),
           vocab={"colour": "glowColours"}),
    Family(kind="tint", props=("colour", "target"), rows=_coloured("tints"),
           vocab={"colour": "tintColours"}),
    Family(kind="transparency", props=("percent", "target"),
           rows=_percents("transps", lambda reads, row: reads.procs.transps[row])),
    Family(kind="desaturate", props=("percent", "target"),
           rows=_percents("desats", lambda reads, row: reads.procs.desats[row])),
    Family(kind="freeze", props=(), rows=_flagged("freezes")),
    Family(kind="camo", props=(), rows=_flagged("camos")),
    Family(kind="morph", props=("display", "target"), rows=_entities("morphs"),
           vocab={"display": "morphs"}),
    Family(kind="shapeshift", props=("form", "target"), rows=_entities("forms"),
           vocab={"form": "shapeshifts"}),
    Family(kind="scale", props=("amount", "target"), rows=_scales),
    Family(kind="summon", props=("creature", "control", "target"), rows=_summons,
           vocab={"creature": "creatures", "control": "controls"}),
    Family(kind="object", props=("object", "target"), rows=_objects,
           vocab={"object": "objects"}),
    Family(kind="screen", props=("texture", "target"), rows=_screens,
           carried=("screen",), vocab={"texture": "files"}),
    Family(kind="tracking", props=(), rows=_attributed("tracktargetinchannel")),
)


# The mech column.

def _mask_of(bits: Mapping[int, int], first: int, second: int) -> int:
    """The audience one effect row plays to, from its two implicit targets.

    Handed the bits rather than the context, because the table is the build's
    and the callers walk a million rows against it: resolving it per row would
    be the same lookup answered over and over.
    """
    return bits.get(first, 0) | bits.get(second, 0)


def _effects(reads: Reads) -> Iterable[SpellRow]:
    """Every effect a spell has, carrying the whole row it came from.

    The carried half is what the shipped app rebuilds its mechanics section
    from: the aura sharing this row, the two implicit targets the mask is
    computed from, and the two misc values whose meaning is a function of the
    effect beside them.

    Raises:
        ValueError: an effect row names an aura and no effect. Nothing in the
            game applies an aura without an effect that applies it, and every
            build measured has none -- but were one to appear, it would carry
            the whole row and this family would never yield it, so the
            mechanics section would silently lose a row rather than fail.
    """
    bits = reads.declared.target_bits
    for spell, effect, aura, first, second, misc_a, misc_b in reads.rows.mechanics:
        if not effect:
            raise ValueError(
                f"spell {spell} has an effect row with aura {aura} and no "
                f"effect; the row model carries the row on its effect")
        yield spell, (effect, _mask_of(bits, first, second),
                      aura, first, second, misc_a, misc_b)


def _auras(reads: Reads) -> Iterable[SpellRow]:
    """Every aura a spell has, as its own row.

    Apart from the effect that applies it, because a scope binds its axes to
    one row and "an aura aimed this way" is a question about the aura.
    """
    bits = reads.declared.target_bits
    for spell, _effect, aura, first, second, _a, _b in reads.rows.mechanics:
        if aura:
            yield spell, (aura, _mask_of(bits, first, second))


def _links(forward: bool) -> Callable[[Reads], Iterable[SpellRow]]:
    """One direction of the spell graph.

    Args:
        forward: whether the row belongs to the spell that triggers, rather
            than to the one triggered. The two directions are the same edges
            read from either end, which is why one declaration serves both.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for source, destination, word, mask in reads.rows.links:
            yield ((source, (destination, word, mask)) if forward
                   else (destination, (source, word, mask)))

    return rows


def _areas(reads: Reads) -> Iterable[SpellRow]:
    """Every place a spell may be cast, one row each."""
    for spell, area in reads.areas.gates:
        yield spell, (area,)


def _channels(payload: str, paired: bool) -> Callable[[Reads], Iterable[SpellRow]]:
    """One side of the invisibility pairing.

    A channel is materialised only where it has an invisible side, and that one
    rule is the whole asymmetry: a spell that hides always shows a row, even
    when nothing in the game can reveal it, while a spell that reveals shows one
    only when its channel has something to reveal. The revealing side carries
    how many spells hide on the channel, which is the fact that makes it worth
    reading.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        hiding = Counter(kind for kinds in reads.effects.invis.ids.values()
                         for kind in kinds)
        source = getattr(reads.effects, payload)
        for spell, kind in sorted((spell, kind)
                                  for spell, kinds in source.ids.items()
                                  for kind in kinds
                                  if not paired or kind in hiding):
            mask = source.masks.get((spell, kind), 0)
            yield spell, ((kind, hiding[kind], mask) if paired else (kind, mask))

    return rows


def _seats(reads: Reads) -> Iterable[SpellRow]:
    """One row per seat of the vehicle a spell puts its subject in.

    Each row carries the vehicle's whole seat count beside one seat, so a scope
    can bind both: a four-seater whose second seat sits on the back is one row,
    not two facts a reader has to pair up again.
    """
    # A seat is named by its POSITION in the flat seat table, so each vehicle
    # needs where its own run begins.
    at: dict[int, int] = {}
    for index, (vehicle, _name) in enumerate(reads.rows.seats):
        at.setdefault(vehicle, index)
    for spell, vehicle in reads.rows.vehicles:
        count = len(reads.vehicles.seats[vehicle])
        mask = reads.effects.vehicles.masks.get((spell, vehicle), 0)
        for slot in range(count):
            yield spell, (count, at[vehicle] + slot, mask, vehicle)


def _speeds(reads: Reads) -> Iterable[SpellRow]:
    """Every movement a spell scales, and by how much.

    Several auras reach one movement, so a spell setting two of them to the
    same amount is one row rather than two identical answers.
    """
    for spell, mods in sorted(reads.effects.speeds.items()):
        for movement, percent in sorted(mods):
            yield spell, (percent, MOVEMENT_NAMES.index(movement),
                          reads.effects.speed_targets.get(
                              (spell, movement, percent), 0))


def _keybinds(reads: Reads) -> Iterable[SpellRow]:
    """Which keybound override an aura suppresses while it holds."""
    for spell, override in id_rows(reads.effects.keybinds):
        yield spell, (override,
                      reads.effects.keybinds.masks.get((spell, override), 0))


MECH_FAMILIES: tuple[Family, ...] = (
    Family(kind="effect", props=("name", "target"), rows=_effects,
           carried=("aura", "targetA", "targetB", "misc0", "misc1"),
           vocab={"name": "effects"}),
    Family(kind="aura", props=("name", "target"), rows=_auras,
           vocab={"name": "auras"}),
    # The word is an INDEX into the pool, so nought is the first word rather
    # than no word: an edge always prints one, and the gap has to be a value
    # the pool cannot hold.
    Family(kind="triggers", props=("spell", "how", "target"), rows=_links(True),
           vocab={"spell": "spells", "how": "linkWords"},
           absent={"how": ABSENT}),
    Family(kind="origin", props=("spell", "how", "target"), rows=_links(False),
           vocab={"spell": "spells", "how": "linkWords"},
           absent={"how": ABSENT}),
    Family(kind="location", props=("area",), rows=_areas,
           vocab={"area": "areas"}),
    Family(kind="invis", props=("channel", "target"),
           rows=_channels("invis", paired=False), absent={"channel": ABSENT}),
    Family(kind="detect", props=("channel", "count", "target"),
           rows=_channels("detect", paired=True), absent={"channel": ABSENT}),
    Family(kind="seats", props=("count", "attach", "target"), rows=_seats,
           carried=("vehicle",), vocab={"attach": "seatAnchors"},
           absent={"attach": ABSENT}),
    Family(kind="speed", props=("amount", "mode", "target"), rows=_speeds,
           vocab={"mode": "movements"}, absent={"mode": ABSENT}),
    Family(kind="keybind", props=("key", "target"), rows=_keybinds,
           vocab={"key": "keybinds"}),
    Family(kind="debuff", props=(), rows=_attributed("auraisdebuff")),
)


COLUMN_FAMILIES: Mapping[str, tuple[Family, ...]] = {
    "model": MODEL_FAMILIES,
    "sound": SOUND_FAMILIES,
    "anim": ANIM_FAMILIES,
    "fx": FX_FAMILIES,
    "mech": MECH_FAMILIES,
}
"""Every column that ships rows, and the families that fill it.

Every column a spell can carry more than one of is here. The two that are not --
the spell's own name and its id -- carry exactly one row each and are read off
the per-spell columns directly.
"""

COLUMN_READS: Mapping[str, tuple[str, ...]] = {
    "model": ("spell_ids", "rows", "mounts"),
    "sound": ("spell_ids", "rows"),
    "anim": ("spell_ids", "rows", "visuals", "effects", "declared", "vehicles",
             "attributes", "anim_replacements", "animkit_anims",
             "animkit_bonesets"),
    "fx": ("spell_ids", "rows", "visuals", "effects", "declared", "attributes",
           "fx", "procs", "references", "paths"),
    "mech": ("spell_ids", "rows", "visuals", "effects", "declared", "vehicles",
             "attributes", "areas"),
}
"""What each column's families map FROM, per column rather than in one union.

A section is handed a `Reads` narrowed to what it declares, and reaching past it
raises -- which is the guard that catches an undeclared input. One union across
every row section defeats that for the largest sections in the pack: the sound
column would declare it reads vehicles and animation replacements when it reads
neither.

Per COLUMN and not per family because a family's rows are often a closure a
shared helper returned, so the reads belong to the helper rather than to the
record naming it. The column is the smallest grain that is honest.

It is also what `Per-module build targets` is specified to union, so a column
whose module is not being built can have its derivations skipped.
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
    "anchors": {"in": "anchorNames"},
    "chainColours": {"in": "fxChains", "keys": "ids", "values": "colors"},
    "shadowyColours": {"in": "shadowies", "keys": "ids",
                       "values": "primaryColors"},
    "ghostColours": {"in": "ghostMats", "keys": "ids", "values": "colors"},
    "glowColours": {"in": "glows", "keys": "ids", "values": "colors"},
    "tintColours": {"in": "tints", "keys": "ids", "values": "colors"},
    "morphs": {"in": "morphs", "keys": "creatureIds", "values": "names"},
    "shapeshifts": {"in": "shapeshifts", "keys": "ids", "values": "names"},
    "creatures": {"in": "summons", "keys": "creatureIds", "values": "names"},
    "controls": {"in": "summonControlNames"},
    "objects": {"in": "objects", "keys": "ids", "values": "names"},
    "effects": {"in": "effectNames"},
    "auras": {"in": "auraNames"},
    "spells": {"in": "spells", "keys": "ids", "values": "names"},
    "linkWords": {"in": "linkKindNames"},
    "areas": {"in": "areas", "keys": "ids", "values": "names"},
    "seatAnchors": {"in": "vehicleSeats", "values": "attachments"},
    "movements": {"in": "speedModeNames"},
    "keybinds": {"in": "keybinds", "keys": "ids", "values": "keys"},
}
"""Where each vocabulary lives, and how it is keyed.

Three shapes, and no others. A vocabulary naming neither keys nor values IS the
section -- a bare array, or an object whose keys are the numbers. One naming
values alone is a bare column inside a section, indexed by the stored number.
One naming both is two parallel columns a reader pairs into a map. Saying which
a vocabulary is here is what lets one reader resolve every property without
knowing what any of them mean.

Most resolve to a word. A colour resolves to a NUMBER, and that is the same
mechanism rather than an exception: a tint row stores which tint it is, exactly
as a mount row stores which mount, and what the id means is the vocabulary's to
say. Storing the colour itself would put the appearance where the identity
belongs and leave the reader nothing to rebuild the tint from.
"""
