"""The fields no reader fills under its own name: adapters, decorated.

Every reader registers itself with `route` where it is written. What is left
here are the few fields whose value is assembled from others rather than read,
so the function that assembles it lives beside the record that names it.
"""

from __future__ import annotations

from collections.abc import Container, Mapping

from ..sources import read_anim_names
from ..tables import Tables
from .effects import MaskedIds, SpellEffectRows, implicit_target_bits, read_spell_effect_rows
from .factions import FactionTemplateRow, read_faction_templates
from .fx import ScreenRow
from .keybinds import KeyboundOverride
from .route import route


@route("spell_ids", names="names.names")
def spell_ids(names: Mapping[int, str]) -> list[int]:
    """Every spell the pack lists, sorted: the row order of every per-spell column."""
    return sorted(names)


@route("anim_names")
def anim_names() -> list[str]:
    """The checked-in animation names. Not a context field: the three animation
    routes and the declarations all resolve ids through it."""
    return read_anim_names()


@route("effects", spell_names="names.names", screens="fx.screens")
def effects(
    tables: Tables,
    spell_names: Container[int],
    screens: Mapping[int, ScreenRow],
    keybinds: Mapping[int, KeyboundOverride],
    version: str,
) -> SpellEffectRows:
    """The effect rows, with the rosters and the target bits the reader wants
    assembled from the fields that carry them."""
    return read_spell_effect_rows(
        tables, spell_names, {"screens": screens, "keybounds": keybinds}, implicit_target_bits(version), version
    )


@route("factions", templates="effects.factions")
def factions(tables: Tables, templates: MaskedIds) -> list[FactionTemplateRow]:
    """The faction templates the auras set, named."""
    return read_faction_templates(tables, set(templates.distinct()))


@route("used_kits", sounds="visuals.sounds")
def used_kits(sounds: Mapping[int, Mapping[tuple[tuple[int, int], int], int]]) -> set[int]:
    """The sound kits some spell reaches, which both kit reads are scoped to."""
    return {kit for played in sounds.values() for (kit, _file), _phase in played}
