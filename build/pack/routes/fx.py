"""The payload tables behind the effects a kit plays.

Six unrelated tables a kit reaches by effect type. Each declaration names the
columns it takes, keeping the visible core and dropping the renderer tuning:
tuning is a column that changes how a thing is drawn, and geometry that
changes where it is drawn is content.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from .colors import RGB_MASK, channel, pack_rgb
from .columns import to_float
from .flow import Cell, as_text, number_of

SCREEN_EFFECT_FOG = 3
"""The screen effect whose parameter carries a fog tint rather than a grade."""

TEX_OVERLAY, TEX_MASK = 0, 1
"""What a texture is for. A mask is flat grey, meaningless untinted and painted
by the grade colours; an overlay is finished art in its own colours."""

ARGB_ALPHA_SHIFT = 24

WAVE_VISIBLE = 0.5
"""The wave height below which a ripple is not a ripple anyone sees.

A frequency with no amplitude is a wave nobody can see, and most chains carry
one: a non-zero test would call two thirds of them wavy, and at this height
the word sits level with its siblings.
"""

Vignette = tuple[float, float, float]
Textures = tuple[tuple[int, int], ...]


class ChainEffect(NamedTuple):
    """One SpellChainEffects row: everything a beam segment draws with.

    Named rather than a bare six-tuple because every reader wants a different
    slot of it -- the colours, the sound, the textures, the segments it nests
    -- and an index says nothing about which.
    """

    red: int
    green: int
    blue: int
    sound: int
    """The sound kit played while the beam holds, or 0."""
    textures: tuple[int, ...]
    """Deduplicated but kept in slot order, which is what the renderer layers
    them in."""
    nested: tuple[int, ...]
    """The chains this one draws in turn. The graph may contain a cycle."""
    arcing: bool = False
    """Whether the beam bows away from the straight line between its ends."""
    flickering: bool = False
    """Whether the beam switches on and off while it holds."""
    jagged: bool = False
    """Whether the beam's joints scatter off the line, as lightning does."""
    wavy: bool = False
    """Whether the beam ripples along its length, at a visible amplitude."""
    width: float = 0.0
    """How wide the beam starts, in yards."""


class Beam(NamedTuple):
    """One BeamEffect row: the chain it draws, and the two ends it attaches at.

    The pair rides with the chain rather than with either end, and the chains
    the drawn one nests inherit it: they are segments of the same beam.
    """

    chain: int
    source: int
    destination: int


class Dissolve(NamedTuple):
    """One DissolveEffect row: how long, painted with what, anchored where.

    The geometry columns are renderer tuning; the attachment is not. -1 here
    means the whole body rather than unset, so it is kept.
    """

    duration: float
    textures: tuple[int, ...]
    attachment: int


class Shadowy(NamedTuple):
    """One ShadowyEffect row: two packed colours and where it anchors.

    Stored as signed ARGB, so the alpha byte is masked off; the attachment
    reads like the dissolve's.
    """

    primary: int
    secondary: int
    attachment: int


@dataclass
class ScreenRow:
    """One screen effect: what it does to the whole frame while its aura holds.

    A colour of -1 means the row carries none, which is not the same as black.

    A row is a bundle rather than one thing: the paint it puts on the frame,
    the light preset it applies, the sound it swaps to and the hour it pins
    are four independent payloads, and most rows carry only some of them.
    They are read together because they share a row, and separated by the
    sections that ship them.
    """

    name: str = ""
    """The row's own internal name."""
    fog: int = -1
    """The packed fog tint, for the rows that are fog."""
    fog_alpha: int = -1
    """How opaque the fog is, 0..255."""
    mul: int = -1
    """The grade colour the frame is multiplied by."""
    add: int = -1
    """The grade colour added to the frame."""
    mask: Vignette = (0.0, 0.0, 0.0)
    """The radial vignette shaping where the grade applies. A size of 0 means
    the row has no full-screen effect to shape."""
    textures: Textures = ()
    """The textures it draws, each with the role it plays."""
    sky: int = 0
    """The `LightParams` preset it applies, or zero for a row that applies none.

    Independent of everything above it: a row may carry a preset and no paint at
    all, which is a sky change wearing a screen effect's id.
    """
    sky_fade: tuple[int, int] = (0, 0)
    """How long the preset takes to fade in and back out, in milliseconds."""
    ambience: int = 0
    """The `SoundAmbience` it swaps the surroundings to, or zero for none."""
    music: int = 0
    """The `ZoneMusic` it plays over the top, or zero for none."""
    time_of_day: int = -1
    """The minute of the day it pins the sky to, or -1 to leave the clock alone."""

    @classmethod
    def of(  # noqa: PLR0913  -- one parameter per column of the two rows it is read from
        cls,
        name: str,
        parameter: int,
        effect: int,
        mul_red: int | None,
        mul_green: int | None,
        mul_blue: int | None,
        add_red: int | None,
        add_green: int | None,
        add_blue: int | None,
        overlay: int,
        blended: tuple[int, ...],
        offset: float,
        size: float,
        power: float,
        sky: int,
        fade_in: int,
        fade_out: int,
        ambience: int,
        music: int,
        hour: int,
    ) -> ScreenRow:
        """A screen row from its own columns and its full-screen row's, in order.

        The fog parameter is AARRGGBB, not the RRGGBBXX the wiki claims. The
        vignette is content, not tuning: it decides where the grade lands, so
        an area effect is a coloured rim around a clear centre. A screen with
        no full-screen row reads its grade columns as nothing, and carries no
        grade rather than a black one.
        """
        is_fog = effect == SCREEN_EFFECT_FOG
        graded = None not in (mul_red, mul_green, mul_blue, add_red, add_green, add_blue)
        roles: dict[int, int] = {}
        if overlay:
            roles[overlay] = TEX_OVERLAY
        for file in blended:
            roles.setdefault(file, TEX_MASK)
        return cls(
            name=name,
            fog=(parameter & RGB_MASK) if is_fog else -1,
            fog_alpha=((parameter & 0xFFFFFFFF) >> ARGB_ALPHA_SHIFT) & 0xFF if is_fog else -1,
            mul=pack_rgb(mul_red or 0, mul_green or 0, mul_blue or 0) if graded else -1,
            add=pack_rgb(add_red or 0, add_green or 0, add_blue or 0) if graded else -1,
            mask=(offset, size, power),
            textures=tuple(roles.items()),
            sky=sky,
            sky_fade=(fade_in, fade_out),
            ambience=ambience,
            music=music,
            time_of_day=hour,
        )


@dataclass
class FxPayloads:
    """Every fx payload table, keyed by its own row id."""

    chains: Mapping[int, ChainEffect] = field(default_factory=dict)
    """Chain -> what it draws."""
    beams: Mapping[int, Beam] = field(default_factory=dict)
    """Beam -> the chain it draws and its two attachments."""
    dissolves: Mapping[int, Dissolve] = field(default_factory=dict)
    glows: Mapping[int, int] = field(default_factory=dict)
    """Edge glow -> its packed colour, which is the whole visible payload."""
    glow_alphas: Mapping[int, int] = field(default_factory=dict)
    """Edge glow -> its alpha, a real 0..255 spread rather than a flag."""
    shadowies: Mapping[int, Shadowy] = field(default_factory=dict)
    screens: Mapping[int, ScreenRow] = field(default_factory=dict)
    """Screen effect -> its payload."""
    visual_screens: Mapping[int, int] = field(default_factory=dict)
    """The kit's route into a screen effect: `SpellVisualScreenEffect` -> `ScreenEffect`."""


# The readers a cell goes through on its way into these records.


def grade(cell: Cell) -> int | None:
    """A full-screen colour column as a channel byte, or None where the screen
    has no full-screen row and the join left the column empty."""
    return None if cell == "" else channel(cell)


def seconds(cell: Cell) -> float:
    """A duration column to a hundredth of a second, nought where it is empty."""
    return to_float(as_text(cell), 2) if cell else 0


def positive(cell: Cell) -> bool:
    """Whether a tuning column is set at all, which is what makes it a trait."""
    return number_of(cell) > 0


def visible_wave(cell: Cell) -> bool:
    """Whether a wave height clears the threshold below which nobody sees it."""
    return number_of(cell) >= WAVE_VISIBLE


def yards(cell: Cell) -> float:
    """A width column to a hundredth of a yard."""
    return round(number_of(cell), 2)


def thousandths(cell: Cell) -> float:
    """A vignette column to a thousandth."""
    return to_float(as_text(cell), 3)
