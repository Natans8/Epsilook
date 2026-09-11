"""When in a spell's life something happens: the phase vocabulary.

A spell is a sequence -- precast, cast, travel, impact, aura, channel -- and
`SpellVisualEvent.StartEvent` names where on it a kit starts. The same words
place everything else the pack ships: a missile is what fills the travel, so
it starts there; an effect lands where the spell does, which is the impact
when a missile or a delay carries it and the cast otherwise; and an aura, and
whatever hangs off one, holds for the aura phase. Declared here because three
layers say it: the routes read the event, the walk keys an occurrence by it,
and the pack ships the word.
"""

from __future__ import annotations

PHASES_ENUM = "spell_visual_events"
"""The vendored `SpellVisualEventEvent` enum, whose values are the phases.

Read by the visual route, which is what turns it into the shipped words; this
module holds only the values the build itself names, so every layer can import
it without reaching the sources.
"""

PHASE_NONE = 0
"""Nothing places it: content reached with no event and no rule to stand in."""
PHASE_CAST = 3
PHASE_TRAVEL = 4
"""Where a missile starts, which is what the travel phase is."""
PHASE_IMPACT = 6
PHASE_AURA = 7
PHASE_AURA_END = 8
PHASE_CHANNEL = 11
"""Where a channelled spell's effects land and its auras hold: the channel
start, since the server handles a channel at once whatever its speed."""

PHASE_LAUNCH = 25
"""The pack's own phase: the server's launch, after the cast and before the
travel, which the client never names. The effects the server only runs at
launch, the jumps and the trigger-spell effects, sit here whatever the spell's
speed. The value is the one past the client's enum, listed in the vendored
file so it wears a word like the rest."""

AURA_PHASE_EVENTS = frozenset({PHASE_AURA, PHASE_AURA_END})
"""The events meaning the aura phase, the one that can disagree with the rest
of the spell about who "the target" is. See `resolve_target_bit`."""


def landing(delayed: bool) -> int:
    """Where a spell's effects happen: the impact when something carries them
    there, the cast otherwise."""
    return PHASE_IMPACT if delayed else PHASE_CAST
