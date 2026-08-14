"""The manifest: which module files a pack is made of, and what it lacks.

One manifest per pack, naming its modules by their content-addressed
filenames. Sharing is a fact of these documents rather than of the files: two
packs whose modules serialised identically name the same file, and nothing
else records that they have anything in common.

A section a build switched off is named here too. Absence is a declaration
everywhere else in this build, and stating it in the artifact is what lets the
app tell "this build never had it" from "this pack is broken".
"""

from __future__ import annotations

from collections.abc import Sequence

from .module import Module


def manifest(pack_id: str, modules: Sequence[Module],
             absent: Sequence[str] = ()) -> dict[str, object]:
    """One pack's manifest.

    Args:
        pack_id: the pack's identity, which is normally its build id and
            differs only for a pack sharing its patch with another, such as a
            test line level with live.
        modules: the modules assembled for it.
        absent: the sections this build ships without, from
            `module.absent_sections` rather than assembled by the caller.

    Returns:
        The manifest as it lands in the artifact. Each module carries its size
        so a deploy can be checked against what was built without fetching it.
    """
    return {
        "pack": pack_id,
        "modules": {module.name: {"file": module.filename, "bytes": len(module.payload)}
                    for module in modules},
        "absentSections": list(absent),
    }
