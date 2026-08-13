"""Who a spell visual is shown to, as a bit mask.

A row of the visual graph carries the audience it plays for: the caster, the
target, an area, or a combination. The bits are named here because they are
set while reading the source tables, resolved while walking the graph, and
shipped in the pack -- three layers, one vocabulary.
"""

from __future__ import annotations

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
