"""Colour, from the game's three spellings to the pack's one -- and to a WORD.

The game stores a colour as three 0..1 floats, the pack ships one packed
0xRRGGBB integer, and the search corpus wants neither: it wants a word.

⭐ THE WORD IS WHY THIS ROUTE EXISTS. For roughly 46% of the spells that carry
an effect colour, the tint is the only colour signal there is -- the texture
underneath is greyscale, and what makes it red is the multiply. So
`fx:"chain red"` can only work if the word is baked at build time, from the
number, before anything is searchable. The app reproduces these same buckets so
the hover panel's caption says the word that searches.
"""

from __future__ import annotations

import colorsys

# Hue boundaries in degrees, each naming everything below it and above the one
# before. Red appears twice because it wraps the circle.
HUE_WORDS = ((15, "red"), (45, "orange"), (70, "yellow"), (160, "green"),
             (200, "cyan"), (255, "blue"), (290, "purple"), (330, "pink"),
             (361, "red"))

MIN_SATURATION, MIN_VALUE = 0.15, 0.08
"""Below either, a colour carries no hue worth a word.

White, grey and near-black tints are not a colour a player would search for --
they are the absence of one -- so they name nothing rather than being forced
into the nearest bucket.
"""


def to_channel(text: str) -> int:
    """A 0..1 float colour column as a 0..255 channel byte."""
    return max(0, min(255, round(float(text or 0) * 255)))


def pack_rgb(red: int, green: int, blue: int) -> int:
    """Three 0..255 channels as one 0xRRGGBB integer -- the pack's colour form."""
    return (red << 16) | (green << 8) | blue


def unpack_rgb(color: int) -> tuple[int, int, int]:
    """A packed 0xRRGGBB colour back into its three channels."""
    return (color >> 16) & 255, (color >> 8) & 255, color & 255


def hue_word(red: int, green: int, blue: int) -> str:
    """The coarse hue word for one colour, or "" when it carries no hue."""
    hue, saturation, value = colorsys.rgb_to_hsv(red / 255, green / 255, blue / 255)
    if saturation < MIN_SATURATION or value < MIN_VALUE:
        return ""
    degrees = hue * 360
    return next((word for limit, word in HUE_WORDS if degrees < limit), "")


def hue_words(colors: tuple[int, ...]) -> str:
    """The distinct hue words of several packed colours, in the order given.

    A row may carry more than one colour -- a shadowy effect carries two -- and
    a searcher looking for either should find it, so both words ship. Negative
    entries are "no colour here" sentinels and name nothing.
    """
    words = dict.fromkeys(word for color in colors if color >= 0
                          if (word := hue_word(*unpack_rgb(color))))
    return " ".join(words)
