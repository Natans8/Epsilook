"""The description templates, cooked to the prose the pack ships.

A derivation and not a route: its inputs are what four routes produced -- the
templates, the numbers they ask for, their variables, and the spell list -- and
it reads no table of its own. `spelltext.py` beside it is the language; this is
the pass that runs it over one build.

Only spells the pack lists are cooked. A template routinely redirects to a
spell that has no name row, which is why the templates themselves are read
unfiltered: the redirect target has to be resolvable even though it never ships
a description of its own.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from ..progress import log
from ..routes import SpellNames, SpellText
from ..routes.values import DescriptionValues
from .spelltext import ENGLISH, DescriptionCooker, TextLocale


@dataclass
class CookedText:
    """Every body of prose a spell carries, placeholder-free.

    Three bodies rather than one because they answer different questions: what
    the cast does, what the buff says while it is on you, and what the dungeon
    journal notes about the ability. They are one axis to search and three
    facts to hold.
    """

    descriptions: dict[int, str] = field(default_factory=dict)
    """What the tooltip says the cast does."""

    auras: dict[int, str] = field(default_factory=dict)
    """What the buff says while it is on you -- often the only claim written,
    and the half that names the state a roleplayer is after."""

    encounters: dict[int, str] = field(default_factory=dict)
    """The dungeon journal's separate note on a boss ability."""

    resolved: int = 0
    """Values the cooker substituted."""

    elided: int = 0
    """Values it could not justify and left out.

    Kept because it is the measure of the cooker's one rule: a number this data
    cannot justify is dropped rather than guessed, and a run where this fell to
    zero would mean the rule had stopped firing.
    """


def cook_text(templates: SpellText, values: DescriptionValues, names: SpellNames,
              locale: TextLocale = ENGLISH) -> CookedText:
    """Cook every template belonging to a spell the pack lists.

    Args:
        templates: the raw templates and the variables they read.
        values: the numbers a template can ask for.
        names: the spell list, and the names templates print.
        locale: which language's grammar the cooker writes.

    Returns:
        The three cooked bodies, holding only spells whose template cooked to
        something. A template that resolves to nothing is not a spell with an
        empty description: it is a spell with none.
    """
    cooker = DescriptionCooker(templates.descriptions, templates.auras,
                               names.names, values, templates.variables, locale)

    def cooked(source: Mapping[int, str]) -> dict[int, str]:
        return {spell: prose for spell, template in source.items()
                if spell in names.names and (prose := cooker.cook(spell, template))}

    text = CookedText(descriptions=cooked(templates.descriptions),
                      auras=cooked(templates.auras),
                      encounters=cooked(templates.notes))
    text.resolved = cooker.stats["resolved"]
    text.elided = cooker.stats["elided"]
    log(f"  {len(text.descriptions):,} descriptions, {len(text.auras):,} aura "
        f"texts, {len(text.encounters):,} encounter notes "
        f"({text.resolved:,} values resolved, {text.elided:,} elided)")
    return text
