"""What a spell does to the frame itself, rather than to anything in it.

A screen effect grades the whole view -- a fog tint, a colour multiplied over
everything, a vignette shaping how far it reaches. It is the one visual family
that is not attached to a model, which is why it is here and not with the rest.
"""

from __future__ import annotations

from ...derive import Reads
from ...routes.colors import hue_words
from ..registry import register
from ..section import Count, Section, SectionColumns

TEX_OVERLAY = 0
"""Finished art, drawn in its own colours.

Sorts before the flat masks, so a screen carrying both previews the art rather
than the texture the colours are painted onto.
"""


def payloads(reads: Reads) -> SectionColumns:
    """What each used screen effect paints, and how it is shaped."""
    ids = sorted(reads.references.screens)
    rows = [reads.fx.screens[screen] for screen in ids]
    return {"ids": ids,
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
            "hues": [hue_words((row.fog, row.mul, row.add)) for row in rows]}


def textures(reads: Reads) -> SectionColumns:
    """The textures each screen effect draws, art before mask."""
    rows = sorted((screen, role, fid)
                  for screen in sorted(reads.references.screens)
                  for fid, role in reads.fx.screens[screen].textures)
    return {"screenIds": [row[0] for row in rows],
            "roles": [row[1] for row in rows],
            "fids": [row[2] for row in rows]}


SCREENS = register(Section(
    name="screens",
    doc="What each screen effect paints, and the vignette that shapes it.",
    module="core",
    produce=payloads,
    columns=("ids", "names", "fogColors", "fogAlphas", "mulColors", "addColors",
             "maskOffsetY", "maskSize", "maskPower", "hues"),
    reads=("references", "fx"),
    counts=(Count("screens", lambda columns, _r: len(columns["ids"])),),
))

SCREEN_TEXTURES = register(Section(
    name="screenTextures",
    doc="The textures each screen effect draws, finished art before flat mask.",
    module="core",
    produce=textures,
    columns=("screenIds", "roles", "fids"),
    reads=("references", "fx"),
))
