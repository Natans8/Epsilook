"""Colour: the game's three floats, or its signed ARGB, to the pack's packed integer.

The pack ships colours and never the words for them. What a colour is called
is a question about the reader's language, so it is answered where the query
is read rather than baked into every pack.
"""

from .columns import to_float
from .flow import Cell, as_text, key_of

RGB_MASK = 0xFFFFFF
"""The colour half of a packed value. Several tables store a colour as signed
ARGB, where the top byte is opacity rather than colour."""


def to_channel(text: str) -> int:
    """A 0..1 float colour column as a 0..255 channel byte."""
    return max(0, min(255, round(to_float(text) * 255)))


def channel(cell: Cell) -> int:
    """A 0..1 colour cell as a 0..255 channel byte."""
    return to_channel(as_text(cell))


def rgb_of(cell: Cell) -> int:
    """A colour cell stored as signed ARGB, its alpha byte masked off."""
    return key_of(cell) & RGB_MASK


def pack_rgb(red: int, green: int, blue: int) -> int:
    """Three 0..255 channels as one 0xRRGGBB integer -- the pack's colour form."""
    return (red << 16) | (green << 8) | blue
