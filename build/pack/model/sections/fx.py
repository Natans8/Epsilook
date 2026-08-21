"""The visual effects a spell wears: chains, dissolves, and the colour families.

Several of these are one shape repeated -- a spell-to-row link, the distinct
rows, and what each row looks like -- because that is genuinely what the game
has: unrelated effect tables that all amount to a colour. They stay declared
apart rather than merged, since each names its rows in its own id space and a
reader that merged them could not say which table a row came from.
"""

from __future__ import annotations

from collections.abc import Callable

from ...derive import Reads
from ...derive.kinds import WHOLE_MODEL
from ...routes.colors import hue_word, hue_words, pack_rgb
from ..registry import register
from ..section import (Column, Layout, Scope, Section, SectionColumns, size)

WHOLE_MODEL_WORD = "full body"
"""What an overlay anchored to no point covers, and searches under.

A word rather than a blank, because "anchored nowhere" and "anchored
everywhere" are the same row in the game data and only the second is true of
what a player sees.
"""


def used(reads: Reads, bucket: str) -> list[int]:
    """The distinct rows of one family some spell reaches, sorted."""
    return sorted({row for rows in getattr(reads.visuals, bucket).values()
                   for row in rows})


def fx_chains(reads: Reads) -> SectionColumns:
    """Each drawn chain's tint and the hue word its corpus searches by."""
    ids = sorted(reads.references.chains)
    drawn = [reads.fx.chains[chain] for chain in ids]
    return {"ids": ids,
            "colors": [pack_rgb(row.red, row.green, row.blue) for row in drawn],
            "hues": [hue_word(row.red, row.green, row.blue) for row in drawn]}


def fx_textures(reads: Reads) -> SectionColumns:
    """The textures each drawn chain paints with."""
    rows = sorted((chain, fid) for chain in reads.references.chains
                  for fid in reads.fx.chains[chain].textures)
    return {"chainIds": [row[0] for row in rows], "fids": [row[1] for row in rows]}


def dissolves(reads: Reads) -> SectionColumns:
    """Each dissolve row's duration and where it is anchored."""
    ids = sorted(reads.references.dissolves)
    return {"ids": ids,
            "durations": [reads.fx.dissolves[row][0] for row in ids],
            "attaches": [reads.fx.dissolves[row][2] for row in ids]}


def dissolve_textures(reads: Reads) -> SectionColumns:
    """The textures each dissolve blends through."""
    rows = sorted((row, fid) for row in sorted(reads.references.dissolves)
                  for fid in reads.fx.dissolves[row][1])
    return {"dissolveIds": [row[0] for row in rows],
            "fids": [row[1] for row in rows]}


def colored(bucket: str, colors_of: Callable[[Reads, int], tuple[int, ...]],
            columns: dict[str, Callable[[Reads, int], object]]
            ) -> Callable[[Reads], SectionColumns]:
    """One colour family's distinct rows, their colours and their hue words."""

    def produce(reads: Reads) -> SectionColumns:
        ids = used(reads, bucket)
        made: dict[str, Column] = {"ids": ids}
        for name, of_row in columns.items():
            made[name] = [of_row(reads, row) for row in ids]
        made["hues"] = [hue_words(colors_of(reads, row)) for row in ids]
        return made

    return produce


FX_CHAINS = register(Section(
    name="fxChains",
    doc="Each drawn chain's tint, and the hue word it is searched by.",
    module="core",
    produce=fx_chains,
    columns=("ids", "colors", "hues"),
    reads=("references", "fx"),
    counts=(size("fxChains", "ids"),),
))

FX_TEXTURES = register(Section(
    name="fxTextures",
    doc="The textures each drawn chain paints with.",
    module="core",
    produce=fx_textures,
    columns=("chainIds", "fids"),
    reads=("references", "fx"),
))

DISSOLVES = register(Section(
    name="dissolves",
    doc="Each dissolve row's duration and where on the model it is anchored.",
    module="core",
    produce=dissolves,
    columns=("ids", "durations", "attaches"),
    reads=("references", "fx"),
    needs=("DissolveEffect",),
    counts=(size("dissolves", "ids"),),
))

DISSOLVE_TEXTURES = register(Section(
    name="dissolveTextures",
    doc="The textures each dissolve blends through.",
    module="core",
    produce=dissolve_textures,
    columns=("dissolveIds", "fids"),
    reads=("references", "fx"),
    needs=("DissolveEffect",),
    degraded_without=("TextureBlendSet",),
))

GLOWS = register(Section(
    name="glows",
    doc="Each edge glow's colour and opacity.",
    module="core",
    produce=colored("glows", lambda reads, row: (reads.fx.glows[row],),
                    {"colors": lambda reads, row: reads.fx.glows[row],
                     "alphas": lambda reads, row: reads.fx.glow_alphas[row]}),
    columns=("ids", "colors", "alphas", "hues"),
    reads=("visuals", "fx"),
    needs=("EdgeGlowEffect",),
    counts=(size("glows", "ids"),),
))

SHADOWIES = register(Section(
    name="shadowies",
    doc="Each shadowy effect's two colours and where it is anchored.",
    module="core",
    produce=colored("shadowies", lambda reads, row: reads.fx.shadowies[row][:2],
                    {"primaryColors": lambda reads, row: reads.fx.shadowies[row][0],
                     "secondaryColors": lambda reads, row: reads.fx.shadowies[row][1],
                     # Where the effect is anchored; -1 is the whole body.
                     "attaches": lambda reads, row: reads.fx.shadowies[row][2]}),
    columns=("ids", "primaryColors", "secondaryColors", "hues", "attaches"),
    reads=("visuals", "fx"),
    needs=("ShadowyEffect",),
    counts=(size("shadowies", "ids"),),
))

GHOST_MATS = register(Section(
    name="ghostMats",
    doc="Each ghost material's colour.",
    module="core",
    produce=colored("ghost_mats", lambda reads, row: (reads.procs.ghost_mats[row],),
                    {"colors": lambda reads, row: reads.procs.ghost_mats[row]}),
    columns=("ids", "colors", "hues"),
    reads=("visuals", "procs"),
    counts=(size("ghostMats", "ids"),),
))

TINTS = register(Section(
    name="tints",
    doc="Each model tint's colour.",
    module="core",
    produce=colored("tints", lambda reads, row: (reads.procs.tints[row],),
                    {"colors": lambda reads, row: reads.procs.tints[row]}),
    columns=("ids", "colors", "hues"),
    reads=("visuals", "procs"),
    counts=(size("tints", "ids"),),
))

ANCHOR_NAMES = register(Section(
    name="anchorNames",
    doc="Where an overlay is anchored: a point on the model, or the whole of it.",
    module="universal",
    produce=lambda reads: {"names": {**reads.declared.attachment_names,
                                     WHOLE_MODEL: WHOLE_MODEL_WORD}},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))
