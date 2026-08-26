"""The values a spell sets on its subject: how fast, how big, how hidden.

The rows themselves live in the mech column now, because each is a thing the
spell DOES and a query binds its axes to one row. What stays here is the one
thing those rows cannot carry: the word each movement is named by, which a row
stores a number into.
"""

from __future__ import annotations

from ...routes.effects import MOVEMENT_NAMES
from ..registry import register
from ..section import Layout, Scope, Section

SPEED_MODE_NAMES = register(
    Section(
        name="speedModeNames",
        doc="The movement each speed row scales, by the number the row stores.",
        module="universal",
        produce=lambda _reads: {"names": list(MOVEMENT_NAMES)},
        columns=("names",),
        layout=Layout.BARE,
        scope=Scope.UNIVERSAL,
    )
)
