"""Creature -> name and displays, and display -> the model file it wears.

The name and the displays come only from the TrinityCore world tables; the
`CreatureDisplayInfo.ModelID -> CreatureModelData.FileDataID` chain is client
data, so a build with no server dump still resolves a morph's model and loses
only the word for it. Morphs, shapeshift forms, mounts and the Type-2 effect
names all end at a `CreatureDisplayID` and all resolve it here.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import NamedTuple

from ..sources.enums import load_local_enum


def creature_type_words() -> dict[int, str]:
    """The type value a creature carries -> the client's word for it.

    The vocabulary is vendored keyed by the mask bit a misc slot sets, since
    that is how a spell tests it, and a creature carries the value itself. The
    bit is turned back here rather than in every reader that draws one.
    """
    return {bit.bit_length(): str(word) for bit, word in load_local_enum("creature_types").items()}


def creature_rank_words() -> dict[int, str]:
    """The rank value -> the word for it, from normal up to world boss."""
    return {rank: str(word) for rank, word in load_local_enum("creature_ranks").items()}


class CreatureKind(NamedTuple):
    """What a creature is, as the server bills it."""

    creature: int
    type: int
    """A `CreatureType` value: 1 beast, 6 undead, 7 humanoid, and the rest."""
    rank: int
    """A `CreatureEliteType` value: normal, elite, rare, world boss."""
    faction: int
    """The `FactionTemplate` it belongs to, which the build already names."""


@dataclass
class CreatureModels:
    """The creature chain, from an NPC entry down to a model file."""

    names: Mapping[int, str] = field(default_factory=dict)
    """Creature entry -> its NPC name. Empty without a server dump."""

    displays: Mapping[int, Sequence[tuple[int, int]]] = field(default_factory=dict)
    """Creature entry -> [(slot, CreatureDisplayID)] in slot order, the first
    being the one the pill shows. Empty without a server dump."""

    display_model: Mapping[int, int] = field(default_factory=dict)
    """CreatureDisplayInfo.ID -> CreatureModelData.ID."""

    model_fid: Mapping[int, int] = field(default_factory=dict)
    """CreatureModelData.ID -> the model's file id."""

    totem_displays: Mapping[int, Sequence[int]] = field(default_factory=dict)
    """Spell -> the displays its totem wears, one per caster race, deduplicated
    and in display order. Empty without a server dump.

    Keyed by the SPELL rather than by the creature, unlike `displays`, because
    that is how the table keys it: the summoned creature carries one display
    and the race decides which model stands in for it. Several races share a
    model, so this is shorter than the row count.
    """

    display_skins: Mapping[int, tuple[int, ...]] = field(default_factory=dict)
    """CreatureDisplayInfo.ID -> the texture files it paints its model with, in
    slot order, for the displays that carry any. A display with none paints
    the model's own textures, and a humanoid display's skin is a baked
    customization rather than a file, so both are absent here."""

    def fid_for_display(self, display_id: int) -> int:
        """A display id resolved to its model file id, or 0 when unknown.

        Two hops: several displays share one model, so the file id lives one
        table further down.
        """
        return self.model_fid.get(self.display_model.get(display_id, 0), 0)
