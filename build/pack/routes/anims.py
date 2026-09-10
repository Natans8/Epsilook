"""Animations: anim kit segments, the regions they move, and aura swaps.

An animation id indexes a community-maintained name list rather than a db2 key,
so every reader here drops an id past the list's end.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..sources import load_local_enum
from .route import route

BONESET_FULL_BODY = "Full Body"
"""The default region. Never shown, because it distinguishes nothing."""

NO_EMOTE = 0
"""What an animation Epsilon exposes no emote for carries."""

SPEED_UNIT = 1000
"""Stored units per whole factor: a kit playing at its animation's own pace ships as 1000."""


@route("emotes")
def read_anim_emotes(anim_names: Sequence[str]) -> tuple[list[int], list[int]]:
    """The Epsilon emote that performs each animation, one-shot and looping.

    Two columns parallel to `anim_names` and indexed the same way, `NO_EMOTE`
    where Epsilon exposes no emote of that kind. Epsilon presents the client's
    animation set as emotes, so an animation any build indexes is one a player
    can perform -- which is why this reads a checked-in declaration rather than
    a table of the build being packed, and why every pack carries it.

    An emote id is what every route into an animation takes: `.mod anim` plays
    it on the current animation and `.mod standstate` sets it as the standing
    pose. Neither accepts an `AnimationData` id, which is what makes this
    mapping the click-path and not a restatement of one the pack already has.

    Args:
        anim_names: the build's animation names, which bound the columns. An
            emote for an animation past this build's table is dropped, like
            every other animation route.
    """
    emotes = load_local_enum("epsilon_emotes")
    oneshots = [NO_EMOTE] * len(anim_names)
    loops = [NO_EMOTE] * len(anim_names)
    for anim, pair in emotes.items():
        if 0 <= anim < len(anim_names):
            oneshots[anim] = pair.get("oneshot", NO_EMOTE)
            loops[anim] = pair.get("loop", NO_EMOTE)
    return oneshots, loops
