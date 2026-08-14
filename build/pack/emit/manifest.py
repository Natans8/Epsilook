"""The manifest: which module files a build is made of, and what is missing.

One manifest per build, naming its modules by their content-addressed
filenames. Sharing is a fact of these documents rather than of the files: two
builds whose modules encoded identically name the same file, and nothing else
records that they have anything in common.

A section a build switched off is named here too. Absence is a declaration
everywhere else in this build, and stating it in the artifact is what lets the
app tell "this build never had it" from "this pack is broken".
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence

from .module import Module


def manifest(build: str, modules: Sequence[Module],
             absent: Iterable[str] = ()) -> dict[str, object]:
    """One build's manifest.

    Args:
        build: the build id this manifest describes.
        modules: the modules assembled for it.
        absent: sections this build ships without, by name.

    Returns:
        The manifest as it lands in the artifact: the module filenames by
        logical name, and the absent sections sorted so two builds lacking the
        same tables produce the same document.
    """
    return {
        "build": build,
        "modules": {module.name: module.filename for module in modules},
        "absentSections": sorted(absent),
    }


def shared(manifests: Iterable[Mapping[str, object]]) -> dict[str, list[str]]:
    """Which module files more than one build names, and which builds those are.

    The measurement behind the scope declaration, taken from the artifact
    rather than assumed: a module declared universal that turns out to be named
    by one build is a claim the build no longer supports, and one that recurs
    without being declared is sharing nobody asked for and nobody is checking.

    Returns:
        Module filename to the builds naming it, for the files named more than
        once, ordered by filename.
    """
    builds: dict[str, list[str]] = {}
    for entry in manifests:
        modules = entry.get("modules")
        if not isinstance(modules, Mapping):
            continue
        for filename in modules.values():
            builds.setdefault(str(filename), []).append(str(entry.get("build", "")))
    return {name: sorted(who) for name, who in sorted(builds.items()) if len(who) > 1}
