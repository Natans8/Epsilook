"""Shapeshift forms: the name a form has, and the creature it turns you into.

Most forms have no creature at all -- Battle Stance, Shadowform, Stealth,
Moonkin -- so the name and the displays are kept apart.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import NamedTuple


class FormRow(NamedTuple):
    """One form's row, its display slots read whole."""

    form: int
    name: str
    displays: list[int]


@dataclass
class ShapeshiftForms:
    """Each form's name, and the creature displays it wears if any."""

    names: dict[int, str] = field(default_factory=dict)
    """Form -> its name."""

    displays: dict[int, list[int]] = field(default_factory=dict)
    """Form -> the creature displays it turns the character into, in slot
    order. Empty for forms that change no appearance."""

    @classmethod
    def assemble(cls, rows: Iterable[FormRow]) -> ShapeshiftForms:
        """The bundle from the rows."""
        forms = cls()
        for row in rows:
            forms.names[row.form] = row.name
            forms.displays[row.form] = row.displays
        return forms
