"""The prose a spell carries: descriptions, their variables, encounter notes.

Raw templates only; cooking them into readable prose is a derivation over
what several routes produced, so it lives in `derive/spelltext.py`.
The templates are deliberately not filtered against the spell list, because a
template routinely redirects to a spell that has no name row of its own.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from ..tables import Tables
from .columns import to_int

ASSIGNMENT = re.compile(r"\s*\$(\w+)\s*=\s*(.*)$")
"""One `$name=body` line of a description-variables row."""

JOURNAL_DEPTH = 4
"""How far to follow a journal section's children. The journal nests three
deep, so this is the cycle stop rather than a shape claim."""


@dataclass
class SpellText:
    """Every raw template a spell carries, before any of it is cooked."""

    descriptions: dict[int, str] = field(default_factory=dict)
    """Spell id -> what the tooltip says the cast does."""

    auras: dict[int, str] = field(default_factory=dict)
    """Spell id -> what the buff says while it is on you, often the only claim
    that is written."""

    variables: dict[int, dict[str, str]] = field(default_factory=dict)
    """Spell id -> {variable name -> its template body}.

    The bodies travel unresolved: each is itself a template resolved in the
    reading spell's own context.
    """

    notes: dict[int, str] = field(default_factory=dict)
    """Spell id -> the dungeon journal's note on it, still a raw template."""


def read_templates(tables: Tables) -> tuple[dict[int, str], dict[int, str]]:
    """The description and aura-description templates, unfiltered."""
    descriptions: dict[int, str] = {}
    auras: dict[int, str] = {}
    for spell_id, description, aura in tables.rows(
            "Spell", ["ID", "Description_lang", "AuraDescription_lang"]):
        identifier = to_int(spell_id)
        if description:
            descriptions[identifier] = description
        if aura:
            auras[identifier] = aura
    return descriptions, auras


def read_variables(tables: Tables) -> dict[int, dict[str, str]]:
    """Spell -> the named variable bodies its description may interpolate."""
    bodies: dict[int, dict[str, str]] = {}
    for set_id, text in tables.rows("SpellDescriptionVariables", ["ID", "Variables"]):
        assignments = {match.group(1): match.group(2)
                       for line in text.splitlines()
                       if (match := ASSIGNMENT.match(line))}
        if assignments:
            bodies[to_int(set_id)] = assignments
    return {to_int(spell_id): body
            for spell_id, set_id in tables.rows(
                "SpellXDescriptionVariables", ["SpellID", "SpellDescriptionVariablesID"])
            if (body := bodies.get(to_int(set_id)))}


def read_encounter_notes(tables: Tables) -> dict[int, str]:
    """Spell -> the dungeon journal's note on it, children folded in.

    A spell-linked section usually has an empty body, because the client renders
    the spell's own description in that slot; what is written is the
    difficulty-specific note beside it. Children fold into their parent so a
    note one level down is not lost.
    """
    sections: dict[str, tuple[str, str, str]] = {}
    for section_id, body, parent, spell in tables.rows(
            "JournalEncounterSection",
            ["ID", "BodyText_lang", "ParentSectionID", "SpellID"]):
        sections[section_id] = (body, parent, spell)

    children: dict[str, list[str]] = defaultdict(list)
    for section_id, (_, parent, _spell) in sections.items():
        if to_int(parent):
            children[parent].append(section_id)
    # Sorted once: a subtree is walked again for every ancestor that names a
    # spell.
    for siblings in children.values():
        siblings.sort()

    def gather(section_id: str, depth: int = 0) -> list[str]:
        body, _parent, _spell = sections[section_id]
        out = [body] if body.strip() else []
        if depth < JOURNAL_DEPTH:
            for child in children.get(section_id, ()):
                out += gather(child, depth + 1)
        return out

    notes: dict[int, list[str]] = defaultdict(list)
    for section_id, (_body, _parent, spell) in sections.items():
        if (identifier := to_int(spell)) and (parts := gather(section_id)):
            notes[identifier] += parts
    return {spell: "\n\n".join(parts) for spell, parts in notes.items()}


def read_spell_text(tables: Tables) -> SpellText:
    """Every raw template in one bundle, which is how the cooker takes them."""
    descriptions, auras = read_templates(tables)
    return SpellText(descriptions, auras,
                     read_variables(tables), read_encounter_notes(tables))
