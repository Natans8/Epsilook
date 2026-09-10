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
from ...routes import interrupt_words
from ...routes.selectors import SELECTORS
from ...targets import IMPLICIT_PREFIX
from ..registry import register
from ..section import Layout, Scope, Section, SectionColumns, size


def selectors(reads: Reads) -> SectionColumns:
    """Every discriminated reference, one row per selector value and slot.

    What a raw value on a mechanics row is an id into: the row's own effect
    or aura picks the meaning, and this table says which table or vocabulary
    each of its columns then indexes. Shipped rather than left in the build,
    because the mechanics rows carry both misc values raw and a reader with
    this can resolve them. Flat rather than a list per selector, so both
    media carry it as plain columns; a selector reading several columns is
    several rows agreeing on the first three.
    """
    del reads  # a declaration, the same on every build
    rows = [
        (declared.table, declared.select, value, slot)
        for declared in SELECTORS
        for value in declared.select.values
        for slot in declared.select.slots
    ]
    return {
        "tables": [table for table, _select, _value, _slot in rows],
        "columns": [chosen.on for _table, chosen, _value, _slot in rows],
        "values": [value for _table, _select, value, _slot in rows],
        "slotColumns": [slot.column for _table, _select, _value, slot in rows],
        "holds": [slot.holds.value for _table, _select, _value, slot in rows],
        "intos": [slot.into for _table, _select, _value, slot in rows],
        # The first patch on which the value stopped meaning this, or empty.
        "untils": [chosen.until for _table, chosen, _value, _slot in rows],
    }


def used_targets(reads: Reads) -> list[int]:
    """The implicit-target ids this build's rows actually name, sorted."""
    return sorted({target for row in reads.rows.mechanics for target in (row.target_a, row.target_b) if target})


def target_names(reads: Reads) -> SectionColumns:
    """The name of each implicit target in use, without its enum prefix.

    Keyed by id rather than dense, because the ids in use are scattered through
    a much larger range. An id the enum does not name is left out and renders
    as its raw id, which is the same fallback an unknown effect gets.
    """
    return {
        "names": {
            str(target): reads.declared.target_names[target].removeprefix(IMPLICIT_PREFIX)
            for target in used_targets(reads)
            if target in reads.declared.target_names
        }
    }


def target_bits(reads: Reads) -> SectionColumns:
    """The caster, target or area bit each implicit target contributes.

    A row's icons are the union of its two targets' bits, so this rides as a
    small map rather than as a column as long as the mechanics rows -- which
    measured a hundred and ten kilobytes gzipped for the same fact.
    """
    return {
        "bits": {
            str(target): reads.declared.target_bits[target]
            for target in used_targets(reads)
            if reads.declared.target_bits.get(target)
        }
    }


EFFECT_NAMES = register(
    Section(
        name="effectNames",
        doc="Every effect id's enum name, for the word a mechanics pill prints.",
        module="universal",
        produce=lambda reads: {"names": reads.declared.effect_names},
        columns=("names",),
        layout=Layout.BARE,
        reads=("declared",),
        scope=Scope.UNIVERSAL,
    )
)

AURA_NAMES = register(
    Section(
        name="auraNames",
        doc="Every aura id's enum name, for the word a mechanics pill prints.",
        module="universal",
        produce=lambda reads: {"names": reads.declared.aura_names},
        columns=("names",),
        layout=Layout.BARE,
        reads=("declared",),
        scope=Scope.UNIVERSAL,
    )
)

IMPLICIT_TARGET_NAMES = register(
    Section(
        name="implicitTargetNames",
        doc="The name of each implicit target this build's rows name.",
        module="core",
        produce=target_names,
        columns=("names",),
        layout=Layout.BARE,
        reads=("rows", "declared"),
        counts=(size("implicitTargets", "names"),),
    )
)

SELECTORS_TABLE = register(
    Section(
        name="selectors",
        doc="What each column of a discriminated row is an id into, per selector value.",
        module="universal",
        produce=selectors,
        columns=("tables", "columns", "values", "slotColumns", "holds", "intos", "untils"),
        scope=Scope.UNIVERSAL,
        counts=(size("selectors", "values"),),
    )
)


def interrupt_names(reads: Reads) -> SectionColumns:
    """The word for each aura-interrupt bit, indexed by bit; empty where a bit
    is housekeeping or unnamed."""
    del reads  # a vendored enum, the same on every build
    words = interrupt_words()
    return {"names": [words.get(bit, "") for bit in range(max(words) + 1)]}


INTERRUPT_NAMES = register(
    Section(
        name="interruptNames",
        doc="The word for each event that removes an aura, by the bit that says so.",
        module="universal",
        produce=interrupt_names,
        columns=("names",),
        layout=Layout.BARE,
        scope=Scope.UNIVERSAL,
    )
)

IMPLICIT_TARGET_BITS = register(
    Section(
        name="implicitTargetBits",
        doc="The caster, target or area bit each implicit target contributes.",
        module="core",
        produce=target_bits,
        columns=("bits",),
        layout=Layout.BARE,
        reads=("rows", "declared"),
    )
)
