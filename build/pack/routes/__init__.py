"""The readers: one module per route family.

A reader takes the `Tables` it is handed and returns a typed bundle. It may
not name a file, a URL or an emitter; `tools/check.py` enforces that.
`docs/DATA_ROUTES.md` documents what each route means.
"""

from __future__ import annotations

from . import registry as _registry
from .areas import Area, AreaGates
from .assets import resolve_paths
from .attributes import attribute_bit, read_spell_attributes
from .creatures import CreatureKind, CreatureModels, creature_rank_words, creature_type_words
from .delivery import Delivery
from .effects import EffectNumbers, EffectRow, MaskedIds, SpellEffectRows, implicit_target_bits
from . import flows as _flows
from .factions import FactionTemplateRow
from .fx import ChainEffect, FxPayloads, ScreenRow
from .gameobjects import GameObjectData
from .interrupts import interrupt_words
from .items import ItemModels
from .keybinds import KeyboundOverride
from .kits import KitEffects
from .missiles import Missile, MissileMotion, VisualMissiles
from .mounts import MountData
from .names import SpellNames
from .procedures import ProcEffects
from .reach import Cone, Reach
from .route import ROUTES, Route, route
from .shapeshifts import ShapeshiftForms
from .sources import SOURCE_WORDS, LootRow, QuestRewards, SourceKind
from .skies import (
    CONDITIONS,
    RAMP_COLORS,
    Skybox,
    SkyPlace,
    SkyPreset,
    SkyRoster,
    SkyStop,
    flat_ramp,
    read_skies,
)
from .sounds import Ambience, ZoneMusic
from .spells import SpellProperties
from .text import SpellText
from .values import DescriptionValues
from .vehicles import VehicleSeats
from .visuals import KitEvent, VisualGraph, phase_words

del _registry, _flows  # imported for the adapters and the declarations they register

__all__ = [
    "Cone",
    "Ambience",
    "Area",
    "AreaGates",
    "attribute_bit",
    "ChainEffect",
    "CONDITIONS",
    "CreatureKind",
    "creature_rank_words",
    "creature_type_words",
    "CreatureModels",
    "Delivery",
    "DescriptionValues",
    "EffectNumbers",
    "EffectRow",
    "FactionTemplateRow",
    "flat_ramp",
    "FxPayloads",
    "GameObjectData",
    "implicit_target_bits",
    "interrupt_words",
    "ItemModels",
    "KeyboundOverride",
    "KitEffects",
    "MaskedIds",
    "Missile",
    "MissileMotion",
    "MountData",
    "ProcEffects",
    "RAMP_COLORS",
    "Reach",
    "read_skies",
    "read_spell_attributes",
    "resolve_paths",
    "Route",
    "ROUTES",
    "route",
    "ScreenRow",
    "ShapeshiftForms",
    "SOURCE_WORDS",
    "LootRow",
    "QuestRewards",
    "SourceKind",
    "Skybox",
    "SkyPlace",
    "SkyPreset",
    "SkyRoster",
    "SkyStop",
    "SpellEffectRows",
    "SpellNames",
    "SpellProperties",
    "SpellText",
    "VehicleSeats",
    "KitEvent",
    "phase_words",
    "VisualGraph",
    "VisualMissiles",
    "ZoneMusic",
]
