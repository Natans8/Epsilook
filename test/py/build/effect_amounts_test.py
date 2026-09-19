"""The numbers an effect ships beyond its mechanics row, and the cone a spell's area takes."""

from __future__ import annotations

import math
from dataclasses import replace

from pack.derive.context import DeriveContext, Reads
from pack.model.section import SectionColumns
from pack.model.sections.mechanics import EFFECT_AMOUNTS, SPELL_CONES, effect_amounts, spell_cones
from pack.routes import Cone, DescriptionValues, EffectNumbers, SpellEffectRows
from pack.routes.names import SpellNames

CONTEXT = replace(
    DeriveContext(build=None),  # type: ignore[arg-type]
    names=SpellNames(names={116: "Frostbolt"}),
    values=DescriptionValues(points={116: {1: 649.35, 3: 0.0}, 999: {1: 5.0}}, level=60),
    spell_radii={7: 8.0, 9: 30.0},
    effects=SpellEffectRows(
        numbers=[
            EffectNumbers(116, 0, radius=7, max_radius=9, facing=math.pi / 2, spell_power=0.8, variance=0.2),
            EffectNumbers(116, 2, mechanic=12, chain=0.5, pvp=0.5),
        ],
        multipliers={(116, 2): 1.5},
    ),
    spell_cones=(Cone(116, 90.0, 0.0), Cone(117, 0.0, 5.0)),
)


def produced(context: DeriveContext) -> SectionColumns:
    """The section, handed only the fields its record declares, as a build hands it."""
    return effect_amounts(Reads(context, EFFECT_AMOUNTS.reads))


def row(table: SectionColumns, spell: int, order: int) -> dict[str, object]:
    """One effect's values, by column."""
    at = list(zip(table["spellIds"], table["orders"])).index((spell, order))
    return {name: column[at] for name, column in table.items()}


def test_an_effect_ships_its_numbers_in_fixed_point_under_its_own_index() -> None:
    """The description values count effects from one; the rows count them from nought."""
    first = row(produced(CONTEXT), 116, 0)
    assert first["amounts"] == 6494
    assert (first["radii"], first["maxRadii"]) == (80, 300)
    assert first["facings"] == 900
    assert first["spellPowers"] == 800
    assert first["spreads"] == 200
    assert (first["chains"], first["pvps"]) == (100, 100)


def test_an_effect_with_no_amount_keeps_what_else_it_carries() -> None:
    third = row(produced(CONTEXT), 116, 2)
    assert (third["amounts"], third["mechanics"]) == (0, 12)
    assert (third["chains"], third["pvps"]) == (50, 50)
    assert third["multipliers"] == 150


def test_a_spell_the_pack_does_not_list_ships_nothing() -> None:
    assert 999 not in produced(CONTEXT)["spellIds"]


def test_a_cone_ships_in_tenths_of_a_degree_and_a_line_in_tenths_of_a_yard() -> None:
    table = spell_cones(Reads(CONTEXT, SPELL_CONES.reads))
    assert list(zip(table["spellIds"], table["degrees"], table["widths"])) == [(116, 900, 0), (117, 0, 50)]
