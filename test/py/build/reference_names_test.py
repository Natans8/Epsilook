"""The names a reference slot's raw value resolves to, read off the rows a build carries."""

from __future__ import annotations

from dataclasses import replace

from pack.derive.context import DeriveContext, Reads
from pack.derive.rows import MechanicRow, PackRows
from pack.model.section import SectionColumns
from pack.model.sections.mechanics import REFERENCE_NAMES_TABLE, reference_names
from pack.routes import EffectNumbers, SpellEffectRows
from pack.routes.creatures import CreatureModels
from pack.routes.factions import FactionTemplateRow
from pack.routes.fx import FxPayloads, ScreenRow
from pack.routes.gameobjects import GameObjectData
from pack.routes.items import ItemModels, ItemName
from pack.routes.names import SpellNames
from pack.routes.shapeshifts import ShapeshiftForms

APPLY_AURA = 6


def mechanic(effect: int, *, aura: int = 0, misc_a: int = 0, misc_b: int = 0) -> MechanicRow:
    """One effect row, with nothing but the columns a reference is read from."""
    return MechanicRow(1, effect, aura, 0, 0, misc_a, misc_b, 0, 0, 0, 0, 0)


CONTEXT = replace(
    DeriveContext(build=None),  # type: ignore[arg-type]
    rows=PackRows(
        mechanics=[
            mechanic(28, misc_a=500),
            mechanic(APPLY_AURA, aura=56, misc_a=501),
            mechanic(50, misc_a=700),
            mechanic(230, misc_a=9, misc_b=800),
            mechanic(APPLY_AURA, aura=36, misc_a=3),
            mechanic(APPLY_AURA, aura=43, misc_a=116),
            mechanic(APPLY_AURA, aura=260, misc_a=40),
            mechanic(APPLY_AURA, aura=243, misc_a=35),
            mechanic(131, misc_a=3000),
            mechanic(103, misc_a=72),
            mechanic(44, misc_a=164),
            mechanic(53, misc_a=1897),
            mechanic(28, misc_a=599),
            mechanic(APPLY_AURA, aura=18, misc_a=6),
        ]
    ),
    creatures=CreatureModels(names={500: "Imp", 501: "Murloc"}),
    objects=GameObjectData(name={700: "Campfire"}),
    items=ItemModels(names={800: ItemName("Hearthstone", 1), 801: ItemName("Linen Cloth", 1)}),
    names=SpellNames(names={116: "Frostbolt"}),
    forms=ShapeshiftForms(names={3: "Travel Form"}),
    fx=FxPayloads(screens={40: ScreenRow(name="Drunk Blur")}),
    factions=(FactionTemplateRow(35, 7, 1, "Stormwind"),),
    kit_names=((3000, "Bell Toll"),),
    faction_names={72: "Stormwind"},
    skill_names={164: "Blacksmithing"},
    enchantment_names={1897: "+5 Weapon Damage"},
    effects=SpellEffectRows(numbers=[EffectNumbers(1, 4, item=801)]),
)


def produced(context: DeriveContext) -> SectionColumns:
    """The section, handed only the fields its record declares, as a build hands it."""
    return reference_names(Reads(context, REFERENCE_NAMES_TABLE.reads))


def named(table: SectionColumns) -> dict[tuple[str, int], str]:
    """The section's rows as one lookup, by table and id."""
    return {(into, ident): name for into, ident, name in zip(table["tables"], table["ids"], table["names"])}


def test_every_reference_the_rows_carry_is_named_through_its_table() -> None:
    assert named(produced(CONTEXT)) == {
        ("creature_template", 500): "Imp",
        ("creature_template", 501): "Murloc",
        ("creature_template", 599): "",
        ("gameobject_template", 700): "Campfire",
        ("Item", 800): "Hearthstone",
        ("Item", 801): "Linen Cloth",
        ("SpellShapeshiftForm", 3): "Travel Form",
        ("Spell", 116): "Frostbolt",
        ("ScreenEffect", 40): "Drunk Blur",
        ("FactionTemplate", 35): "Stormwind",
        ("SoundKit", 3000): "Bell Toll",
        ("Faction", 72): "Stormwind",
        ("SkillLine", 164): "Blacksmithing",
        ("SpellItemEnchantment", 1897): "+5 Weapon Damage",
    }


def test_the_ids_do_not_depend_on_the_names() -> None:
    """A language that names fewer things must still line its column up with
    the same ids, since the two ship in different modules joined by position."""
    unnamed = produced(replace(CONTEXT, creatures=CreatureModels(), items=ItemModels(), skill_names={}))
    whole = produced(CONTEXT)
    assert (unnamed["tables"], unnamed["ids"]) == (whole["tables"], whole["ids"])
