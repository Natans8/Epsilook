"""The shared context every section's ``produce`` receives."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields
from typing import Any

from ..build import Build
from ..routes import (AreaGates, CreatureModels, Delivery, FxPayloads,
                      GameObjectData, ItemModels, KeyboundOverride, KitEffects,
                      ModelSources, MountData, ProcEffects, ShapeshiftForms,
                      SpellEffectRows, SpellNames, SpellProperties, SpellText,
                      VehicleSeats, VisualGraph, VisualMissiles)
from .displays import ResolvedDisplays
from .icons import IconIndex
from .prose import CookedText
from .references import References
from .walk import SpellVisuals


class Reads:
    """A section's declared slice of the context, and nothing else.

    A section names the context fields it maps from and is handed one of these
    instead of the context itself. Reaching for anything undeclared raises,
    which is what keeps a section's inputs a fact about the record rather than
    something only reading `produce` can tell you.

    Without it every section can reach every field, which is the condition that
    made placement arbitrary in the builder this replaces: what a section
    consumed was whatever happened to be in scope.
    """

    def __init__(self, context: DeriveContext, declared: Iterable[str]) -> None:
        self._context = context
        self._declared = frozenset(declared)

    def __getattr__(self, name: str) -> Any:
        """The named context field, if the section declared it.

        Raises:
            AttributeError: the field exists but was not declared, or does not
                exist at all. The two are told apart in the message because
                they are different mistakes: one is a missing declaration, the
                other a typo or a field that has not been derived yet.
        """
        if name in self._declared:
            return getattr(self._context, name)
        if any(existing.name == name for existing in fields(self._context)):
            raise AttributeError(
                f"{name!r} is not in this section's `reads`; declare it there")
        raise AttributeError(f"the derive context has no {name!r}")


@dataclass(frozen=True, eq=False)
class DeriveContext:
    """Everything a section may read, computed once per build per locale.

    Sections receive a `Reads` over this, narrowed to what each one declares.
    A locale build constructs its own context over locale-qualified tables.

    Anything two sections share belongs here rather than being recomputed by
    each of them, which is what keeps the section registry flat: a section
    depends on this and never on another section.

    Frozen so a section cannot swap a field out from under the next one, and
    compared by identity because every field it holds is unhashable -- the
    default equality would advertise a hash that raises the moment anyone
    keyed a cache on a build's context.
    """

    build: Build
    """The build being packed."""

    spell_ids: Sequence[int] = ()
    """Every spell the pack lists, sorted. The row order of every per-spell
    column, so a section aligning to it never sorts again."""

    # What the routes read.
    names: SpellNames = field(default_factory=SpellNames)
    props: SpellProperties = field(default_factory=SpellProperties)
    templates: SpellText = field(default_factory=SpellText)
    """The raw description templates, before the cooker runs."""

    effects: SpellEffectRows | None = None
    graph: VisualGraph | None = None
    creatures: CreatureModels | None = None
    items: ItemModels | None = None
    mounts: MountData | None = None
    objects: GameObjectData | None = None
    models: ModelSources | None = None
    procs: ProcEffects | None = None
    fx: FxPayloads | None = None
    kits: KitEffects | None = None
    forms: ShapeshiftForms | None = None
    vehicles: VehicleSeats | None = None
    areas: AreaGates | None = None

    missiles: Mapping[int, VisualMissiles] = field(default_factory=dict)
    motions: Mapping[int, str] = field(default_factory=dict)
    soundkit_files: Mapping[int, set[int]] = field(default_factory=dict)
    animkit_anims: Mapping[int, set[int]] = field(default_factory=dict)
    animkit_bonesets: Mapping[int, dict[int, list[str]]] = field(default_factory=dict)
    anim_replacements: Mapping[int, dict[int, int]] = field(default_factory=dict)
    keybinds: Mapping[int, KeyboundOverride] = field(default_factory=dict)
    delivery: Sequence[Delivery] = ()
    attributes: Mapping[str, Sequence[int]] = field(default_factory=dict)
    alt_names: Mapping[int, str] = field(default_factory=dict)
    kit_names: Sequence[tuple[int, str]] = ()
    """The named sound kits this pack reaches, from the pinned build."""

    # What this layer derived from them.
    visuals: SpellVisuals = field(default_factory=SpellVisuals)
    """What the graph walk attributed to each spell."""

    icons: IconIndex = field(default_factory=IconIndex)
    """The deduped icon table and each spell's place in it."""

    paths: Mapping[int, str] = field(default_factory=dict)
    """File id to asset path, in the listfile's own casing.

    Resolved once for every file id the build references, since the listfile is
    far too large to consult per lookup.
    """

    references: References = field(default_factory=References)
    """Every file id the build reaches, split by what names it."""

    displays: ResolvedDisplays = field(default_factory=ResolvedDisplays)
    """The morph and shapeshift rows, flattened and resolved."""

    prose: CookedText = field(default_factory=CookedText)
    """The description templates, cooked to placeholder-free text."""

    # What the build declares rather than reads from any table.
    anim_names: Sequence[str] = ()
    anim_emote_oneshots: Sequence[int] = ()
    anim_emote_loops: Sequence[int] = ()
    gobs: Mapping[int, int] = field(default_factory=dict)
    """Model file id to the id `.gob spawn` takes for it."""

    expansions: Sequence[Mapping[str, Any]] = ()
    """The expansion ladder, oldest first."""

    era_of: Mapping[int, int] = field(default_factory=dict)
    """Spell to its rung in `expansions`; absent means no rung claims it."""

    def reads(self, declared: Iterable[str]) -> Reads:
        """This context narrowed to the named fields."""
        return Reads(self, declared)


CONTEXT_FIELDS = frozenset(existing.name for existing in fields(DeriveContext))
"""Every field a section may declare in its `reads`.

Read once here rather than per registration: the registry checks a declaration
against it, so a section naming a field that does not exist fails when it is
declared rather than when some build finally runs its `produce`.
"""
