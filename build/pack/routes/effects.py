"""A spell's effects, split into the payloads each one reaches.

An effect's misc value has no fixed meaning: the `Effect` or `EffectAura`
beside it decides which table the value indexes. Selectors are declared as a
map from value to bucket, so adding a payload is a line there and a field on
`SpellEffectRows`.

A value reaching a payload is marked consumed on its `EffectRow`, which keeps
it searchable while telling the renderer a dedicated pill already shows it.
`docs/DATA_ROUTES.md` documents what each payload means.

TODO: carry the raw misc values out of this route, so an axis over one is a
declaration rather than a rebuild. Blocked on the section registry.
"""

from __future__ import annotations

from collections.abc import Container, Mapping
from dataclasses import dataclass, field

from ..sources import read_enum_names
from ..tables import Tables
from ..targets import NO_TARGET, implicit_target_bit
from .columns import to_amount, to_int, to_int_from_float

EFFECT_APPLY_AURA = 6
"""Applies an aura. Its implicit target says who ends up carrying it."""

EFFECT_SUMMON = 28
"""Summons a creature: misc0 is the creature, misc1 its `SummonProperties`."""

EFFECT_PLAY_SOUND = 131
EFFECT_PLAY_MUSIC = 132
EFFECT_PLAYS_SOUND = frozenset({EFFECT_PLAY_SOUND, EFFECT_PLAY_MUSIC})
"""Plays a sound kit outright, with no visual behind it. misc0 is the kit."""

EFFECT_SPAWN_OBJECT = frozenset({
    50,   # TRANS_DOOR
    76,   # SUMMON_OBJECT_WILD
    104,  # SUMMON_OBJECT_SLOT1
    171,  # SUMMON_PERSONAL_GAMEOBJECT
})
"""Spawns a gameobject: misc0 is a `gameobject_template` entry.

The four differ in slot and lifetime, never in what the misc value means.
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

SPEED_AURAS = {
    31: "run", 129: "run", 171: "run",
    32: "mounted", 130: "mounted", 172: "mounted",
    58: "swim",
    206: "flight", 207: "flight", 208: "flight",
    209: "flight", 210: "flight", 211: "flight",
    33: "all",
}
"""The movement-speed auras, mapped to the movement each one scales.

The amount is a signed percentage and the sign is stored rather than derived,
because the aura name does not carry it: a decrease aura may hold a positive
value and an increase aura a negative one.
"""

SCALE_AURAS = frozenset({61, 239, 591})
"""The object-scale auras. The amount is a signed percentage.

One mechanic under three spellings: TrinityCore handles 61 and 239 together,
and 239 is spelled 591 on the newer Classic clients. No build carries both
spellings, so a set covers the drift without a per-version branch.
"""

ZERO_IS_A_VALUE = frozenset({AURA_MOD_INVISIBILITY, AURA_MOD_INVISIBILITY_DETECT})
"""Selectors whose misc0 of zero is data rather than "nothing named".

An invisibility channel of zero is general invisibility. Everywhere else the
misc value is a row id, where zero means the effect names nothing.
"""

SPELL_EFFECT_COLUMNS = [
    "SpellID", "Effect", "EffectAura",
    "EffectMiscValue_0", "EffectMiscValue_1",
    "ImplicitTarget_0", "ImplicitTarget_1",
    "EffectBasePoints", "EffectBasePointsF",
    "EffectTriggerSpell",
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
    return {target_id: bit
            for target_id, name in read_enum_names("Target", version).items()
            if (bit := implicit_target_bit(name))}


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

    effect_consumed: bool = False
    aura_consumed: bool = False
    """Whether that half reached a parsed pill of its own on this row.

    A consumed half stays here and stays searchable; the flag only says a
    dedicated pill already shows it, so drawing the raw one would say the same
    thing twice. Per row, so a value whose payload was dropped is unflagged and
    the raw pill remains the only thing that reports it.
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

    altnames: dict[int, set[int]] = field(default_factory=dict)
    """Spell to the override-name ids its auras carry.

    Unmasked: these resolve to text for the search corpus and never render, so
    who the spell was aimed at says nothing about them.
    """

    anim_sets: dict[int, set[int]] = field(default_factory=dict)
    """Spell to the animation-replacement sets its auras carry. Unmasked, since
    the swaps render as animation pills of their own."""

    summons: dict[int, set[tuple[int, int]]] = field(default_factory=dict)
    """Spell to the creature and summon-control pairs it summons."""

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


def read_summon_control(tables: Tables) -> dict[int, int]:
    """Read each `SummonProperties` row's control value.

    Args:
        tables: the source to read from.

    Returns:
        Summon-properties id to control value, which says whether the summon is
        a guardian, a pet, possessed, or uncontrolled.
    """
    return {to_int(row_id): to_int(control) for row_id, control
            in tables.rows("SummonProperties", ["ID", "Control"])}


def read_spell_effect_rows(tables: Tables, spell_names: Container[int],
                           screens: Container[int], keybounds: Container[int],
                           target_bits: Mapping[int, int]) -> SpellEffectRows:
    """Read `SpellEffect` once and split it into every payload it feeds.

    Args:
        tables: the source to read from.
        spell_names: the build's spell list; effects of anything absent from it
            are skipped.
        screens: the screen effects this build has. One it lacks is dropped
            rather than kept as a bare id, having nothing to show.
        keybounds: the key overrides this build has. The table trails its aura
            on the newest builds, so a missing one is dropped the same way.
        target_bits: implicit-target id to target bit, from
            `implicit_target_bits`.

    Returns:
        Every payload, with the mechanics rows left over after consumption.
    """
    rows = SpellEffectRows()
    control = read_summon_control(tables)

    # Where a misc value lands, by the aura or effect that gives it meaning.
    # The whole spell-to-payload map, readable in one place, and the extension
    # point the module docstring describes: promoting an unparsed aura to an
    # axis of its own is a field on SpellEffectRows and a line here.
    by_aura: dict[int, MaskedIds] = {
        AURA_TRANSFORM: rows.morphs,
        AURA_SHAPESHIFT: rows.forms,
        AURA_SCREEN_EFFECT: rows.screens,
        AURA_SET_VEHICLE_ID: rows.vehicles,
        AURA_MOD_INVISIBILITY: rows.invis,
        AURA_MOD_INVISIBILITY_DETECT: rows.detect,
        AURA_KEYBOUND_OVERRIDE: rows.keybinds,
    }
    by_effect: dict[int, MaskedIds] = {effect: rows.objects
                                       for effect in EFFECT_SPAWN_OBJECT}
    # These two render as something other than a chip of their own, so there is
    # no audience to record against them.
    unmasked_by_aura: dict[int, dict[int, set[int]]] = {
        AURA_OVERRIDE_NAME: rows.altnames,
        AURA_ANIM_REPLACEMENT_SET: rows.anim_sets,
    }
    # Payloads that must exist to be worth keeping, and where to ask.
    declared: dict[int, Container[int]] = {
        AURA_SCREEN_EFFECT: screens,
        AURA_KEYBOUND_OVERRIDE: keybounds,
    }

    for row in tables.rows("SpellEffect", SPELL_EFFECT_COLUMNS):
        spell = to_int(row[0])
        if spell not in spell_names:
            continue
        effect, aura = to_int(row[1]), to_int(row[2])
        misc0, misc1 = to_int_from_float(row[3]), to_int_from_float(row[4])
        first, second = to_int(row[5]), to_int(row[6])
        amount = to_amount(row[7], row[8])
        trigger = to_int(row[9])
        mask = target_bits.get(first, NO_TARGET) | target_bits.get(second, NO_TARGET)

        # A link the pack cannot name is dropped, because the chip is an icon
        # and a name and an unnameable one renders as a bare id. A self-link
        # goes too: a chip pointing at its own row.
        if trigger and trigger != spell and trigger in spell_names:
            rows.links.add((spell, trigger, effect, aura))
            key = (spell, trigger)
            rows.link_targets[key] = rows.link_targets.get(key, NO_TARGET) | mask

        # The whole-spell views resolve_target_mask reads: every effect, and
        # the apply-aura effects on their own.
        rows.cast_target_bits[spell] = \
            rows.cast_target_bits.get(spell, NO_TARGET) | mask
        if effect == EFFECT_APPLY_AURA:
            rows.aura_target_bits[spell] = \
                rows.aura_target_bits.get(spell, NO_TARGET) | mask

        # Each selector is asked separately rather than under one shared guard,
        # because a row's effect and its aura are independent and a roster
        # declared for one must not veto the other.
        names_something = misc0 > 0
        consumed_effect = consumed_aura = False
        if (plain := unmasked_by_aura.get(aura)) is not None and names_something:
            plain.setdefault(spell, set()).add(misc0)
            consumed_aura = True
        if (spawned := by_effect.get(effect)) is not None and names_something:
            spawned.add(spell, misc0, mask)
            consumed_effect = True
        if (bucket := by_aura.get(aura)) is not None:
            roster = declared.get(aura)
            if (names_something or aura in ZERO_IS_A_VALUE) \
                    and (roster is None or misc0 in roster):
                bucket.add(spell, misc0, mask)
                consumed_aura = True

        if effect == EFFECT_SUMMON and misc0 > 0:
            rows.summons.setdefault(spell, set()).add((misc0, control.get(misc1, 0)))
            key = (spell, misc0)
            rows.summon_targets[key] = \
                rows.summon_targets.get(key, NO_TARGET) | mask
            consumed_effect = True
        if effect in EFFECT_PLAYS_SOUND and misc0 > 0:
            key = (spell, misc0)
            rows.sounds[key] = rows.sounds.get(key, NO_TARGET) | mask
            consumed_effect = True

        # Speed and scale carry a NUMBER rather than a reference, and A ZERO
        # AMOUNT IS DROPPED for both. These pills are made of nothing but the
        # number, so a "+0%" one promises a change and delivers none, and it
        # drags the spell into fx:speed and fx:scale counts it does not belong
        # in. The amount is genuinely elsewhere on those rows -- a talent, the
        # morph the spell applies, a script -- and nothing in the pack can
        # reach it. What survives is the mechanics row, which still carries the
        # aura: "has a speed aura at all" is a question with a home, and this
        # is not it.
        if amount and (movement := SPEED_AURAS.get(aura)) is not None:
            rows.speeds.setdefault(spell, set()).add((movement, amount))
            change = (spell, movement, amount)
            rows.speed_targets[change] = \
                rows.speed_targets.get(change, NO_TARGET) | mask
            consumed_aura = True
        if amount and aura in SCALE_AURAS:
            rows.scales.setdefault(spell, set()).add(amount)
            sized = (spell, amount)
            rows.scale_targets[sized] = \
                rows.scale_targets.get(sized, NO_TARGET) | mask
            consumed_aura = True

        # The row is recorded whole whether or not either half was consumed, so
        # every effect and aura the spell has stays searchable. The flags say
        # only that a dedicated pill already shows that half. Decided by what
        # this row produced rather than by a second list of consumed values, so
        # a new axis flags its own selector the moment it is declared above.
        if effect or aura:
            rows.mechanics.add(EffectRow(spell, effect, aura, first, second,
                                         consumed_effect, consumed_aura))
    return rows
