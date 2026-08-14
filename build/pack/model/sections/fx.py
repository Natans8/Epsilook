"""The visual effects a spell wears: chains, dissolves, and the colour families.

Several of these are one shape repeated -- a spell-to-row link, the distinct
rows, and what each row looks like -- because that is genuinely what the game
has: unrelated effect tables that all amount to a colour. They stay declared
apart rather than merged, since each names its rows in its own id space and a
reader that merged them could not say which table a row came from.
"""

from __future__ import annotations

from collections import Counter

from collections.abc import Callable

from ...derive import Reads, masked_rows
from ...routes.colors import hue_word, hue_words, pack_rgb
from ...measure import numeric_domain
from ..registry import register
from ..section import Count, Domain, Section, SectionColumns


def links(bucket: str, id_column: str) -> Callable[[Reads], SectionColumns]:
    """One family's spell-to-row links, each with the audience it was aimed at."""
    def produce(reads: Reads) -> SectionColumns:
        rows = masked_rows(getattr(reads.visuals, bucket))
        return {"spellIds": [row[0] for row in rows],
                id_column: [row[1] for row in rows],
                "targets": [row[2] for row in rows]}
    return produce


def used(reads: Reads, bucket: str) -> list[int]:
    """The distinct rows of one family some spell reaches, sorted."""
    return sorted({row for rows in getattr(reads.visuals, bucket).values()
                   for row in rows})


def spell_fx(reads: Reads) -> SectionColumns:
    """Which chain effects a spell draws, and where the beam attaches."""
    rows = reads.rows.chains
    return {"spellIds": [row[0] for row in rows],
            "chainIds": [row[1] for row in rows],
            "targets": [row[2] for row in rows],
            "srcAttach": [row[3] for row in rows],
            "dstAttach": [row[4] for row in rows]}


def fx_chains(reads: Reads) -> SectionColumns:
    """Each drawn chain's tint and the hue word its corpus searches by."""
    ids = sorted(reads.references.chains)
    return {"ids": ids,
            "colors": [pack_rgb(*reads.fx.chains[chain][:3]) for chain in ids],
            "hues": [hue_word(*reads.fx.chains[chain][:3]) for chain in ids]}


def fx_textures(reads: Reads) -> SectionColumns:
    """The textures each drawn chain paints with."""
    rows = sorted((chain, fid) for chain in reads.references.chains
                  for fid in reads.fx.chains[chain][4])
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
        made: dict[str, list[object]] = {"ids": ids}
        for name, of_row in columns.items():
            made[name] = [of_row(reads, row) for row in ids]
        made["hues"] = [hue_words(colors_of(reads, row)) for row in ids]
        return made
    return produce


def percents(bucket: str, value_of: Callable[[Reads, int], int]
             ) -> Callable[[Reads], SectionColumns]:
    """A percent-only family: the percent IS the row, so there is no id table."""
    def produce(reads: Reads) -> SectionColumns:
        pairs = sorted({(spell, value_of(reads, row))
                        for spell, rows in getattr(reads.visuals, bucket).items()
                        for row in rows})
        return {"spellIds": [pair[0] for pair in pairs],
                "percents": [pair[1] for pair in pairs]}
    return produce


SPELL_FX = register(Section(
    name="spellFx",
    doc="Which chain effects a spell draws, and where the beam attaches.",
    module="core",
    produce=spell_fx,
    columns=("spellIds", "chainIds", "targets", "srcAttach", "dstAttach"),
    reads=("rows",),
    counts=(Count("spellFx", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("count.fx", lambda columns, _r: numeric_domain(
        Counter(columns["spellIds"]).values())),),
))

FX_CHAINS = register(Section(
    name="fxChains",
    doc="Each drawn chain's tint, and the hue word it is searched by.",
    module="core",
    produce=fx_chains,
    columns=("ids", "colors", "hues"),
    reads=("references", "fx"),
    counts=(Count("fxChains", lambda columns, _r: len(columns["ids"])),),
))

FX_TEXTURES = register(Section(
    name="fxTextures",
    doc="The textures each drawn chain paints with.",
    module="core",
    produce=fx_textures,
    columns=("chainIds", "fids"),
    reads=("references", "fx"),
))

SPELL_DISSOLVES = register(Section(
    name="spellDissolves",
    doc="Which dissolve effects a spell applies.",
    module="core",
    produce=links("dissolves", "dissolveIds"),
    columns=("spellIds", "dissolveIds", "targets"),
    reads=("visuals",),
    counts=(Count("spellDissolves",
                  lambda columns, _r: len(columns["spellIds"])),),
))

DISSOLVES = register(Section(
    name="dissolves",
    doc="Each dissolve row's duration and where on the model it is anchored.",
    module="core",
    produce=dissolves,
    columns=("ids", "durations", "attaches"),
    reads=("references", "fx"),
    counts=(Count("dissolves", lambda columns, _r: len(columns["ids"])),),
))

DISSOLVE_TEXTURES = register(Section(
    name="dissolveTextures",
    doc="The textures each dissolve blends through.",
    module="core",
    produce=dissolve_textures,
    columns=("dissolveIds", "fids"),
    reads=("references", "fx"),
))

SPELL_GLOWS = register(Section(
    name="spellGlows",
    doc="Which edge glows a spell applies.",
    module="core",
    produce=links("glows", "glowIds"),
    columns=("spellIds", "glowIds", "targets"),
    reads=("visuals",),
    counts=(Count("spellGlows", lambda columns, _r: len(columns["spellIds"])),),
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
    counts=(Count("glows", lambda columns, _r: len(columns["ids"])),),
))

SPELL_SHADOWIES = register(Section(
    name="spellShadowies",
    doc="Which shadowy recolours a spell applies.",
    module="core",
    produce=links("shadowies", "shadowyIds"),
    columns=("spellIds", "shadowyIds", "targets"),
    reads=("visuals",),
    counts=(Count("spellShadowies",
                  lambda columns, _r: len(columns["spellIds"])),),
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
    counts=(Count("shadowies", lambda columns, _r: len(columns["ids"])),),
))

SPELL_GHOST_MATS = register(Section(
    name="spellGhostMats",
    doc="Which ghost materials a spell applies.",
    module="core",
    produce=links("ghost_mats", "ghostIds"),
    columns=("spellIds", "ghostIds", "targets"),
    reads=("visuals",),
    counts=(Count("spellGhostMats",
                  lambda columns, _r: len(columns["spellIds"])),),
))

GHOST_MATS = register(Section(
    name="ghostMats",
    doc="Each ghost material's colour.",
    module="core",
    produce=colored("ghost_mats", lambda reads, row: (reads.procs.ghost_mats[row],),
                    {"colors": lambda reads, row: reads.procs.ghost_mats[row]}),
    columns=("ids", "colors", "hues"),
    reads=("visuals", "procs"),
    counts=(Count("ghostMats", lambda columns, _r: len(columns["ids"])),),
))

SPELL_TINTS = register(Section(
    name="spellTints",
    doc="Which model tints a spell applies.",
    module="core",
    produce=lambda reads: {
        "spellIds": [row[0] for row in masked_rows(reads.visuals.tints)],
        "tintIds": [row[1] for row in masked_rows(reads.visuals.tints)]},
    columns=("spellIds", "tintIds"),
    reads=("visuals",),
    counts=(Count("spellTints", lambda columns, _r: len(columns["spellIds"])),),
))

TINTS = register(Section(
    name="tints",
    doc="Each model tint's colour.",
    module="core",
    produce=colored("tints", lambda reads, row: (reads.procs.tints[row],),
                    {"colors": lambda reads, row: reads.procs.tints[row]}),
    columns=("ids", "colors", "hues"),
    reads=("visuals", "procs"),
    counts=(Count("tints", lambda columns, _r: len(columns["ids"])),),
))

SPELL_DESATURATES = register(Section(
    name="spellDesaturates",
    doc="How far a spell drains the colour from its subject.",
    module="core",
    produce=percents("desats", lambda reads, row: reads.procs.desats[row]),
    columns=("spellIds", "percents"),
    reads=("visuals", "procs"),
    counts=(Count("spellDesaturates",
                  lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("desaturate", lambda columns, _r: numeric_domain(
        columns["percents"])),),
))

SPELL_TRANSPARENCIES = register(Section(
    name="spellTransparencies",
    doc="How far a spell fades its subject.",
    module="core",
    produce=percents("transps", lambda reads, row: reads.procs.transps[row]),
    columns=("spellIds", "percents"),
    reads=("visuals", "procs"),
    counts=(Count("spellTransparencies",
                  lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("transparency", lambda columns, _r: numeric_domain(
        columns["percents"])),),
))

SPELL_FREEZES = register(Section(
    name="spellFreezes",
    doc="The spells that freeze their subject's animation outright.",
    module="core",
    produce=lambda reads: {"spellIds": sorted(reads.visuals.freezes)},
    columns=("spellIds",),
    reads=("visuals",),
    counts=(Count("spellFreezes", lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_CAMOS = register(Section(
    name="spellCamos",
    doc="The spells that camouflage their subject.",
    module="core",
    produce=lambda reads: {"spellIds": sorted(reads.visuals.camos)},
    columns=("spellIds",),
    reads=("visuals",),
    counts=(Count("spellCamos", lambda columns, _r: len(columns["spellIds"])),),
))
