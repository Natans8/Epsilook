"""The row tables more than one section reads.

The walk says what each spell reaches as buckets keyed by spell; a section
ships rows. Flattening one bucket is trivial, but several of the flattenings
are read by two or three sections at once -- the model rows decide which
missile motions and which items the pack has to name, the vehicle rows decide
which anim kits count as used -- and computing them twice is how two sections
start disagreeing about the same fact.

So they are computed once here and handed to every section that reads them,
which is the same rule that keeps the registry flat: a section depends on this
layer and never on another section.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import NamedTuple

from ..routes import MaskedIds, SpellEffectRows, VehicleSeats
from ..routes.models import MODEL_CAT_ITEM, Placement
from .links import link_kind_word
from .walk import Bucket, SpellVisuals


class ModelRow(NamedTuple):
    """One model a spell reaches, flattened for the row tables.

    A tuple, so it sorts, hashes and dedupes exactly as the anonymous shape it
    replaces; the names are what let a reader three layers away say which small
    integer it is holding.
    """

    spell: int
    file: int
    category: int
    mask: int
    source: int
    """The attachment the model hangs from."""
    destination: int
    """The attachment it points at, for the kinds that span two."""
    ref: int
    """What the category says this row refers to: an item, a creature display."""
    motion: int
    """The flight path a missile follows, or zero."""
    placement: Placement
    """How it sits against its attachment, and what it animates.

    Only the attached categories reach a table that says; the rest carry
    `UNPLACED`, which is the same neutral answer their model gets drawn with.
    """
    built: int
    """The size the model itself is, apart from what placed it."""


class MechanicRow(NamedTuple):
    """One effect a spell carries, reduced to the columns the pack ships."""

    spell: int
    effect: int
    aura: int
    target_a: int
    target_b: int
    misc_a: int
    misc_b: int


def masked_rows(bucket: Bucket) -> list[tuple[int, int, int]]:
    """One masked bucket as (spell, payload, mask) rows, sorted."""
    return sorted((spell, payload, mask)
                  for spell, payloads in bucket.items()
                  for payload, mask in payloads.items())


def id_rows(ids: MaskedIds) -> list[tuple[int, int]]:
    """One payload map as (spell, payload) rows, sorted.

    The mask rides on the pair rather than in the row, since these sections
    carry it in a column of its own.
    """
    return sorted((spell, payload) for spell, payloads in ids.ids.items()
                  for payload in payloads)


@dataclass
class PackRows:
    """Every flattening at least two sections read."""

    models: list[ModelRow] = field(default_factory=list)
    sounds: list[tuple[int, int, int, int]] = field(default_factory=list)
    animkits: list[tuple[int, int, int]] = field(default_factory=list)
    chains: list[tuple[int, int, int, int, int]] = field(default_factory=list)
    mechanics: list[MechanicRow] = field(default_factory=list)

    motions: list[int] = field(default_factory=list)
    """The flight paths the model rows name, sorted."""

    items: list[int] = field(default_factory=list)
    """The items the model rows point at, sorted."""

    vehicles: list[tuple[int, int]] = field(default_factory=list)
    """(spell, vehicle) for vehicles with at least one seat.

    A seatless vehicle carries no pill, so it is dropped here rather than in
    each of the five sections that would otherwise each have to remember.
    """

    vehicle_ids: list[int] = field(default_factory=list)
    used_animkits: set[int] = field(default_factory=set)
    """Anim kits some spell reaches, whether through a visual or a seat."""

    links: list[tuple[int, int, int, int]] = field(default_factory=list)
    """(source, destination, word, mask) for every edge between two spells.

    The word is an index into `link_words`, pooled here rather than by whoever
    ships it: the link section and the mechanics rows both name the same words,
    and a second pool would number them differently while looking identical.
    """

    link_words: list[str] = field(default_factory=list)
    """The distinct words the edges print, in first-seen order."""

    bonesets: list[tuple[int, int, list[int]]] = field(default_factory=list)
    """(kit, animation, boneset indexes) for every used kit's animations.

    The indexes point into `boneset_names`, which is why the pair is built here:
    two callers wanting one half each would pool the words twice and number them
    differently while looking identical.
    """

    boneset_names: list[str] = field(default_factory=list)
    """The distinct body regions the boneset rows index, in first-seen order."""

    seats: list[tuple[int, str]] = field(default_factory=list)
    """(vehicle, attachment name) for every seat, in artifact order.

    One flat list because that is how the seats ship, and a row referring to
    one seat refers to it by its place here.
    """


def spell_rows(per_vehicle: Mapping[int, set[int]],
               vehicles: list[tuple[int, int]], limit: int | None = None
               ) -> list[tuple[int, int]]:
    """Flatten a per-vehicle map onto the spells that reach those vehicles.

    A spell reaches its vehicle's animations through the vehicle, so this is
    the hop the pack takes once rather than making every reader take it.
    `limit` drops ids past the animation name table, as every animation route
    does.
    """
    return sorted({(spell, value) for spell, vehicle in vehicles
                   for value in per_vehicle.get(vehicle, ())
                   if limit is None or value < limit})


def spell_role_rows(per_vehicle: Mapping[int, set[tuple[int, int]]],
                    vehicles: list[tuple[int, int]], limit: int
                    ) -> list[tuple[int, int, int]]:
    """The same hop for animations that carry the role they play in.

    Apart from `spell_rows` rather than widening it, because the limit applies
    to the animation and a caller that lost track of which half it bounded
    would silently bound the role instead.
    """
    return sorted({(spell, anim, role) for spell, vehicle in vehicles
                   for anim, role in per_vehicle.get(vehicle, ())
                   if anim < limit})


def link_rows(effects: SpellEffectRows, effect_names: Mapping[int, str],
              aura_names: Mapping[int, str]
              ) -> tuple[list[tuple[int, int, int, int]], list[str]]:
    """Every edge between two spells, and the words they print.

    The word replaces the effect and aura the edge came from, so two rows that
    differ only in a column the pack does not ship become one edge. The words
    are pooled in first-seen order over the sorted edges, which is what makes
    the numbering stable without a sort over unrelated strings.
    """
    words: dict[str, int] = {}
    rows = {(source, destination,
             words.setdefault(link_kind_word(effect, aura, effect_names,
                                             aura_names), len(words)))
            for source, destination, effect, aura in sorted(effects.links)}
    return ([(source, destination, word,
              effects.link_targets.get((source, destination), 0))
             for source, destination, word in sorted(rows)], list(words))


def seat_rows(vehicle_ids: Sequence[int],
              seats: Mapping[int, Sequence[str]]) -> list[tuple[int, str]]:
    """One row per seat, in the order the artifact ships them.

    Both the seat table and the rows that point into it are laid out from this,
    because a row names a seat by its POSITION here: two accounts of that order
    would send a query about one seat to another vehicle's.
    """
    return [(vehicle, name) for vehicle in vehicle_ids
            for name in seats[vehicle]]


def build_rows(visuals: SpellVisuals, effects: SpellEffectRows,
               seats: VehicleSeats, effect_names: Mapping[int, str],
               aura_names: Mapping[int, str],
               bonesets: Mapping[int, Mapping[int, list[str]]]) -> PackRows:
    """Flatten everything at least two sections read, once."""
    models = sorted(
        ModelRow(spell, worn.file, worn.category, mask, worn.source,
                 worn.destination, worn.ref, worn.motion, worn.placement,
                 worn.built)
        for spell, payloads in visuals.models.items()
        for worn, mask in payloads.items())
    vehicles = sorted((spell, vehicle)
                      for spell, ids in effects.vehicles.ids.items()
                      for vehicle in ids if seats.seats.get(vehicle))
    animkits = masked_rows(visuals.animkits)
    used = {kit for _spell, kit, _mask in animkits}
    used |= {kit for _spell, kit in spell_rows(seats.animkits, vehicles)}
    vehicle_ids = sorted({vehicle for _spell, vehicle in vehicles})
    edges, words = link_rows(effects, effect_names, aura_names)
    boneset_pairs, boneset_pool = boneset_rows(bonesets, used)
    return PackRows(
        models=models,
        sounds=sorted((spell, kit, file, mask)
                      for spell, payloads in visuals.sounds.items()
                      for (kit, file), mask in payloads.items()),
        animkits=animkits,
        chains=sorted((spell, chain, mask, source, destination)
                      for spell, payloads in visuals.chains.items()
                      for (chain, source, destination), mask in payloads.items()),
        # Deduped on what ships: two effect rows differing only in a flag the
        # pack does not carry are one row once the shipped columns are what
        # identifies them.
        mechanics=sorted({MechanicRow(row.spell, row.effect, row.aura,
                                      row.target_a, row.target_b,
                                      row.misc_a, row.misc_b)
                          for row in effects.mechanics}),
        motions=sorted({row.motion for row in models if row.motion}),
        items=sorted({row.ref for row in models
                      if row.category == MODEL_CAT_ITEM and row.ref}),
        vehicles=vehicles,
        vehicle_ids=vehicle_ids,
        used_animkits=used,
        bonesets=boneset_pairs,
        boneset_names=boneset_pool,
        links=edges,
        link_words=words,
        seats=seat_rows(vehicle_ids, seats.seats))


def boneset_rows(bonesets: Mapping[int, Mapping[int, list[str]]],
                 used: set[int]) -> tuple[list[tuple[int, int, list[int]]], list[str]]:
    """Which body region each used kit's animations move, and the pooled names.

    The same handful of regions repeats across thousands of rows, so a row
    carries indexes into a pool rather than the words. Pooled in first-seen
    order, which is stable because the kits are walked in sorted order.
    """
    pool: dict[str, int] = {}
    rows = [(kit, anim, [pool.setdefault(name, len(pool)) for name in names])
            for kit in sorted(bonesets) if kit in used
            for anim, names in sorted(bonesets[kit].items())]
    return rows, list(pool)


def replacement_rows(visuals: SpellVisuals, effects: SpellEffectRows,
                     replacements: Mapping[int, set[tuple[int, int]]],
                     limit: int) -> list[tuple[int, int, int, int]]:
    """Every animation a spell swaps for another, from both sources merged.

    Two routes describe one thing -- a character wearing a different animation
    than its own. One reaches it through the visual graph and the other through
    an aura naming a replacement set, and both are pairs of animation ids, so
    they union into one per-spell set rather than shipping as two families a
    reader would have to merge. Deduped, since a spell commonly carries the same
    pair from both; the two sources' masks union with them, because one pair
    reached both ways plays on everyone either way reaches.
    """
    pairs: dict[tuple[int, int, int], int] = {}

    def keep(of_spell: int, base: int, worn: int, mask: int) -> None:
        """Record one swap, dropping either half past the name table."""
        if 0 <= base < limit and 0 <= worn < limit:
            swap = (of_spell, base, worn)
            pairs[swap] = pairs.get(swap, 0) | mask

    for spell, swapped in visuals.anims.items():
        for (source, destination), mask in swapped.items():
            keep(spell, source, destination, mask)
    for spell, sets in effects.anim_sets.ids.items():
        for identifier in sets:
            mask = effects.anim_sets.masks.get((spell, identifier), 0)
            for source, destination in replacements.get(identifier, ()):
                keep(spell, source, destination, mask)
    return sorted((spell, source, destination, mask)
                  for (spell, source, destination), mask in pairs.items())
