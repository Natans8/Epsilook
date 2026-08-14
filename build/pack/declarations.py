"""What the build is TOLD, as against what it reads from a game table.

Every field here comes from a checked-in file, a vendored table or a published
enum definition -- never from the tables of the build being packed. That is the
whole of what unites them, and it is worth a record of its own for two reasons.

They reach a section without passing through `routes/`, so keeping them in the
derive context made that context claim to have derived things nobody derived.
And they do not vary the way the rest does: a locale build recomputes its
context over locale-qualified tables, while none of this changes with the
language. Different provenance, different lifetime, different record.

Package-root vocabulary: it holds plain values and imports no layer, so the
wiring can fill it without anything below reaching upward for it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class Declarations:
    """The tables and ladders a build is handed rather than reads."""

    anim_names: Sequence[str] = ()
    """Every animation's name, from the community list. Its INDEX is the
    animation id every route speaks in, which is why a route drops an id past
    the end of it rather than trusting one."""

    anim_emote_oneshots: Sequence[int] = ()
    anim_emote_loops: Sequence[int] = ()
    """The Epsilon emote performing each animation, parallel to `anim_names`.

    Not about the build being packed at all: an animation any build indexes is
    one a player can perform, which is why every pack carries the same columns.
    """

    gobs: Mapping[int, int] = field(default_factory=dict)
    """Model file id to the id `.gob spawn` takes for it, read from Epsilon's
    own client and vendored because no build can regenerate it."""

    expansions: Sequence[Mapping[str, Any]] = ()
    """The expansion ladder, oldest first."""

    era_of: Mapping[int, int] = field(default_factory=dict)
    """Spell to its rung in `expansions`; absent means no rung claims it."""

    effect_names: Mapping[int, str] = field(default_factory=dict)
    aura_names: Mapping[int, str] = field(default_factory=dict)
    target_names: Mapping[int, str] = field(default_factory=dict)
    """The published enum names this build resolves to, for the words it prints.

    Resolved per build because an enum's names carry build guards, and shared
    across builds whenever they come out identical -- which is a fact about the
    bytes rather than a claim made here.
    """

    target_bits: Mapping[int, int] = field(default_factory=dict)
    """Implicit target id to the caster, target or area bit it contributes."""

    item_quality_names: Any = ()
    attachment_names: Any = ()
    summon_control_names: Any = ()
    """The checked-in vocabularies the pack ships so the app names nothing
    itself. Each arrives in the shape its own declaration file has."""
