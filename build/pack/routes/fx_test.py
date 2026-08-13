"""The fx payloads, and the line between renderer tuning and content."""

from __future__ import annotations

from .conftest import BuildTables
from .fx import (TEX_MASK, TEX_OVERLAY, expand_chain, read_blend_sets,
                 read_fx_payloads)

TEXTURE_BLEND_SET = """\
ID,TextureFileDataID_0,TextureFileDataID_1,TextureFileDataID_2
1,100,101,100
2,200,0,0
"""

DISSOLVE_EFFECT = """\
ID,TextureBlendSetID,Duration,AttachID
10,1,1.5,5
11,0,,-1
"""

FULL_SCREEN_EFFECT = """\
ID,ColorMultiplyRed,ColorMultiplyGreen,ColorMultiplyBlue,ColorAdditionRed,ColorAdditionGreen,ColorAdditionBlue,OverlayTextureFileDataID,TextureBlendSetID,MaskOffsetY,MaskSizeMultiplier,MaskPower
20,1,0,0,0,0,1,300,1,0.25,2.0,1.5
21,1,1,1,0,0,0,100,1,0,0,0
"""

# Screen 33 points at the full-screen row whose overlay texture is also in its
# blend set -- the one file that could take either role.
SCREEN_EFFECT = """\
ID,Name,Param_0,Effect,FullScreenEffectID
30,Shaman - Hex,-2143272448,3,0
31,Grade,0,8,20
32,Bare,0,8,0
33,Both,0,8,21
"""

SPELL_VISUAL_SCREEN_EFFECT = """\
ID,ScreenEffectID,ScreenEffectTypeID
40,30,0
"""

EDGE_GLOW_EFFECT = """\
ID,GlowRed,GlowGreen,GlowBlue,GlowAlpha
50,0,1,0,0.5
"""

SHADOWY_EFFECT = """\
ID,PrimaryColor,SecondaryColor,AttachPos
60,-16776961,255,-1
"""

# Chain 70 nests 71; 72 and 73 nest each other.
SPELL_CHAIN_EFFECTS = """\
ID,Red,Green,Blue,SoundKitID,TextureFileDataID_0,TextureFileDataID_1,TextureFileDataID_2,SpellChainEffectID_0,SpellChainEffectID_1,SpellChainEffectID_2,SpellChainEffectID_3,SpellChainEffectID_4,SpellChainEffectID_5,SpellChainEffectID_6,SpellChainEffectID_7,SpellChainEffectID_8,SpellChainEffectID_9,SpellChainEffectID_10
70,255,0,0,900,400,401,400,71,0,0,0,0,0,0,0,0,0,0
71,0,255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
72,0,0,255,0,0,0,0,73,0,0,0,0,0,0,0,0,0,0
73,0,0,0,0,0,0,0,72,0,0,0,0,0,0,0,0,0,0
"""

BEAM_EFFECT = """\
ID,BeamID,SourceAttachID,DestAttachID
80,70,1,2
"""


def payloads(tables: BuildTables):
    return read_fx_payloads(tables(
        TextureBlendSet=TEXTURE_BLEND_SET, DissolveEffect=DISSOLVE_EFFECT,
        FullScreenEffect=FULL_SCREEN_EFFECT, ScreenEffect=SCREEN_EFFECT,
        SpellVisualScreenEffect=SPELL_VISUAL_SCREEN_EFFECT,
        EdgeGlowEffect=EDGE_GLOW_EFFECT, ShadowyEffect=SHADOWY_EFFECT,
        SpellChainEffects=SPELL_CHAIN_EFFECTS, BeamEffect=BEAM_EFFECT))


def test_a_blend_set_keeps_slot_order_and_drops_repeats(
        tables: BuildTables) -> None:
    """The order is what the renderer layers them in, so it is not a set."""
    assert read_blend_sets(tables(TextureBlendSet=TEXTURE_BLEND_SET)) == {
        1: (100, 101), 2: (200,)}


def test_a_build_predating_the_blend_set_table_reads_nothing(
        tables: BuildTables) -> None:
    """⛔ Asking what shape an array field takes must not be what decides
    whether the build survives: the table is declared optional, so a build that
    predates it loses its dissolve materials and screen masks rather than
    failing."""
    assert read_blend_sets(tables()) == {}


def test_a_build_predating_the_fx_tables_yields_no_payloads(
        tables: BuildTables) -> None:
    """Every one of them is declared optional, so the categories switch
    themselves off together."""
    payloads = read_fx_payloads(tables(
        SpellChainEffects=SPELL_CHAIN_EFFECTS, BeamEffect=BEAM_EFFECT))
    assert payloads.dissolves == {}
    assert payloads.glows == {}
    assert payloads.screens == {}


def test_a_dissolve_carries_its_blend_sets_textures(tables: BuildTables) -> None:
    assert payloads(tables).dissolves[10] == (1.5, (100, 101), 5)


def test_an_unanchored_dissolve_keeps_its_minus_one(tables: BuildTables) -> None:
    """⛔ Unlike a model attachment, -1 here means the WHOLE body rather than
    "unset", so dropping it would lose what the row says."""
    assert payloads(tables).dissolves[11] == (0, (), -1)


def test_the_vignette_survives(tables: BuildTables) -> None:
    """⛔ The correction this route is written around: it decides WHERE the
    grade lands, so an area effect is a rim around a clear centre."""
    assert payloads(tables).screens[31].mask == (0.25, 2.0, 1.5)


def test_a_screen_with_no_full_screen_row_has_no_vignette(
        tables: BuildTables) -> None:
    """A size of 0 is what says there is nothing to shape."""
    screen = payloads(tables).screens[32]
    assert screen.mask == (0.0, 0.0, 0.0)
    assert (screen.mul, screen.add) == (-1, -1)


def test_the_two_texture_roles_are_kept_apart(tables: BuildTables) -> None:
    """A mask is meaningless untinted and an overlay is finished art, so a
    preview that swaps them is wrong either way round."""
    assert set(payloads(tables).screens[31].textures) == {
        (300, TEX_OVERLAY), (100, TEX_MASK), (101, TEX_MASK)}


def test_a_file_in_both_roles_keeps_the_overlay(tables: BuildTables) -> None:
    """It is the finished art either way, and painting it as a mask would tint
    art that already has its own colours.

    The same file id is a mask on the screen that only blend-sets it, so this
    is the role being decided rather than the file carrying one.
    """
    resolved = payloads(tables)
    assert dict(resolved.screens[31].textures)[100] == TEX_MASK
    assert dict(resolved.screens[33].textures)[100] == TEX_OVERLAY


def test_the_fog_parameter_is_argb(tables: BuildTables) -> None:
    """⛔ Not the RRGGBBXX the wiki claims: the top byte is opacity, verified
    against the rows whose colours are known from the game."""
    screen = payloads(tables).screens[30]
    assert screen.fog == 0x404200
    assert screen.fog_alpha == 0x80


def test_a_non_fog_screen_carries_no_fog(tables: BuildTables) -> None:
    """-1 says the row has none, which is not the same as black."""
    screen = payloads(tables).screens[31]
    assert (screen.fog, screen.fog_alpha) == (-1, -1)


def test_a_glow_packs_its_colour_and_keeps_its_alpha(tables: BuildTables) -> None:
    """The alpha is a real spread rather than a set flag, so it is shown."""
    assert payloads(tables).glows[50] == 0x00FF00
    assert payloads(tables).glow_alphas[50] == 128


def test_a_ghost_masks_the_alpha_off_both_colours(tables: BuildTables) -> None:
    """Stored as signed ARGB, so the top byte is not colour."""
    assert payloads(tables).shadowies[60] == (0x0000FF, 0x0000FF, -1)


def test_a_chain_keeps_its_colour_sound_and_textures(tables: BuildTables) -> None:
    red, green, blue, sound, textures, nested = payloads(tables).chains[70]
    assert (red, green, blue, sound) == (255, 0, 0, 900)
    assert textures == (400, 401)
    assert nested == (71,)


def test_a_beam_carries_both_of_its_ends(tables: BuildTables) -> None:
    """The pair rides with the chain it draws rather than with either end."""
    assert payloads(tables).beam_chain[80] == (70, 1, 2)


def test_expanding_a_chain_reaches_what_it_nests(tables: BuildTables) -> None:
    reached: set[int] = set()
    expand_chain(payloads(tables).chains, 70, reached)
    assert reached == {70, 71}


def test_a_chain_cycle_terminates(tables: BuildTables) -> None:
    """Guarded on membership rather than depth, so a pair that nest each other
    stops instead of recursing forever."""
    reached: set[int] = set()
    expand_chain(payloads(tables).chains, 72, reached)
    assert reached == {72, 73}
