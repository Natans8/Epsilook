"""Every route that puts geometry on screen, and the vocabularies naming it.

One row per way a spell shows a model. The category says which id space the
row's reference is in, so a creature display and an item share one field rather
than each getting a column that is empty for the other six categories.
"""

from __future__ import annotations

from ...derive import Reads, build_item_icons
from ...routes.models import MODEL_CAT_NAMES
from ...targets import TARGET_NAMES
from ..registry import register
from ..section import (Cardinality, Count, Layout, Scope, Section, SectionColumns, size)

NO_QUALITY = -1
"""What an item with no searchable row carries, which is not quality zero."""


def items(reads: Reads) -> SectionColumns:
    """The items a model row points at, and what a pill shows for each.

    An item with no searchable row still ships: it renders as a plain model
    pill, and its icon still reads.
    """
    used = reads.rows.items
    _names, icons = build_item_icons(used, reads.items.icon_fid, reads.paths)
    return {"ids": list(used),
            "names": [reads.items.name.get(item, "") for item in used],
            "qualities": [reads.items.quality.get(item, NO_QUALITY)
                          for item in used],
            "icons": icons}


MISSILE_MOTIONS = register(Section(
    name="missileMotions",
    doc="The flight paths missile rows name, by motion id: what each is called, "
        "and how many projectiles it is written for.",
    module="core",
    produce=lambda reads: {
        "ids": list(reads.rows.motions),
        "names": [reads.motions[motion].name if motion in reads.motions else ""
                  for motion in reads.rows.motions],
        "projectiles": [reads.motions[motion].projectiles
                        if motion in reads.motions else 0
                        for motion in reads.rows.motions]},
    columns=("ids", "names", "projectiles"),
    reads=("rows", "motions"),
    counts=(size("missileMotions", "ids"),),
))

ITEMS = register(Section(
    name="items",
    doc="The items a model row points at, with the name, quality and icon a pill shows.",
    module="core",
    produce=items,
    columns=("ids", "names", "qualities", "icons"),
    reads=("rows", "items", "paths"),
    cardinality={"names": Cardinality.PARTIAL, "icons": Cardinality.PARTIAL},
    absent={"icons": 0},
    counts=(size("items", "ids"),
            Count("namedItems", lambda columns, _r: sum(
                1 for name in columns["names"] if name))),
    localizable=('names',),
))

ITEM_ICON_NAMES = register(Section(
    name="itemIconNames",
    doc="Each distinct item icon name, which items index into.",
    module="core",
    produce=lambda reads: {"names": build_item_icons(
        reads.rows.items, reads.items.icon_fid, reads.paths)[0]},
    columns=("names",),
    layout=Layout.BARE,
    reads=("rows", "items", "paths"),
))

ITEM_QUALITY_NAMES = register(Section(
    name="itemQualityNames",
    doc="The quality words an item's quality indexes, from the checked-in enum.",
    module="universal",
    produce=lambda reads: {"names": reads.declared.item_quality_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))

ATTACHMENT_NAMES = register(Section(
    name="attachmentNames",
    doc="Where on a model an attachment id points, by id.",
    module="universal",
    produce=lambda reads: {"names": reads.declared.attachment_names},
    columns=("names",),
    layout=Layout.BARE,
    reads=("declared",),
    scope=Scope.UNIVERSAL,
))

MODEL_CATEGORY_NAMES = register(Section(
    name="modelCatNames",
    doc="The word each model category answers to in search and renders under.",
    module="universal",
    produce=lambda _reads: {"names": dict(MODEL_CAT_NAMES)},
    columns=("names",),
    layout=Layout.BARE,
    scope=Scope.UNIVERSAL,
))

TARGET_WORDS = register(Section(
    name="targetNames",
    doc="The word each target bit renders as.",
    module="universal",
    produce=lambda _reads: {"names": dict(TARGET_NAMES)},
    columns=("names",),
    layout=Layout.BARE,
    scope=Scope.UNIVERSAL,
))
