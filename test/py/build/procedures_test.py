"""One table, thirteen meanings: what the Type dispatch has to get right."""

from __future__ import annotations

from pack.routes.attachments import NO_ATTACHMENT, NO_MOTION
from pack.routes.models import (MODEL_CAT_AREA, MODEL_CAT_TRAIL, SCALE_UNIT,
                                UNPLACED, AttachModel, ModelSources)
from pack.routes.procedures import ProcEffects, read_proc_effects
from support import BuildTables

# One row per handler, plus the say-nothing cases each handler drops.
SPELL_PROCEDURAL_EFFECT = """\
ID,Type,Value_0,Value_1,Value_2,Value_3
1,0,55,0,0,0
2,26,56.0,0,0,0
3,1,16711680,0,0,0
4,23,0,0,0,255
5,23,0,0,0,0
6,22,0,0,0,65280
7,22,0,0,0,0
8,21,0,0,0.5,0
9,21,0,0,0,0
10,14,0.25,0,0,0
11,14,0,0,0,0
12,11,0,0,0,0
13,18,0,0,0,0
14,9,200,0,0,0
15,9,999,0,0,0
16,27,500,0,0,0
17,7,12,0,13,0
18,7,0,0,0,0
19,1,4294901760,0,0,0
"""

MODELS = ModelSources(area_model_fid={200: 8300}, weapontrail_fid={500: 8400})


def procs(tables: BuildTables) -> ProcEffects:
    return read_proc_effects(
        tables(SpellProceduralEffect=SPELL_PROCEDURAL_EFFECT), MODELS)


def test_every_chain_type_reaches_one_bucket(tables: BuildTables) -> None:
    """Three Types mean chain, and one of them spells its value as a float."""
    assert procs(tables).chain == {1: 55, 2: 56}


def test_a_tint_keeps_three_bytes(tables: BuildTables) -> None:
    assert procs(tables).tints[3] == 0xFF0000


def test_the_fourth_byte_is_not_colour(tables: BuildTables) -> None:
    """A packed colour is three bytes."""
    assert procs(tables).tints[19] == 0xFF0000


def test_a_material_recolour_reads_its_own_column(tables: BuildTables) -> None:
    """The payload column differs per Type."""
    assert procs(tables).tints[4] == 255


def test_a_colourless_tint_folds_in_as_black(tables: BuildTables) -> None:
    """Deliberately unlike the ghost case: black multiplies the model down to
    darkness."""
    assert procs(tables).tints[5] == 0


def test_a_colourless_ghost_is_dropped(tables: BuildTables) -> None:
    """A ghost with no colour has nothing to show."""
    resolved = procs(tables)
    assert resolved.ghost_mats == {6: 0x00FF00}
    assert 7 not in resolved.ghost_mats


def test_a_strength_becomes_a_whole_percent(tables: BuildTables) -> None:
    assert procs(tables).desats == {8: 50}
    assert procs(tables).transps == {10: 25}


def test_a_strength_of_zero_is_not_an_effect(tables: BuildTables) -> None:
    """A percentage of zero would render as a claim that something happened."""
    resolved = procs(tables)
    assert 9 not in resolved.desats
    assert 11 not in resolved.transps


def test_the_valueless_types_are_membership(tables: BuildTables) -> None:
    resolved = procs(tables)
    assert resolved.freezes == {12}
    assert resolved.camos == {13}


def test_a_model_procedure_resolves_through_its_own_table(
        tables: BuildTables) -> None:
    """Two Types reach two tables and land in one bucket, tagged by category."""
    assert procs(tables).models == {
        14: AttachModel(8300, MODEL_CAT_AREA, NO_ATTACHMENT, NO_ATTACHMENT, 0,
                         NO_MOTION, UNPLACED, SCALE_UNIT),
        16: AttachModel(8400, MODEL_CAT_TRAIL, NO_ATTACHMENT, NO_ATTACHMENT, 0,
                         NO_MOTION, UNPLACED, SCALE_UNIT),
    }


def test_a_model_that_does_not_resolve_is_dropped(tables: BuildTables) -> None:
    assert 15 not in procs(tables).models


def test_an_animation_pairs_with_the_slot_it_replaces(
        tables: BuildTables) -> None:
    """A value is meaningless without the base it stands in for. Slot 4 (Walk)
    is left alone here, so it contributes no pair."""
    assert procs(tables).anims == {17: ((0, 12), (5, 13))}


def test_an_animation_row_replacing_nothing_is_dropped(
        tables: BuildTables) -> None:
    assert 18 not in procs(tables).anims
