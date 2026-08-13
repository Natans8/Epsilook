#!/usr/bin/env python3
"""Which shipped packs would a newer community listfile actually change?

    python tools/listfile.py            # every pack on disk
    python tools/listfile.py midnight   # one pack (prefix match)

WHY IT EXISTS. The listfile keeps growing for builds already shipped, so a
pack's asset names can go stale without anything in the game moving. Acting on
that is cheap to say and expensive to do wrong in both directions: rebuilding
every pack re-ships ~94 MB of LFS and makes every user re-download it, while
rebuilding none leaves names missing that the community has since supplied.

The decisive question is not which expansion a file id belongs to -- file ids
climb with build recency, but a Classic re-release runs a modern client and
references ids far above its own era, so that ordering answers nothing. It is
simply: does the listfile give a DIFFERENT name to any file id this pack
already references? A pack ships its own fid -> path table, so the answer is an
intersection, and it costs seconds instead of a rebuild.

A pack with no differences cannot change except in `meta.listfileTag`, and
re-shipping it would cost its whole size for a metadata string.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import sys
from pathlib import Path

from packs import select

from repo import CACHE

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
LISTFILE = CACHE / "listfile" / "community-listfile.csv"
TAG_FILE = CACHE / "listfile" / "release-tag.txt"

RED, GREEN, YELLOW, DIM, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[0m"


def pack_files(path: Path) -> tuple[dict[int, str], str]:
    """A pack's fid -> path table, and the listfile tag it was built against."""
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        pack = json.load(handle)
    files = pack["files"]
    # Negative ids are the build's own inventions -- the equipped-weapon slots,
    # which stand in for "whatever the caster is holding" and name no asset. The
    # listfile cannot know them, and counting them as lost names reports every
    # pack as stale forever.
    named = {int(fid): name for fid, name in zip(files["fids"], files["paths"])
             if int(fid) > 0}
    return named, pack["meta"].get("listfileTag", "")


def listfile_names(wanted: set[int]) -> dict[int, str]:
    """The cached listfile's names for the file ids asked for.

    Only the wanted ids are kept: the listfile is ~149 MB over some 4 million
    rows, and the packs between them reference under a hundred thousand.
    """
    csv.field_size_limit(10_000_000)
    found: dict[int, str] = {}
    with LISTFILE.open(newline="", encoding="utf-8") as handle:
        for row in csv.reader(handle, delimiter=";"):
            if len(row) < 2:
                continue
            fid = int(row[0])
            if fid in wanted:
                found[fid] = row[1]
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", nargs="?", help="pack id or a prefix of one (default: all)")
    args = parser.parse_args()

    if not LISTFILE.exists():
        print(f"{YELLOW}no cached listfile{RESET} — run a build first")
        return 0
    cached_tag = TAG_FILE.read_text(encoding="utf-8").strip() if TAG_FILE.exists() else "unknown"

    packs = [(pack, DATA / pack.id / "spelldata.json.gz") for pack in select(args.version)]
    packs = [(pack, path) for pack, path in packs if path.exists()]
    if not packs:
        print("no packs on disk")
        return 0

    print(f"{DIM}cached listfile: {cached_tag}{RESET}")
    tables = {pack.id: pack_files(path) for pack, path in packs}
    wanted = {fid for named, _ in tables.values() for fid in named}
    print(f"{DIM}resolving {len(wanted):,} referenced file ids ...{RESET}")
    current = listfile_names(wanted)

    stale = []
    for pack, _ in packs:
        named, built_against = tables[pack.id]
        renamed = {fid for fid, name in named.items()
                   if fid in current and current[fid] != name}
        gained = {fid for fid, name in named.items() if not name and fid in current}
        lost = {fid for fid, name in named.items() if name and fid not in current}
        moved = len(renamed | gained | lost)
        mark = f"{YELLOW}would change{RESET}" if moved else f"{GREEN}unaffected {RESET}"
        detail = (f"{len(gained)} newly named, {len(renamed) - len(gained & renamed)} renamed, "
                  f"{len(lost)} lost" if moved else "no name differs")
        behind = "" if built_against == cached_tag else f"  {DIM}(built against {built_against}){RESET}"
        print(f"  {mark} {pack.id:20s} {len(named):>7,} fids  {detail}{behind}")
        if moved:
            stale.append(pack.key)

    print()
    if stale:
        print(f"{YELLOW}{len(stale)} pack(s) would change{RESET} — "
              f"python tools/rebuild.py {' '.join(stale)}")
        return 0
    print(f"{GREEN}no pack would change{RESET} — a rebuild would move only "
          f"meta.listfileTag, so it is not worth the re-download")
    return 0


if __name__ == "__main__":
    sys.exit(main())
