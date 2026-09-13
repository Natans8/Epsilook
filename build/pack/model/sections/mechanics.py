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

from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping

from ...derive import Reads
from ...derive.rows import MechanicRow
from ...routes import interrupt_words
from ...routes.flow import Holds, export_name
from ...routes.selectors import SELECTORS, WORDS
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
        # A column ships as the source spells it, without the table the flow qualifies it by.
        "columns": [export_name(chosen.on) for _table, chosen, _value, _slot in rows],
        "values": [value for _table, _select, value, _slot in rows],
        "slotColumns": [export_name(slot.column) for _table, _select, _value, slot in rows],
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


def selector_vocabularies(reads: Reads) -> SectionColumns:
    """The words of every vocabulary a slot in `selectors` names, one row per word.

    A slot holding a value or a mask of a vocabulary names it by its checked-in
    file, and this is that file's words, so a reader holding the raw value can
    name it: a value is the row whose value it equals, and a mask is every row
    whose bit it sets, since a mask's vocabulary is keyed by its bits.
    """
    del reads  # a declaration, the same on every build
    return {
        "vocabularies": [word.vocabulary for word in WORDS],
        "values": [word.value for word in WORDS],
        "words": [word.word for word in WORDS],
    }


SELECTOR_VOCABULARIES = register(
    Section(
        name="selectorVocabularies",
        doc="The word each value of a vocabulary a selector's slot names stands for.",
        module="universal",
        produce=selector_vocabularies,
        columns=("vocabularies", "values", "words"),
        scope=Scope.UNIVERSAL,
        counts=(size("selectorVocabularies", "values"),),
    )
)

REFERENCE_NAMES: Mapping[str, Callable[[Reads], Mapping[int, str]]] = {
    "creature_template": lambda reads: reads.creatures.names,
    "gameobject_template": lambda reads: reads.objects.name,
    "Item": lambda reads: {item: named.name for item, named in reads.items.names.items()},
    "Spell": lambda reads: reads.names.names,
    "SpellShapeshiftForm": lambda reads: reads.forms.names,
    "ScreenEffect": lambda reads: {screen: row.name for screen, row in reads.fx.screens.items()},
    "FactionTemplate": lambda reads: {row.template: row.name for row in reads.factions},
    "SoundKit": lambda reads: dict(reads.kit_names),
}
"""The tables a reference slot points into whose names the build already reads, each as its whole id to name map."""


def referenced(rows: Iterable[MechanicRow]) -> dict[str, set[int]]:
    """The ids the rows' reference slots point at, by the table they point into.

    An aura row is read under its aura and any other row under its effect, the
    way the selector roster declares them.
    """
    slots: dict[tuple[str, int], list[tuple[str, str]]] = defaultdict(list)
    for declared in SELECTORS:
        if declared.table != "SpellEffect":
            continue
        on = export_name(declared.select.on)
        for slot in declared.select.slots:
            if slot.holds is Holds.REFERENCE and slot.into in REFERENCE_NAMES:
                for value in declared.select.values:
                    slots[(on, value)].append((export_name(slot.column), slot.into))
    found: dict[str, set[int]] = defaultdict(set)
    for row in rows:
        for column, into in slots.get(("EffectAura", row.aura) if row.aura else ("Effect", row.effect), ()):
            value = row.misc_a if column.endswith("_0") else row.misc_b
            if value:
                found[into].add(value)
    return found


def reference_names(reads: Reads) -> SectionColumns:
    """The name of every id a reference slot of this build's rows points at.

    One row per table and id. The ids come from the rows alone and a name the
    build cannot find is empty, so every language's column lines up with the
    same ids.
    """
    found = referenced(reads.rows.mechanics)
    rows = [(table, ident) for table in sorted(found) for ident in sorted(found[table])]
    names = {table: REFERENCE_NAMES[table](reads) for table in found}
    return {
        "tables": [table for table, _ident in rows],
        "ids": [ident for _table, ident in rows],
        "names": [names[table].get(ident, "") for table, ident in rows],
    }


REFERENCE_NAMES_TABLE = register(
    Section(
        name="referenceNames",
        doc="The name of each id an effect or aura's reference slot points at.",
        module="core",
        produce=reference_names,
        columns=("tables", "ids", "names"),
        reads=("rows", "creatures", "objects", "items", "names", "forms", "fx", "factions", "kit_names"),
        degraded_without=("creature_template", "gameobject_template"),
        counts=(size("referenceNames", "ids"),),
        localizable=("names",),
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
