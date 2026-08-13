"""The prose a spell carries: descriptions, their variables, encounter notes.

RAW TEMPLATES ONLY. A description is a small language -- `$s1`, `$@spelldesc`,
`$<shield>` -- with its own grammar, and cooking it into readable prose lives in
`spelltext.py`. This route's job is to find the templates and the bodies they
interpolate, which keeps a parser out of the reading layer and lets it be
exercised on its own.

⛔ THE TEMPLATES ARE DELIBERATELY NOT FILTERED AGAINST THE SPELL LIST. A
template routinely redirects to a spell that has no name row of its own, and
dropping those empties 491 descriptions on 9.2.7 that resolve perfectly well.
The filter belongs where the pack is assembled, not here.
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
"""How far to follow a journal section's children.

The journal nests three deep, so this is one more than the data needs -- it is
the cycle stop rather than a shape claim.
"""


@dataclass
class SpellText:
    """Every raw template a spell carries, before any of it is cooked."""

    descriptions: dict[int, str] = field(default_factory=dict)
    """Spell id -> what the tooltip says the CAST does."""

    auras: dict[int, str] = field(default_factory=dict)
    """Spell id -> what the buff says while it is on you. A different claim
    from the description and often the only one that is written."""

    variables: dict[int, dict[str, str]] = field(default_factory=dict)
    """Spell id -> {variable name -> its template body}.

    A row is a newline-separated list of assignments SHARED by every spell
    pointing at it, and each body is itself a template resolved in the reading
    spell's own context -- so the bodies travel unresolved and the cooker does
    the resolving.
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
                       for line in re.split(r"[\r\n]+", text)
                       if (match := ASSIGNMENT.match(line))}
        if assignments:
            bodies[to_int(set_id)] = assignments
    return {to_int(spell_id): body
            for spell_id, set_id in tables.rows(
                "SpellXDescriptionVariables", ["SpellID", "SpellDescriptionVariablesID"])
            if (body := bodies.get(to_int(set_id)))}


def read_encounter_notes(tables: Tables) -> dict[int, str]:
    """Spell -> the dungeon journal's note on it, children folded in.

    ⚠ A SPELL-LINKED SECTION USUALLY HAS AN EMPTY BODY. 6,658 sections name a
    spell on 9.2.7 and only 324 of them say anything, because the client
    renders the spell's own description in that slot. What IS written is the
    difficulty-specific note beside it ("In Mythic difficulty, …") -- real
    prose no other route carries, which is why an almost-always-empty table
    still earns a read.

    Child sections fold into their parent so a note written one level down is
    not lost.
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

    def gather(section_id: str, depth: int = 0) -> list[str]:
        body, _parent, _spell = sections[section_id]
        out = [body] if body.strip() else []
        if depth < JOURNAL_DEPTH:
            for child in sorted(children.get(section_id, ())):
                out += gather(child, depth + 1)
        return out

    notes: dict[int, list[str]] = defaultdict(list)
    for section_id, (_body, _parent, spell) in sections.items():
        if (identifier := to_int(spell)) and (parts := gather(section_id)):
            notes[identifier] += parts
    return {spell: "\n\n".join(parts) for spell, parts in notes.items()}


def read_spell_text(tables: Tables) -> SpellText:
    """Every raw template in one bundle, which is how the cooker wants them."""
    descriptions, auras = read_templates(tables)
    return SpellText(descriptions, auras,
                     read_variables(tables), read_encounter_notes(tables))
