"""Shapeshift forms: the name a form has, and the creature it turns you into.

⭐ MOST FORMS HAVE NO CREATURE AT ALL, which is why the name and the displays
are kept apart rather than a form being "a display with a label". Battle Stance,
Shadowform, Stealth and Moonkin change what a character can DO without changing
what it looks like, so they are a name and nothing else -- and a route that
required a display would drop them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables, array_columns
from .columns import to_int

FORM_DISPLAY_SLOTS = 4
"""How many creature displays a form's array holds where it is an array.

It narrowed to a plain scalar in a later build, which the array reader hides.
Nothing is lost in the array builds: only the first slot is ever filled.
"""


@dataclass
class ShapeshiftForms:
    """Each form's name, and the creature displays it wears if any."""

    names: dict[int, str] = field(default_factory=dict)
    """Form -> its name."""

    displays: dict[int, list[int]] = field(default_factory=dict)
    """Form -> the creature displays it turns the character into, in slot
    order. Empty for the forms that change no appearance."""


def read_shapeshift_forms(tables: Tables) -> ShapeshiftForms:
    """Read each form's name and its creature displays."""
    forms = ShapeshiftForms()
    columns = array_columns(tables, "SpellShapeshiftForm", "CreatureDisplayID",
                            FORM_DISPLAY_SLOTS)
    for form_id, name, *displays in tables.rows(
            "SpellShapeshiftForm", ["ID", "Name_lang", *columns]):
        form = to_int(form_id)
        forms.names[form] = name
        forms.displays[form] = [display for display in
                                (to_int(value) for value in displays) if display > 0]
    return forms
