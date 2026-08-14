"""The spell -> visual -> kit edges: the spine everything else hangs off.

Two hops, both many-to-many, and both carrying a TARGET MASK -- who the content
plays for. Almost every payload in the pack is reached by walking these edges,
so what they get wrong, everything downstream repeats.

The redirect graph has cycles. A `SpellVisual` can name another visual the
client swaps in for it, and on 9.2.7 one visual names itself while one pair
names each other. So following redirects is a WORKLIST over a mask that only
ever gains bits -- a fixpoint that terminates whatever shape the data takes --
and not the recursion it looks like it wants to be.

Following them at all is what makes that content visible. The redirected-to
visual is usually reachable no other way: on 9.2.7 only 37 of 228 caster
targets and 30 of 257 hostile targets also appear in `SpellXSpellVisual`.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from ..tables import Tables
from ..targets import AURA_PHASE_EVENTS, NO_TARGET, TARGET_BITS, VISUAL_REDIRECTS
from .columns import to_int


@dataclass
class VisualGraph:
    """The two hops, and the sound a visual plays on its own."""

    spell_visuals: dict[int, dict[int, int]] = field(default_factory=dict)
    """Spell -> {visual -> the extra target bits it was REACHED through}.

    A visual reached straight from `SpellXSpellVisual` carries `NO_TARGET`:
    its rows are already masked by their own event. One reached through a
    redirect carries the bits of the columns the path went through, because
    which column it came through is what says whether the content is the
    caster's own view or a hostile target's.
    """

    visual_kits: dict[int, dict[int, tuple[int, int]]] = field(default_factory=dict)
    """Visual -> {kit -> (aura-phase mask, every-other-phase mask)}.

    Split by phase, and it is not tidiness. "Target" means a different unit
    in the two: an aura-phase visual belongs to the aura and plays on whoever
    CARRIES it, while every other phase shares the cast's frame. Folding them
    into one mask before the spell's own effects are known loses the
    distinction that rescues mixed spells like Vanish and Blink, whose
    self-aura rides alongside effects aimed at someone else.
    """

    visual_sounds: dict[int, int] = field(default_factory=dict)
    """Visual -> the SoundKit its animation events play."""


def expand_redirects(seeds: set[int],
                     redirects: dict[int, list[tuple[int, int]]]) -> dict[int, int]:
    """Every visual reachable from `seeds`, with the bits it was reached through.

    A worklist keyed on the mask already recorded rather than a recursion,
    because the redirect graph contains cycles. A visual is re-queued only
    while its mask still GROWS; masks are a five-bit union and only ever gain
    bits, so this is a fixpoint and it terminates regardless of the data's
    shape. Chains longer than one hop are real -- three targets redirect again
    -- which is why it cannot flatten into a single lookup.
    """
    reached: dict[int, int] = {}
    queue = [(visual, NO_TARGET) for visual in seeds]
    while queue:
        visual, mask = queue.pop()
        before = reached.get(visual)
        merged = mask if before is None else before | mask
        if before is not None and merged == before:
            continue  # nothing new to say about this visual, and the cycle stop
        reached[visual] = merged
        for target, bit in redirects.get(visual, ()):
            # the hop's bit joins the mask of the path taken to get here, so a
            # redirect reached through a redirect carries both
            queue.append((target, mask | bit))
    return reached


def read_visual_graph(tables: Tables) -> VisualGraph:
    """Read both hops of the visual graph, redirects expanded.

    Both tables stream. Reading them into a dict keyed by row id first would be
    the shape the builder this replaces needed -- there, revisions arrived in a
    SECOND pass and had to overwrite the original by id before any edge was
    derived, or a re-pointed spell would keep the old visual alongside the new.
    The provider merges revisions in-stream now, so the row id has no reader
    left and 300,000 buffered rows have no purpose.
    """
    direct: dict[int, set[int]] = defaultdict(set)
    for spell_id, visual_id in tables.rows("SpellXSpellVisual",
                                           ["SpellID", "SpellVisualID"]):
        spell, visual = to_int(spell_id), to_int(visual_id)
        if spell and visual:
            direct[spell].add(visual)

    bits = list(VISUAL_REDIRECTS.values())
    redirects: dict[int, list[tuple[int, int]]] = {}
    graph = VisualGraph()
    for row_id, sound_id, *target_ids in tables.rows(
            "SpellVisual", ["ID", "AnimEventSoundID", *VISUAL_REDIRECTS]):
        visual, sound = to_int(row_id), to_int(sound_id)
        if sound:
            graph.visual_sounds[visual] = sound
        # A visual naming ITSELF is dropped here rather than in the expansion:
        # it is a no-op redirect, and one exists on 9.2.7.
        hops = [(target, bit) for target, bit in zip(map(to_int, target_ids), bits)
                if target and target != visual]
        if hops:
            redirects[visual] = hops

    graph.spell_visuals = {spell: expand_redirects(visuals, redirects)
                           for spell, visuals in direct.items()}

    kits: dict[int, dict[int, tuple[int, int]]] = defaultdict(dict)
    for visual_id, kit_id, target_type, start_event in tables.rows(
            "SpellVisualEvent",
            ["SpellVisualID", "SpellVisualKitID", "TargetType", "StartEvent"]):
        visual, kit = to_int(visual_id), to_int(kit_id)
        if not (visual and kit):
            continue
        bit = TARGET_BITS.get(to_int(target_type), NO_TARGET)
        aura, other = kits[visual].get(kit, (NO_TARGET, NO_TARGET))
        # Within a phase the bits UNION rather than replace: one visual reaches
        # the same kit through several event rows, and impact kits carry
        # duplicates differing only in TargetType.
        if to_int(start_event) in AURA_PHASE_EVENTS:
            kits[visual][kit] = (aura | bit, other)
        else:
            kits[visual][kit] = (aura, other | bit)
    graph.visual_kits = dict(kits)
    return graph
