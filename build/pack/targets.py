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

# Declared before VISUAL_REDIRECTS, which needs them.
NO_TARGET = 0
TARGET_CASTER, TARGET_TARGET, TARGET_AREA = 1, 2, 4
TARGET_NOT_CASTER, TARGET_MISSILE_DEST = 8, 16

VISUAL_REDIRECTS = {
    "CasterSpellVisualID": TARGET_CASTER,
    "HostileSpellVisualID": TARGET_TARGET,
    "LowViolenceSpellVisualID": NO_TARGET,
    "ReducedUnexpectedCameraMovementSpellVisualID": NO_TARGET,
}
"""`SpellVisual` columns naming a substitute visual, and the bit it carries.

The redirected-to visual is usually reachable no other way, so following these
is what makes that content visible at all. Only the first two say anything
about who sees the visual; the other two are client-setting variants nobody
casts at anyone, so they carry no bit. A further redirect column is one line.
"""

TARGET_BITS = {1: TARGET_CASTER, 2: TARGET_TARGET, 3: TARGET_AREA,
               4: TARGET_NOT_CASTER, 5: TARGET_MISSILE_DEST}
"""`SpellVisualEvent.TargetType` to the bit it contributes to a row's mask.

Unioned over every kit a spell reaches the content through, so a row playing on
both caster and target carries both bits. That is real data rather than an
artefact: impact kits carry duplicate event rows differing only here.

Value 0 is absent because it contributes no bit, like content arriving from
outside the event graph - a missile set carries no event row at all.
"""

TARGET_NAMES = {1: "caster", 2: "target", 4: "area", 8: "target", 16: "area"}
"""The search word each bit answers to.

Two pairs share a word deliberately: "target, never caster" is still a target,
and a missile's destination is a place like any other area. Each keeps its own
bit and icon. "Both" is derived from the caster and target bits app-side.
"""

AURA_PHASE_EVENTS = frozenset({7, 8})
"""The `SpellVisualEvent.StartEvent` values meaning the aura phase.

The one phase that can disagree with the rest of the spell, which is why it is
split out. `TargetType` is relative to the cast rather than a claim about which
unit owns the visual, so a spell cast on its own caster still records "target"
and a self-buff would otherwise show a target icon.

An aura-phase visual belongs to the aura and plays on whoever carries it, so
believe the apply-aura effects' implicit target. Every other phase shares the
cast's frame, so "target" means the caster only when the whole spell is
self-cast; believing every effect's target there also catches self-cast impact
visuals that the aura test alone would miss.
"""


IMPLICIT_PREFIX = "TARGET_"
"""The prefix every implicit-target enum name opens with. What follows it names
what the effect is anchored to."""

IMPLICIT_HINTS = (
    (TARGET_AREA, ("AREA", "CONE", "CLUMP", "RECT", "TRAJ", "DYNOBJ", "_LINE_",
                   "GROUND", "RANDOM", "RADIUS", "FRONT", "BACK", "_LEFT",
                   "_RIGHT", "MOVEMENT", "CENTROID")),
    (TARGET_TARGET, ("TARGET", "NEARBY", "CHANNEL_TARGET", "LASTTARGET",
                     "CHAINHEAL", "BATTLE_PET")),
    (TARGET_CASTER, ("CASTER", "SRC", "PET", "MASTER", "SUMMONER", "VEHICLE",
                     "PASSENGER", "OWN_CRITTER", "MINIPET", "HOME")),
    (TARGET_AREA, ("DEST",)),
)
"""Substrings that classify an implicit-target name, in the order tried.

The order is the classification. A place beats the rest, because a spread, a
cone or a trajectory is somewhere rather than someone whatever it hangs off;
then the selected unit; then the caster's own sphere. A bare destination is
last, because the word appears inside names the earlier rows have claimed.

The classification is deliberately rough: it feeds the icon saying who a spell
hits, not the targeting rule the server runs. A name matching nothing carries
no bit, which is right for the values naming neither a unit nor a place.
"""


def implicit_target_bit(name: str) -> int:
    """Classify one implicit-target enum name as a target bit.

    Returns the bits the visual graph uses, because it is the same question
    asked of a different table, and sharing the vocabulary is what lets
    `resolve_target_mask` compare the two.

    Args:
        name: the enum name, or an empty string.

    Returns:
        One of the target bits, or `NO_TARGET` if the name anchors to nothing.
    """
    upper = (name or "").upper()
    if not upper.startswith(IMPLICIT_PREFIX):
        return NO_TARGET
    body = upper[len(IMPLICIT_PREFIX):]
    for bit, hints in IMPLICIT_HINTS:
        if any(hint in body for hint in hints):
            return bit
    return NO_TARGET


def resolve_target_mask(aura_mask: int, other_mask: int,
                        aura_bits: int, cast_bits: int) -> int:
    """Fold a kit's two phase masks into the one its row ships with.

    A target bit becomes a caster bit wherever the matching test says the spell
    aims only at its caster, since there "the target" is the caster. Only the
    plain target bit is rewritten: `TARGET_NOT_CASTER` says outright that it is
    not the caster, so it can never mean one.

    Args:
        aura_mask: the mask from the kit's aura-phase events.
        other_mask: the mask from its every other phase.
        aura_bits: the union of the spell's apply-aura implicit targets.
        cast_bits: the union over all of the spell's effects.

    Returns:
        The single mask the row ships with.
    """
    if aura_mask & TARGET_TARGET and aura_bits == TARGET_CASTER:
        aura_mask = (aura_mask & ~TARGET_TARGET) | TARGET_CASTER
    if other_mask & TARGET_TARGET and cast_bits == TARGET_CASTER:
        other_mask = (other_mask & ~TARGET_TARGET) | TARGET_CASTER
    return aura_mask | other_mask


def merge_masked(into: dict[T, int], items: Iterable[T], mask: int) -> None:
    """Union items into a payload bucket, accumulating each one's target mask.

    The primitive the graph walk is built from. Every payload bucket maps a
    content item to a target mask whatever the content is, so adding a kit's
    contribution is one operation rather than one per payload kind, and the
    walk stays a loop over kits rather than a switch over payloads.

    Args:
        into: the bucket to merge into, modified in place.
        items: the content items this kit contributed.
        mask: the audience they were reached through.
    """
    for item in items:
        into[item] = into.get(item, NO_TARGET) | mask
