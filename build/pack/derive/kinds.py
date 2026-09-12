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

from ..phases import PHASE_AURA
from ..routes.colors import pack_rgb
from ..routes.effects import (
    EFFECT_ACTIVATE_OBJECT,
    EFFECT_ATTRIBUTE_FLAGS,
    EFFECT_SUMMON,
    MOVEMENT_NAMES,
    UNIMPLEMENTED_EFFECTS,
    carries_attribute,
)
from ..routes.models import (
    MODEL_CAT_AREA,
    MODEL_CAT_ATTACH,
    MODEL_CAT_BARRAGE,
    MODEL_CAT_DISPLAY,
    MODEL_CAT_ITEM,
    MODEL_CAT_MISSILE,
    MODEL_CAT_TRAIL,
)
from ..routes.vehicles import PASSENGER_ROLE_NAMES
from .context import Reads
from .rows import ModelRow, effect_phase, id_rows, masked_rows, replacement_rows, spell_role_rows, spell_rows
from .walk import screen_occurrences

RowValue = int | float
"""One stored value.

Float because two axes are genuinely fractional: a size change and a movement
change are signed percentages, and forty-four of them carry a fraction. Every
other column holds an integer, which the artifact writes the same way either
way.
"""

RowValues = tuple[RowValue, ...]
"""One row's values: its declared properties, then whatever it carries.

Flat, including a property that spans several columns: its components sit where
the property sits, in the order the family declares them. So a family yields the
tuple it always did, and which columns belong to which property is read from the
declaration rather than from the shape of the row.
"""

PropColumns = list[RowValue] | Mapping[str, list[RowValue]]
"""One property's shipped column, or its components' columns by name."""

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

NO_PACE = -1_000_000
"""The stored pace of a kit row that plays no animation.

Far outside any pace a kit carries, because a negative pace is a real one: the
client plays the animation backwards.
"""

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

    spans: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    """Per property that is more than one number, its components in order.

    One property, several columns. A position and a rotation are each ONE thing
    to a reader and three numbers to the machine, so they are declared as one
    property here and ship as a column per component. A property absent from
    this is a single column, which is what almost all of them are.

    The components arrive in `rows` flattened in this order, immediately where
    the property sits among the props -- so a family yields the same flat tuple
    it always did and only the reading of it changes.

    It is for a value that is one thing to a reader and several numbers to the
    machine. It is NOT a way to group unrelated properties under one word.
    """

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

    def width(self, prop: str) -> int:
        """How many columns one property occupies."""
        return len(self.spans[prop]) if prop in self.spans else 1


PHASED = {"phase": "phases"}
"""The phase's vocabulary entry: every timed family resolves it the same way."""


def timed(
    kind: str,
    props: tuple[str, ...],
    rows: Callable[[Reads], Iterable[SpellRow]],
    *,
    vocab: Mapping[str, str] | None = None,
    absent: Mapping[str, int] | None = None,
    carried: tuple[str, ...] = (),
    spans: Mapping[str, tuple[str, ...]] | None = None,
) -> Family:
    """A family that happens at a moment of the spell.

    The phase closes its properties and resolves through the phase vocabulary,
    stated here once so a family cannot declare one half without the other. A
    family with no phase is one that does not happen: a pose and a freeze are
    membership, a mount is a link from the spell, a location is a gate.
    """
    return Family(
        kind=kind,
        props=(*props, "phase"),
        rows=rows,
        vocab={**(vocab or {}), **PHASED},
        absent=absent or {},
        carried=carried,
        spans=spans or {},
    )


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

    spans: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    """The family's spanning properties and their components. See `Family`."""

    carried: tuple[str, ...] = ()
    """The family's carried column names, in the order they follow the props."""

    @property
    def values(self) -> Mapping[str, PropColumns]:
        """The declared properties' columns, by property name.

        A property spanning several columns answers with its components by
        name; a single-column property answers with its column. That is the
        split the encoder already writes, a group against a plain column, so
        the two shapes here need no spelling of their own.
        """
        held: dict[str, PropColumns] = {}
        at = 0
        for prop in self.props:
            parts = self.spans.get(prop)
            if parts is None:
                held[prop] = self.columns[at]
                at += 1
            else:
                held[prop] = {name: self.columns[at + which] for which, name in enumerate(parts)}
                at += len(parts)
        return held

    @property
    def extras(self) -> Mapping[str, list[RowValue]]:
        """The carried columns, by name. Empty for most kinds."""
        return dict(zip(self.carried, self.columns[len(self.columns) - len(self.carried) :]))


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


def _pool(family: Family, rows: Iterable[SpellRow], into: dict[int, list[int]], base: int) -> KindPool:
    """One family's rows pooled, and every spell's references recorded.

    Insertion order is the pool's order, which keeps the encoding deterministic
    without a sort that would have to order tuples of unrelated meanings.
    """
    slots: dict[RowValues, int] = {}
    for spell, values in rows:
        slot = slots.setdefault(values, len(slots))
        into.setdefault(spell, []).append(base + slot)
    width = sum(family.width(prop) for prop in family.props) + len(family.carried)
    columns = tuple([values[at] for values in slots] for at in range(width))
    # Only this kind's own properties: a shared helper hands every kind it
    # builds one vocabulary map, so without the cut a kind ships entries for
    # properties it does not have.
    own = set(family.props)
    return KindPool(
        props=family.props,
        columns=columns,
        vocab={prop: where for prop, where in family.vocab.items() if prop in own},
        absent={prop: gap for prop, gap in family.absent.items() if prop in own},
        rows=len(slots),
        spans={prop: parts for prop, parts in family.spans.items() if prop in own},
        carried=family.carried,
    )


def build_column(families: Sequence[Family], reads: Reads, spell_ids: Sequence[int]) -> ColumnRows:
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
            raise ValueError(f"{family.kind} resolves {', '.join(unknown)}, which no vocabulary declares")
        keyed = sorted(set(family.spans) & set(family.vocab))
        if keyed:
            raise ValueError(
                f"{family.kind} spans {', '.join(keyed)} and resolves them "
                f"through a vocabulary; a vocabulary keys ONE stored number "
                f"and a spanning property has none to key"
            )
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
    return ColumnRows(kinds=tuple(family.kind for family in families), pools=pools, counts=counts, refs=refs)


# The model column.

PLACEMENT_PROPS = ("scale", "built", "offset", "rotation", "anim", "animkit")
"""The placement properties, in the order `placed` flattens them.

Only the kinds reached through `SpellVisualKitModelAttach` declare these; the
rest carry the neutral placement and would ship a column of it saying nothing.
"""

PLACEMENT_SPANS = {"offset": ("x", "y", "z"), "rotation": ("yaw", "pitch", "roll")}
"""The placement properties that are one thing over several columns.

A position and a rotation are each one value a reader means as a whole. Nothing
else here is: the three animations a row can name are three answers to one
question rather than one answer in three parts, and grouping those under one
word is what a span is NOT for.

A spanning property resolves through no vocabulary, which follows from the same
rule -- what a vocabulary keys is a single stored number, and a value that is
one thing in several numbers has none to key.
"""


def placed(row: ModelRow) -> RowValues:
    """A row's placement, flattened in the order `PLACEMENT_PROPS` declares.

    The animation is the one the model holds while it is worn. The two either
    side of it -- what it plays arriving and what it plays going -- reach the
    anim column already, where they answer what a spell plays; what this adds
    is which of a spell's models is the one playing it, and the held animation
    is what that question means.

    TODO: give the arriving and departing animations their own properties once
    a reader has a way to ask about a moment rather than about a model.
    """
    return (
        row.placement.scale,
        row.built,
        *row.placement.offset,
        *row.placement.rotation,
        row.placement.held,
        row.placement.animkit,
    )


def _models(
    kind: str, cat: int, props: tuple[str, ...], pick: Callable[[ModelRow], RowValues], carried: bool | None = None
) -> Family:
    """One model category as its own kind.

    A weapon the caster already carries has no model of its own: its file id is
    a sentinel naming a slot. That splits the attach category in two -- the
    model it draws, and the weapon it points at -- and splits only that one.
    The sentinel also turns up under the other categories, where it stays with
    its own kind and reads as the label the file table gives it, because what
    the game did there is show the carried weapon flying or trailing rather than
    name a slot.

    Args:
        carried: which half of the attach category this kind takes -- `True`
            the carried-weapon sentinels, `False` the real models, `None` every
            row of the category. Only the attach category passes anything but
            `None`.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for row in reads.rows.models:
            if row.category != cat or (carried is not None and (row.file < 0) is not carried):
                continue
            yield row.spell, (*pick(row), row.phase)

    return timed(
        kind,
        props,
        rows,
        vocab={
            "file": "files",
            "slot": "slots",
            "where": "attachments",
            "from": "attachments",
            "to": "attachments",
            "motion": "motions",
            "projectiles": "motionProjectiles",
            "name": "items",
            "anim": "anims",
        },
        absent={"where": ABSENT, "from": ABSENT, "to": ABSENT},
        spans=PLACEMENT_SPANS,
    )


def _mounts(reads: Reads) -> Iterable[SpellRow]:
    """The mounts a spell puts its target on.

    The display's own file is resolved here rather than shipped as a second hop:
    a mount row names one model, and making a reader join two tables to learn
    which would be the reassembly this layer exists to stop.
    """
    for spell, display in reads.mounts.links:
        yield spell, (display, reads.mounts.fid.get(display, 0))


MODEL_FAMILIES: tuple[Family, ...] = (
    # `motion` and `projectiles` both store the flight path's id and differ only in
    # which vocabulary reads it -- its name, or how many projectiles it is
    # written for. The count stays one copy in the motion table that way, the
    # same trade `tint.colour` makes.
    _models(
        "missile",
        MODEL_CAT_MISSILE,
        ("file", "from", "to", "motion", "projectiles", "target"),
        lambda row: (row.file, row.source, row.destination, row.motion, row.motion, row.mask),
    ),
    _models("barrage", MODEL_CAT_BARRAGE, ("file", "where", "target"), lambda row: (row.file, row.source, row.mask)),
    _models("ground", MODEL_CAT_AREA, ("file", "target"), lambda row: (row.file, row.mask)),
    _models(
        "attach",
        MODEL_CAT_ATTACH,
        ("file", "where", "target", *PLACEMENT_PROPS),
        lambda row: (row.file, row.source, row.mask, *placed(row)),
        carried=False,
    ),
    _models("trail", MODEL_CAT_TRAIL, ("file", "target"), lambda row: (row.file, row.mask)),
    _models(
        "display",
        MODEL_CAT_DISPLAY,
        ("id", "file", "where", "target", *PLACEMENT_PROPS),
        lambda row: (row.ref, row.file, row.source, row.mask, *placed(row)),
    ),
    _models(
        "item",
        MODEL_CAT_ITEM,
        ("file", "id", "name", "where", "target", *PLACEMENT_PROPS),
        lambda row: (row.file, row.ref, row.ref, row.source, row.mask, *placed(row)),
    ),
    _models(
        "equipped",
        MODEL_CAT_ATTACH,
        ("slot", "where", "target", *PLACEMENT_PROPS),
        lambda row: (row.file, row.source, row.mask, *placed(row)),
        carried=True,
    ),
    Family(kind="mount", props=("name", "file"), rows=_mounts, vocab={"name": "mounts", "file": "files"}),
)


# The sound column.


def _sounds(reads: Reads) -> Iterable[SpellRow]:
    """Every sound file a spell plays, under the kit that plays it.

    The type is the KIT's, read once per kit and carried onto each of its rows,
    so a spell whose noise is an emote or a death can be told from the many
    whose noise is simply a spell.
    """
    for row in reads.rows.sounds:
        yield (
            row.spell,
            (
                row.file,
                row.kit,
                reads.kit_types.get(row.kit, ABSENT),
                int(row.kit in reads.looping_kits),
                row.mask,
                row.phase,
            ),
        )


SOUND_FAMILIES: tuple[Family, ...] = (
    timed(
        "sound",
        ("file", "kit", "type", "loop", "target"),
        _sounds,
        vocab={"file": "files", "kit": "kits", "type": "soundTypes"},
        absent={"type": ABSENT, "loop": 0},
    ),
)


# The anim column.


def _animkits(reads: Reads) -> Iterable[SpellRow]:
    """One row per animation a kit plays, and per region that animation moves.

    The expansion happens here rather than in the reader because a region is
    answered by one row: asking which spells animate the head must not be
    answered by a row that merely joined every region its kit touches.
    """
    pool = {name: at for at, name in enumerate(reads.rows.boneset_names)}
    for spell, kit, phase, mask in reads.rows.animkits:
        anims = sorted(reads.animkit_anims.get(kit, ()))
        if not anims:
            yield spell, (kit, ABSENT, ABSENT, NO_PACE, mask, phase)
            continue
        for anim in anims:
            pace = reads.animkit_speeds.get((kit, anim), NO_PACE)
            regions = reads.animkit_bonesets.get(kit, {}).get(anim) or []
            if not regions:
                yield spell, (kit, anim, ABSENT, pace, mask, phase)
            for region in regions:
                yield spell, (kit, anim, pool[region], pace, mask, phase)


def _loose(reads: Reads) -> Iterable[SpellRow]:
    """Every animation played on the unit directly, from both routes.

    A vehicle's OWN animations are loose too -- they are the vehicle's
    behaviour rather than the rider's, so they belong beside the animations a
    kit plays and not under the passenger kind. They carry no mask, they hold
    for as long as the vehicle aura does, and one already reached through a
    visual is not repeated: the two routes describe the same animation
    playing, and a reader asking which spells play it wants one row, not one
    per route that found it.
    """
    limit = len(reads.declared.anim_names)
    seen: dict[int, set[int]] = {}
    for spell, anims in reads.visuals.visual_anims.items():
        for (anim, phase), mask in anims.items():
            if anim < limit:
                seen.setdefault(spell, set()).add(anim)
                yield spell, (anim, mask, phase)
    for spell, anim in spell_rows(reads.vehicles.vehicle_anims, reads.rows.vehicles, limit):
        if anim not in seen.get(spell, ()):
            yield spell, (anim, 0, PHASE_AURA)


def _replacements(reads: Reads) -> Iterable[SpellRow]:
    """Every animation a spell wears in place of another.

    The replacement leads: it is what the character is seen doing, and the
    one the kind's own word reaches.
    """
    for spell, source, destination, phase, mask in replacement_rows(
        reads.visuals, reads.effects, reads.anim_replacements, len(reads.declared.anim_names)
    ):
        yield spell, (destination, source, mask, phase)


def _poses(reads: Reads) -> Iterable[SpellRow]:
    """The spells that hold a pose by suppressing their own animation."""
    for spell in reads.attributes.get("preventsanim", ()):
        yield spell, ()


_ROLES: tuple[str, ...] = tuple(PASSENGER_ROLE_NAMES[role] for role in sorted(PASSENGER_ROLE_NAMES))
"""The rider's roles as property names, in role order.

Read off the route's own declaration so a role added there becomes a property
here with no second list to remember.
"""


def _passengers(reads: Reads) -> Iterable[SpellRow]:
    """A rider's animations, each under the role it plays in.

    One property per role rather than one row carrying all three, because a
    query asking what a rider does on the way in must not be answered by the
    animation it holds once seated. All of them hold for the vehicle aura.
    """
    for spell, anim, role in spell_role_rows(
        reads.vehicles.passenger_anims, reads.rows.vehicles, len(reads.declared.anim_names)
    ):
        values: list[RowValue] = [ABSENT] * len(PASSENGER_ROLE_NAMES)
        values[role] = anim
        yield spell, (*values, PHASE_AURA)


ANIM_FAMILIES: tuple[Family, ...] = (
    timed(
        "kit",
        ("id", "anim", "boneset", "speed", "target"),
        _animkits,
        vocab={"anim": "anims", "boneset": "bonesets"},
        absent={"anim": ABSENT, "boneset": ABSENT, "speed": NO_PACE},
    ),
    timed(
        "loose",
        ("anim", "target"),
        _loose,
        vocab={"anim": "anims"},
        absent={"anim": ABSENT},
    ),
    timed(
        "replace",
        ("to", "from", "target"),
        _replacements,
        vocab={"to": "anims", "from": "anims"},
        absent={"to": ABSENT, "from": ABSENT},
    ),
    Family(kind="pose", props=(), rows=_poses),
    timed(
        "passenger",
        _ROLES,
        _passengers,
        vocab={role: "anims" for role in _ROLES},
        absent={role: ABSENT for role in _ROLES},
    ),
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


def _visual_kits(reads: Reads) -> Iterable[SpellRow]:
    """Every visual kit a spell's visuals name, by id, when it starts and for
    whom: the spine of the spell's timeline."""
    for spell, kit, phase, mask in masked_rows(reads.visuals.visual_kits):
        yield spell, (kit, mask, phase)


def _chains(reads: Reads) -> Iterable[SpellRow]:
    """The beams a spell draws, one row per texture each paints with."""
    for spell, chain, source, destination, phase, mask in reads.rows.chains:
        payload = reads.fx.chains[chain]
        tint = 0 if pack_rgb(payload.red, payload.green, payload.blue) == UNTINTED else chain
        character = (int(payload.arcing), int(payload.flickering), int(payload.jagged), int(payload.wavy))
        for texture in _per_texture(_painted(reads, payload.textures)):
            yield spell, (texture, source, destination, tint, *character, payload.width, mask, phase, chain)


def _dissolves(reads: Reads) -> Iterable[SpellRow]:
    """The dissolves a spell applies, one row per texture each blends."""
    for spell, dissolve, phase, mask in masked_rows(reads.visuals.dissolves):
        _duration, textures, attach = reads.fx.dissolves[dissolve]
        for texture in _per_texture(_painted(reads, textures)):
            yield spell, (attach, texture, mask, phase, dissolve)


def _shadowies(reads: Reads) -> Iterable[SpellRow]:
    """The shadow passes a spell wears.

    The colour stores which shadowy row it is and the vocabulary resolves the
    PRIMARY of its two colours: the secondary is the pass's falloff, not a
    second answer to what colour it is.
    """
    for spell, shadowy, phase, mask in masked_rows(reads.visuals.shadowies):
        yield spell, (reads.fx.shadowies[shadowy][2], shadowy, mask, phase)


def _coloured(bucket: str) -> Callable[[Reads], Iterable[SpellRow]]:
    """One colour-only family: the row is which recolour, when, and who it
    plays on."""

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for spell, row, phase, mask in masked_rows(getattr(reads.visuals, bucket)):
            yield spell, (row, mask, phase)

    return rows


def _percents(bucket: str, value_of: Callable[[Reads, int], int]) -> Callable[[Reads], Iterable[SpellRow]]:
    """A percent-only family: the percent IS the row, so there is no id table.

    Two rows resolving to one percent at one phase are one row wearing both
    audiences, so the masks union rather than splitting the percent in two.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        masks: dict[tuple[int, int, int], int] = {}
        for spell, values in getattr(reads.visuals, bucket).items():
            for (row, phase), mask in values.items():
                key = (spell, value_of(reads, row), phase)
                masks[key] = masks.get(key, 0) | mask
        for (spell, percent, phase), mask in sorted(masks.items()):
            yield spell, (percent, mask, phase)

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
    """One aura payload: which thing a spell reaches, and who it was aimed at.

    Every payload read this way is an aura's, so it holds from the aura phase.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        ids = getattr(reads.effects, payload)
        for spell, entity in id_rows(ids):
            yield spell, (entity, ids.masks.get((spell, entity), 0), PHASE_AURA)

    return rows


def _scales(reads: Reads) -> Iterable[SpellRow]:
    """Every size change a spell applies, as a signed percentage."""
    for spell, percents in sorted(reads.effects.scales.items()):
        for percent in sorted(percents):
            yield spell, (percent, reads.effects.scale_targets.get((spell, percent), 0), PHASE_AURA)


def _summons(reads: Reads) -> Iterable[SpellRow]:
    """The creatures a spell brings, and who commands each.

    The audience belongs to the creature alone: one creature summoned under two
    control words is one thing summoned, aimed once. A summon is an effect,
    so it happens where the spell lands.
    """
    for spell, summoned in sorted(reads.effects.summons.items()):
        phase = effect_phase(EFFECT_SUMMON, 0, spell, reads.props.delayed, reads.rows.channelled)
        for creature, control in sorted(summoned):
            yield (
                spell,
                (creature, control, reads.effects.summon_targets.get((spell, creature), 0), phase),
            )


def _activations(reads: Reads) -> Iterable[SpellRow]:
    """What a spell does to the gameobject it reaches, with the action's own
    number: the anim kit or spell visual an action plays, nought otherwise.
    An activation is an effect, so it happens where the spell lands."""
    for spell, performed in sorted(reads.effects.activations.items()):
        phase = effect_phase(EFFECT_ACTIVATE_OBJECT, 0, spell, reads.props.delayed, reads.rows.channelled)
        for action, number in sorted(performed):
            mask = reads.effects.activation_targets.get((spell, action, number), 0)
            yield spell, (action, number, mask, phase)


def _objects(reads: Reads) -> Iterable[SpellRow]:
    """The gameobjects a spell places in the world, where it lands."""
    for spell, entry in reads.references.object_rows:
        yield (
            spell,
            (
                entry,
                reads.effects.objects.masks.get((spell, entry), 0),
                effect_phase(0, 0, spell, reads.props.delayed, reads.rows.channelled),
            ),
        )


def _screens(reads: Reads) -> Iterable[SpellRow]:
    """The screen effects a spell grades the frame with.

    Two routes reach one -- an aura naming the effect, which holds it for the
    aura phase, and a visual kit playing it, which starts it at the kit's
    event -- and each is an occurrence of its own.
    """
    for (spell, screen, phase), mask in sorted(
        screen_occurrences(reads.effects.screens, reads.visuals.screens).items()
    ):
        payload = reads.fx.screens.get(screen)
        drawn = sorted((role, fid) for fid, role in payload.textures) if payload else []
        for texture in _per_texture(_painted(reads, [fid for _role, fid in drawn])):
            yield spell, (texture, mask, phase, screen)


FX_FAMILIES: tuple[Family, ...] = (
    timed("visual", ("id", "target"), _visual_kits),
    timed(
        "chain",
        ("texture", "from", "to", "colour", "arcing", "flickering", "jagged", "wavy", "width", "target"),
        _chains,
        carried=("chain",),
        vocab={"texture": "files", "from": "attachments", "to": "attachments", "colour": "chainColours"},
        # A trait ships as one where the beam has it and nought where it does
        # not, and nought is the absence of the property rather than a value.
        absent={"from": ABSENT, "to": ABSENT, "arcing": 0, "flickering": 0, "jagged": 0, "wavy": 0},
    ),
    timed(
        "dissolve",
        ("where", "texture", "target"),
        _dissolves,
        carried=("dissolve",),
        vocab={"where": "anchors", "texture": "files"},
        absent={"where": NO_ANCHOR},
    ),
    timed(
        "shadowy",
        ("where", "colour", "target"),
        _shadowies,
        vocab={"where": "anchors", "colour": "shadowyColours"},
        absent={"where": NO_ANCHOR},
    ),
    timed(
        "ghost",
        ("colour", "target"),
        _coloured("ghost_mats"),
        vocab={"colour": "ghostColours"},
    ),
    timed(
        "glow",
        ("colour", "target"),
        _coloured("glows"),
        vocab={"colour": "glowColours"},
    ),
    timed(
        "tint",
        ("colour", "target"),
        _coloured("tints"),
        vocab={"colour": "tintColours"},
    ),
    timed(
        "transparency",
        ("percent", "target"),
        _percents("transps", lambda reads, row: reads.procs.transps[row]),
    ),
    timed(
        "desaturate",
        ("percent", "target"),
        _percents("desats", lambda reads, row: reads.procs.desats[row]),
    ),
    Family(kind="freeze", props=(), rows=_flagged("freezes")),
    Family(kind="camo", props=(), rows=_flagged("camos")),
    timed(
        "morph",
        ("creature", "target"),
        _entities("morphs"),
        vocab={"creature": "morphs"},
    ),
    timed(
        "shapeshift",
        ("form", "target"),
        _entities("forms"),
        vocab={"form": "shapeshifts"},
    ),
    timed("scale", ("amount", "target"), _scales),
    timed(
        "summon",
        ("creature", "control", "target"),
        _summons,
        vocab={"creature": "creatures", "control": "controls"},
    ),
    timed("object", ("object", "target"), _objects, vocab={"object": "objects"}),
    timed(
        "screen",
        ("texture", "target"),
        _screens,
        carried=("screen",),
        vocab={"texture": "files"},
    ),
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
    for row in reads.rows.mechanics:
        if not row.effect:
            raise ValueError(
                f"spell {row.spell} has an effect row with aura {row.aura} and no "
                f"effect; the row model carries the row on its effect"
            )
        yield (
            row.spell,
            (
                row.effect,
                _mask_of(bits, row.target_a, row.target_b),
                row.order,
                row.hops,
                int(row.effect in UNIMPLEMENTED_EFFECTS),
                *(int(carries_attribute(row.attributes, bit)) for bit in EFFECT_ATTRIBUTE_FLAGS.values()),
                row.phase,
                row.aura,
                row.target_a,
                row.target_b,
                row.misc_a,
                row.misc_b,
            ),
        )


def _auras(reads: Reads) -> Iterable[SpellRow]:
    """Every aura a spell has, as its own row.

    Apart from the effect that applies it, because a scope binds its axes to
    one row and "an aura aimed this way" is a question about the aura.
    """
    bits = reads.declared.target_bits
    for row in reads.rows.mechanics:
        if row.aura:
            yield row.spell, (row.aura, _mask_of(bits, row.target_a, row.target_b), row.every, row.phase)


def _links(forward: bool) -> Callable[[Reads], Iterable[SpellRow]]:
    """One direction of the spell graph.

    Args:
        forward: whether the row belongs to the spell that triggers, rather
            than to the one triggered. The two directions are the same edges
            read from either end, which is why one declaration serves both.
    """

    def rows(reads: Reads) -> Iterable[SpellRow]:
        for source, destination, word, phase, mask in reads.rows.links:
            yield (
                (source, (destination, word, mask, phase)) if forward else (destination, (source, word, mask, phase))
            )

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
        hiding = Counter(kind for kinds in reads.effects.invis.ids.values() for kind in kinds)
        source = getattr(reads.effects, payload)
        for spell, kind in sorted(
            (spell, kind) for spell, kinds in source.ids.items() for kind in kinds if not paired or kind in hiding
        ):
            mask = source.masks.get((spell, kind), 0)
            yield spell, ((kind, hiding[kind], mask, PHASE_AURA) if paired else (kind, mask, PHASE_AURA))

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
            yield spell, (count, at[vehicle] + slot, mask, PHASE_AURA, vehicle)


def _speeds(reads: Reads) -> Iterable[SpellRow]:
    """Every movement a spell scales, and by how much.

    Several auras reach one movement, so a spell setting two of them to the
    same amount is one row rather than two identical answers.
    """
    for spell, mods in sorted(reads.effects.speeds.items()):
        for movement, percent in sorted(mods):
            yield (
                spell,
                (
                    percent,
                    MOVEMENT_NAMES.index(movement),
                    reads.effects.speed_targets.get((spell, movement, percent), 0),
                    PHASE_AURA,
                ),
            )


def _breaks(reads: Reads) -> Iterable[SpellRow]:
    """Every event that removes a spell's aura, one row each."""
    for spell, bits in sorted(reads.aura_interrupts.items()):
        for bit in bits:
            yield spell, (bit,)


def _keybinds(reads: Reads) -> Iterable[SpellRow]:
    """Which keybound override an aura suppresses while it holds."""
    for spell, override in id_rows(reads.effects.keybinds):
        yield spell, (override, reads.effects.keybinds.masks.get((spell, override), 0), PHASE_AURA)


MECH_FAMILIES: tuple[Family, ...] = (
    # The index is the effect's place in its spell's own order, which nothing
    # else on the row says; the phase is where that order happens.
    timed(
        "effect",
        ("name", "target", "index", "hops", "unimplemented", *EFFECT_ATTRIBUTE_FLAGS),
        _effects,
        carried=("aura", "targetA", "targetB", "misc0", "misc1"),
        vocab={"name": "effects"},
        absent={"hops": 0, "unimplemented": 0, **dict.fromkeys(EFFECT_ATTRIBUTE_FLAGS, 0)},
    ),
    timed("aura", ("name", "target", "every"), _auras, vocab={"name": "auras"}, absent={"every": 0}),
    # The word is an INDEX into the pool, so nought is the first word rather
    # than no word: an edge always prints one, and the gap has to be a value
    # the pool cannot hold.
    timed(
        "triggers",
        ("spell", "how", "target"),
        _links(True),
        vocab={"spell": "spells", "how": "linkWords"},
        absent={"how": ABSENT},
    ),
    timed(
        "origin",
        ("spell", "how", "target"),
        _links(False),
        vocab={"spell": "spells", "how": "linkWords"},
        absent={"how": ABSENT},
    ),
    Family(kind="location", props=("area",), rows=_areas, vocab={"area": "areas"}),
    timed(
        "invis",
        ("channel", "target"),
        _channels("invis", paired=False),
        absent={"channel": ABSENT},
    ),
    timed(
        "detect",
        ("channel", "count", "target"),
        _channels("detect", paired=True),
        absent={"channel": ABSENT},
    ),
    timed(
        "vehicle",
        ("seats", "where", "target"),
        _seats,
        carried=("vehicle",),
        vocab={"where": "seatAnchors"},
        absent={"where": ABSENT},
    ),
    timed(
        "speed",
        ("amount", "mode", "target"),
        _speeds,
        vocab={"mode": "movements"},
        absent={"mode": ABSENT},
    ),
    timed("keybind", ("key", "target"), _keybinds, vocab={"key": "keybinds"}),
    Family(kind="debuff", props=(), rows=_attributed("auraisdebuff")),
    timed(
        "faction",
        ("name", "target"),
        _entities("factions"),
        vocab={"name": "factions"},
    ),
    Family(kind="breaks", props=("on",), rows=_breaks, vocab={"on": "interrupts"}),
    timed("activate", ("action", "parameter", "target"), _activations, vocab={"action": "gameobjectActions"}),
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
    "sound": ("spell_ids", "rows", "kit_types", "looping_kits"),
    "anim": (
        "spell_ids",
        "rows",
        "visuals",
        "effects",
        "declared",
        "vehicles",
        "attributes",
        "anim_replacements",
        "animkit_anims",
        "animkit_bonesets",
        "animkit_speeds",
    ),
    "fx": (
        "spell_ids",
        "rows",
        "visuals",
        "effects",
        "declared",
        "attributes",
        "fx",
        "procs",
        "references",
        "paths",
        "props",
    ),
    "mech": (
        "spell_ids",
        "rows",
        "visuals",
        "effects",
        "declared",
        "vehicles",
        "attributes",
        "props",
        "areas",
        "aura_interrupts",
    ),
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
    "soundTypes": {"in": "soundTypes", "keys": "ids", "values": "names"},
    "motionProjectiles": {"in": "missileMotions", "keys": "ids", "values": "projectiles"},
    "items": {"in": "items", "keys": "ids", "values": "names"},
    "mounts": {"in": "mounts", "keys": "displayIds", "values": "names"},
    "kits": {"in": "soundKitNames", "keys": "soundKitIds", "values": "names"},
    "anims": {"in": "animNames"},
    "bonesets": {"in": "bonesetNames"},
    "slots": {"in": "equippedSlots", "keys": "fids", "values": "slots"},
    "anchors": {"in": "anchorNames"},
    "chainColours": {"in": "fxChains", "keys": "ids", "values": "colors"},
    "shadowyColours": {"in": "shadowies", "keys": "ids", "values": "primaryColors"},
    "ghostColours": {"in": "ghostMats", "keys": "ids", "values": "colors"},
    "glowColours": {"in": "glows", "keys": "ids", "values": "colors"},
    "tintColours": {"in": "tints", "keys": "ids", "values": "colors"},
    "morphs": {"in": "morphs", "keys": "creatureIds", "values": "names"},
    "shapeshifts": {"in": "shapeshifts", "keys": "ids", "values": "names"},
    "creatures": {"in": "summons", "keys": "creatureIds", "values": "names"},
    "controls": {"in": "summonControlNames"},
    "gameobjectActions": {"in": "gameobjectActionNames"},
    "objects": {"in": "objects", "keys": "ids", "values": "names"},
    "effects": {"in": "effectNames"},
    "auras": {"in": "auraNames"},
    "spells": {"in": "spells", "keys": "ids", "values": "names"},
    "linkWords": {"in": "linkKindNames"},
    "areas": {"in": "areas", "keys": "ids", "values": "names"},
    "seatAnchors": {"in": "vehicleSeats", "values": "attachments"},
    "movements": {"in": "speedModeNames"},
    "keybinds": {"in": "keybinds", "keys": "ids", "values": "keys"},
    "factions": {"in": "factionNames", "keys": "ids", "values": "names"},
    "interrupts": {"in": "interruptNames"},
    "phases": {"in": "visualPhases"},
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
