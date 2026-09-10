"""The readers: one module per route family.

A reader takes the `Tables` it is handed and returns a typed bundle. It may
not name a file, a URL or an emitter; `tools/check.py` enforces that.
`docs/DATA_ROUTES.md` documents what each route means.
"""

from __future__ import annotations

from . import registry as _registry
from .anims import read_anim_replacements, read_animkit_anims, read_animkit_bonesets
from .areas import Area, AreaGates, read_area_gates, read_zone_maps
from .assets import resolve_paths
from .attributes import attribute_bit, read_spell_attributes
from .creatures import CreatureModels, read_creature_models
from .delivery import Delivery, read_spell_delivery
from .effects import EffectRow, MaskedIds, SpellEffectRows, implicit_target_bits, read_spell_effect_rows
from . import flows as _flows
from .factions import FactionTemplateRow
from .fx import ChainEffect, FxPayloads, ScreenRow, expand_chain, read_fx_payloads
from .gameobjects import GameObjectData, read_gameobjects
from .interrupts import interrupt_words, read_aura_interrupts
from .items import ItemModels, read_item_models
from .keybinds import KeyboundOverride, read_keybound_overrides
from .kits import KitEffects, read_kit_effects
from .missiles import Missile, MissileMotion, VisualMissiles, read_missile_motions, read_missiles
from .models import ModelSources, read_model_sources
from .mounts import MountData, read_mounts
from .names import SpellNames, read_override_names, read_spell_names
from .procedures import ProcEffects, read_proc_effects
from .reach import Reach, read_spell_reach
from .route import ROUTES, Route, route
from .shapeshifts import ShapeshiftForms, read_shapeshift_forms
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
from .sounds import Ambience, ZoneMusic, read_ambiences, read_soundkit_files, read_zone_music
from .spells import SpellProperties, read_spell_properties
from .text import SpellText, read_spell_text
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
    "read_ambiences",
    "read_anim_replacements",
    "read_animkit_anims",
    "read_animkit_bonesets",
    "read_area_gates",
    "read_aura_interrupts",
    "read_creature_models",
    "read_fx_payloads",
    "read_gameobjects",
    "read_item_models",
    "read_keybound_overrides",
    "read_kit_effects",
    "read_missile_motions",
    "read_missiles",
    "read_model_sources",
    "read_mounts",
    "read_override_names",
    "read_proc_effects",
    "read_shapeshift_forms",
    "read_skies",
    "read_soundkit_files",
    "read_spell_attributes",
    "read_spell_delivery",
    "read_spell_effect_rows",
    "read_spell_names",
    "read_spell_properties",
    "read_spell_reach",
    "read_spell_text",
    "read_spell_values",
    "read_vehicle_seats",
    "read_visual_graph",
    "read_zone_maps",
    "read_zone_music",
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
