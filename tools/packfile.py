#!/usr/bin/env python3
"""Read a shipped pack: its manifest, and the modules that manifest names.

A pack is not one file. It is a `manifest.json` plus a set of content-addressed
module files in a directory they all share, and a section may be split across
two of them -- its structure in `core`, the game's own language in `names` --
under the same key in both.

The modules holding a language are named per language, so reading a pack means
choosing one. Every reader here defaults to `DEFAULT_LOCALE`, which every pack
ships and which is what the app shows unless somebody asks otherwise.

Every tool that reads a pack reads it through here. Four of them used to open
one gzipped document directly, and four re-implementations of "join the modules
back together" would be four chances to join them differently.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

SITE = Path(__file__).resolve().parent.parent / "site"
"""The document root every module path in a manifest is relative to."""

DEFAULT_LOCALE = "enUS"
"""Which language a reader gets when it does not ask for one.

Declared again from `pack.derive.locales`, because a tool must not have to put
the build package on its path to read a pack that is already on disk.
`check_locale_declaration` reconciles the two.
"""


def manifest_of(pack_dir: Path) -> dict[str, Any]:
    """One pack's manifest.

    Raises:
        FileNotFoundError: there is no pack there. Raised rather than returning
            an empty manifest, which would read downstream as a pack that ships
            nothing -- a different and much quieter kind of wrong.
    """
    path = pack_dir / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} does not exist")
    loaded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def module(file: str) -> dict[str, Any]:
    """One module file, decoded."""
    with gzip.open(SITE / file, "rt", encoding="utf-8") as handle:
        loaded = json.load(handle)
    assert isinstance(loaded, dict)
    return loaded


def entries(manifest: dict[str, Any],
            locale: str = DEFAULT_LOCALE) -> dict[str, dict[str, Any]]:
    """Which module file a pack reads for each module, in one language.

    The structure modules and the chosen language's, together: that IS a pack
    to a reader, and every consumer wanting one asks for it the same way.

    Args:
        manifest: the pack's manifest.
        locale: the language to read. A pack that does not carry it falls back
            to the default one, which every pack ships.

    Returns:
        Module name -> its manifest entry.

    Raises:
        ValueError: the manifest names no languages at all. That is a pack from
            before the language became an axis of the artifact, and reading it
            as though it merely had none would silently drop every name and
            every description in it.
    """
    locales = manifest.get("locales", {})
    if not locales:
        raise ValueError(f"{manifest.get('pack', 'this pack')} names no languages; "
                         f"it predates the language axis and has to be rebuilt")
    return {**manifest.get("modules", {}),
            **(locales.get(locale) or locales.get(DEFAULT_LOCALE, {}))}


def load(pack_dir: Path, *, want: tuple[str, ...] = (),
         locale: str = DEFAULT_LOCALE) -> dict[str, Any]:
    """One pack as the single document its modules add up to.

    Args:
        pack_dir: the pack's own directory, holding its manifest.
        want: which modules to read, by name. Empty means all of them -- but a
            caller after asset paths has no use for prose, and `text` is a
            quarter of the pack, so naming what you need is worth it.
        locale: which language's names and prose to read.

    Returns:
        Every section by name, with `meta` from the manifest. A section split
        across modules comes back joined, which is what makes a reader here
        indifferent to which module a column ended up in.
    """
    manifest = manifest_of(pack_dir)
    pack: dict[str, Any] = {"meta": manifest.get("meta", {})}
    for name, entry in entries(manifest, locale).items():
        if want and name not in want:
            continue
        for section, columns in module(entry["file"]).items():
            held = pack.get(section)
            if isinstance(held, dict) and isinstance(columns, dict):
                held.update(columns)
            else:
                pack[section] = columns
    return pack


def sizes(pack_dir: Path, locale: str = DEFAULT_LOCALE) -> dict[str, int]:
    """What each of a pack's modules costs, by module name.

    Off the manifest rather than off the files, so it answers without reading
    a megabyte -- which is the reason the sizes are written down there.

    One language's, because that is what a reader downloads: adding every
    language up would describe a pack nobody fetches.
    """
    return {name: entry["bytes"]
            for name, entry in entries(manifest_of(pack_dir), locale).items()}


def files(manifest: dict[str, Any]) -> list[str]:
    """Every module file a pack names, in every language it ships.

    What a deploy has to carry, as against what one reader fetches: a pack is
    only complete when the file behind each of these is there.
    """
    named = [entry["file"] for entry in manifest.get("modules", {}).values()]
    for spoken in manifest.get("locales", {}).values():
        named += [entry["file"] for entry in spoken.values()]
    return named
