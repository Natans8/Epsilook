"""Every route that is a declaration, in one place.

A route here is a flow and the shape it lands in, registered as the field it
fills. Its needs are read off the flow, so nothing is said twice; a change to
a route is a change to its line; a version that reads the same fact through
another table declares its own plan for the same field with `since`.

What is not here is a computation rather than a read: the graph walk, the
row flattening, the families and the text cooker, each a decorated function
in its own module.
"""

from __future__ import annotations

from .factions import FactionTemplateRow
from .flow import as_rows, c, flow, word
from .route import declare

factions = declare(
    "factions",
    flow("the faction a spell sets")
    .read("FactionTemplate", c.ID, c.Faction, c.FactionGroup)
    .narrow(c.ID, "effects.factions.named")
    .join(c.Faction, "Faction", c.Name_lang)
    >> as_rows(FactionTemplateRow, c.ID, c.Faction, c.FactionGroup, word(c.Name_lang), sort=True),
)
"""The template each aura sets, resolved to the faction's name and group."""
