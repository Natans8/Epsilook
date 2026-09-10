"""The derived fields no function fills under its own name: adapters, decorated.

Every derivation registers itself with `route` where it is written; this is
the one assembled from two others.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..routes import MaskedIds, ScreenRow
from ..routes.route import route
from .walk import Bucket, screen_reach, sky_spells


@route("sky_spells", by_aura="effects.screens", by_kit="visuals.screens", screens="fx.screens")
def sky_spells_of(by_aura: MaskedIds, by_kit: Bucket, screens: Mapping[int, ScreenRow]) -> dict[int, list[int]]:
    """Which spells set each preset, through the screen effects they reach."""
    return sky_spells(screen_reach(by_aura, by_kit), screens)
