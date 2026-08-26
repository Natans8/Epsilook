"""Which languages a pack ships, and what each of them is to the code.

A pack's structure is one artifact and its language is another: the ids, the
file ids and the graph between them say the same thing to everybody, and only
the names and the prose change. So a language is an axis of the build beside
the game version, and a `Locale` is what one value of that axis IS -- the code
the sources are asked for, and the wording the cooker itself contributes.

Adding a language the game ships is one row below. A language whose plural
rules no `TextLocale` covers needs one of those too, which is the only reason
that half is not here.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .spelltext import ENGLISH, FRENCH, RUSSIAN, SPANISH, TextLocale


@dataclass(frozen=True)
class Locale:
    """One language a pack is read in.

    Two fields and no third: what the sources call it, and what the cooker has
    to know to write in it. **What a reader CALLS it is the interface's, not
    the pack's** -- the pack carries string values, and naming a language in
    the reader's own language is the interface saying something about itself.
    """

    code: str
    """What the sources call it, e.g. ``ruRU``.

    The wago export and the server dump agree on this spelling, which is why
    there is one field rather than two.
    """

    text: TextLocale
    """The wording the cooker supplies: duration units, and how a plural marker
    picks among its forms."""


DEFAULT_LOCALE = "enUS"
"""The language a pack is read in when nothing asks for another.

It is what the exporters answer with when no language is named, so this one
costs no download and no second read -- the build's own tables already are it.
Every pack ships it, which is what lets a reader fall back to it without
checking.
"""

LOCALES: tuple[Locale, ...] = (
    Locale(DEFAULT_LOCALE, ENGLISH),
    Locale("ruRU", RUSSIAN),
    Locale("frFR", FRENCH),
    Locale("esES", SPANISH),
)
"""Every language the packs are built in, the default first.

What a given pack actually ships is this list narrowed by its roster row. A
client that publishes only some of these names the ones it has; one that
publishes them all says nothing. See `locales_named`.
"""


def locale_of(code: str) -> Locale:
    """The declared language with this code.

    Raises:
        KeyError: no language is declared under it. Refused rather than
            defaulted: a build asked for a language nobody declared would
            otherwise ship English under that language's name.
    """
    for locale in LOCALES:
        if locale.code == code:
            return locale
    raise KeyError(f"no locale is declared for {code!r}; declared: " + ", ".join(locale.code for locale in LOCALES))


def locales_named(codes: Sequence[str]) -> tuple[Locale, ...]:
    """The languages a caller asked for, or every one where it asked for none.

    Not every client publishes every language: Blizzard's builds do, and a
    private client need not -- Epsilon ships English alone. Which languages a
    build has is a fact about that build, so it arrives from the roster rather
    than being probed, and asking for none means "whatever is declared".

    The default is always included, even unasked: every pack ships it, and that
    is what lets a reader fall back to it without checking.

    Raises:
        KeyError: a code no language is declared under. Filtering it away
            silently would turn one typo on a roster row into a pack quietly
            shipping English alone.
    """
    if not codes:
        return LOCALES
    wanted = {DEFAULT_LOCALE, *(locale_of(code).code for code in codes)}
    return tuple(locale for locale in LOCALES if locale.code in wanted)
