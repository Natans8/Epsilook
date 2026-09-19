"""A spell's effects, split into the payloads each one reaches.

An effect's misc value has no fixed meaning: the `Effect` or `EffectAura`
beside it decides which table the value indexes. The declaration is one read
of `SpellEffect` split into a branch per payload, each a selector saying
which values choose it and what the row's columns then hold, so adding a
payload is a branch there and a field on `SpellEffectRows`.

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

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from ..sources import load_local_enum, read_enum_names
from ..targets import NO_TARGET, implicit_target_bit
from . import catalogue as T
from .flow import Cell, Column, Rows, Schema, column_name, key_of, number_of

EFFECT_APPLY_AURA = 6
"""Applies an aura. Its implicit target says who ends up carrying it."""

EFFECT_ACTIVATE_OBJECT = 86
"""What the spell does to a gameobject: misc0 the action, misc1 the action's own parameter."""
EFFECT_SUMMON = 28
"""Summons a creature: misc0 is the creature, misc1 its `SummonProperties`."""

VALUE_MULTIPLIER_EFFECTS = frozenset(
    {
        8,  # POWER_DRAIN, the power gained per point drained
        9,  # HEALTH_LEECH, the health healed per point leeched
        41,  # JUMP, the jump's speed
        42,  # JUMP_DEST
        62,  # POWER_BURN, the damage per point burned
        213,  # JUMP_DEST_2
    }
)
"""The effects whose handler on the Epsilon core reads the value multiplier."""

VALUE_MULTIPLIER_AURAS = frozenset(
    {
        53,  # PERIODIC_LEECH
        62,  # PERIODIC_HEALTH_FUNNEL
        64,  # PERIODIC_MANA_LEECH
        97,  # MANA_SHIELD, the mana spent per point absorbed
        162,  # POWER_BURN
    }
)
"""The auras whose tick or absorb on the Epsilon core reads the value multiplier.

Every other row's value is unread, and some hold sentinels near 10**17 that
no reader could take for a multiplier.
"""

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

MISC0 = T.SpellEffect.EffectMiscValue[0]
MISC1 = T.SpellEffect.EffectMiscValue[1]
AMOUNT = T.SpellEffect.EffectBasePoints
"""The columns the selectors name."""

_HANDLERS = load_local_enum("spell_effect_handlers")
LAUNCH_EFFECTS = frozenset(
    effect for effect, held in _HANDLERS.items() if isinstance(held, dict) and held.get("phase") == "launch"
)
"""The effects the server only runs at launch, which sit at the launch phase
whatever the spell's speed: read off the vendored handler table."""

UNIMPLEMENTED_EFFECTS = frozenset(
    effect for effect, held in _HANDLERS.items() if isinstance(held, dict) and held.get("phase") == "unimplemented"
)
"""The effects the server has no handler for at all."""

_ATTRIBUTES = load_local_enum("spell_effect_attributes")
EFFECT_ATTRIBUTE_FLAGS: dict[str, int] = {
    str(held["handler"]): bit
    for bit, held in sorted(_ATTRIBUTES.items())
    if isinstance(held, dict) and held.get("handler")
}
"""The effect attribute bits that ship as flags, by the word each ships under.

Which bits ship is a declaration in the vendored file; the rest are a
vocabulary the pack carries and no claim about behaviour.
"""


def carries_attribute(attributes: int, bit: int) -> bool:
    """Whether an effect's attribute bits carry one bit."""
    return bool(attributes & (1 << bit))


def implicit_target_bits(version: str) -> Mapping[int, int]:
    """Resolve one build's implicit-target ids to target bits.

    The ids differ between builds, so they are read from that build's enum
    names rather than declared. Separate from the flow that consumes it, so
    the flow can be handed a mapping and tested without an enum file.

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


def tenth(cell: Cell) -> float:
    """An amount to a tenth, which drops the modern builds' float32 conversion noise."""
    return round(number_of(cell), 1)


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
    every: int = 0
    """`EffectAuraPeriod`: how often a periodic aura ticks, in milliseconds, or nought."""
    hops: int = 0
    """`EffectChainTargets`: how many further targets the effect chains to, or nought."""
    attributes: int = 0
    """`EffectAttributes`: the row's attribute bits, raw."""


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

    @property
    def named(self) -> frozenset[int]:
        """Every payload named, as the roster a flow narrows on."""
        return frozenset(payload for payloads in self.ids.values() for payload in payloads)

    def distinct(self) -> list[int]:
        """Every payload named, sorted and deduplicated.

        The row order each of these sections builds its parallel columns
        against, so it is derived once here rather than by each of them.
        """
        return sorted({payload for payloads in self.ids.values() for payload in payloads})


@dataclass(frozen=True)
class AsMasked:
    """The terminal a masked payload lands in: spell to the ids it reaches,
    each pair with the union of the masks its rows carried."""

    spell: str
    payload: str
    mask: str

    def taken(self) -> frozenset[str]:
        """The columns taken."""
        return frozenset({self.spell, self.payload, self.mask})

    def collect(self, rows: Rows, schema: Schema) -> MaskedIds:
        """The masked ids."""
        spell_at, payload_at, mask_at = schema.at(self.spell), schema.at(self.payload), schema.at(self.mask)
        found = MaskedIds()
        for row in rows:
            found.add(key_of(row[spell_at]), key_of(row[payload_at]), key_of(row[mask_at]))
        return found


def as_masked(spell: str | Column, payload: str | Column, mask: str | Column) -> AsMasked:
    """Land as the payload ids each spell reaches, masked by who the rows were aimed at."""
    return AsMasked(column_name(spell), column_name(payload), column_name(mask))


class EffectNumbers(NamedTuple):
    """What one effect carries beyond its amount and its misc columns, as the table stores it.

    Each default is the table's own, so an effect built from its key alone is
    one that carries nothing.
    """

    spell: int
    order: int
    """The effect's `EffectIndex`, from nought, as a mechanics row counts it."""
    mechanic: int = 0
    """A `SpellMechanic` id, or nought."""
    item: int = 0
    """The item the effect creates, or nought."""
    radius: int = 0
    """The `SpellRadius` id of the effect's radius, or nought."""
    max_radius: int = 0
    """The `SpellRadius` id of its maximum radius, or nought."""
    facing: float = 0.0
    """The facing an effect places something at, in radians."""
    chain: float = 1.0
    """What each further chained target's amount is multiplied by, one where it keeps the whole."""
    spell_power: float = 0.0
    """The share of spell power the amount adds."""
    attack_power: float = 0.0
    """The share of attack power the amount adds."""
    per_level: float = 0.0
    """What the amount gains per caster level."""
    per_resource: float = 0.0
    """What the amount gains per combo point or other spent resource."""
    pvp: float = 1.0
    """What the amount is multiplied by against players, one where it is unchanged."""
    variance: float = 0.0
    """How far the amount strays: a roll within half this fraction of it either way, nought where fixed."""


@dataclass
class SpellEffectRows:
    """Everything one pass over `SpellEffect` produces.

    Every field starts empty, so adding a payload is a field plus the branch
    that fills it, with no call site to keep in step.
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
    summon_targets: dict[tuple[int, int], int] = field(default_factory=dict)
    """Spell and creature to mask.

    Not a `MaskedIds` because the two halves are keyed differently: the id set
    carries the control word too, while the mask belongs to the creature alone,
    since one creature summoned under two control words is one chip.
    """
    activations: dict[int, set[tuple[int, int]]] = field(default_factory=dict)
    """Spell to the gameobject action and parameter pairs it performs."""
    activation_targets: dict[tuple[int, int, int], int] = field(default_factory=dict)
    """Spell, action and parameter to mask: each pair is its own row, aimed once."""
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
    numbers: list[EffectNumbers] = field(default_factory=list)
    """What each base-difficulty effect carries beyond its amount and its misc
    columns, sorted; an effect whose every value is the table's own default is
    left out."""
    multipliers: dict[tuple[int, int], float] = field(default_factory=dict)
    """Spell and effect index to the value multiplier, on the base-difficulty
    rows whose effect or aura the core reads it for: a drain's or a leech's
    return per point, a burn's damage per point, a mana shield's mana per point
    absorbed, a jump's speed."""
    mechanics: set[EffectRow] = field(default_factory=set)
    """Every distinct effect the spell has: the mechanics column's rows.

    A set, which collapses the per-difficulty copies `SpellEffect` ships while
    keeping genuinely distinct effects apart.
    """
    aura_target_bits: dict[int, int] = field(default_factory=dict)
    """Spell to the union over its apply-aura effects: who carries the aura."""
    cast_target_bits: dict[int, int] = field(default_factory=dict)
    """Spell to the union over all its effects: what the whole spell aims at."""
