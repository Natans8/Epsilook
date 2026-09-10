"""The spell list itself: id -> name, and the names a spell can take on.

The name table is the spell list: a spell exists for this build only if it has
a name row, and every route downstream filters against it. Which table carries
the name drifted -- `SpellName.db2` was split out of `Spell.db2` in BfA -- so
the source is declared in `SPELL_NAME_SOURCES`, first candidate the build has.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping
from dataclasses import dataclass, field

from ..drift import SPELL_NAME_SOURCES


@dataclass
class SpellNames:
    """The spell list, and the two other things a spell can be called."""

    names: dict[int, str] = field(default_factory=dict)
    """Spell id -> name. Membership is the spell list."""

    subtexts: dict[int, str] = field(default_factory=dict)
    """Spell id -> the parenthetical rank or variant under the name, for the
    builds and spells that have one."""

    overrides: dict[int, str] = field(default_factory=dict)
    """Spell id -> every name it can rename its target to, as one string.

    Search corpus only, never displayed: a spell may carry several and picks
    among them at cast time, so there is no single answer to print.
    """

    @classmethod
    def assemble(cls, names: Mapping[int, str], subtexts: Mapping[int, str]) -> SpellNames:
        """The list and its subtexts; a build with no name source is fatal,
        since an empty spell list would look like a successful build of
        nothing."""
        if not names:
            sys.exit(
                "error: no spell-name source for this build; tried "
                + ", ".join(table for table, _ in SPELL_NAME_SOURCES)
            )
        return cls(dict(names), {spell: text for spell, text in subtexts.items() if spell in names})


def override_names(names: Mapping[int, str], by_spell: Mapping[int, set[int]]) -> dict[int, str]:
    """Spell -> its override names as one searchable string, in id order so
    the string is stable across builds."""
    resolved = {
        spell: " ".join(names[identifier] for identifier in sorted(identifiers) if identifier in names)
        for spell, identifiers in by_spell.items()
    }
    return {spell: text for spell, text in resolved.items() if text}
