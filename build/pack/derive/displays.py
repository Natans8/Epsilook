"""Creature displays, resolved for the routes that show one.

A morph, a summon and a shapeshift form all name something that appears -- the
caster becomes it, or it is called up beside them -- and all reach a model the
same way: through a display id, which resolves one table further down.
Flattening them here is what lets the pack ship a row rather than a chain the
app would have to walk again. A creature is one thing whichever effect names
it, so the morph and summon routes land in one list keyed by the creature.

A payload the build has no row for is dropped rather than shipped nameless,
which is the same rule the dissolve and screen routes follow: a pill made of
nothing has nothing to say.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..routes import CreatureModels, ShapeshiftForms, SpellEffectRows


@dataclass(frozen=True)
class Display:
    """One thing a spell turns its target into, and the model it wears."""

    subject: int
    """The creature entry or shapeshift form."""

    display: int
    """The display id it was reached through."""

    fid: int
    """The model file, or zero where the display resolves to none."""


@dataclass
class ResolvedDisplays:
    """Every display the morph and form routes reach, flattened to rows."""

    creatures: list[Display] = field(default_factory=list)
    """Creature displays, for every creature a morph or a summon names, in
    creature order then slot order.

    A creature can carry several, and the first is the one the pill shows.
    """

    forms: list[Display] = field(default_factory=list)
    """Shapeshift form displays, in form order."""

    known_forms: dict[int, set[int]] = field(default_factory=dict)
    """Spell to the forms that survived, for the pill that names them.

    Returned rather than pruned in place: the effect rows are a route's output,
    and a derivation that edited them would leave the two disagreeing about
    what the build found.
    """


def totem_displays(effects: SpellEffectRows, creatures: CreatureModels) -> dict[int, tuple[int, ...]]:
    """The per-race displays each summoned totem gains, keyed by its creature.

    The table keys on the spell and the pack keys a display row on the
    creature, so the summon edge is what carries one to the other. A spell
    summoning several creatures gives its displays to each, which no shipped
    totem spell does.
    """
    gained: dict[int, list[int]] = {}
    for spell, displays in creatures.totem_displays.items():
        for creature, _control in effects.summons.get(spell, ()):
            gained.setdefault(creature, []).extend(displays)
    return {creature: tuple(dict.fromkeys(displays)) for creature, displays in gained.items()}


def _reached_displays(creature: int, creatures: CreatureModels, extra: dict[int, tuple[int, ...]]) -> list[int]:
    """A creature's own displays in slot order, then the totem ones it gained.

    Slot order first keeps the display the pill already showed in front, so
    adding the others changes what a row carries and not what it leads with.

    The creature's own list is passed through untouched, duplicates included: a
    display named in two slots has always been two rows, and collapsing it here
    would silently move a count in every pack for a reason that has nothing to
    do with totems. Only the gained displays are filtered, against what the
    creature already wears.
    """
    own = [display for _slot, display in creatures.displays.get(creature, ())]
    seen = set(own)
    return [*own, *(display for display in extra.get(creature, ()) if display not in seen)]


def resolve_displays(effects: SpellEffectRows, creatures: CreatureModels, forms: ShapeshiftForms) -> ResolvedDisplays:
    """Flatten both display routes to rows, dropping what cannot be named.

    Args:
        effects: the per-spell morph, summon and form payloads.
        creatures: the display-to-model tables.
        forms: the shapeshift forms this build has, and what they wear. A
            spell naming a form absent from it keeps its others and loses that
            one.

    Returns:
        Both row lists, and the surviving forms per spell. A form with no
        display keeps its name and renders as a name-only pill, so it survives
        with no row here.
    """
    resolved = ResolvedDisplays()

    used_creatures = {c for reached in effects.morphs.ids.values() for c in reached}
    used_creatures.update(creature for summoned in effects.summons.values() for creature, _control in summoned)
    extra = totem_displays(effects, creatures)
    resolved.creatures = [
        Display(creature, display, creatures.fid_for_display(display))
        for creature in sorted(used_creatures)
        for display in _reached_displays(creature, creatures, extra)
    ]

    resolved.known_forms = {
        spell: surviving
        for spell, reached in effects.forms.ids.items()
        if (surviving := {form for form in reached if form in forms.names})
    }
    used_forms = {form for reached in resolved.known_forms.values() for form in reached}
    resolved.forms = [
        Display(form, display, creatures.fid_for_display(display))
        for form in sorted(used_forms)
        for display in forms.displays.get(form, ())
    ]
    return resolved
