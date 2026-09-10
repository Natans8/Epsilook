"""The derived fields no function fills under its own name: adapters, decorated.

Every derivation registers itself with `route` where it is written; this is
the one assembled from two others.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from ..routes import ScreenRow
from ..routes.route import route
from .walk import Occurrence, screen_reach, sky_spells


@route("sky_spells", by_aura="effects.screens.ids", by_kit="visuals.screens", screens="fx.screens")
def sky_spells_of(
    by_aura: Mapping[int, Iterable[int]],
    by_kit: Mapping[int, Iterable[Occurrence]],
    screens: Mapping[int, ScreenRow],
) -> dict[int, list[int]]:
    """Which spells set each preset, through the screen effects they reach."""
    return sky_spells(screen_reach(by_aura, by_kit), screens)
