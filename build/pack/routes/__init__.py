"""The readers: one module per route family.

A reader takes the `Tables` it is handed and returns a typed bundle. This is the
INTERPRETIVE half of the build -- dispatch on effect and procedure types, chain
expansion, target-mask resolution, the decode of a column that means one thing
under one enum value and another under the next. It is the half a relational
engine is worst at, which is why the routes are Python over a provider rather
than views over a database.

⛔ A ROUTE NEVER LEARNS WHERE A ROW CAME FROM OR WHAT SHIPS. No file paths, no
URLs, no emitters -- the path rule in `tools/check.py` enforces it. That is what
makes the source swappable and the artifact reshapeable without editing a
reader, and it is why the layer can be tested against a directory of three-row
CSVs.

`docs/DATA_ROUTES.md` documents what each route MEANS; these modules are how it
is read.
"""

from __future__ import annotations

from .anims import (read_anim_replacements, read_animkit_anims,
                    read_animkit_bonesets)
from .creatures import CreatureModels, read_creature_models
from .fx import FxPayloads, ScreenRow, expand_chain, read_fx_payloads
from .items import ItemModels, read_item_models
from .kits import KitEffects, read_kit_effects
from .missiles import VisualMissiles, read_missile_motions, read_missiles
from .models import ModelSources, read_model_sources
from .names import SpellNames, read_override_names, read_spell_names
from .procedures import ProcEffects, read_proc_effects
from .sounds import read_soundkit_files
from .text import SpellText, read_spell_text
from .visuals import VisualGraph, read_visual_graph

__all__ = [
    "CreatureModels",
    "FxPayloads",
    "ItemModels",
    "KitEffects",
    "ModelSources",
    "ProcEffects",
    "ScreenRow",
    "SpellNames",
    "SpellText",
    "VisualGraph",
    "VisualMissiles",
    "expand_chain",
    "read_anim_replacements",
    "read_animkit_anims",
    "read_animkit_bonesets",
    "read_creature_models",
    "read_fx_payloads",
    "read_item_models",
    "read_kit_effects",
    "read_missile_motions",
    "read_missiles",
    "read_model_sources",
    "read_override_names",
    "read_proc_effects",
    "read_soundkit_files",
    "read_spell_names",
    "read_spell_text",
    "read_visual_graph",
]
