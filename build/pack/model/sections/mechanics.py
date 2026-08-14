"""What a spell's effects DO, who they are aimed at, and the words for both.

One row per effect rather than per spell, because a search scope binds its axes
to one row: a query for an effect that is also aimed a certain way must mean a
single effect that is both, not two effects that are one each.

The name tables live here rather than in a vocabulary module of their own,
because they are the codomain of these columns -- `effects` indexes
`effectNames` and the target columns index the two target tables. Reading one
without the others tells you nothing.
"""

from __future__ import annotations

from collections import Counter

from ...derive import Reads
from ...measure import numeric_domain
from ...targets import IMPLICIT_PREFIX
from ..registry import register
from ..section import (Cardinality, Count, Domain, Layout, Scope, Section,
                       SectionColumns)


def spell_mechanics(reads: Reads) -> SectionColumns:
    """One row per distinct effect, carrying what it does and who it is for."""
    rows = reads.rows.mechanics
    return {"spellIds": [row[0] for row in rows],
            "effects": [row[1] for row in rows],
            "auras": [row[2] for row in rows],
            "targetsA": [row[3] for row in rows],
            "targetsB": [row[4] for row in rows],
            # Raw, because what they mean is a function of the effect or aura
            # beside them and that reading is the app's.
            "misc0": [row[5] for row in rows],
            "misc1": [row[6] for row in rows]}


def used_targets(reads: Reads) -> list[int]:
    """The implicit-target ids this build's rows actually name, sorted."""
    return sorted({target for row in reads.rows.mechanics
                   for target in (row[3], row[4]) if target})


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


SPELL_MECHANICS = register(Section(
    name="spellMechanics",
    doc="One row per spell effect: what it does and who it is aimed at.",
    module="core",
    produce=spell_mechanics,
    columns=("spellIds", "effects", "auras", "targetsA", "targetsB",
             "misc0", "misc1"),
    reads=("rows",),
    # Most rows carry neither, so they are stored as the rows that do.
    cardinality={"misc0": Cardinality.PARTIAL, "misc1": Cardinality.PARTIAL},
    absent={"misc0": 0, "misc1": 0},
    counts=(Count("spellMechanics",
                  lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("count.mech", lambda columns, _r: numeric_domain(
        Counter(columns["spellIds"]).values())),),
))

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
    counts=(Count("implicitTargets", lambda columns, _r: len(columns["names"])),),
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
