"""The spell list itself: id -> name, and the names a spell can take on.

The name table is the spell list: a spell exists for this build only if it has
a name row, and every route downstream filters against it. Which table carries
the name drifted -- `SpellName.db2` was split out of `Spell.db2` in BfA -- so
the source is declared in `SPELL_NAME_SOURCES`, first candidate the build has.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field

from ..drift import SPELL_NAME_SOURCES
from ..progress import log
from ..tables import Tables
from .columns import to_int


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


def read_spell_names(tables: Tables) -> SpellNames:
    """Read the spell list and its subtexts.

    A build with no name source is fatal: an empty spell list would look like a
    successful build of nothing.
    """
    source = next(((table, columns) for table, columns in SPELL_NAME_SOURCES
                   if tables.available(table)), None)
    if source is None:
        sys.exit("error: no spell-name source for this build; tried "
                 + ", ".join(table for table, _ in SPELL_NAME_SOURCES))
    table, columns = source
    log(f"  spell names from {table}.{columns[1]}")

    spells = SpellNames()
    for spell_id, name in tables.rows(table, columns):
        spells.names[to_int(spell_id)] = name
    for spell_id, subtext in tables.rows("Spell", ["ID", "NameSubtext_lang"]):
        identifier = to_int(spell_id)
        if identifier in spells.names and subtext:
            spells.subtexts[identifier] = subtext
    return spells


def read_override_names(tables: Tables,
                        by_spell: dict[int, set[int]]) -> dict[int, str]:
    """Spell -> its override names as one searchable string.

    `by_spell` is which SpellOverrideName ids each spell's auras name. Resolved
    in sorted id order so the string is stable across builds.
    """
    names = {to_int(override_id): name for override_id, name
             in tables.rows("SpellOverrideName", ["ID", "OverrideName_lang"])}
    resolved = {spell: " ".join(names[identifier] for identifier in sorted(identifiers)
                                if identifier in names)
                for spell, identifiers in by_spell.items()}
    return {spell: text for spell, text in resolved.items() if text}
