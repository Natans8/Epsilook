"""The readers: one module per route family.

A reader takes the `Tables` it is handed and returns a typed bundle. It may
not name a file, a URL or an emitter; `tools/check.py` enforces that.
`docs/DATA_ROUTES.md` documents what each route means.
"""

from __future__ import annotations

from .anims import (read_anim_replacements, read_animkit_anims,
                    read_animkit_bonesets)
from .areas import Area, AreaGates, read_area_gates, read_zone_maps
from .assets import resolve_paths
from .attributes import attribute_bit, read_spell_attributes
from .creatures import CreatureModels, read_creature_models
from .delivery import Delivery, read_spell_delivery
from .effects import (EffectRow, MaskedIds, SpellEffectRows,
                      implicit_target_bits, read_spell_effect_rows)
from .fx import FxPayloads, ScreenRow, expand_chain, read_fx_payloads
from .gameobjects import GameObjectData, read_gameobjects
from .items import ItemModels, read_item_models
from .keybinds import KeyboundOverride, read_keybound_overrides
from .kits import KitEffects, read_kit_effects
from .missiles import (MissileMotion, VisualMissiles, read_missile_motions,
                       read_missiles)
from .models import ModelSources, read_model_sources
from .mounts import MountData, read_mounts
from .names import SpellNames, read_override_names, read_spell_names
from .procedures import ProcEffects, read_proc_effects
from .shapeshifts import ShapeshiftForms, read_shapeshift_forms
from .sounds import read_soundkit_files
from .spells import SpellProperties, read_spell_properties
from .text import SpellText, read_spell_text
from .values import DescriptionValues, read_spell_values
from .vehicles import VehicleSeats, read_vehicle_seats
from .visuals import VisualGraph, read_visual_graph

__all__ = [
    "Area",
    "AreaGates",
    "CreatureModels",
    "Delivery",
    "DescriptionValues",
    "EffectRow",
    "FxPayloads",
    "GameObjectData",
    "ItemModels",
    "KeyboundOverride",
    "KitEffects",
    "MaskedIds",
    "MissileMotion",
    "ModelSources",
    "MountData",
    "ProcEffects",
    "ScreenRow",
    "ShapeshiftForms",
    "SpellEffectRows",
    "SpellNames",
    "SpellProperties",
    "SpellText",
    "VehicleSeats",
    "VisualGraph",
    "VisualMissiles",
    "attribute_bit",
    "expand_chain",
    "implicit_target_bits",
    "read_anim_replacements",
    "read_animkit_anims",
    "read_animkit_bonesets",
    "read_area_gates",
    "read_zone_maps",
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
    "read_soundkit_files",
    "read_spell_attributes",
    "read_spell_delivery",
    "read_spell_effect_rows",
    "read_spell_names",
    "read_spell_properties",
    "read_spell_text",
    "read_spell_values",
    "read_vehicle_seats",
    "read_visual_graph",
    "resolve_paths",
]
