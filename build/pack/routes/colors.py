"""Colour: the game's three floats to the pack's packed integer, and to a word.

The word is baked here because many effect textures are greyscale and take
their colour from the tint alone. The app reproduces these buckets so the hover
caption says the word that searches.
"""

from __future__ import annotations

import colorsys

# Hue boundaries in degrees, each naming everything below it and above the one
# before. Red appears twice because it wraps the circle.
HUE_WORDS = ((15, "red"), (45, "orange"), (70, "yellow"), (160, "green"),
             (200, "cyan"), (255, "blue"), (290, "purple"), (330, "pink"),
             (361, "red"))

MIN_SATURATION, MIN_VALUE = 0.15, 0.08
"""Below either, a colour names no hue: white, grey and near-black are the
absence of one rather than a colour anyone searches for."""

RGB_MASK = 0xFFFFFF
"""The colour half of a packed value. Several tables store a colour as signed
ARGB, where the top byte is opacity rather than colour."""


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

    A negative entry is the "no colour here" sentinel and names nothing.
    """
    words = dict.fromkeys(word for color in colors if color >= 0
                          if (word := hue_word(*unpack_rgb(color))))
    return " ".join(words)
