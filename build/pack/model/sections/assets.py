"""The asset tables: which files the pack names, and how to place them.

Two sections and one shape: an id column and whatever the pack can say about
the id. `files` is every asset a spell reaches; the icon tables are the same
idea for a picture, kept apart because an icon is reduced to a name rather than
shipped as a path.
"""

from __future__ import annotations

from ...derive import Reads
from ...routes.models import SYNTHETIC_MODEL_FILES
from ..registry import register
from ..section import Cardinality, Count, Layout, Section, SectionColumns

NO_GOB = 0
"""What a model Epsilon has no placeable object for carries."""


def files(reads: Reads) -> SectionColumns:
    """Every file id the build reaches, named where the listfile names it.

    The fileless model sentinels join the real ids: they are what a spell that
    plays the caster's own weapon reaches, and giving them a row is what lets
    the pill carry a label and be searched like any other model. They are
    appended rather than sorted in, since they are not file ids and sorting
    them among real ones would put them somewhere a reader has to explain.
    """
    ids = sorted(reads.references.assets)
    paths = [reads.paths.get(fid, "") for fid in ids]
    used = {worn.file for models in reads.visuals.models.values() for worn in models}
    for fid, name in SYNTHETIC_MODEL_FILES.items():
        if fid in used:
            ids.append(fid)
            paths.append(name)
    return {
        "fids": ids,
        "paths": paths,
        # Negative on purpose: `.gob spawn` reads the sign to tell a
        # gameobject_template entry from a display id.
        "gobs": [reads.declared.gobs.get(fid, NO_GOB) for fid in ids],
    }


ICON_NAMES = register(
    Section(
        name="iconNames",
        doc="Each distinct icon name, the key the icon CDN serves it under.",
        module="core",
        produce=lambda reads: {"names": list(reads.icons.names)},
        columns=("names",),
        layout=Layout.BARE,
        reads=("icons",),
        counts=(Count("icons", lambda columns, _reads: len(columns["names"])),),
    )
)

ICON_FIDS = register(
    Section(
        name="iconFids",
        doc="The file id behind each icon name, parallel to iconNames.",
        module="core",
        produce=lambda reads: {"fids": list(reads.icons.fids)},
        columns=("fids",),
        layout=Layout.BARE,
        reads=("icons",),
    )
)

FILES = register(
    Section(
        name="files",
        doc="Every asset the build references, its path, and the object that places it.",
        module="core",
        produce=files,
        columns=("fids", "paths", "gobs"),
        reads=("references", "paths", "declared", "visuals"),
        # Most assets have no placeable object, and a few have no name at all.
        cardinality={"paths": Cardinality.PARTIAL, "gobs": Cardinality.PARTIAL},
        absent={"gobs": 0},
        counts=(
            Count("files", lambda columns, _reads: len(columns["fids"])),
            Count("gobModels", lambda columns, reads: sum(1 for fid in columns["fids"] if fid in reads.declared.gobs)),
        ),
    )
)
