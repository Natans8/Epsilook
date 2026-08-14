"""Creature displays, resolved for the two routes that show one.

A morph and a shapeshift form both name something the caster becomes, and both
reach a model the same way: through a display id, which resolves one table
further down. Flattening them here is what lets the pack ship a row rather than
a chain the app would have to walk again.

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

    morphs: list[Display] = field(default_factory=list)
    """Creature displays, in creature order then slot order.

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


def resolve_displays(effects: SpellEffectRows, creatures: CreatureModels,
                     forms: ShapeshiftForms) -> ResolvedDisplays:
    """Flatten both display routes to rows, dropping what cannot be named.

    Args:
        effects: the per-spell morph and form payloads.
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
    resolved.morphs = [
        Display(creature, display, creatures.fid_for_display(display))
        for creature in sorted(used_creatures)
        for _slot, display in creatures.displays.get(creature, ())]

    resolved.known_forms = {
        spell: surviving
        for spell, reached in effects.forms.ids.items()
        if (surviving := {form for form in reached if form in forms.names})}
    used_forms = {form for reached in resolved.known_forms.values()
                  for form in reached}
    resolved.forms = [
        Display(form, display, creatures.fid_for_display(display))
        for form in sorted(used_forms)
        for display in forms.displays.get(form, ())]
    return resolved
