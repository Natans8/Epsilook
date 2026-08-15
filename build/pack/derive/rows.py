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

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from ..routes import MaskedIds, SpellEffectRows, VehicleSeats
from ..routes.colors import hue_words
from ..routes.models import MODEL_CAT_ITEM
from .walk import Bucket, SpellVisuals

ModelRow = tuple[int, int, int, int, int, int, int, int]
"""(spell, file, category, mask, source attach, dest attach, ref id, motion)."""

ColorRows = tuple[list[tuple[int, int, int]], list[int], list[str]]
"""One colour family's spell pairs, its distinct row ids, and their hue words."""


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


def color_rows(bucket: Bucket,
               colors_of: Callable[[int], tuple[int, ...]]) -> ColorRows:
    """Flatten one colour-only family into the three columns its sections need.

    Every colour-only family -- glow, tint, shadowy, ghost material -- has the
    same shape: the spell-to-row pairs with their masks, the distinct row ids,
    and one hue-word string per id. What differs is only where the colours come
    from, which is why that is the argument: a shadowy row carries two colours
    and the rest carry one.
    """
    ids = sorted({row for rows in bucket.values() for row in rows})
    return masked_rows(bucket), ids, [hue_words(colors_of(row)) for row in ids]


@dataclass
class PackRows:
    """Every flattening at least two sections read."""

    models: list[ModelRow] = field(default_factory=list)
    sounds: list[tuple[int, int, int, int]] = field(default_factory=list)
    animkits: list[tuple[int, int, int]] = field(default_factory=list)
    chains: list[tuple[int, int, int, int, int]] = field(default_factory=list)
    mechanics: list[tuple[int, int, int, int, int, int, int]] = field(
        default_factory=list)

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


def build_rows(visuals: SpellVisuals, effects: SpellEffectRows,
               seats: VehicleSeats) -> PackRows:
    """Flatten everything at least two sections read, once."""
    models = sorted(
        (spell, file, category, mask, source, destination, ref, motion)
        for spell, payloads in visuals.models.items()
        for (file, category, source, destination, ref, motion), mask
        in payloads.items())
    vehicles = sorted((spell, vehicle)
                      for spell, ids in effects.vehicles.ids.items()
                      for vehicle in ids if seats.seats.get(vehicle))
    animkits = masked_rows(visuals.animkits)
    used = {kit for _spell, kit, _mask in animkits}
    used |= {kit for _spell, kit in spell_rows(seats.animkits, vehicles)}
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
        mechanics=sorted({(row.spell, row.effect, row.aura, row.target_a,
                           row.target_b, row.misc_a, row.misc_b)
                          for row in effects.mechanics}),
        motions=sorted({row[7] for row in models if row[7]}),
        items=sorted({row[6] for row in models
                      if row[2] == MODEL_CAT_ITEM and row[6]}),
        vehicles=vehicles,
        vehicle_ids=sorted({vehicle for _spell, vehicle in vehicles}),
        used_animkits=used)


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
