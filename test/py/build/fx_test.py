"""The fx payloads, and the line between renderer tuning and content."""

from __future__ import annotations

from pack.routes.fx import TEX_MASK, TEX_OVERLAY, FxPayloads
from support import BuildTables, resolve

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
# blend set -- the one file that could take either role. Screen 30 also swaps
# the sky and the music, and 31 the ambience and the hour: the row is a
# bundle, and each half is read whether or not the others are set.
SCREEN_EFFECT = """\
ID,Name,Param_0,Effect,FullScreenEffectID,LightParamsID,LightParamsFadeIn,LightParamsFadeOut,SoundAmbienceID,ZoneMusicID,TimeOfDayOverride
30,Shaman - Hex,-2143272448,3,0,2124,500,1000,0,1807,-1
31,Grade,0,8,20,0,0,0,22,0,720
32,Bare,0,8,0,0,0,0,0,0,-1
33,Both,0,8,21,0,0,0,0,0,-1
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

# Chain 70 nests 71; 72 and 73 nest each other. 70 has every character
# trait, and 72 ripples below the visible height.
SPELL_CHAIN_EFFECTS = """\
ID,Red,Green,Blue,SoundKitID,ArcHeight,MaxFlickerOnDuration,JointOffsetRadius,WaveHeight,StartWidth,TextureFileDataID_0,TextureFileDataID_1,TextureFileDataID_2,SpellChainEffectID_0,SpellChainEffectID_1,SpellChainEffectID_2,SpellChainEffectID_3,SpellChainEffectID_4,SpellChainEffectID_5,SpellChainEffectID_6,SpellChainEffectID_7,SpellChainEffectID_8,SpellChainEffectID_9,SpellChainEffectID_10
70,255,0,0,900,1.5,0.2,0.3,0.6,0.5,400,401,400,71,0,0,0,0,0,0,0,0,0,0
71,0,255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
72,0,0,255,0,0,0,0,0.4,1.25,0,0,0,73,0,0,0,0,0,0,0,0,0,0
73,0,0,0,0,0,0,0,0,0,0,0,0,72,0,0,0,0,0,0,0,0,0,0
"""

BEAM_EFFECT = """\
ID,BeamID,SourceAttachID,DestAttachID
80,70,1,2
"""


def payloads(tables: BuildTables) -> FxPayloads:
    found = resolve(
        "fx",
        tables(
            TextureBlendSet=TEXTURE_BLEND_SET,
            DissolveEffect=DISSOLVE_EFFECT,
            FullScreenEffect=FULL_SCREEN_EFFECT,
            ScreenEffect=SCREEN_EFFECT,
            SpellVisualScreenEffect=SPELL_VISUAL_SCREEN_EFFECT,
            EdgeGlowEffect=EDGE_GLOW_EFFECT,
            ShadowyEffect=SHADOWY_EFFECT,
            SpellChainEffects=SPELL_CHAIN_EFFECTS,
            BeamEffect=BEAM_EFFECT,
        ),
    )
    if not isinstance(found, FxPayloads):
        raise TypeError("the fx field is the payload bundle")
    return found


def test_a_build_predating_the_fx_tables_yields_no_payloads(tables: BuildTables) -> None:
    """All of them are declared optional, so the categories switch off."""
    found = resolve("fx", tables(SpellChainEffects=SPELL_CHAIN_EFFECTS, BeamEffect=BEAM_EFFECT))
    assert isinstance(found, FxPayloads)
    assert found.dissolves == {}
    assert found.glows == {}
    assert found.screens == {}


def test_a_dissolve_carries_its_blend_sets_textures(tables: BuildTables) -> None:
    """In slot order and with the repeat dropped, since the order is what the
    renderer layers them in."""
    assert payloads(tables).dissolves[10] == (1.5, (100, 101), 5)


def test_a_dissolve_whose_blend_set_this_build_lacks_paints_nothing(tables: BuildTables) -> None:
    """Asking what shape the array field takes must not decide whether the
    build survives."""
    found = resolve("dissolves", tables(DissolveEffect=DISSOLVE_EFFECT))
    assert isinstance(found, dict)
    assert found[10].textures == ()


def test_an_unanchored_dissolve_keeps_its_minus_one(tables: BuildTables) -> None:
    """Unlike a model attachment, -1 here means the whole body, not unset."""
    assert payloads(tables).dissolves[11] == (0, (), -1)


def test_the_vignette_survives(tables: BuildTables) -> None:
    """It decides where the grade lands, so an area effect is a rim around a
    clear centre."""
    assert payloads(tables).screens[31].mask == (0.25, 2.0, 1.5)


def test_a_screen_with_no_full_screen_row_has_no_vignette(tables: BuildTables) -> None:
    """A size of 0 is what says there is nothing to shape."""
    screen = payloads(tables).screens[32]
    assert screen.mask == (0.0, 0.0, 0.0)
    assert (screen.mul, screen.add) == (-1, -1)


def test_the_two_texture_roles_are_kept_apart(tables: BuildTables) -> None:
    """A mask is meaningless untinted; an overlay is finished art."""
    assert set(payloads(tables).screens[31].textures) == {(300, TEX_OVERLAY), (100, TEX_MASK), (101, TEX_MASK)}


def test_a_file_in_both_roles_keeps_the_overlay(tables: BuildTables) -> None:
    """The same file id is a mask on the screen that only blend-sets it, so the
    role is decided per screen rather than carried by the file."""
    resolved = payloads(tables)
    assert dict(resolved.screens[31].textures)[100] == TEX_MASK
    assert dict(resolved.screens[33].textures)[100] == TEX_OVERLAY


def test_the_fog_parameter_is_argb(tables: BuildTables) -> None:
    """Not the RRGGBBXX the wiki claims: the top byte is opacity."""
    screen = payloads(tables).screens[30]
    assert screen.fog == 0x404200
    assert screen.fog_alpha == 0x80


def test_a_non_fog_screen_carries_no_fog(tables: BuildTables) -> None:
    """-1 says the row has none, which is not the same as black."""
    screen = payloads(tables).screens[31]
    assert (screen.fog, screen.fog_alpha) == (-1, -1)


def test_a_glow_packs_its_colour_and_keeps_its_alpha(tables: BuildTables) -> None:
    """The alpha is a real spread rather than a flag."""
    assert payloads(tables).glows[50] == 0x00FF00
    assert payloads(tables).glow_alphas[50] == 128


def test_a_ghost_masks_the_alpha_off_both_colours(tables: BuildTables) -> None:
    """Stored as signed ARGB, so the top byte is not colour."""
    assert payloads(tables).shadowies[60] == (0x0000FF, 0x0000FF, -1)


def test_a_chain_keeps_its_colour_sound_and_textures(tables: BuildTables) -> None:
    chain = payloads(tables).chains[70]
    assert (chain.red, chain.green, chain.blue, chain.sound) == (255, 0, 0, 900)
    assert chain.textures == (400, 401)
    assert chain.nested == (71,)


def test_a_beam_carries_both_of_its_ends(tables: BuildTables) -> None:
    """The pair rides with the chain it draws rather than with either end."""
    assert payloads(tables).beams[80] == (70, 1, 2)


def test_a_screen_carries_the_sky_and_sound_it_swaps_in(tables: BuildTables) -> None:
    """Independent of the paint: a fog row still names a preset and a music set."""
    screen = payloads(tables).screens[30]
    assert screen.sky == 2124
    assert screen.sky_fade == (500, 1000)
    assert screen.music == 1807
    assert (screen.ambience, screen.time_of_day) == (0, -1)


def test_a_screen_pinning_the_hour_says_which_minute(tables: BuildTables) -> None:
    screen = payloads(tables).screens[31]
    assert screen.time_of_day == 720
    assert screen.ambience == 22


def test_a_screen_that_only_paints_swaps_nothing(tables: BuildTables) -> None:
    """Nought and minus one are the two absences, and neither is a value."""
    screen = payloads(tables).screens[32]
    assert (screen.sky, screen.music, screen.ambience, screen.time_of_day) == (0, 0, 0, -1)


def test_a_chains_character_is_read_off_its_geometry(tables: BuildTables) -> None:
    """Four words and a width: each a column the renderer tunes by, read as a
    trait a reader can name."""
    chain = payloads(tables).chains[70]
    assert (chain.arcing, chain.flickering, chain.jagged, chain.wavy) == (True, True, True, True)
    assert chain.width == 0.5


def test_a_ripple_below_the_visible_height_is_not_wavy(tables: BuildTables) -> None:
    """A non-zero test would call most chains wavy; the threshold is measured."""
    chain = payloads(tables).chains[72]
    assert not chain.wavy
    assert chain.width == 1.25
