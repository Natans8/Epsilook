"""The manifest: which module files a pack is made of, and what it lacks.

One manifest per pack, naming its modules by their content-addressed
filenames. Sharing is a fact of these documents rather than of the files: two
packs whose modules serialised identically name the same file, and nothing
else records that they have anything in common.

The modules that hold a language are named apart from the rest, once per
language. That is the shape a reader needs: it fetches the structure whatever
language it is showing, and one language's names beside it. It is also the only
place the file a language is in gets written down, since a module's own name is
its content hash and says nothing about what is inside.

A section a build switched off is named here too. Absence is a declaration
everywhere else in this build, and stating it in the artifact is what lets the
app tell "this build never had it" from "this pack is broken".
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence

from .module import Module


def entry(module: Module, location: str) -> dict[str, object]:
    """Where one module landed and what it costs.

    The size travels so a deploy can be checked against what was built without
    fetching it.
    """
    return {"file": f"{location}/{module.filename}" if location else module.filename,
            "bytes": len(module.payload)}


def manifest(pack_id: str, modules: Sequence[Module],
             header: Mapping[str, object] | None = None, *,
             absent: Sequence[str] = (), location: str = "") -> dict[str, object]:
    """One pack's manifest.

    Args:
        pack_id: the pack's identity, which is normally its build id and
            differs only for a pack sharing its patch with another, such as a
            test line level with live.
        modules: every module assembled for it, in any language. Which of them
            hold a language is what each module says, rather than something
            worked out again here from its name.
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
        The manifest as it lands in the artifact. `modules` holds what says the
        same thing in every language and `locales` what does not, so choosing a
        language is choosing one entry of the second and changes nothing about
        the first.
    """
    locales: dict[str, dict[str, object]] = {}
    for module in modules:
        if module.locale:
            locales.setdefault(module.locale, {})[module.name] = entry(module, location)
    return {
        "pack": pack_id,
        "meta": dict(header or {}),
        "modules": {module.name: entry(module, location)
                    for module in modules if not module.locale},
        "locales": locales,
        "absentSections": list(absent),
    }


def carry_forward(fresh: Mapping[str, object], existing: Mapping[str, object],
                  built: frozenset[str],
                  home: Mapping[str, str]) -> dict[str, object]:
    """A partial build's manifest, completed from the pack's previous one.

    A partial build produces some modules and a manifest naming only those;
    writing that manifest would replace a whole pack with a partial one. So the
    unbuilt modules keep the entries the pack already had -- their files are
    untouched on disk, which is what makes the old entries still true -- and
    the sections that ship in them keep their counts, domains, absence and
    degradation the same way.

    One edge is accepted rather than solved: a count is carried by KEY, so a
    key no section computes any more lingers until the next whole build. The
    keys are data-driven per section, and mapping each back to the section
    that computed it would be a second account of the counts.

    Args:
        fresh: the manifest of what was just built.
        existing: the manifest the pack already had.
        built: the module names that were built.
        home: section name -> the module it ships in, from the registry, for
            deciding which carried claims about a section still stand.
    """
    def merged_entries(name: str) -> dict[str, object]:
        held = existing.get(name)
        kept = {module: entry for module, entry in held.items()
                if module not in built} if isinstance(held, Mapping) else {}
        add = fresh.get(name)
        return {**kept, **(add if isinstance(add, Mapping) else {})}

    held_locales = existing.get("locales")
    old_locales: Mapping[str, Mapping[str, object]] = (
        held_locales if isinstance(held_locales, Mapping) else {})
    made_locales = fresh.get("locales")
    new_locales: Mapping[str, Mapping[str, object]] = (
        made_locales if isinstance(made_locales, Mapping) else {})
    locales = {code: {**{module: entry for module, entry
                         in old_locales.get(code, {}).items()
                         if module not in built},
                      **new_locales.get(code, {})}
               for code in sorted(set(old_locales) | set(new_locales))}

    def standing(claims: object) -> dict[str, object]:
        """The existing per-section claims about sections not rebuilt."""
        if not isinstance(claims, Mapping):
            return {}
        return {name: value for name, value in claims.items()
                if home.get(str(name), "") not in built}

    old_meta = existing.get("meta")
    old_meta = old_meta if isinstance(old_meta, Mapping) else {}
    new_meta = fresh.get("meta")
    new_meta = dict(new_meta) if isinstance(new_meta, Mapping) else {}
    for table in ("counts", "domains"):
        held = old_meta.get(table)
        new_meta[table] = {**(dict(held) if isinstance(held, Mapping) else {}),
                           **(new_meta.get(table) or {})}
    new_meta["degradedSections"] = {
        **standing(old_meta.get("degradedSections")),
        **(new_meta.get("degradedSections") or {})}

    added = fresh.get("absentSections")
    absent = sorted(set(standing_names(existing.get("absentSections"), built, home))
                    | {str(name) for name
                       in (added if isinstance(added, list) else [])})

    return {**dict(fresh), "meta": new_meta,
            "modules": merged_entries("modules"), "locales": locales,
            "absentSections": absent}


def standing_names(absent: object, built: frozenset[str],
                   home: Mapping[str, str]) -> list[str]:
    """The carried absent sections whose module was not rebuilt."""
    if not isinstance(absent, list):
        return []
    return [str(name) for name in absent
            if home.get(str(name), "") not in built]


def _leaf(value: object) -> bool:
    """Whether a value nests no further and so fits on one line."""
    if isinstance(value, Mapping):
        return not any(isinstance(held, (Mapping, list)) for held in value.values())
    if isinstance(value, list):
        return not any(isinstance(held, (Mapping, list)) for held in value)
    return True


def _rendered(value: object, indent: int) -> str:
    """One value, leaves inline and everything above them indented."""
    if _leaf(value):
        return json.dumps(value, ensure_ascii=False)
    pad = " " * indent
    if isinstance(value, Mapping):
        body = ",\n".join(
            f"{pad}  {json.dumps(key, ensure_ascii=False)}: "
            f"{_rendered(held, indent + 2)}" for key, held in value.items())
        return "{\n" + body + "\n" + pad + "}"
    assert isinstance(value, list)
    body = ",\n".join(f"{pad}  {_rendered(held, indent + 2)}" for held in value)
    return "[\n" + body + "\n" + pad + "]"


def rendered(manifest: Mapping[str, object]) -> str:
    """The manifest as the text that lands on disk.

    Indented down to the leaves and no further: a module entry, the counts, one
    domain each sit on a single line. The manifest is the one artifact file the
    repository diffs, and a fully-indented document turns every rebuild into
    hundreds of changed lines -- this keeps a diff one line per entry that
    moved, which is exactly the review a rebuild wants, while the skeleton
    stays readable. Parses back to the same document either way.
    """
    return _rendered(manifest, 0) + "\n"
