"""The fields no reader fills under its own name: adapters, decorated.

Every reader registers itself with `route` where it is written. What is left
here are the few fields whose value is assembled from others rather than read,
so the function that assembles it lives beside the record that names it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence

from ..sources import read_anim_names
from .effects import implicit_target_bits
from .route import route


@route("spell_ids", names="names.names")
def spell_ids(names: Mapping[int, str]) -> list[int]:
    """Every spell the pack lists, sorted: the row order of every per-spell column."""
    return sorted(names)


@route("anim_ids")
def anim_ids(anim_names: Sequence[str]) -> range:
    """The animation ids this build names: an id past the list is dropped by
    every animation route, and this is the roster that says so."""
    return range(len(anim_names))


@route("anim_names")
def anim_names() -> list[str]:
    """The checked-in animation names. Not a context field: the three animation
    routes and the declarations all resolve ids through it."""
    return read_anim_names()


@route("target_bits")
def target_bits(version: str) -> Mapping[int, int]:
    """This build's implicit-target ids resolved to target bits, which the
    effect rows look their two target columns up through."""
    return implicit_target_bits(version)


@route("used_kits", sounds="visuals.sounds")
def used_kits(sounds: Mapping[int, Mapping[tuple[tuple[int, int], int], int]]) -> set[int]:
    """The sound kits some spell reaches, which both kit reads are scoped to."""
    return {kit for played in sounds.values() for (kit, _file), _phase in played}
