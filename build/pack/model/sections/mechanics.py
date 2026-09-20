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

import math
from collections.abc import Callable, Mapping

from ...derive import Reads
from ...derive.references import referenced
from ...derive.sources import source_references
from ...routes import EffectNumbers, interrupt_words
from ...routes.flow import export_name
from ...routes.selectors import SELECTORS, WORDS
from ...routes.values import FIRST_EFFECT_INDEX
from ...targets import IMPLICIT_PREFIX
from ..registry import register
from ..section import Cardinality, Count, Layout, Scope, Section, SectionColumns, size


def selectors(reads: Reads) -> SectionColumns:
    """Every discriminated reference, one row per selector value and slot.

    What a raw value on a mechanics row is an id into: the row's own effect
    or aura picks the meaning, and this table says which table or vocabulary
    each of its columns then indexes. Flat rather than a list per selector, so
    both media carry it as plain columns; a selector reading several columns is
    several rows agreeing on the first three.

    It is a dictionary, and it is keyed by the selector rather than by the
    spell. A row does not carry its misc values raw: where a selector has a
    route the value is lifted onto a kind that can name it, so a summon ships
    its creature and a morph its display, and where it has none the effect's
    own name is all that ships. So this resolves what a value would mean, and
    what it is must come from a kind that named it.
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
        # What an amount is divided by before it reads in its unit, one where it is read as stored.
        "scales": [slot.scale for _table, _select, _value, slot in rows],
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
        columns=("tables", "columns", "values", "slotColumns", "holds", "intos", "scales", "untils"),
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
    "Faction": lambda reads: reads.faction_names,
    "SkillLine": lambda reads: reads.skill_names,
    "SpellItemEnchantment": lambda reads: reads.enchantment_names,
}
"""The tables a reference slot points into whose names the build already reads, each as its whole id to name map."""


def reference_names(reads: Reads) -> SectionColumns:
    """The name of every id a reference slot of this build's rows points at.

    One row per table and id. The ids come from the rows alone and a name the
    build cannot find is empty, so every language's column lines up with the
    same ids.
    """
    found = referenced(reads.rows.mechanics, reads.effects.numbers, into=REFERENCE_NAMES)
    # The creatures, objects and items a spell is come by through are named the
    # same way as everything else a row points at.
    for table, ids in source_references(reads.spell_sources).items():
        if table not in REFERENCE_NAMES:
            raise KeyError(f"a spell source names {table!r}, which REFERENCE_NAMES cannot name")
        found[table].update(ids)
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
        reads=(
            "rows",
            "creatures",
            "objects",
            "items",
            "names",
            "forms",
            "fx",
            "factions",
            "kit_names",
            "faction_names",
            "skill_names",
            "enchantment_names",
            "effects",
            "spell_sources",
        ),
        degraded_without=("creature_template", "gameobject_template"),
        counts=(size("referenceNames", "ids"),),
        localizable=("names",),
    )
)

TENTHS = 10
"""A distance, an amount and an angle ship in tenths, since a whole number is what both readers are fastest at."""

HUNDREDTHS = 100
"""A multiplier ships in hundredths, a hundred being unchanged."""

THOUSANDTHS = 1000
"""A coefficient ships in thousandths."""


def effect_amounts(reads: Reads) -> SectionColumns:
    """Every effect's numbers beyond what its mechanics row carries, one row per spell and effect index.

    The amount is resolved at the build's level cap, the way a description
    prints it, and reads in the unit and scale `selectors` gives the effect's
    points column. The radii are in yards and the facing in degrees, each in
    tenths; the chain and PvP multipliers in hundredths, a hundred being
    unchanged; the two power coefficients and the variance in thousandths; the
    value multiplier in hundredths, nought except where the core reads it;
    what the amount gains per level and per spent resource in tenths. The
    mechanic is a `spell_mechanics` value and the item the id of the item the
    effect creates.
    A row is kept where any of them differs from the table's own default, for
    the spells the pack lists.
    """
    values = reads.values
    radii = reads.spell_radii
    listed = reads.names.names
    numbers = {(row.spell, row.order): row for row in reads.effects.numbers}
    multipliers = reads.effects.multipliers
    keys = (
        set(numbers)
        | set(multipliers)
        | {
            (spell, number - FIRST_EFFECT_INDEX)
            for spell, held in values.points.items()
            if spell in listed
            for number, value in held.items()
            if value
        }
    )
    rows = sorted(keys)
    unchanged = EffectNumbers(0, 0)
    held = [numbers.get(key, unchanged) for key in rows]

    def scaled(value: float, factor: int) -> int:
        return round(value * factor)

    return {
        "spellIds": [spell for spell, _order in rows],
        "orders": [order for _spell, order in rows],
        "amounts": [
            scaled(values.points.get(spell, {}).get(order + FIRST_EFFECT_INDEX, 0), TENTHS) for spell, order in rows
        ],
        "radii": [scaled(radii.get(row.radius, 0), TENTHS) for row in held],
        "maxRadii": [scaled(radii.get(row.max_radius, 0), TENTHS) for row in held],
        "facings": [scaled(math.degrees(row.facing), TENTHS) for row in held],
        "chains": [scaled(row.chain, HUNDREDTHS) for row in held],
        "spellPowers": [scaled(row.spell_power, THOUSANDTHS) for row in held],
        "attackPowers": [scaled(row.attack_power, THOUSANDTHS) for row in held],
        "perLevels": [scaled(row.per_level, TENTHS) for row in held],
        "perResources": [scaled(row.per_resource, TENTHS) for row in held],
        "pvps": [scaled(row.pvp, HUNDREDTHS) for row in held],
        "spreads": [scaled(row.variance, THOUSANDTHS) for row in held],
        "multipliers": [scaled(multipliers.get(key, 0.0), HUNDREDTHS) for key in rows],
        "mechanics": [row.mechanic for row in held],
        "items": [row.item for row in held],
    }


EFFECT_DEFAULTS = {
    "radii": 0,
    "maxRadii": 0,
    "facings": 0,
    "chains": HUNDREDTHS,
    "spellPowers": 0,
    "attackPowers": 0,
    "perLevels": 0,
    "perResources": 0,
    "pvps": HUNDREDTHS,
    "spreads": 0,
    "multipliers": 0,
    "mechanics": 0,
    "items": 0,
}
"""Each sparse column's default, which most rows carry and the encoding leaves out."""

EFFECT_AMOUNTS = register(
    Section(
        name="effectAmounts",
        doc="Each effect's resolved amount, radii, facing, multipliers, coefficients, mechanic and created item.",
        module="core",
        produce=effect_amounts,
        columns=("spellIds", "orders", "amounts", *EFFECT_DEFAULTS),
        reads=("values", "effects", "spell_radii", "names"),
        cardinality=dict.fromkeys(EFFECT_DEFAULTS, Cardinality.PARTIAL),
        absent=EFFECT_DEFAULTS,
        counts=(
            size("effectAmounts", "spellIds"),
            Count("effectAmountLevel", lambda _columns, reads: reads.values.level),
        ),
    )
)


def spell_cones(reads: Reads) -> SectionColumns:
    """The cone or line each spell's area takes in front of its caster, in tenths of a degree and of a yard."""
    cones = reads.spell_cones
    return {
        "spellIds": [cone.spell for cone in cones],
        "degrees": [round(cone.degrees * TENTHS) for cone in cones],
        "widths": [round(cone.width * TENTHS) for cone in cones],
    }


SPELL_CONES = register(
    Section(
        name="spellCones",
        doc="The angle of the cone or the width of the line a spell's area takes.",
        module="core",
        produce=spell_cones,
        columns=("spellIds", "degrees", "widths"),
        reads=("spell_cones",),
        counts=(size("spellCones", "spellIds"),),
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
