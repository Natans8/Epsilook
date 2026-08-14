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

from collections.abc import Mapping, Sequence

from .module import Module


def manifest(pack_id: str, modules: Sequence[Module],
             header: Mapping[str, object] | None = None, *,
             absent: Sequence[str] = (), location: str = "") -> dict[str, object]:
    """One pack's manifest.

    Args:
        pack_id: the pack's identity, which is normally its build id and
            differs only for a pack sharing its patch with another, such as a
            test line level with live.
        modules: the modules assembled for it.
        header: the pack's own `meta`, which lives HERE rather than in a
            module. Two reasons, and the second is the one that costs bytes.
            It is what a reader needs before deciding to fetch anything -- the
            format says whether this pack can be read at all, so learning it
            from inside a module would mean downloading a pack to find out it
            cannot be used. And it is the only per-PACK thing in an artifact
            that is otherwise per-BUILD: it carries the label, so a module
            holding it could never be shared by two packs on one build, and
            the module it used to sit in is the largest one there is.
        absent: the sections this build ships without, from
            `module.absent_sections` rather than assembled by the caller.
        location: where the modules were written, relative to the site root.
            It travels in the manifest so a reader never derives it: the writer
            chooses the layout, and a reader deriving the same path from a
            constant of its own would be a second declaration of one fact.

    Returns:
        The manifest as it lands in the artifact. Each module carries its size
        so a deploy can be checked against what was built without fetching it.
    """
    return {
        "pack": pack_id,
        "meta": dict(header or {}),
        "modules": {module.name: {"file": f"{location}/{module.filename}"
                                          if location else module.filename,
                                  "bytes": len(module.payload)}
                    for module in modules},
        "absentSections": list(absent),
    }
