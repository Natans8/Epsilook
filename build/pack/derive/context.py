"""The shared context every section's ``produce`` receives."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, fields, replace
from typing import Any

from ..build import Build
from ..declarations import Declarations
from ..routes import (AreaGates, CreatureModels, Delivery, FxPayloads,
                      GameObjectData, ItemModels, KeyboundOverride, KitEffects,
                      ModelSources, MountData, ProcEffects, ShapeshiftForms,
                      SpellEffectRows, SpellNames, SpellProperties, SpellText,
                      VehicleSeats, VisualGraph, VisualMissiles)
from .displays import ResolvedDisplays
from .icons import IconIndex
from .prose import CookedText
from .references import References
from .rows import PackRows
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
    anim_replacements: Mapping[int, set[tuple[int, int]]] = field(
        default_factory=dict)
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

    rows: PackRows = field(default_factory=PackRows)
    """Every flattening at least two sections read."""

    prose: CookedText = field(default_factory=CookedText)
    """The description templates, cooked to placeholder-free text."""

    declared: Declarations = field(default_factory=Declarations)
    """What the build was told rather than read: the ladders, the checked-in
    vocabularies, and the published enum names."""

    def reads(self, declared: Iterable[str]) -> Reads:
        """This context narrowed to the named fields."""
        return Reads(self, declared)

    def spoken_in(self, spoken: Spoken) -> DeriveContext:
        """This same build, with everything the language changes replaced.

        Everything else is kept rather than read again, and that is the
        invariant the whole locale pass rests on: a section's structure column
        and its language column ship in different modules and are joined by
        position, so the ids, the counts and the order they were built in have
        to be one build's rather than two reads that agreed.
        """
        return replace(self, **{name: getattr(spoken, name)
                                for name in SPOKEN_FIELDS})


@dataclass(frozen=True)
class Spoken:
    """Everything about a build that changes with the language it is read in.

    The exact slice of the context a locale pass rebuilds: the names the game
    translates, the templates it writes them into, and the prose cooked out of
    them. Declared as a record rather than as a list of field names so that
    what a locale pass must produce and what the context will accept are one
    thing -- a field added here without a route to fill it does not compile,
    and a field left out is one the pack would ship in English under another
    language's name.
    """

    names: SpellNames
    """The spell list, its subtexts, and the names spells rename targets to."""

    alt_names: Mapping[int, str]
    """Each spell's override names, folded into one searchable string."""

    templates: SpellText
    """The raw description templates, which are written per language."""

    creatures: CreatureModels
    """Creature names, which morphs and summons both read."""

    items: ItemModels
    """Item display names."""

    mounts: MountData
    """Mount display names."""

    objects: GameObjectData
    """Placed object names."""

    forms: ShapeshiftForms
    """Shapeshift form names."""

    areas: AreaGates
    """Gated area names."""

    prose: CookedText
    """The templates cooked with this language's own wording."""


CONTEXT_FIELDS = frozenset(existing.name for existing in fields(DeriveContext))
"""Every field a section may declare in its `reads`.

Read once here rather than per registration: the registry checks a declaration
against it, so a section naming a field that does not exist fails when it is
declared rather than when some build finally runs its `produce`.
"""

SPOKEN_FIELDS = frozenset(existing.name for existing in fields(Spoken))
"""Every context field that carries the game's own language.

What a locale pass rebuilds, and what the registry checks a localizable section
against: a section shipping translated text must read at least one of these, or
its column would be the same in every language with nothing to say so.
"""
