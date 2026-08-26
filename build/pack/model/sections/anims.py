"""Animations: the kits, what they segment, what they swap, and how to perform one.

Four routes reach an animation and they are kept apart because they read
differently on a pill: a kit groups its segments, a replacement is a pair, a
visual animation is loose, and the emote columns are not about the build at all
but about what a player can ask for.
"""

from __future__ import annotations

from ...derive import Reads
from ..registry import register
from ..section import Count, Layout, Scope, Section, SectionColumns, size


def animkit_anims(reads: Reads) -> SectionColumns:
    """Which animations each used kit segments."""
    rows = sorted(
        (kit, anim) for kit, anims in reads.animkit_anims.items() if kit in reads.rows.used_animkits for anim in anims
    )
    return {"animKitIds": [kit for kit, _anim in rows], "animIds": [anim for _kit, anim in rows]}


def boneset_columns(reads: Reads) -> SectionColumns:
    """Which body region each used kit's animations move."""
    rows = reads.rows.bonesets
    return {
        "animKitIds": [row[0] for row in rows],
        "animIds": [row[1] for row in rows],
        "bonesets": [row[2] for row in rows],
    }


ANIMKIT_ANIMS = register(
    Section(
        name="animKitAnims",
        doc="Which animations each anim kit a spell reaches is made of.",
        module="core",
        produce=animkit_anims,
        columns=("animKitIds", "animIds"),
        reads=("rows", "animkit_anims"),
        counts=(size("animKitAnims", "animKitIds"),),
    )
)

BONESET_NAMES = register(
    Section(
        name="bonesetNames",
        doc="The body regions an animation can be confined to, pooled.",
        module="core",
        produce=lambda reads: {"names": reads.rows.boneset_names},
        columns=("names",),
        layout=Layout.BARE,
        reads=("rows",),
    )
)

ANIMKIT_BONESETS = register(
    Section(
        name="animKitAnimBoneset",
        doc="Which body region each of a kit's animations moves.",
        module="core",
        produce=boneset_columns,
        columns=("animKitIds", "animIds", "bonesets"),
        reads=("rows",),
        counts=(size("animKitAnimBoneset", "animKitIds"),),
    )
)

ANIM_NAMES = register(
    Section(
        name="animNames",
        doc="Every animation's name, indexed by animation id.",
        module="universal",
        produce=lambda reads: {"names": list(reads.declared.anim_names)},
        columns=("names",),
        layout=Layout.BARE,
        reads=("declared",),
        scope=Scope.UNIVERSAL,
    )
)

ANIM_EMOTE_ONESHOTS = register(
    Section(
        name="animEmoteOneshots",
        doc="The Epsilon emote that performs each animation once, by animation id.",
        module="universal",
        produce=lambda reads: {"emotes": list(reads.declared.anim_emote_oneshots)},
        columns=("emotes",),
        layout=Layout.BARE,
        reads=("declared",),
        scope=Scope.UNIVERSAL,
        counts=(
            Count(
                "animEmotes",
                lambda _columns, reads: sum(
                    1
                    for oneshot, loop in zip(reads.declared.anim_emote_oneshots, reads.declared.anim_emote_loops)
                    if oneshot or loop
                ),
            ),
        ),
    )
)

ANIM_EMOTE_LOOPS = register(
    Section(
        name="animEmoteLoops",
        doc="The Epsilon emote that holds each animation, by animation id.",
        module="universal",
        produce=lambda reads: {"emotes": list(reads.declared.anim_emote_loops)},
        columns=("emotes",),
        layout=Layout.BARE,
        reads=("declared",),
        scope=Scope.UNIVERSAL,
    )
)
