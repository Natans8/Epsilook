"""Every route that puts geometry on screen, and the vocabularies naming it.

One row per way a spell shows a model. The category says which id space the
row's reference is in, so a creature display and an item share one field rather
than each getting a column that is empty for the other six categories.
"""

from __future__ import annotations

from collections import Counter

from ...derive import Reads, build_item_icons
from ...routes.models import (MODEL_CAT_DISPLAY, MODEL_CAT_ITEM,
                              MODEL_CAT_NAMES, SYNTHETIC_MODEL_FILES)
from ...targets import TARGET_NAMES
from ...measure import numeric_domain
from ..registry import register
from ..section import (Cardinality, Count, Domain, Layout, Scope, Section,
                       SectionColumns)

NO_QUALITY = -1
"""What an item with no searchable row carries, which is not quality zero."""


def spell_models(reads: Reads) -> SectionColumns:
    """One row per model a spell shows, in whichever way it shows it."""
    rows = reads.rows.models
    return {"spellIds": [row[0] for row in rows],
            "fids": [row[1] for row in rows],
            "cats": [row[2] for row in rows],
            "targets": [row[3] for row in rows],
            # Raw attachment ids, named through attachmentNames. An attached
            # model puts its single point in the source; a missile uses both,
            # launch to impact. They are part of the row key, so one model at
            # two points is two rows and renders as two pills.
            "srcAttach": [row[4] for row in rows],
            "dstAttach": [row[5] for row in rows],
            # The entity the model came from, in whichever id space the row's
            # category names. One field rather than one per category, since a
            # row only ever comes from one such entity.
            "refIds": [row[6] for row in rows],
            "motions": [row[7] for row in rows]}


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


SPELL_MODELS = register(Section(
    name="spellModels",
    doc="One row per model a spell shows, with where it attaches and how it flies.",
    module="core",
    produce=spell_models,
    columns=("spellIds", "fids", "cats", "targets", "srcAttach", "dstAttach",
             "refIds", "motions"),
    reads=("rows",),
    cardinality={"refIds": Cardinality.PARTIAL, "motions": Cardinality.PARTIAL},
    absent={"refIds": 0, "motions": 0},
    counts=(
        Count("spellModels", lambda columns, _r: len(columns["spellIds"])),
        Count("spellDisplayModels", lambda columns, _r: sum(
            1 for category in columns["cats"] if category == MODEL_CAT_DISPLAY)),
        Count("spellItemModels", lambda columns, _r: sum(
            1 for category in columns["cats"] if category == MODEL_CAT_ITEM)),
        Count("spellMissileMotions", lambda columns, _r: sum(
            1 for motion in columns["motions"] if motion)),
        # The equipped-weapon markers: rows whose file is a sentinel rather
        # than an asset, because the model is whatever the caster is holding.
        Count("spellWeaponModels", lambda columns, _r: sum(
            1 for fid in columns["fids"] if fid in SYNTHETIC_MODEL_FILES)),
    ),
    domains=(Domain("count.model", lambda columns, _r: numeric_domain(
        Counter(columns["spellIds"]).values())),),
))

MISSILE_MOTIONS = register(Section(
    name="missileMotions",
    doc="The flight paths missile rows name, by motion id.",
    module="core",
    produce=lambda reads: {
        "ids": list(reads.rows.motions),
        "names": [reads.motions.get(motion, "") for motion in reads.rows.motions]},
    columns=("ids", "names"),
    reads=("rows", "motions"),
    counts=(Count("missileMotions", lambda columns, _r: len(columns["ids"])),),
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
    counts=(Count("items", lambda columns, _r: len(columns["ids"])),
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
