"""The payload tables behind the effects a kit plays: beams, dissolves, glows,
ghosts and full-screen grades.

Six unrelated tables with one thing in common -- a kit reaches them by effect
type, and each carries a payload that is mostly renderer tuning with a small
VISIBLE core. This route keeps the core and drops the tuning, which is why each
reader names the columns it takes rather than taking the row.

⛔ WHAT COUNTS AS TUNING WAS GOT WRONG ONCE, and the correction is the reason
the rule is written down: the full-screen mask triplet was skipped as tuning
when it is a RADIAL VIGNETTE, and area-denial effects previewed as a coloured
rim around a clear centre until it came back. Tuning is a column that changes
how a thing is drawn; geometry that changes WHERE it is drawn is content.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..tables import Tables, array_columns
from .colors import pack_rgb, to_channel
from .columns import to_int

SCREEN_EFFECT_FOG = 3
"""The screen effect whose parameter carries a fog tint rather than a grade."""

TEX_OVERLAY, TEX_MASK = 0, 1
"""What a texture is FOR, and the two are not interchangeable.

A blend-set texture is a MASK: flat grey or white, meaningless untinted, and
painted by the grade colours. An overlay texture is finished art drawn on top
in its own colours. A preview that treats one as the other is wrong either way
round, so the role ships with the texture rather than being inferred from it.
"""

ARGB_ALPHA_SHIFT = 24
RGB_MASK = 0xFFFFFF

# (offsetY, size multiplier, power)
Vignette = tuple[float, float, float]
# ((file id, role), ...)
Textures = tuple[tuple[int, int], ...]


@dataclass
class ScreenRow:
    """One screen effect: what it does to the whole frame while its aura holds.

    A colour of -1 means the row carries none, which is not the same as black.
    Gamma, saturation, blur, fades and the ambience columns are skipped.
    """

    name: str = ""
    """The row's own internal name, which is readable and worth showing."""

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
    the row has no full-screen effect at all, so there is nothing to shape."""

    textures: Textures = ()
    """The textures it draws, each with the role it plays."""


@dataclass
class FxPayloads:
    """Every fx payload table, keyed by its own row id."""

    chains: dict[int, tuple[int, int, int, int, tuple[int, ...], tuple[int, ...]]] = \
        field(default_factory=dict)
    """Chain -> (red, green, blue, sound kit, textures, nested chains)."""

    beam_chain: dict[int, tuple[int, int, int]] = field(default_factory=dict)
    """Beam -> (the chain it draws, source attachment, destination attachment)."""

    dissolves: dict[int, tuple[float, tuple[int, ...], int]] = field(default_factory=dict)
    """Dissolve -> (duration, textures, attachment)."""

    glows: dict[int, int] = field(default_factory=dict)
    """Edge glow -> its packed colour, which is the whole visible payload."""

    glow_alphas: dict[int, int] = field(default_factory=dict)
    """Edge glow -> its alpha, a real 0..255 spread rather than a set flag."""

    shadowies: dict[int, tuple[int, int, int]] = field(default_factory=dict)
    """Ghost effect -> (primary colour, secondary colour, attachment)."""

    screens: dict[int, ScreenRow] = field(default_factory=dict)
    """Screen effect -> its payload."""

    svse_screen: dict[int, int] = field(default_factory=dict)
    """The kit's route into a screen effect."""


def read_blend_sets(tables: Tables) -> dict[int, tuple[int, ...]]:
    """Blend set -> its textures, deduplicated and in slot order.

    Two consumers, which is why it is read once: a dissolve's materials and a
    screen effect's mask layers.
    """
    columns = array_columns(tables, "TextureBlendSet", "TextureFileDataID", 3)
    return {to_int(row[0]): tuple(dict.fromkeys(
        file for file in (to_int(value) for value in row[1:]) if file))
        for row in tables.rows("TextureBlendSet", ["ID", *columns])}


def read_full_screen_effects(
        tables: Tables, blend_sets: dict[int, tuple[int, ...]]
) -> dict[int, tuple[int, int, Vignette, Textures]]:
    """Full-screen effect -> (multiply, add, vignette, textures).

    ⛔ THE VIGNETTE IS CONTENT, NOT TUNING. It is what decides WHERE the grade
    lands: the offset shifts its centre and the size and power shape the
    falloff, so an area-denial effect is a coloured rim around a clear centre
    rather than an evenly tinted frame.
    """
    rows: dict[int, tuple[int, int, Vignette, Textures]] = {}
    for row in tables.rows(
            "FullScreenEffect",
            ["ID", "ColorMultiplyRed", "ColorMultiplyGreen", "ColorMultiplyBlue",
             "ColorAdditionRed", "ColorAdditionGreen", "ColorAdditionBlue",
             "OverlayTextureFileDataID", "TextureBlendSetID",
             "MaskOffsetY", "MaskSizeMultiplier", "MaskPower"]):
        overlay = to_int(row[7])
        # A file carrying both roles keeps the overlay one: it is the finished
        # art either way, and painting it as a mask would tint art that already
        # has its own colours.
        roles: dict[int, int] = {}
        if overlay:
            roles[overlay] = TEX_OVERLAY
        for file in blend_sets.get(to_int(row[8]), ()):
            roles.setdefault(file, TEX_MASK)
        offset, size, power = (round(float(value or 0), 3) for value in row[9:12])
        rows[to_int(row[0])] = (
            pack_rgb(*(to_channel(value) for value in row[1:4])),
            pack_rgb(*(to_channel(value) for value in row[4:7])),
            (offset, size, power),
            tuple(roles.items()),
        )
    return rows


def read_screens(tables: Tables,
                 full_screen: dict[int, tuple[int, int, Vignette, Textures]]
                 ) -> dict[int, ScreenRow]:
    """Screen effect -> its payload, the full-screen half folded in.

    ⛔ THE FOG PARAMETER IS AARRGGBB, not the RRGGBBXX the wiki claims. Verified
    against the rows whose colours are known from the game: the top byte is
    opacity and spreads across the whole range, so reading it the other way
    round yields a colour shifted by a byte and an opacity that is really blue.
    """
    screens: dict[int, ScreenRow] = {}
    for screen_id, name, parameter, effect, full_screen_id in tables.rows(
            "ScreenEffect", ["ID", "Name", "Param_0", "Effect", "FullScreenEffectID"]):
        is_fog = to_int(effect) == SCREEN_EFFECT_FOG
        packed = to_int(parameter)
        multiply, add, mask, textures = full_screen.get(
            to_int(full_screen_id), (-1, -1, (0.0, 0.0, 0.0), ()))
        screens[to_int(screen_id)] = ScreenRow(
            name=name,
            fog=(packed & RGB_MASK) if is_fog else -1,
            fog_alpha=((packed & 0xFFFFFFFF) >> ARGB_ALPHA_SHIFT) & 0xFF if is_fog else -1,
            mul=multiply, add=add, mask=mask, textures=textures)
    return screens


def read_fx_payloads(tables: Tables) -> FxPayloads:
    """Read every fx payload table."""
    blend_sets = read_blend_sets(tables)
    payloads = FxPayloads()

    # The geometry columns are renderer tuning, but the attachment is not: it is
    # a raw M2 point naming where on the model the effect is anchored, and -1
    # means the WHOLE body rather than "unset". So it is kept rather than
    # dropped the way an unset model attachment is.
    for dissolve_id, blend_set_id, duration, attach in tables.rows(
            "DissolveEffect", ["ID", "TextureBlendSetID", "Duration", "AttachID"]):
        payloads.dissolves[to_int(dissolve_id)] = (
            round(float(duration), 2) if duration else 0,
            blend_sets.get(to_int(blend_set_id), ()),
            to_int(attach))

    payloads.screens = read_screens(
        tables, read_full_screen_effects(tables, blend_sets))
    for row_id, screen_id, _type_id in tables.rows(
            "SpellVisualScreenEffect", ["ID", "ScreenEffectID", "ScreenEffectTypeID"]):
        payloads.svse_screen[to_int(row_id)] = to_int(screen_id)

    # The colour is the whole visible payload; the multiplier, fade and fresnel
    # columns are tuning. The alpha is a real spread rather than a set flag,
    # unlike the ghost effect's, so it is worth showing.
    for glow_id, red, green, blue, alpha in tables.rows(
            "EdgeGlowEffect",
            ["ID", "GlowRed", "GlowGreen", "GlowBlue", "GlowAlpha"]):
        payloads.glows[to_int(glow_id)] = pack_rgb(
            to_channel(red), to_channel(green), to_channel(blue))
        payloads.glow_alphas[to_int(glow_id)] = to_channel(alpha)

    # Two packed colours stored as signed ARGB, so the alpha byte is masked off.
    # The attachment reads like the dissolve's and is kept for the same reason.
    for effect_id, primary, secondary, attach in tables.rows(
            "ShadowyEffect", ["ID", "PrimaryColor", "SecondaryColor", "AttachPos"]):
        payloads.shadowies[to_int(effect_id)] = (
            to_int(primary) & RGB_MASK, to_int(secondary) & RGB_MASK, to_int(attach))

    # Chains nest: a composite chain names up to eleven others. The flicker and
    # wave columns are tuning; the colour, the sound and the textures are not.
    textures = array_columns(tables, "SpellChainEffects", "TextureFileDataID", 3)
    nested = array_columns(tables, "SpellChainEffects", "SpellChainEffectID", 11)
    for row in tables.rows("SpellChainEffects",
                           ["ID", "Red", "Green", "Blue", "SoundKitID",
                            *textures, *nested]):
        first = 5 + len(textures)
        chain_red, chain_green, chain_blue, sound = (
            to_int(value) for value in row[1:5])
        payloads.chains[to_int(row[0])] = (
            chain_red, chain_green, chain_blue, sound,
            # Deduplicated but kept in slot order: a chain may repeat a texture,
            # and the order is what the renderer layers them in.
            tuple(dict.fromkeys(file for file in
                                (to_int(value) for value in row[5:first]) if file)),
            tuple(chain for chain in
                  (to_int(value) for value in row[first:]) if chain),
        )

    # A beam attaches at BOTH ends -- source on the caster, destination on
    # whatever it connects to -- so the pair rides with the chain it draws
    # rather than with either end.
    for beam_id, chain_id, source, destination in tables.rows(
            "BeamEffect", ["ID", "BeamID", "SourceAttachID", "DestAttachID"]):
        payloads.beam_chain[to_int(beam_id)] = (
            to_int(chain_id), to_int(source), to_int(destination))
    return payloads


def expand_chain(chains: dict[int, tuple], chain_id: int, into: set[int]) -> None:
    """Add a chain and every chain it nests to `into`.

    A worklist rather than the recursion it looks like it wants to be, for the
    same two reasons the visual redirects are one: the graph may contain a
    cycle, and its depth is the data's to choose rather than ours. Membership
    in `into` is both the cycle stop and the visited set, so this terminates
    whatever shape the nesting takes and never grows the Python stack with it.
    """
    queue = [chain_id]
    while queue:
        current = queue.pop()
        if current in into or current not in chains:
            continue
        into.add(current)
        queue.extend(chains[current][5])
