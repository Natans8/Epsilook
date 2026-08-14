"""Who a spell visual is shown to, as a bit mask.

A row of the visual graph carries the audience it plays for: the caster, the
target, an area, or a combination. The bits are named here because they are
set while reading the source tables, resolved while walking the graph, and
shipped in the pack -- three layers, one vocabulary.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TypeVar

T = TypeVar("T")

# The bits a target mask can carry. Named up here because VISUAL_REDIRECTS
# (below) needs them before TARGET_BITS — which maps SpellVisualEvent.TargetType
# onto these same bits, and is where the scheme is explained in full.
NO_TARGET = 0
TARGET_CASTER, TARGET_TARGET, TARGET_AREA = 1, 2, 4
TARGET_NOT_CASTER, TARGET_MISSILE_DEST = 8, 16

# SpellVisual columns that point at ANOTHER SpellVisual the client swaps in for
# this one -> the extra target bit everything reached through that redirect
# carries. The redirected-to visual is usually reachable no other way (on 9.2.7
# only 37 of 228 caster targets and 30 of 257 hostile targets also appear in
# SpellXSpellVisual), so following these is what makes that content visible at
# all — it is not a re-labelling of rows we already show.
#
# Only the first two carry a "who sees this" meaning. Low-violence and
# reduced-camera-movement are CLIENT SETTING variants — nobody casts them at
# anyone — so they declare NO_TARGET rather than being forced into a bit.
# Adding a future redirect column is one line here and nothing else.
VISUAL_REDIRECTS = {
    "CasterSpellVisualID": TARGET_CASTER,  # what the caster themself sees
    "HostileSpellVisualID": TARGET_TARGET,  # what a hostile target sees
    "LowViolenceSpellVisualID": NO_TARGET,
    "ReducedUnexpectedCameraMovementSpellVisualID": NO_TARGET,
}


TARGET_BITS = {1: TARGET_CASTER, 2: TARGET_TARGET, 3: TARGET_AREA,
               4: TARGET_NOT_CASTER, 5: TARGET_MISSILE_DEST}
"""SpellVisualEvent.TargetType -> the bit it contributes to a row's mask.

Unioned over every kit a spell reaches the content through, so a row that plays
on caster AND target carries both bits. That is genuine data rather than a
build artefact: impact kits carry duplicate event rows differing only in this
column.

Value 0 (None) is deliberately absent. It is effectively unused -- one row in
207,241 on 9.2.7 -- and contributes no bit, exactly like content that arrives
from outside the event graph, since a missile set carries no event row at all.
"""

TARGET_NAMES = {1: "caster", 2: "target", 4: "area", 8: "target", 16: "area"}
"""The search word each bit answers to.

Two pairs share a word on purpose. "Target, never caster" is still a target --
it keeps its own bit and its own icon colour, but nobody would search for it by
another name -- and a missile's destination is a place on the ground like any
other area. "Both" is derived app-side from bits 1|2 rather than being a bit.
"""

AURA_PHASE_EVENTS = frozenset({7, 8})
"""SpellVisualEvent.StartEvent values that mean the AURA phase (start / end).

The one phase that can disagree with the rest of the spell, which is why it
is the only one split out. `TargetType` is relative to the CAST -- "the caster"
against "the unit being cast at" -- and is not a claim about which unit owns
the visual. When a spell is cast on the caster themself the two are the same
unit and the client still writes `Target`: 29,886 spells on 9.2.7 (Divine
Shield's bubble, Ice Barrier, every self-buff's aura visual) would otherwise
render a "target" icon for content that plays on you.

An aura-phase visual belongs to the aura, so it plays on whoever CARRIES the
aura -- believe the APPLY_AURA effects' implicit target. Every other phase
shares the cast's frame, so "Target" only means the caster when the WHOLE spell
is self-cast -- believe every effect's target, which also catches self-cast
impact visuals like Healing Potion that the aura test alone would miss.
"""


def resolve_target_mask(aura_mask: int, other_mask: int,
                        aura_bits: int, cast_bits: int) -> int:
    """Fold a kit's two phase masks into the one the row ships with.

    `aura_bits` is the OR of the spell's APPLY_AURA implicit-target bits and
    `cast_bits` the OR over all of its effects. A `TARGET_TARGET` bit becomes
    `TARGET_CASTER` where the matching test says the spell targets only the
    caster -- that is, where "the target" IS the caster.

    Only the plain target bit is rewritten. `TARGET_NOT_CASTER` says "not the
    caster" outright, so it can never mean the caster and is left alone.
    """
    if aura_mask & TARGET_TARGET and aura_bits == TARGET_CASTER:
        aura_mask = (aura_mask & ~TARGET_TARGET) | TARGET_CASTER
    if other_mask & TARGET_TARGET and cast_bits == TARGET_CASTER:
        other_mask = (other_mask & ~TARGET_TARGET) | TARGET_CASTER
    return aura_mask | other_mask


def merge_masked(into: dict[T, int], items: Iterable[T], mask: int) -> None:
    """Union `items` into `into`, OR-ing `mask` onto each one's target mask.

    The single primitive behind the whole graph walk. Every payload bucket is
    a {content item -> target mask} map, whatever the content is, so adding a
    kit's contribution is one operation rather than one per payload kind. That
    is what keeps the walk a loop over kits instead of a switch over payloads.
    """
    for item in items:
        into[item] = into.get(item, NO_TARGET) | mask
