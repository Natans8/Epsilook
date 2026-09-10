"""The faction an aura turns its target into, named.

The aura carries a faction template, which is what the client sets. The
template's own faction is the name a reader is after, and its group is the
one thing other players can read about a unit wearing it: a template in no
group is invisible to everyone, whatever it says about whom it hates. So the
pack ships the name for the word, the group for what separates nine templates
all named Monster, and the faction id for the link.
"""

from __future__ import annotations

from typing import NamedTuple


class FactionTemplateRow(NamedTuple):
    """One template a spell sets, resolved to what a reader can say about it."""

    template: int
    faction: int
    """The faction the template belongs to, which is what the name is of."""

    group: int
    """The `FactionGroup` mask: which side other players read the unit as."""

    name: str
