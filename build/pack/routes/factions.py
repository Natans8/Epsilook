"""The faction an aura turns its target into, named.

The aura carries a faction template, which is what the client sets. The
template's own faction is the name a reader is after, and its group is the
one thing other players can read about a unit wearing it: a template in no
group is invisible to everyone, whatever it says about whom it hates. So the
pack ships the name for the word, the group for what separates nine templates
all named Monster, and the faction id for the link.
"""

from __future__ import annotations

from collections.abc import Container
from typing import NamedTuple

from ..tables import Tables
from .columns import to_int
from .flow import flow


class FactionTemplateRow(NamedTuple):
    """One template a spell sets, resolved to what a reader can say about it."""

    template: int
    faction: int
    """The faction the template belongs to, which is what the name is of."""

    group: int
    """The `FactionGroup` mask: which side other players read the unit as."""

    name: str


def read_faction_templates(tables: Tables, used: Container[int]) -> list[FactionTemplateRow]:
    """Every template some spell sets, with its faction's name, in template order.

    Args:
        tables: the source to read from.
        used: the template ids the effect rows name.

    Returns:
        One row per used template the build has. A template naming a faction
        with no name row keeps an empty name, since the template is still the
        thing the spell sets.
    """
    route = (
        flow("the faction a spell sets")
        .read("FactionTemplate", "ID", "Faction", "FactionGroup")
        .narrow("ID", used, "the templates some spell sets")
        .join("Faction", "Faction", "Name_lang")
    )
    return sorted(
        FactionTemplateRow(to_int(template), to_int(faction), to_int(group), (name or "").strip())
        for template, faction, group, name in route.rows(tables)
    )
