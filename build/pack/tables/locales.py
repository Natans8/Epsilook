"""Reading a build in another language: which source restates which table.

Two sources carry the game's own words and they are read the same way, by the
same merge, differing only in what each has to declare.

The CLIENT's tables are re-exported per language, so the second export is the
same table with its text written differently -- every row, every column spelled
alike. It declares nothing but which tables it covers.

The SERVER's are not: TrinityCore keeps creature and object names in a
``*_locale`` table holding one row per entry per language, so reading one
language means refusing the other nine, and the two sides spell the name column
differently on each of the two tables. It declares the spellings and the rule
that picks a language.

Both are RESTATEMENTS rather than patches, which is the one thing that makes
them the same mechanism: a blank means unwritten, and the base decides which
rows exist. See `Overlay.restates`.

The server mapping carries no rule until `locale_overlays` fills one in.
Module-private for the reason the hotfix map is: an overlay with no rule would
union every language into one table, last one wins.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import replace

from ..sources.tdb import LOCALE_COLUMN, TDB_LOCALE_TABLES
from ..supplements import spoken
from .overlay import Overlay, reconcile

_TRANSLATIONS: Mapping[str, Overlay] = {
    # Each side spells the name column as its own table spells it, which is not
    # the same spelling: `Name` on the creature table and `name` on the object
    # one. A join on the wrong one reads as a language with nothing in it.
    "creature_template": Overlay(
        "creature_template_locale",
        {"entry": "entry", "name": "Name"},
        key="entry",
        judged_on=LOCALE_COLUMN,
        restates=True,
    ),
    "gameobject_template": Overlay(
        "gameobject_template_locale",
        {"entry": "entry", "name": "name"},
        key="entry",
        judged_on=LOCALE_COLUMN,
        restates=True,
    ),
}
"""World table -> how its translations revise it, before a language is known."""


def translated_exports(tables: Iterable[str]) -> dict[str, Overlay]:
    """Each named table, restated by the same client's export in another language.

    No column map and no rule: it is the same table from the same exporter, so
    every column is spelled alike and every row it carries counts. What makes
    it a restatement rather than a patch is that a blank means untranslated and
    the build's own copy decides which rows there are -- both of which
    `Overlay.restates` says once.

    Args:
        tables: the tables the second export covers.

    Returns:
        Table name -> how its translation restates it.
    """
    return {table: Overlay(table, restates=True) for table in tables}


def locale_overlays(code: str) -> dict[str, Overlay]:
    """The translation overlays for one language.

    Args:
        code: the locale code as the dump spells it, e.g. ``ruRU``.

    Returns:
        World table name -> how that language's rows revise it. A release that
        carries no translations at all distils the tables empty, and the merge
        then leaves every name as the dump's own tables have it.

    Raises:
        ValueError: the code is empty. Refused rather than obeyed because a
            rule admitting nothing and a rule admitting everything are one
            typo apart here, and the second would union ten languages into one
            table with no error and no log line.
    """
    if not code:
        raise ValueError(
            "locale_overlays: no language named; a blank code "
            "matches no row and would read as a language the "
            "server has nothing in"
        )
    admits = spoken(code)
    return {base: replace(overlay, admits=admits) for base, overlay in _TRANSLATIONS.items()}


def check_translation_declaration() -> list[str]:
    """Ways this map and the distiller's column list could have drifted apart.

    The same two-sided comparison the hotfix map gets, and for the same reason:
    only this one knows the world table's spelling of a column, and only the
    distiller's roster knows what was written out.

    Returns:
        One message per disagreement; empty when the two agree.
    """
    return reconcile(_TRANSLATIONS, TDB_LOCALE_TABLES["world"])
