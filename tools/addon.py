#!/usr/bin/env python3
"""Build the addon's data from a pack that has already shipped.

    uv run python tools/addon.py                 # both variations, default pack
    uv run python tools/addon.py --pack 9.2.7    # one pack (prefix match)
    uv run python tools/addon.py --variation full
    uv run python tools/addon.py --list          # what would be written

A transform of the artifact rather than a second build of it. The browser's
modules already hold every section in the layout its record declared, so the
addon's data is those same payloads written in a shape Lua can index. That
makes this seconds rather than a minute, and it makes a disagreement between
the two media impossible to introduce here: nothing on this path can produce a
column, only spell one differently.

Two variations, and the difference is what a running client can answer for
itself. `full` carries every section and is what the query engine is tested
against, since a gap there would look like an engine defect. `lean` leaves out
whatever the supply table names, for an addon that asks the game instead. The
table is empty today, so the two agree until a route is proven against the
client and one row is added.

What lands on disk is a complete, installable set of addon directories. It is
generated, so it is not tracked: a variation is tens of megabytes and rebuilds
from the pack in seconds.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import packfile
from repo import ROOT, log, survive_console_encoding

sys.path.insert(0, str(ROOT / "build"))

from pack.emit.addon import Variation, chunks  # noqa: E402
from pack.model import SECTIONS  # noqa: E402

survive_console_encoding()

DATA = ROOT / "site" / "data"

OUT = ROOT / "addon" / "build"
"""Where a variation's addon directories land.

Under the sub-project rather than beside the pack, because these are the
addon's files and nothing the site serves. One directory per variation, so a
player copies one of them into the client and gets a coherent set.
"""


def chosen(prefix: str) -> Path:
    """The pack directory to read, by an unambiguous prefix of its id.

    Raises:
        SystemExit: no pack matches, or more than one does. Guessing which
            was meant would silently build the addon from another client.
    """
    packs = sorted(path for path in DATA.iterdir()
                   if path.is_dir() and (path / "manifest.json").exists())
    if not prefix:
        return next((path for path in packs if "epsilon" in path.name), packs[0])
    matched = [path for path in packs if path.name.startswith(prefix)]
    if len(matched) != 1:
        sys.exit(f"error: {prefix!r} matches {len(matched)} packs; "
                 f"one of {', '.join(path.name for path in packs)}")
    return matched[0]


def write(chunk_files: dict[str, dict[str, bytes]], into: Path) -> int:
    """Replace a variation's directory with the chunks just built.

    Replaced rather than merged: an axis that stopped being emitted would
    otherwise stay on disk and keep answering, which is exactly the failure a
    clipped section is meant to produce visibly.
    """
    if into.exists():
        shutil.rmtree(into)
    written = 0
    for addon, files in chunk_files.items():
        directory = into / addon
        directory.mkdir(parents=True)
        for name, payload in files.items():
            # Bytes, and never text: the blob is addressed by byte offset, so
            # a newline translated on the way to disk would move every column
            # written after it.
            (directory / name).write_bytes(payload)
            written += 1
    return written


def build(pack_dir: Path, variation: Variation, *, dry: bool) -> None:
    """One variation of the addon data, from one shipped pack."""
    sections = packfile.load(pack_dir)
    meta = sections.pop("meta", {})
    built = chunks(SECTIONS, sections, pack=pack_dir.name,
                   version=str(meta.get("version", pack_dir.name)),
                   built=str(meta.get("built", "")), variation=variation,
                   absent=tuple(meta.get("absentSections", ())))
    total = sum(len(payload) for chunk in built
                for payload in chunk.files.values())
    log(f"{variation.value}: {len(built)} addons, {total:,} bytes")
    for chunk in built:
        size = sum(len(payload) for payload in chunk.files.values())
        log(f"    {chunk.addon:26} {size:>12,}")
    if dry:
        return
    into = OUT / variation.value
    write({chunk.addon: dict(chunk.files) for chunk in built}, into)
    log(f"  wrote {into}")


def main() -> None:
    """Build the variations named on the command line."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", default="", metavar="PREFIX",
                        help="which shipped pack to read; defaults to the "
                             "Epsilon one, which is the client the addon runs "
                             "on")
    parser.add_argument("--variation", action="append", default=[],
                        choices=[member.value for member in Variation],
                        help="which variation to build, repeatable; both by "
                             "default")
    parser.add_argument("--list", dest="dry", action="store_true",
                        help="report what would be written and write nothing")
    args = parser.parse_args()

    pack_dir = chosen(args.pack)
    wanted = ([Variation(name) for name in args.variation]
              or list(Variation))
    log(f"Reading {pack_dir.name}")
    for variation in wanted:
        build(pack_dir, variation, dry=args.dry)


if __name__ == "__main__":
    main()
