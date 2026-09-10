"""A spell's effects, split into the payloads each one reaches.

An effect's misc value has no fixed meaning: the `Effect` or `EffectAura`
beside it decides which table the value indexes. Selectors are declared as a
map from value to bucket, so adding a payload is a line there and a field on
`SpellEffectRows`.

A value reaching a payload is marked consumed on its `EffectRow`, which keeps
it searchable while telling the renderer a dedicated pill already shows it.
`docs/DATA_ROUTES.md` documents what each payload means.

The raw misc values travel out with the row. Their meaning is a function of
the effect or aura beside them, which is knowledge the app already has, so
shipping the number turns a future axis over one into a declaration instead of
a rebuild. It is not a skeleton key: many of them are ids into tables the pack
does not carry, so an axis a person would search BY NAME still needs its own
vocabulary shipped.
"""

from __future__ import annotations

from collections.abc import Callable, Container, Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from ..drift import RETIRED_SPAWN_OBJECT_EFFECTS, SPAWN_OBJECT_SLOTS_UNTIL
from ..sources import read_enum_names
from ..tables import Tables
from ..targets import NO_TARGET, implicit_target_bit
from .columns import to_amount, to_int, to_int_from_float
from .flow import Holds, Slot, When, amount, reference, vocabulary, when

EFFECT_APPLY_AURA = 6
"""Applies an aura. Its implicit target says who ends up carrying it."""

EFFECT_SUMMON = 28
"""Summons a creature: misc0 is the creature, misc1 its `SummonProperties`."""

EFFECT_PLAY_SOUND = 131
EFFECT_PLAY_MUSIC = 132
EFFECT_PLAYS_SOUND = frozenset({EFFECT_PLAY_SOUND, EFFECT_PLAY_MUSIC})
"""Plays a sound kit outright, with no visual behind it. misc0 is the kit."""

EFFECT_SPAWN_OBJECT = frozenset(
    {
        50,  # TRANS_DOOR
        76,  # SUMMON_OBJECT_WILD
        104,  # SUMMON_OBJECT_SLOT1
        171,  # SUMMON_PERSONAL_GAMEOBJECT
    }
)
"""Spawns a gameobject: misc0 is a `gameobject_template` entry.

The four differ in slot and lifetime, never in what the misc value means.

Slots 2 to 4 spawn one too, on the builds where they still mean that; their
ids are `RETIRED_SPAWN_OBJECT_EFFECTS`, declared apart because what they
select depends on the build being packed.
"""

AURA_MOD_INVISIBILITY = 18
AURA_MOD_INVISIBILITY_DETECT = 19
"""Hides a unit, and sees into the hiding place. misc0 is a channel.

A detect aura reveals a hide aura on the same channel, so the number pairs the
two. A spell may carry both, so they are read independently.
"""

AURA_SHAPESHIFT = 36
"""misc0 is a `SpellShapeshiftForm`."""

AURA_TRANSFORM = 56
"""misc0 is a creature id: the server-side entry, not a display id."""

AURA_SCREEN_EFFECT = 260
"""misc0 is a `ScreenEffect`."""

AURA_SET_VEHICLE_ID = 296
"""misc0 is a `Vehicle`."""

AURA_ANIM_REPLACEMENT_SET = 312
"""misc0 is an `AnimReplacementSet`."""

AURA_OVERRIDE_NAME = 370
"""misc0 is a `SpellOverrideName`: what the spell renames its target to."""

AURA_KEYBOUND_OVERRIDE = 406
"""misc0 is a `SpellKeyboundOverride`."""

AURA_MOD_FACTION = 243
"""misc0 is a `FactionTemplate`: what the target's faction becomes.

A template rather than a faction, because that is what the client sets; the
template's own faction is the name a reader is after, and its group is what
tells nine templates named Monster apart.
"""

SPEED_AURAS = {
    31: "run",
    129: "run",
    171: "run",
    32: "mounted",
    130: "mounted",
    172: "mounted",
    58: "swim",
    206: "flight",
    207: "flight",
    208: "flight",
    209: "flight",
    210: "flight",
    211: "flight",
    33: "all",
}
"""The movement-speed auras, mapped to the movement each one scales.

The amount is a signed percentage and the sign is stored rather than derived,
because the aura name does not carry it: a decrease aura may hold a positive
value and an increase aura a negative one.
"""

MOVEMENT_NAMES: tuple[str, ...] = tuple(sorted(set(SPEED_AURAS.values())))
"""The movements, in the order a row stores them by.

Read off the aura map rather than listed again, so a movement added there gets
its number here with nothing to keep in step. Sorted rather than first-seen,
because the aura map is written by aura id and a row's stored number must not
change when an unrelated aura is added above it.
"""

SCALE_AURAS = frozenset({61, 239, 591})
"""The object-scale auras. The amount is a signed percentage.

One mechanic under three spellings: TrinityCore handles 61 and 239 together,
and 239 is spelled 591 on the newer Classic clients. No build carries both
spellings, so a set covers the drift without a per-version branch.
"""


SPELL_EFFECT_COLUMNS = [
    "SpellID",
    "Effect",
    "EffectAura",
    "EffectMiscValue_0",
    "EffectMiscValue_1",
    "ImplicitTarget_0",
    "ImplicitTarget_1",
    "EffectBasePoints",
    "EffectBasePointsF",
    "EffectTriggerSpell",
    "EffectIndex",
]
"""The columns this route reads, in the order it unpacks them.

The row id is absent because nothing needs it: the provider merges revisions
in-stream, so there is no buffer to key.
"""


def implicit_target_bits(version: str) -> Mapping[int, int]:
    """Resolve one build's implicit-target ids to target bits.

    The ids differ between builds, so they are read from that build's enum
    names rather than declared. Separate from the reader that consumes it, so
    the reader can be handed a mapping and tested without an enum file.

    Args:
        version: the build whose enum names to read.

    Returns:
        Implicit-target id to target bit, omitting the ids that name no anchor.
    """
    return {
        target_id: bit
        for target_id, name in read_enum_names("Target", version).items()
        if (bit := implicit_target_bit(name))
    }


@dataclass(frozen=True)
class EffectRow:
    """One of a spell's effects: what it does, and who it is aimed at.

    Per effect rather than per spell, because a search scope binds its axes to
    one row: `mech:{JUMP_DEST target:target}` must mean a single effect that is
    both, not two effects that are one each. Further per-effect columns belong
    here for the same reason.
    """

    spell: int
    effect: int
    aura: int
    target_a: int
    target_b: int
    """The row's two implicit-target columns, unresolved and kept apart."""

    misc_a: int = 0
    misc_b: int = 0
    """The row's two misc values, raw.

    Meaningless on their own -- what they refer to is decided by the effect or
    aura on the same row -- which is exactly why they are carried rather than
    interpreted here. Every payload this route decodes reads one of these, and
    throwing the number away afterwards is what made each new axis over one a
    format bump.
    """

    effect_consumed: bool = False
    aura_consumed: bool = False
    """Whether that half reached a parsed pill of its own on this row.

    A consumed half stays here and stays searchable; the flag only says a
    dedicated pill already shows it, so drawing the raw one would say the same
    thing twice. Per row, so a value whose payload was dropped is unflagged and
    the raw pill remains the only thing that reports it.
    """

    order: int = 0
    """`EffectIndex`: the effect's order among the spell's, from nought.

    The order the effects happen in once the spell lands, which is the one
    sequence the effect rows carry of their own.
    """


@dataclass
class MaskedIds:
    """Payload ids per spell, each with the audience it was aimed at.

    One value rather than two parallel maps, which are always written and read
    together and can otherwise fall out of step - an id with no mask, or a mask
    for an id nothing recorded.
    """

    ids: dict[int, set[int]] = field(default_factory=dict)
    """Spell to the payload ids it reaches."""

    masks: dict[tuple[int, int], int] = field(default_factory=dict)
    """Spell and payload to the union of the masks that produced the pair.

    Keyed on the pair because the pair is what becomes a chip: a spell reaching
    two creatures aims at each of them separately.
    """

    def add(self, spell: int, payload: int, mask: int) -> None:
        """Record one payload, unioning its mask onto any already there.

        Several effect rows commonly produce the same pair, and each says who
        its own row was aimed at, so their audiences accumulate.
        """
        self.ids.setdefault(spell, set()).add(payload)
        key = (spell, payload)
        self.masks[key] = self.masks.get(key, NO_TARGET) | mask

    def distinct(self) -> list[int]:
        """Every payload named, sorted and deduplicated.

        The row order each of these sections builds its parallel columns
        against, so it is derived once here rather than by each of them.
        """
        return sorted({payload for payloads in self.ids.values() for payload in payloads})


@dataclass
class SpellEffectRows:
    """Everything one pass over `SpellEffect` produces.

    Every field starts empty, so adding a payload is a field plus the line that
    fills it, with no call site to keep in step.
    """

    morphs: MaskedIds = field(default_factory=MaskedIds)
    """Creature ids the spell turns its target into."""

    forms: MaskedIds = field(default_factory=MaskedIds)
    """Shapeshift forms it puts its target in."""

    objects: MaskedIds = field(default_factory=MaskedIds)
    """GameObject entries it spawns."""

    screens: MaskedIds = field(default_factory=MaskedIds)
    """Screen effects it grades the frame with."""

    vehicles: MaskedIds = field(default_factory=MaskedIds)
    """Vehicles it seats its target in."""

    invis: MaskedIds = field(default_factory=MaskedIds)
    """Invisibility channels it hides its target in."""

    detect: MaskedIds = field(default_factory=MaskedIds)
    """Invisibility channels it lets its target see into."""

    keybinds: MaskedIds = field(default_factory=MaskedIds)
    """Key overrides it applies."""

    factions: MaskedIds = field(default_factory=MaskedIds)
    """Faction templates it sets its target to."""

    altnames: dict[int, set[int]] = field(default_factory=dict)
    """Spell to the override-name ids its auras carry.

    Unmasked: these resolve to text for the search corpus and never render, so
    who the spell was aimed at says nothing about them.
    """

    anim_sets: MaskedIds = field(default_factory=MaskedIds)
    """Spell to the animation-replacement sets its auras carry, and who the
    aura carrying each was aimed at.

    The swaps render as animation pills of their own, which is why the mask
    went unread for a long time; it is carried because a replacement row can
    be asked who it plays on like any other row.
    """

    summons: dict[int, set[tuple[int, int]]] = field(default_factory=dict)
    """Spell to the creature and summon-control pairs it summons."""

    summon_controls: dict[int, int] = field(default_factory=dict)
    """Summon-properties id to its control value, read once for the summons
    to resolve their second slot through."""

    summon_targets: dict[tuple[int, int], int] = field(default_factory=dict)
    """Spell and creature to mask.

    Not a `MaskedIds` because the two halves are keyed differently: the id set
    carries the control word too, while the mask belongs to the creature alone,
    since one creature summoned under two control words is one chip.
    """

    sounds: dict[tuple[int, int], int] = field(default_factory=dict)
    """Spell and sound kit to mask, for the effects that play a sound.

    A mask with no id set, because these merge into the sound column where the
    kits reached through visuals already live.
    """

    speeds: dict[int, set[tuple[str, float]]] = field(default_factory=dict)
    """Spell to the movement and percentage changes its auras make."""

    speed_targets: dict[tuple[int, str, float], int] = field(default_factory=dict)
    """Spell, movement and percentage to mask, keyed on the whole change
    because that is what one speed pill shows."""

    scales: dict[int, set[float]] = field(default_factory=dict)
    """Spell to the size changes its auras make, as percentages."""

    scale_targets: dict[tuple[int, float], int] = field(default_factory=dict)
    """Spell and percentage to mask; a scale pill is the percentage alone."""

    links: set[tuple[int, int, int, int]] = field(default_factory=set)
    """Source, target, effect and aura: the edges between two spells.

    Stored raw, because naming an edge needs the enum tables that belong to
    whoever assembles the pack. One direction only; the reverse index is
    derived in the browser.
    """

    link_targets: dict[tuple[int, int], int] = field(default_factory=dict)
    """Source and triggered spell to mask.

    An edge is itself an effect row, so its implicit targets say who the
    triggering effect aimed at. Keyed on the pair alone, because a spell
    reached two ways is one chip whose icons are the union.
    """

    mechanics: set[EffectRow] = field(default_factory=set)
    """Every distinct effect the spell has: the mechanics column's rows.

    A set, which collapses the per-difficulty copies `SpellEffect` ships while
    keeping genuinely distinct effects apart.
    """

    aura_target_bits: dict[int, int] = field(default_factory=dict)
    """Spell to the union over its apply-aura effects: who carries the aura."""

    cast_target_bits: dict[int, int] = field(default_factory=dict)
    """Spell to the union over all its effects: what the whole spell aims at."""


class Values(NamedTuple):
    """What the reader decoded off one effect row, for a payload's record.

    Every column a selector's slots can name arrives here already read, so a
    record picks what its declaration says it holds and reads nothing itself.
    """

    effect: int
    aura: int
    misc0: int
    misc1: int
    amount: float
    """The row's amount, in whichever of the two spellings this build exports."""

    trigger: int


Record = Callable[[SpellEffectRows, int, Values, int], bool]
"""Where a selected row's values land: the bundle, the spell, the values, the
mask; and whether anything was recorded, which is what consumes the row."""

SLOT_VALUES: Mapping[str, str] = {
    "EffectMiscValue_0": "misc0",
    "EffectMiscValue_1": "misc1",
    "EffectBasePoints": "amount",
    "EffectTriggerSpell": "trigger",
}
"""Which decoded value each column a slot can name arrives as."""


@dataclass(frozen=True)
class Payload:
    """One selected meaning of an effect row, and where it lands.

    The `select` is the declaration: which selector column, which values,
    what each named column then holds. The rest is the reader's wiring for
    it. A payload holding one reference needs no record of its own, since the
    slot says which value it is and the bundle field says where it goes.
    """

    select: When
    into: Callable[[SpellEffectRows], MaskedIds | dict[int, set[int]]] | None = None
    """Which bundle field a single reference lands in."""

    record: Record | None = None
    """Where several slots, or an amount, land; written where one reference
    into one field does not describe it."""

    roster: str = ""
    """Names the roster this payload must appear in to be kept, or empty.

    The name is a key into the rosters the reader is handed, so a payload that
    needs narrowing declares it here rather than adding a parameter.
    """

    @property
    def reference(self) -> Slot:
        """The one slot a default record lands, for a payload declaring no record.

        Raises:
            ValueError: the payload declares no record and not exactly one
                slot holding a reference or a vocabulary value.
        """
        slots = [slot for slot in self.select.slots if slot.holds is not Holds.AMOUNT]
        if len(self.select.slots) != 1 or len(slots) != 1:
            raise ValueError(f"a payload with {len(self.select.slots)} slots needs a record saying where they land")
        return slots[0]


def _summon(rows: SpellEffectRows, spell: int, values: Values, mask: int) -> bool:
    """A creature and how it is controlled, aimed by the creature alone."""
    rows.summons.setdefault(spell, set()).add((values.misc0, rows.summon_controls.get(values.misc1, 0)))
    key = (spell, values.misc0)
    rows.summon_targets[key] = rows.summon_targets.get(key, NO_TARGET) | mask
    return True


def _played_sound(rows: SpellEffectRows, spell: int, values: Values, mask: int) -> bool:
    """A kit played outright, which merges into the sound column later."""
    key = (spell, values.misc0)
    rows.sounds[key] = rows.sounds.get(key, NO_TARGET) | mask
    return True


def _speed(rows: SpellEffectRows, spell: int, values: Values, mask: int) -> bool:
    """A movement scaled by a signed percentage.

    A zero amount is dropped: a pill made of nothing but the number would
    promise a change and deliver none, and drag the spell into counts it does
    not belong in. The mechanics row still carries the aura, unconsumed.
    """
    if not values.amount:
        return False
    movement = SPEED_AURAS[values.aura]
    rows.speeds.setdefault(spell, set()).add((movement, values.amount))
    change = (spell, movement, values.amount)
    rows.speed_targets[change] = rows.speed_targets.get(change, NO_TARGET) | mask
    return True


def _scale(rows: SpellEffectRows, spell: int, values: Values, mask: int) -> bool:
    """A size change, as a signed percentage; zero is dropped as a speed is."""
    if not values.amount:
        return False
    rows.scales.setdefault(spell, set()).add(values.amount)
    sized = (spell, values.amount)
    rows.scale_targets[sized] = rows.scale_targets.get(sized, NO_TARGET) | mask
    return True


MISC0 = "EffectMiscValue_0"
MISC1 = "EffectMiscValue_1"
AMOUNT = "EffectBasePoints"
"""The columns the selectors below name."""

PAYLOADS: tuple[Payload, ...] = (
    Payload(when("EffectAura", AURA_TRANSFORM, [reference(MISC0, "creature_template")]), lambda rows: rows.morphs),
    Payload(when("EffectAura", AURA_SHAPESHIFT, [reference(MISC0, "SpellShapeshiftForm")]), lambda rows: rows.forms),
    Payload(when("EffectAura", AURA_SET_VEHICLE_ID, [reference(MISC0, "Vehicle")]), lambda rows: rows.vehicles),
    Payload(
        when("EffectAura", AURA_MOD_INVISIBILITY, [vocabulary(MISC0, "channels", zero_is_a_value=True)]),
        lambda rows: rows.invis,
    ),
    Payload(
        when("EffectAura", AURA_MOD_INVISIBILITY_DETECT, [vocabulary(MISC0, "channels", zero_is_a_value=True)]),
        lambda rows: rows.detect,
    ),
    Payload(
        when("EffectAura", AURA_SCREEN_EFFECT, [reference(MISC0, "ScreenEffect")]),
        lambda rows: rows.screens,
        roster="screens",
    ),
    Payload(
        when("EffectAura", AURA_KEYBOUND_OVERRIDE, [reference(MISC0, "SpellKeyboundOverride")]),
        lambda rows: rows.keybinds,
        roster="keybounds",
    ),
    Payload(
        when("EffectAura", AURA_OVERRIDE_NAME, [reference(MISC0, "SpellOverrideName")]), lambda rows: rows.altnames
    ),
    Payload(
        when("EffectAura", AURA_ANIM_REPLACEMENT_SET, [reference(MISC0, "AnimReplacementSet")]),
        lambda rows: rows.anim_sets,
    ),
    Payload(when("EffectAura", AURA_MOD_FACTION, [reference(MISC0, "FactionTemplate")]), lambda rows: rows.factions),
    Payload(
        when("Effect", sorted(EFFECT_SPAWN_OBJECT), [reference(MISC0, "gameobject_template")]),
        lambda rows: rows.objects,
    ),
    # The three slots the game later handed to other effects: a gameobject
    # entry through Wrath, and something else from the patch that reused them.
    Payload(
        when(
            "Effect",
            sorted(RETIRED_SPAWN_OBJECT_EFFECTS),
            [reference(MISC0, "gameobject_template")],
            until=SPAWN_OBJECT_SLOTS_UNTIL,
        ),
        lambda rows: rows.objects,
    ),
    Payload(
        when("Effect", EFFECT_SUMMON, [reference(MISC0, "creature_template"), reference(MISC1, "SummonProperties")]),
        record=_summon,
    ),
    Payload(when("Effect", sorted(EFFECT_PLAYS_SOUND), [reference(MISC0, "SoundKit")]), record=_played_sound),
    Payload(when("EffectAura", sorted(SPEED_AURAS), [amount(AMOUNT)]), record=_speed),
    Payload(when("EffectAura", sorted(SCALE_AURAS), [amount(AMOUNT)]), record=_scale),
)
"""Every meaning an effect row's columns take, declared once.

A selector column and a value choose the meaning, and the slots say what the
row's other columns then hold: a reference into a table, a value a vocabulary
names, a number. The reader dispatches off these, the shipped selector table
is read off these, and adding a payload is a row here plus the field it lands
in. The link through the trigger column is not here, because nothing selects
it: every row carries it.
"""

EFFECT_SELECTORS: tuple[When, ...] = tuple(payload.select for payload in PAYLOADS)
"""The declarations alone, for the table the pack ships."""


def _record(
    payload: Payload | None,
    rows: SpellEffectRows,
    spell: int,
    values: Values,
    mask: int,
    rosters: Mapping[str, Container[int]],
) -> bool:
    """Record one row's values against the payload its selector chose.

    Args:
        payload: the declaration the selector matched, or None for a selector
            no payload claims.
        rows: the bundle being filled.
        spell: the spell whose effect this is.
        values: what the reader decoded off the row.
        mask: who the row was aimed at.
        rosters: the payloads narrowed to what this build has, by roster name.

    Returns:
        Whether the value was recorded, which is what consumes the selector.
    """
    if payload is None:
        return False
    # A reference of nought names no row unless the slot says nought is data,
    # and that holds for every slot whichever record the payload lands in.
    for slot in payload.select.slots:
        if slot.holds is Holds.AMOUNT or slot.zero_is_a_value:
            continue
        if getattr(values, SLOT_VALUES[slot.column]) <= 0:
            return False
    if payload.record is not None:
        return payload.record(rows, spell, values, mask)
    misc = getattr(values, SLOT_VALUES[payload.reference.column])
    roster = rosters.get(payload.roster) if payload.roster else None
    if roster is not None and misc not in roster:
        return False
    if payload.into is None:
        raise ValueError(f"the payload on {payload.select.on} {payload.select.values} lands nowhere")
    into = payload.into(rows)
    if isinstance(into, MaskedIds):
        into.add(spell, misc, mask)
    else:
        into.setdefault(spell, set()).add(misc)
    return True


def read_summon_control(tables: Tables) -> dict[int, int]:
    """Read each `SummonProperties` row's control value.

    Args:
        tables: the source to read from.

    Returns:
        Summon-properties id to control value, which says whether the summon is
        a guardian, a pet, possessed, or uncontrolled.
    """
    return {to_int(row_id): to_int(control) for row_id, control in tables.rows("SummonProperties", ["ID", "Control"])}


def read_spell_effect_rows(
    tables: Tables,
    spell_names: Container[int],
    rosters: Mapping[str, Container[int]],
    target_bits: Mapping[int, int],
    version: str,
) -> SpellEffectRows:
    """Read `SpellEffect` once and split it into every payload it feeds.

    Args:
        tables: the source to read from.
        spell_names: the build's spell list; effects of anything absent from it
            are skipped.
        rosters: what each roster-narrowed payload may reference on this build,
            keyed by the name its declaration gives. A payload naming a roster
            drops a misc value the roster does not contain, because a screen
            effect or key override the build lacks has nothing to show.
        target_bits: implicit-target id to target bit, from
            `implicit_target_bits`.
        version: the build being packed, which decides whether a selector a
            later patch retired still holds.

    Returns:
        Every payload, with the mechanics rows left over after consumption.

    Raises:
        KeyError: if a declaration names a roster the caller did not supply,
            which would otherwise keep every row of that payload silently.
    """
    rows = SpellEffectRows()
    rows.summon_controls = read_summon_control(tables)
    if missing := {p.roster for p in PAYLOADS if p.roster} - set(rosters):
        raise KeyError(f"PAYLOADS names rosters nobody supplied: {sorted(missing)}")
    live = [p for p in PAYLOADS if p.select.holds(version)]
    by_aura = {value: p for p in live if p.select.on == "EffectAura" for value in p.select.values}
    by_effect = {value: p for p in live if p.select.on == "Effect" for value in p.select.values}

    for row in tables.rows("SpellEffect", SPELL_EFFECT_COLUMNS):
        spell = to_int(row[0])
        if spell not in spell_names:
            continue
        effect, aura = to_int(row[1]), to_int(row[2])
        misc0, misc1 = to_int_from_float(row[3]), to_int_from_float(row[4])
        first, second = to_int(row[5]), to_int(row[6])
        trigger = to_int(row[9])
        mask = target_bits.get(first, NO_TARGET) | target_bits.get(second, NO_TARGET)
        values = Values(effect, aura, misc0, misc1, to_amount(row[7], row[8]), trigger)

        # A link the pack cannot name is dropped, because the chip is an icon
        # and a name and an unnameable one renders as a bare id. A self-link
        # goes too: a chip pointing at its own row.
        if trigger and trigger != spell and trigger in spell_names:
            rows.links.add((spell, trigger, effect, aura))
            key = (spell, trigger)
            rows.link_targets[key] = rows.link_targets.get(key, NO_TARGET) | mask

        # The whole-spell views resolve_target_bit reads: every effect, and
        # the apply-aura effects on their own.
        rows.cast_target_bits[spell] = rows.cast_target_bits.get(spell, NO_TARGET) | mask
        if effect == EFFECT_APPLY_AURA:
            rows.aura_target_bits[spell] = rows.aura_target_bits.get(spell, NO_TARGET) | mask

        # The two selectors are asked separately rather than under one shared
        # guard, because a row's effect and its aura are independent and a
        # roster declared for one must not veto the other.
        consumed_aura = _record(by_aura.get(aura), rows, spell, values, mask, rosters)
        consumed_effect = _record(by_effect.get(effect), rows, spell, values, mask, rosters)

        # The row is recorded whole whether or not either half was consumed, so
        # every effect and aura the spell has stays searchable. The flags say
        # only that a dedicated pill already shows that half. Decided by what
        # this row produced rather than by a second list of consumed values, so
        # a new axis flags its own selector the moment it is declared above.
        if effect or aura:
            rows.mechanics.add(
                EffectRow(
                    spell, effect, aura, first, second, misc0, misc1, consumed_effect, consumed_aura, to_int(row[10])
                )
            )
    return rows
