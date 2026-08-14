#!/usr/bin/env python3
"""Read a shipped pack: its manifest, and the modules that manifest names.

A pack is not one file. It is a `manifest.json` plus a set of content-addressed
module files in a directory they all share, and a section may be split across
two of them -- its structure in `core`, the game's own language in `names` --
under the same key in both.

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


def load(pack_dir: Path, *, want: tuple[str, ...] = ()) -> dict[str, Any]:
    """One pack as the single document its modules add up to.

    Args:
        pack_dir: the pack's own directory, holding its manifest.
        want: which modules to read, by name. Empty means all of them -- but a
            caller after asset paths has no use for prose, and `text` is a
            quarter of the pack, so naming what you need is worth it.

    Returns:
        Every section by name, with `meta` from the manifest. A section split
        across modules comes back joined, which is what makes a reader here
        indifferent to which module a column ended up in.
    """
    manifest = manifest_of(pack_dir)
    pack: dict[str, Any] = {"meta": manifest.get("meta", {})}
    for name, entry in manifest["modules"].items():
        if want and name not in want:
            continue
        for section, columns in module(entry["file"]).items():
            held = pack.get(section)
            if isinstance(held, dict) and isinstance(columns, dict):
                held.update(columns)
            else:
                pack[section] = columns
    return pack


def sizes(pack_dir: Path) -> dict[str, int]:
    """What each of a pack's modules costs, by module name.

    Off the manifest rather than off the files, so it answers without reading
    a megabyte -- which is the reason the sizes are written down there.
    """
    return {name: entry["bytes"]
            for name, entry in manifest_of(pack_dir)["modules"].items()}
