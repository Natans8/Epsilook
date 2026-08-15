"""Animations: the kits, what they segment, what they swap, and how to perform one.

Four routes reach an animation and they are kept apart because they read
differently on a pill: a kit groups its segments, a replacement is a pair, a
visual animation is loose, and the emote columns are not about the build at all
but about what a player can ask for.
"""

from __future__ import annotations

from collections import Counter

from ...derive import Reads, boneset_rows, replacement_rows
from ...measure import numeric_domain
from ..registry import register
from ..section import Count, Domain, Layout, Scope, Section, SectionColumns


def spell_animkits(reads: Reads) -> SectionColumns:
    """One row per anim kit a spell plays."""
    rows = reads.rows.animkits
    return {"spellIds": [row[0] for row in rows],
            "animKitIds": [row[1] for row in rows],
            "targets": [row[2] for row in rows]}


def animkit_anims(reads: Reads) -> SectionColumns:
    """Which animations each used kit segments."""
    rows = sorted((kit, anim) for kit, anims in reads.animkit_anims.items()
                  if kit in reads.rows.used_animkits for anim in anims)
    return {"animKitIds": [kit for kit, _anim in rows],
            "animIds": [anim for _kit, anim in rows]}


def boneset_columns(reads: Reads) -> SectionColumns:
    """Which body region each used kit's animations move."""
    rows, _names = boneset_rows(reads.animkit_bonesets, reads.rows.used_animkits)
    return {"animKitIds": [row[0] for row in rows],
            "animIds": [row[1] for row in rows],
            "bonesets": [row[2] for row in rows]}


def replacements(reads: Reads) -> SectionColumns:
    """Every animation a spell wears in place of another."""
    rows = replacement_rows(reads.visuals, reads.effects,
                            reads.anim_replacements, len(reads.declared.anim_names))
    return {"spellIds": [row[0] for row in rows],
            "srcAnims": [row[1] for row in rows],
            "dstAnims": [row[2] for row in rows],
            "targets": [row[3] for row in rows]}


def visual_anims(reads: Reads) -> SectionColumns:
    """The animations a spell's kits play on the unit directly.

    The largest animation source, and the one with no kit to group under, so
    these render as loose pills.
    """
    limit = len(reads.declared.anim_names)
    rows = sorted((spell, anim, mask)
                  for spell, anims in reads.visuals.visual_anims.items()
                  for anim, mask in anims.items() if anim < limit)
    return {"spellIds": [row[0] for row in rows],
            "animIds": [row[1] for row in rows],
            "targets": [row[2] for row in rows]}


SPELL_ANIMKITS = register(Section(
    name="spellAnimKits",
    doc="One row per anim kit a spell plays.",
    module="core",
    produce=spell_animkits,
    columns=("spellIds", "animKitIds", "targets"),
    reads=("rows",),
    counts=(Count("spellAnimKits", lambda columns, _r: len(columns["spellIds"])),),
    domains=(Domain("count.anim", lambda columns, _r: numeric_domain(
        Counter(columns["spellIds"]).values())),),
))

ANIMKIT_ANIMS = register(Section(
    name="animKitAnims",
    doc="Which animations each anim kit a spell reaches is made of.",
    module="core",
    produce=animkit_anims,
    columns=("animKitIds", "animIds"),
    reads=("rows", "animkit_anims"),
    counts=(Count("animKitAnims", lambda columns, _r: len(columns["animKitIds"])),),
))

BONESET_NAMES = register(Section(
    name="bonesetNames",
    doc="The body regions an animation can be confined to, pooled.",
    module="core",
    produce=lambda reads: {"names": boneset_rows(
        reads.animkit_bonesets, reads.rows.used_animkits)[1]},
    columns=("names",),
    layout=Layout.BARE,
    reads=("rows", "animkit_bonesets"),
))

ANIMKIT_BONESETS = register(Section(
    name="animKitAnimBoneset",
    doc="Which body region each of a kit's animations moves.",
    module="core",
    produce=boneset_columns,
    columns=("animKitIds", "animIds", "bonesets"),
    reads=("rows", "animkit_bonesets"),
    counts=(Count("animKitAnimBoneset",
                  lambda columns, _r: len(columns["animKitIds"])),),
))

SPELL_REPLACE_ANIMS = register(Section(
    name="spellReplaceAnims",
    doc="Every base animation a spell swaps for another, from both routes merged.",
    module="core",
    produce=replacements,
    columns=("spellIds", "srcAnims", "dstAnims", "targets"),
    reads=("visuals", "effects", "anim_replacements", "declared"),
    counts=(Count("spellReplaceAnims",
                  lambda columns, _r: len(columns["spellIds"])),),
))

SPELL_VISUAL_ANIMS = register(Section(
    name="spellVisualAnims",
    doc="The animations a spell's kits play on the unit directly.",
    module="core",
    produce=visual_anims,
    columns=("spellIds", "animIds", "targets"),
    reads=("visuals", "declared"),
    counts=(Count("spellVisualAnims",
                  lambda columns, _r: len(columns["spellIds"])),),
))

ANIM_NAMES = register(Section(
    name="animNames",
    doc="Every animation's name, indexed by animation id.",
    module="universal",
    produce=lambda reads: {"names": list(reads.declared.anim_names)},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))

ANIM_EMOTE_ONESHOTS = register(Section(
    name="animEmoteOneshots",
    doc="The Epsilon emote that performs each animation once, by animation id.",
    module="universal",
    produce=lambda reads: {"emotes": list(reads.declared.anim_emote_oneshots)},
    columns=("emotes",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
    counts=(Count("animEmotes", lambda _columns, reads: sum(
        1 for oneshot, loop in zip(reads.declared.anim_emote_oneshots,
                                   reads.declared.anim_emote_loops)
        if oneshot or loop)),),
))

ANIM_EMOTE_LOOPS = register(Section(
    name="animEmoteLoops",
    doc="The Epsilon emote that holds each animation, by animation id.",
    module="universal",
    produce=lambda reads: {"emotes": list(reads.declared.anim_emote_loops)},
    columns=("emotes",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))
