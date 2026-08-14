"""The fan-out point: one row, ten tables, and the double dispatch."""

from __future__ import annotations

from pack.routes.attachments import NO_ATTACHMENT, NO_MOTION
from pack.routes.fx import FxPayloads, ScreenRow
from pack.routes.kits import read_kit_effects
from pack.routes.models import MODEL_CAT_AREA, MODEL_CAT_BARRAGE, MODEL_CAT_TRAIL, ModelSources
from pack.routes.procedures import ProcEffects
from pack.routes.sounds import read_soundkit_files
from support import BuildTables

SPELL_VISUAL_ANIM = """\
ID,InitialAnimID,LoopAnimID,AnimKitID
60,12,0,700
61,0,-1,0
"""

# One row per effect type, plus the rows whose payload this build lacks.
SPELL_VISUAL_KIT_EFFECT = """\
ParentSpellVisualKitID,EffectType,Effect
1,5,300
1,6,60
1,6,61
2,1,10
3,1,11
4,1,12
5,1,13
6,13,80
7,11,400
7,11,999
8,12,500
9,7,600
10,8,20
11,17,30
12,19,40
13,19,41
0,5,300
14,5,0
"""

MODELS = ModelSources(
    attach_models={1: {(8000, 0, 5, NO_ATTACHMENT, 0, NO_MOTION)}},
    attach_anims={1: {17}}, attach_animkits={1: {42}},
    emission_fid={20: 8300}, barrage_fid={30: 8400}, barrage_attach={30: 3})

PROCS = ProcEffects(
    chain={10: 70}, tints={11: 0xFF0000}, freezes={12},
    models={13: (8500, MODEL_CAT_TRAIL, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION)},
    anims={13: ((0, 12),)})

FX = FxPayloads(
    chains={70: (0, 0, 0, 0, (), (71,)), 71: (0, 0, 0, 0, (), ())},
    beam_chain={80: (70, 1, 2)},
    dissolves={400: (1.0, (), -1)}, glows={500: 0xFF0000},
    shadowies={600: (0, 0, -1)},
    screens={90: ScreenRow(name="Shaman - Hex")}, svse_screen={40: 90, 41: 99})

SOUND_KIT_ENTRY = """\
SoundKitID,FileDataID
300,9000
300,9001
0,9002
301,0
"""


def kits(tables: BuildTables):
    return read_kit_effects(
        tables(SpellVisualAnim=SPELL_VISUAL_ANIM,
               SpellVisualKitEffect=SPELL_VISUAL_KIT_EFFECT),
        MODELS, PROCS, FX)


def test_the_attached_models_seed_the_buckets_the_walk_fills(
        tables: BuildTables) -> None:
    """They arrive from a different table; the walk unions rather than
    replaces."""
    resolved = kits(tables)
    assert (8000, 0, 5, NO_ATTACHMENT, 0, NO_MOTION) in resolved.models[1]
    assert resolved.animkits[1] == {42, 700}
    assert resolved.visual_anims[1] == {17, 12}


def test_an_unset_animation_is_not_played(tables: BuildTables) -> None:
    """0 would be Stand and -1 is unset."""
    assert kits(tables).visual_anims[1] == {17, 12}


def test_a_procedure_reaches_the_bucket_it_was_sorted_into(
        tables: BuildTables) -> None:
    """The second dispatch is a membership test, not a second decode."""
    resolved = kits(tables)
    assert resolved.tints[3] == {11}
    assert resolved.freezes == {4}
    assert resolved.models[5] == {
        (8500, MODEL_CAT_TRAIL, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION)}
    assert resolved.anims[5] == {(0, 12)}


def test_a_procedure_chain_carries_no_attachment_pair(
        tables: BuildTables) -> None:
    """It has no beam row to take them from."""
    assert kits(tables).chains[2] == {(70, NO_ATTACHMENT, NO_ATTACHMENT),
                                      (71, NO_ATTACHMENT, NO_ATTACHMENT)}


def test_a_beam_passes_its_ends_down_to_the_chains_it_nests(
        tables: BuildTables) -> None:
    """Nested chains are segments of the same beam."""
    assert kits(tables).chains[6] == {(70, 1, 2), (71, 1, 2)}


def test_a_row_pointing_at_a_payload_this_build_lacks_is_dropped(
        tables: BuildTables) -> None:
    """Not an error: an older build legitimately lacks the table."""
    resolved = kits(tables)
    assert resolved.dissolves[7] == {400}
    assert 999 not in resolved.dissolves[7]
    assert 13 not in resolved.screens


def test_the_emission_and_barrage_models_carry_their_categories(
        tables: BuildTables) -> None:
    resolved = kits(tables)
    assert resolved.models[10] == {
        (8300, MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT, 0, NO_MOTION)}
    assert resolved.models[11] == {
        (8400, MODEL_CAT_BARRAGE, 3, NO_ATTACHMENT, 0, NO_MOTION)}


def test_a_kit_or_effect_of_zero_is_skipped(tables: BuildTables) -> None:
    resolved = kits(tables)
    assert 0 not in resolved.soundkits
    assert 14 not in resolved.soundkits


def test_a_sound_kit_keeps_every_file_it_plays(tables: BuildTables) -> None:
    """The client picks between variations, so all of them are the kit's."""
    assert read_soundkit_files(
        tables(SoundKitEntry=SOUND_KIT_ENTRY)) == {300: {9000, 9001}}
