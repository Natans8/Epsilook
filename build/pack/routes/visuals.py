"""The spell -> visual -> kit edges: the spine everything else hangs off.

Two many-to-many hops, both carrying a target mask saying who the content plays
for. The redirect graph contains cycles -- a visual can name itself, or a pair
name each other -- so following redirects is a worklist over a mask that only
gains bits, not a recursion. The redirected-to visual is usually reachable no
other way.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import NamedTuple

from ..phases import PHASES_ENUM
from ..sources import load_local_enum
from ..tables import Tables
from ..targets import NO_TARGET, TARGET_BITS, VISUAL_REDIRECTS
from .columns import to_int
from .route import route


class KitEvent(NamedTuple):
    """One `SpellVisualEvent` row: a kit, when it starts, and who sees it.

    The unit the walk collects: the same kit starting at the cast and again at
    the impact is two of these, and each keeps its own audience.
    """

    kit: int
    phase: int
    """The `StartEvent`, a value of the vendored phase enum."""
    bit: int
    """The target bit `TargetType` contributes, or `NO_TARGET`."""


@dataclass
class VisualGraph:
    """The two hops, and the sound a visual plays on its own."""

    spell_visuals: dict[int, dict[int, int]] = field(default_factory=dict)
    """Spell -> {visual -> the extra target bits it was reached through}.

    A visual reached straight from `SpellXSpellVisual` carries `NO_TARGET`,
    its rows already being masked by their own event; one reached through a
    redirect carries the bits of the columns the path went through.
    """

    visual_events: dict[int, list[KitEvent]] = field(default_factory=dict)
    """Visual -> its event rows, distinct, in table order.

    Kept per event rather than folded per kit, because the phase is what the
    pack ships: a row says what plays, when, and for whom, and folding the
    events of one kit would lose which audience went with which moment.
    """

    visual_sounds: dict[int, int] = field(default_factory=dict)
    """Visual -> the SoundKit its animation events play."""


def phase_words() -> list[str]:
    """The word for each event a kit can start at, indexed by event id.

    Empty where the enum leaves a value unnamed, so a row storing one reads as
    no word rather than as a neighbour's.
    """
    names = load_local_enum(PHASES_ENUM)
    return [str(names.get(event, "")) for event in range(max(names) + 1)]


def expand_redirects(seeds: set[int], redirects: dict[int, list[tuple[int, int]]]) -> dict[int, int]:
    """Every visual reachable from `seeds`, with the bits it was reached through.

    A worklist, not a recursion: the redirect graph contains cycles. A visual
    is re-queued only while its mask still grows, and masks only ever gain
    bits, so this terminates whatever shape the data takes. Chains longer than
    one hop are real, so it cannot flatten into a single lookup.
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


@route("graph")
def read_visual_graph(tables: Tables) -> VisualGraph:
    """Read both hops of the visual graph, redirects expanded.

    Both tables stream: the provider merges revisions in-stream, so nothing
    needs the row id and there is no reason to buffer rows before deriving an
    edge.
    """
    direct: dict[int, set[int]] = defaultdict(set)
    for spell_id, visual_id in tables.rows("SpellXSpellVisual", ["SpellID", "SpellVisualID"]):
        spell, visual = to_int(spell_id), to_int(visual_id)
        if spell and visual:
            direct[spell].add(visual)

    bits = list(VISUAL_REDIRECTS.values())
    redirects: dict[int, list[tuple[int, int]]] = {}
    graph = VisualGraph()
    for row_id, sound_id, *target_ids in tables.rows("SpellVisual", ["ID", "AnimEventSoundID", *VISUAL_REDIRECTS]):
        visual, sound = to_int(row_id), to_int(sound_id)
        if sound:
            graph.visual_sounds[visual] = sound
        # A visual naming itself is a no-op redirect, dropped here rather than
        # in the expansion.
        hops = [(target, bit) for target, bit in zip(map(to_int, target_ids), bits) if target and target != visual]
        if hops:
            redirects[visual] = hops

    graph.spell_visuals = {spell: expand_redirects(visuals, redirects) for spell, visuals in direct.items()}

    events: dict[int, list[KitEvent]] = defaultdict(list)
    seen: set[tuple[int, KitEvent]] = set()
    for visual_id, kit_id, target_type, start_event in tables.rows(
        "SpellVisualEvent", ["SpellVisualID", "SpellVisualKitID", "TargetType", "StartEvent"]
    ):
        visual, kit = to_int(visual_id), to_int(kit_id)
        if not (visual and kit):
            continue
        event = KitEvent(kit, to_int(start_event), TARGET_BITS.get(to_int(target_type), NO_TARGET))
        # The table repeats an event row verbatim now and then; one is enough.
        if (visual, event) not in seen:
            seen.add((visual, event))
            events[visual].append(event)
    graph.visual_events = dict(events)
    return graph
