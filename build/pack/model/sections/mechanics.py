"""The words an effect row is read through, and the targets it names.

The rows themselves are in the mech column, one per effect: a search scope binds
its axes to one row, so a query for an effect that is also aimed a certain way
must mean a single effect that is both, not two effects that are one each.

What stays here is their codomain -- the enum names a row's stored number
resolves to, and the two implicit-target tables. Reading one without the others
tells you nothing, which is why they are declared together rather than in a
vocabulary module of their own.
"""

from __future__ import annotations

from ...derive import Reads
from ...targets import IMPLICIT_PREFIX
from ..registry import register
from ..section import (Layout, Scope, Section, SectionColumns, size)


def used_targets(reads: Reads) -> list[int]:
    """The implicit-target ids this build's rows actually name, sorted."""
    return sorted({target for row in reads.rows.mechanics
                   for target in (row.target_a, row.target_b) if target})


def target_names(reads: Reads) -> SectionColumns:
    """The name of each implicit target in use, without its enum prefix.

    Keyed by id rather than dense, because the ids in use are scattered through
    a much larger range. An id the enum does not name is left out and renders
    as its raw id, which is the same fallback an unknown effect gets.
    """
    return {"names": {str(target): reads.declared.target_names[target].removeprefix(
        IMPLICIT_PREFIX) for target in used_targets(reads)
        if target in reads.declared.target_names}}


def target_bits(reads: Reads) -> SectionColumns:
    """The caster, target or area bit each implicit target contributes.

    A row's icons are the union of its two targets' bits, so this rides as a
    small map rather than as a column as long as the mechanics rows -- which
    measured a hundred and ten kilobytes gzipped for the same fact.
    """
    return {"bits": {str(target): reads.declared.target_bits[target]
                     for target in used_targets(reads)
                     if reads.declared.target_bits.get(target)}}


EFFECT_NAMES = register(Section(
    name="effectNames",
    doc="Every effect id's enum name, for the word a mechanics pill prints.",
    module="universal",
    produce=lambda reads: {"names": reads.declared.effect_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))

AURA_NAMES = register(Section(
    name="auraNames",
    doc="Every aura id's enum name, for the word a mechanics pill prints.",
    module="universal",
    produce=lambda reads: {"names": reads.declared.aura_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))

IMPLICIT_TARGET_NAMES = register(Section(
    name="implicitTargetNames",
    doc="The name of each implicit target this build's rows name.",
    module="core",
    produce=target_names,
    columns=("names",),
    layout=Layout.BARE,
    reads=("rows", "declared"),
    counts=(size("implicitTargets", "names"),),
))

IMPLICIT_TARGET_BITS = register(Section(
    name="implicitTargetBits",
    doc="The caster, target or area bit each implicit target contributes.",
    module="core",
    produce=target_bits,
    columns=("bits",),
    layout=Layout.BARE,
    reads=("rows", "declared"),
))
