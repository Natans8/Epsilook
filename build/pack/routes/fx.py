"""The payload tables behind the effects a kit plays.

Six unrelated tables a kit reaches by effect type. Each reader names the columns
it takes, keeping the visible core and dropping the renderer tuning: tuning is
a column that changes how a thing is drawn, and geometry that changes where it
is drawn is content.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import NamedTuple

from ..tables import Tables, array_columns
from .colors import RGB_MASK, pack_rgb, to_channel
from .columns import to_float, to_int

SCREEN_EFFECT_FOG = 3
"""The screen effect whose parameter carries a fog tint rather than a grade."""

TEX_OVERLAY, TEX_MASK = 0, 1
"""What a texture is for. A mask is flat grey, meaningless untinted and painted
by the grade colours; an overlay is finished art in its own colours."""

ARGB_ALPHA_SHIFT = 24

# (offsetY, size multiplier, power)
Vignette = tuple[float, float, float]
# ((file id, role), ...)
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


@dataclass
class ScreenRow:
    """One screen effect: what it does to the whole frame while its aura holds.

    A colour of -1 means the row carries none, which is not the same as black.
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


@dataclass
class FxPayloads:
    """Every fx payload table, keyed by its own row id."""

    chains: dict[int, ChainEffect] = field(default_factory=dict)
    """Chain -> what it draws."""

    beam_chain: dict[int, tuple[int, int, int]] = field(default_factory=dict)
    """Beam -> (the chain it draws, source attachment, destination attachment)."""

    dissolves: dict[int, tuple[float, tuple[int, ...], int]] = field(default_factory=dict)
    """Dissolve -> (duration, textures, attachment)."""

    glows: dict[int, int] = field(default_factory=dict)
    """Edge glow -> its packed colour, which is the whole visible payload."""

    glow_alphas: dict[int, int] = field(default_factory=dict)
    """Edge glow -> its alpha, a real 0..255 spread rather than a flag."""

    shadowies: dict[int, tuple[int, int, int]] = field(default_factory=dict)
    """Ghost effect -> (primary colour, secondary colour, attachment)."""

    screens: dict[int, ScreenRow] = field(default_factory=dict)
    """Screen effect -> its payload."""

    svse_screen: dict[int, int] = field(default_factory=dict)
    """The kit's route into a screen effect."""


def read_blend_sets(tables: Tables) -> dict[int, tuple[int, ...]]:
    """Blend set -> its textures, deduplicated and in slot order."""
    columns = array_columns(tables, "TextureBlendSet", "TextureFileDataID", 3)
    return {
        to_int(row[0]): tuple(dict.fromkeys(file for file in (to_int(value) for value in row[1:]) if file))
        for row in tables.rows("TextureBlendSet", ["ID", *columns])
    }


def read_full_screen_effects(
    tables: Tables, blend_sets: dict[int, tuple[int, ...]]
) -> dict[int, tuple[int, int, Vignette, Textures]]:
    """Full-screen effect -> (multiply, add, vignette, textures).

    The vignette is content, not tuning: it decides where the grade lands, so
    an area effect is a coloured rim around a clear centre.
    """
    rows: dict[int, tuple[int, int, Vignette, Textures]] = {}
    for row in tables.rows(
        "FullScreenEffect",
        [
            "ID",
            "ColorMultiplyRed",
            "ColorMultiplyGreen",
            "ColorMultiplyBlue",
            "ColorAdditionRed",
            "ColorAdditionGreen",
            "ColorAdditionBlue",
            "OverlayTextureFileDataID",
            "TextureBlendSetID",
            "MaskOffsetY",
            "MaskSizeMultiplier",
            "MaskPower",
        ],
    ):
        overlay = to_int(row[7])
        # A file carrying both roles keeps the overlay one: painting finished
        # art as a mask would tint art that has its own colours.
        roles: dict[int, int] = {}
        if overlay:
            roles[overlay] = TEX_OVERLAY
        for file in blend_sets.get(to_int(row[8]), ()):
            roles.setdefault(file, TEX_MASK)
        offset, size, power = (to_float(value, 3) for value in row[9:12])
        rows[to_int(row[0])] = (
            pack_rgb(*(to_channel(value) for value in row[1:4])),
            pack_rgb(*(to_channel(value) for value in row[4:7])),
            (offset, size, power),
            tuple(roles.items()),
        )
    return rows


def read_screens(tables: Tables, full_screen: dict[int, tuple[int, int, Vignette, Textures]]) -> dict[int, ScreenRow]:
    """Screen effect -> its payload, the full-screen half folded in.

    The fog parameter is AARRGGBB, not the RRGGBBXX the wiki claims.
    """
    screens: dict[int, ScreenRow] = {}
    for screen_id, name, parameter, effect, full_screen_id in tables.rows(
        "ScreenEffect", ["ID", "Name", "Param_0", "Effect", "FullScreenEffectID"]
    ):
        is_fog = to_int(effect) == SCREEN_EFFECT_FOG
        packed = to_int(parameter)
        multiply, add, mask, textures = full_screen.get(to_int(full_screen_id), (-1, -1, (0.0, 0.0, 0.0), ()))
        screens[to_int(screen_id)] = ScreenRow(
            name=name,
            fog=(packed & RGB_MASK) if is_fog else -1,
            fog_alpha=((packed & 0xFFFFFFFF) >> ARGB_ALPHA_SHIFT) & 0xFF if is_fog else -1,
            mul=multiply,
            add=add,
            mask=mask,
            textures=textures,
        )
    return screens


def read_fx_payloads(tables: Tables) -> FxPayloads:
    """Read every fx payload table."""
    blend_sets = read_blend_sets(tables)
    payloads = FxPayloads()

    # The geometry columns are renderer tuning; the attachment is not. -1 here
    # means the whole body rather than unset, so it is kept.
    for dissolve_id, blend_set_id, duration, attach in tables.rows(
        "DissolveEffect", ["ID", "TextureBlendSetID", "Duration", "AttachID"]
    ):
        payloads.dissolves[to_int(dissolve_id)] = (
            to_float(duration, 2) if duration else 0,
            blend_sets.get(to_int(blend_set_id), ()),
            to_int(attach),
        )

    payloads.screens = read_screens(tables, read_full_screen_effects(tables, blend_sets))
    for row_id, screen_id, _type_id in tables.rows(
        "SpellVisualScreenEffect", ["ID", "ScreenEffectID", "ScreenEffectTypeID"]
    ):
        payloads.svse_screen[to_int(row_id)] = to_int(screen_id)

    # The colour is the whole visible payload; the multiplier, fade and fresnel
    # columns are tuning. The alpha is a real spread rather than a flag.
    for glow_id, red, green, blue, alpha in tables.rows(
        "EdgeGlowEffect", ["ID", "GlowRed", "GlowGreen", "GlowBlue", "GlowAlpha"]
    ):
        payloads.glows[to_int(glow_id)] = pack_rgb(to_channel(red), to_channel(green), to_channel(blue))
        payloads.glow_alphas[to_int(glow_id)] = to_channel(alpha)

    # Two packed colours stored as signed ARGB, so the alpha byte is masked off.
    # The attachment reads like the dissolve's.
    for effect_id, primary, secondary, attach in tables.rows(
        "ShadowyEffect", ["ID", "PrimaryColor", "SecondaryColor", "AttachPos"]
    ):
        payloads.shadowies[to_int(effect_id)] = (
            to_int(primary) & RGB_MASK,
            to_int(secondary) & RGB_MASK,
            to_int(attach),
        )

    # Chains nest: a composite chain names up to eleven others. The flicker and
    # wave columns are tuning.
    textures = array_columns(tables, "SpellChainEffects", "TextureFileDataID", 3)
    nested = array_columns(tables, "SpellChainEffects", "SpellChainEffectID", 11)
    for row in tables.rows("SpellChainEffects", ["ID", "Red", "Green", "Blue", "SoundKitID", *textures, *nested]):
        first = 5 + len(textures)
        chain_red, chain_green, chain_blue, sound = (to_int(value) for value in row[1:5])
        payloads.chains[to_int(row[0])] = ChainEffect(
            chain_red,
            chain_green,
            chain_blue,
            sound,
            tuple(dict.fromkeys(file for file in (to_int(value) for value in row[5:first]) if file)),
            tuple(chain for chain in (to_int(value) for value in row[first:]) if chain),
        )

    # A beam attaches at both ends, so the pair rides with the chain it draws
    # rather than with either end.
    for beam_id, chain_id, source, destination in tables.rows(
        "BeamEffect", ["ID", "BeamID", "SourceAttachID", "DestAttachID"]
    ):
        payloads.beam_chain[to_int(beam_id)] = (to_int(chain_id), to_int(source), to_int(destination))
    return payloads


def expand_chain(chains: Mapping[int, ChainEffect], chain_id: int, into: set[int]) -> None:
    """Add a chain and every chain it nests to `into`.

    A worklist, not a recursion: the graph may contain a cycle. Membership in
    `into` is both the cycle stop and the visited set.
    """
    queue = [chain_id]
    while queue:
        current = queue.pop()
        if current in into or current not in chains:
            continue
        into.add(current)
        queue.extend(chains[current].nested)
