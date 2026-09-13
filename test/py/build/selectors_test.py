"""The selector roster: every effect and aura value typed once, and the
mechanical typing agreeing with the payloads the build reads by hand.

The typing files are read off the data and the core, never written by hand, so
the split's own payloads are an oracle for them: wherever both say what a slot
holds, they must say the same thing.
"""

from __future__ import annotations

import json
from typing import Any

from pack.routes.expressions import export_name
from pack.routes.flow import Holds
from pack.routes.flows import Routes
from pack.routes.selectors import SELECTORS, WORDS
from support import ROOT

ENUMS = ROOT / "build" / "enums"
TYPING = {"Effect": "spell_effect_slots", "EffectAura": "spell_aura_slots"}


def typing(column: str) -> dict[int, dict[str, Any]]:
    """One typing file's records, by selector value.

    Any: a record is a checked-in JSON object whose reads are read by key here,
    and the file's own shape is what the tests below pin.
    """
    held = json.loads((ENUMS / f"{TYPING[column]}.json").read_text(encoding="utf-8"))
    return {int(value): record for value, record in held["values"].items()}


def test_the_mechanical_typing_agrees_with_every_payload_the_build_reads() -> None:
    """A slot the split reads by hand and the typing also types must hold the
    same thing in both; a slot the typing leaves unresolved is not a disagreement."""
    disagreements = []
    for chosen in Routes.effects.selectors:
        column = export_name(chosen.on)
        records = typing(column)
        for value in chosen.values:
            typed = {str(read["column"]): read for read in records.get(value, {}).get("reads", [])}
            for slot in chosen.slots:
                read = typed.get(export_name(slot.column))
                if read is None or slot.holds.value == "parameter":
                    continue
                if str(read["into"]).lower() != slot.into.lower():
                    disagreements.append((column, value, export_name(slot.column), slot.into, read["into"]))
    assert not disagreements


def worded(holds: Holds) -> set[str]:
    """The vocabularies the roster's slots name as holding this."""
    return {slot.into for declared in SELECTORS for slot in declared.select.slots if slot.holds is holds}


def test_every_vocabulary_a_slot_names_ships_its_words() -> None:
    """A slot typed as a vocabulary or a mask names a checked-in file whose words
    the pack carries, so a reader holding the raw value can always name it."""
    named = worded(Holds.VOCABULARY) | worded(Holds.MASK)
    assert named - {word.vocabulary for word in WORDS if word.word} == set()


def test_a_mask_names_a_vocabulary_keyed_by_its_bits() -> None:
    """A reader decodes a mask by which of its words' values it sets, which only
    works where every one of those values is a single bit."""
    masks = worded(Holds.MASK)
    offenders = [
        (w.vocabulary, w.value) for w in WORDS if w.vocabulary in masks and (w.value <= 0 or w.value & (w.value - 1))
    ]
    assert not offenders


def test_each_selector_value_is_typed_once() -> None:
    """The split's payloads win, and a typing file adds only the values they leave."""
    seen: set[tuple[str, str, int]] = set()
    for declared in SELECTORS:
        for value in declared.select.values:
            key = (declared.table, export_name(declared.select.on), value)
            assert key not in seen, key
            seen.add(key)


def test_the_roster_types_hundreds_of_selectors_beyond_the_payloads() -> None:
    """What lets a reader resolve a raw row whatever effect or aura it carries,
    rather than only the few the split reads by hand."""
    typed = {
        (export_name(declared.select.on), value)
        for declared in SELECTORS
        if declared.table == "SpellEffect"
        for value in declared.select.values
    }
    assert len(typed) > 300
