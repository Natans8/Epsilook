"""What a spell does to the frame itself, rather than to anything in it.

A screen effect is a bundle of independent payloads under one id: the paint it
puts on the frame -- a fog tint, a colour multiplied over everything, a
vignette shaping how far it reaches -- and beside it a light preset that swaps
the sky, a music set and an ambience that swap the sound, and an hour it pins
the day to. Most rows carry only some of them, and a row carrying a preset and
no paint is a sky change wearing a screen effect's id.

The paint ships here as the screen's own columns. The preset is an edge into
the sky roster, which ships it as `skySpells`. The two sound halves resolve to
kits, which join the spell's sound rows, and ship here as the two small
vocabularies below so a reader can say which set a screen names.
"""

from __future__ import annotations

from collections.abc import Callable

from ...derive import Reads
from ...routes import Ambience, ScreenRow, ZoneMusic
from ...routes.colors import hue_words
from ..registry import register
from ..section import Cardinality, Count, Section, SectionColumns, size

TEX_OVERLAY = 0
"""Finished art, drawn in its own colours.

Sorts before the flat masks, so a screen carrying both previews the art rather
than the texture the colours are painted onto.
"""

NO_HOUR = -1
"""What a screen that leaves the day's clock alone carries."""


def used_screens(reads: Reads) -> list[ScreenRow]:
    """The reached screen effects' rows, in id order.

    One ordering, bound once: every column below is parallel to `ids` because
    this list made them so.
    """
    return [reads.fx.screens[screen] for screen in sorted(reads.references.screens)]


def payloads(reads: Reads) -> SectionColumns:
    """What each used screen effect paints, and what else it swaps in."""
    rows = used_screens(reads)
    return {
        "ids": sorted(reads.references.screens),
        "names": [row.name for row in rows],
        "fogColors": [row.fog for row in rows],
        "fogAlphas": [row.fog_alpha for row in rows],
        "mulColors": [row.mul for row in rows],
        "addColors": [row.add for row in rows],
        # The radial vignette shaping the coverage; a size of zero means
        # the row has no full-screen entry at all.
        "maskOffsetY": [row.mask[0] for row in rows],
        "maskSize": [row.mask[1] for row in rows],
        "maskPower": [row.mask[2] for row in rows],
        "hues": [hue_words((row.fog, row.mul, row.add)) for row in rows],
        # The light preset the screen swaps the sky to, and how long the swap
        # takes each way, in milliseconds.
        "skyParams": [row.sky for row in rows],
        "skyFadeIns": [row.sky_fade[0] for row in rows],
        "skyFadeOuts": [row.sky_fade[1] for row in rows],
        # The minute of the day the sky is pinned to while the screen holds.
        "hours": [row.time_of_day for row in rows],
        "musicIds": [row.music for row in rows],
        "ambienceIds": [row.ambience for row in rows],
    }


def textures(reads: Reads) -> SectionColumns:
    """The textures each screen effect draws, art before mask."""
    rows = sorted(
        (screen, role, fid)
        for screen in sorted(reads.references.screens)
        for fid, role in reads.fx.screens[screen].textures
    )
    return {"screenIds": [row[0] for row in rows], "roles": [row[1] for row in rows], "fids": [row[2] for row in rows]}


def music_sets(reads: Reads) -> SectionColumns:
    """The music sets the used screens name: each one's name and its two kits."""
    sets: dict[int, ZoneMusic] = reads.zone_music
    ids = sorted({row.music for row in used_screens(reads) if row.music in sets})
    return {
        "ids": ids,
        "names": [sets[music].name for music in ids],
        "dayKits": [sets[music].day for music in ids],
        "nightKits": [sets[music].night for music in ids],
    }


def ambience_sets(reads: Reads) -> SectionColumns:
    """The ambiences the used screens name: each one's two kits."""
    sets: dict[int, Ambience] = reads.ambiences
    ids = sorted({row.ambience for row in used_screens(reads) if row.ambience in sets})
    return {
        "ids": ids,
        "dayKits": [sets[ambience].day for ambience in ids],
        "nightKits": [sets[ambience].night for ambience in ids],
    }


def screens_with(column: str, held: Callable[[object], bool]) -> Callable[[SectionColumns, Reads], int]:
    """How many used screens carry a value in one of the bundle's columns."""

    def count(columns: SectionColumns, _reads: Reads) -> int:
        return sum(1 for value in columns[column] if held(value))

    return count


SCREENS = register(
    Section(
        name="screens",
        doc="What each screen effect paints, the sky preset, music, ambience and hour it swaps in.",
        module="core",
        produce=payloads,
        columns=(
            "ids",
            "names",
            "fogColors",
            "fogAlphas",
            "mulColors",
            "addColors",
            "maskOffsetY",
            "maskSize",
            "maskPower",
            "hues",
            "skyParams",
            "skyFadeIns",
            "skyFadeOuts",
            "hours",
            "musicIds",
            "ambienceIds",
        ),
        reads=("references", "fx"),
        needs=("ScreenEffect",),
        degraded_without=("FullScreenEffect", "SpellVisualScreenEffect"),
        cardinality={
            "skyParams": Cardinality.PARTIAL,
            "skyFadeIns": Cardinality.PARTIAL,
            "skyFadeOuts": Cardinality.PARTIAL,
            "hours": Cardinality.PARTIAL,
            "musicIds": Cardinality.PARTIAL,
            "ambienceIds": Cardinality.PARTIAL,
        },
        absent={
            "skyParams": 0,
            "skyFadeIns": 0,
            "skyFadeOuts": 0,
            "hours": NO_HOUR,
            "musicIds": 0,
            "ambienceIds": 0,
        },
        counts=(
            size("screens", "ids"),
            Count("screens.sky", screens_with("skyParams", bool)),
            Count("screens.music", screens_with("musicIds", bool)),
            Count("screens.ambience", screens_with("ambienceIds", bool)),
            Count("screens.hour", screens_with("hours", lambda hour: hour != NO_HOUR)),
        ),
    )
)

SCREEN_TEXTURES = register(
    Section(
        name="screenTextures",
        doc="The textures each screen effect draws, finished art before flat mask.",
        module="core",
        produce=textures,
        columns=("screenIds", "roles", "fids"),
        reads=("references", "fx"),
        needs=("ScreenEffect",),
        degraded_without=("FullScreenEffect", "TextureBlendSet"),
    )
)

ZONE_MUSIC = register(
    Section(
        name="zoneMusic",
        doc="The music sets the screen effects name: a name and a day and a night kit each.",
        module="core",
        produce=music_sets,
        columns=("ids", "names", "dayKits", "nightKits"),
        reads=("references", "fx", "zone_music"),
        needs=("ScreenEffect",),
        counts=(size("zoneMusic", "ids"),),
    )
)

AMBIENCES = register(
    Section(
        name="ambiences",
        doc="The ambiences the screen effects name: a day and a night kit each.",
        module="core",
        produce=ambience_sets,
        columns=("ids", "dayKits", "nightKits"),
        reads=("references", "fx", "ambiences"),
        needs=("ScreenEffect",),
        counts=(size("ambiences", "ids"),),
    )
)
