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
from .creatures import CreatureModels, read_creature_models
from .delivery import Delivery
from .effects import EffectRow, MaskedIds, SpellEffectRows, implicit_target_bits, read_spell_effect_rows
from . import flows as _flows
from .factions import FactionTemplateRow
from .fx import ChainEffect, FxPayloads, ScreenRow, expand_chain, read_fx_payloads
from .gameobjects import GameObjectData
from .interrupts import interrupt_words
from .items import ItemModels, read_item_models
from .keybinds import KeyboundOverride
from .kits import KitEffects, read_kit_effects
from .missiles import Missile, MissileMotion, VisualMissiles, read_missiles
from .models import ModelSources, read_model_sources
from .mounts import MountData
from .names import SpellNames
from .procedures import ProcEffects, read_proc_effects
from .reach import Reach
from .route import ROUTES, Route, route
from .shapeshifts import ShapeshiftForms
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
from .values import DescriptionValues, read_spell_values
from .vehicles import VehicleSeats, read_vehicle_seats
from .visuals import KitEvent, VisualGraph, phase_words, read_visual_graph

del _registry  # imported for the adapters it registers

__all__ = [
    "Ambience",
    "Area",
    "AreaGates",
    "attribute_bit",
    "ChainEffect",
    "CONDITIONS",
    "CreatureModels",
    "Delivery",
    "DescriptionValues",
    "EffectRow",
    "expand_chain",
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
    "ModelSources",
    "MountData",
    "ProcEffects",
    "RAMP_COLORS",
    "Reach",
    "read_creature_models",
    "read_fx_payloads",
    "read_item_models",
    "read_kit_effects",
    "read_missiles",
    "read_model_sources",
    "read_proc_effects",
    "read_skies",
    "read_spell_attributes",
    "read_spell_effect_rows",
    "read_spell_values",
    "read_vehicle_seats",
    "read_visual_graph",
    "resolve_paths",
    "Route",
    "ROUTES",
    "route",
    "ScreenRow",
    "ShapeshiftForms",
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
