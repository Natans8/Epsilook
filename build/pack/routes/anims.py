"""Animations: anim kit segments, the regions they move, and aura swaps.

An animation id indexes a community-maintained name list rather than a db2 key,
so every reader here drops an id past the list's end.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..tables import Tables
from .columns import to_int

BONESET_FULL_BODY = "Full Body"
"""The default region. Never shown, because it distinguishes nothing."""


def read_animkit_anims(tables: Tables,
                       anim_names: Sequence[str]) -> dict[int, set[int]]:
    """Anim kit -> the animations it segments."""
    anims: dict[int, set[int]] = {}
    for kit_id, anim_id in tables.rows(
            "AnimKitSegment", ["ParentAnimKitID", "AnimID"]):
        kit, anim = to_int(kit_id), to_int(anim_id)
        if kit and 0 <= anim < len(anim_names):
            anims.setdefault(kit, set()).add(anim)
    return anims


def read_animkit_bonesets(tables: Tables) -> dict[int, dict[int, list[str]]]:
    """Anim kit -> {animation -> the body regions that segment moves}.

    A region belongs to a segment, not to the kit, so the result nests. Only
    the (kit, animation) pairs with at least one specific region appear.
    """
    names: dict[int, str] = {}
    for boneset_id, name in tables.rows("AnimKitBoneSet", ["ID", "Name"]):
        if name:
            names[to_int(boneset_id)] = name

    # A config may name several regions -- a left and a right shoulder, say.
    configs: dict[int, set[str]] = {}
    for config_id, boneset_id in tables.rows(
            "AnimKitConfigBoneSet", ["ParentAnimKitConfigID", "AnimKitBoneSetID"]):
        region = names.get(to_int(boneset_id))
        if region:
            configs.setdefault(to_int(config_id), set()).add(region)

    # A config may repeat and an animation may appear in several segments, so
    # the regions union across them.
    regions: dict[tuple[int, int], set[str]] = {}
    for kit_id, anim_id, config_id in tables.rows(
            "AnimKitSegment", ["ParentAnimKitID", "AnimID", "AnimKitConfigID"]):
        found = configs.get(to_int(config_id))
        if found:
            regions.setdefault((to_int(kit_id), to_int(anim_id)), set()).update(found)

    bonesets: dict[int, dict[int, list[str]]] = {}
    for (kit, anim), named in regions.items():
        specific = sorted(named - {BONESET_FULL_BODY})
        if specific:
            bonesets.setdefault(kit, {})[anim] = specific
    return bonesets


def read_anim_replacements(tables: Tables, anim_names: Sequence[str]
                           ) -> dict[int, set[tuple[int, int]]]:
    """Replacement set -> the (from, to) animation swaps it makes.

    Keyed by the set id an animation-replacement aura points at. Both ends
    index the name list, and a pair with either end past it is dropped.
    """
    replacements: dict[int, set[tuple[int, int]]] = {}
    for set_id, source, destination in tables.rows(
            "AnimReplacement",
            ["ParentAnimReplacementSetID", "SrcAnimID", "DstAnimID"]):
        replacement_set = to_int(set_id)
        first, second = to_int(source), to_int(destination)
        if replacement_set and 0 <= first < len(anim_names) \
                and 0 <= second < len(anim_names):
            replacements.setdefault(replacement_set, set()).add((first, second))
    return replacements
