#!/usr/bin/env python3
"""Rebuild data packs with the labels they already have, and prove the build.

    python tools/rebuild.py --list           # what would run, for every pack
    python tools/rebuild.py 9.2.7            # rebuild one pack (prefix match)
    python tools/rebuild.py                  # rebuild all ten
    python tools/rebuild.py --verify         # the deterministic-build oracle
    python tools/rebuild.py --verify 11.2.7  # ... against another pack

WHY IT EXISTS. build_data.py takes --label and --default on every invocation
and forgets them otherwise, so a rebuild that omits them silently renames a
pack to its build id and drops the default flag. Those values are already
written down in site/data/versions.json - this reads them back instead of
asking a human to retype ten labels correctly.

--verify IS THE ORACLE. The build is deterministic: rebuilding a pack whose
sources have not changed must reproduce it byte for byte, except meta.built,
which is today's date and changes the content hash. So a no-op rebuild leaves
the tree dirty in a way that looks like a real change and, if committed, makes
every user re-download megabytes for a date. This rebuilds into a scratch copy
of the pack, compares the two with meta.built normalised away, restores the
committed bytes, and reports which of the three outcomes happened:

    identical            the pack is reproducible - nothing to commit
    date only            reproducible; only meta.built moved
    CONTENT DIFFERS      sources or build logic changed - inspect before trusting

It refuses to run against a dirty pack, because restoring afterwards would
throw away whatever was there.
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build" / "build_data.py"
DATA = ROOT / "site" / "data"
MANIFEST = DATA / "versions.json"

RED, GREEN, YELLOW, DIM, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[0m"


def git(*args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                             encoding="utf-8", errors="replace", check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""
    return out.stdout or ""


def entries() -> list[dict]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def select(wanted: str | None) -> list[dict]:
    """All packs, or the ones whose id starts with `wanted`."""
    every = entries()
    if not wanted:
        return every
    hits = [e for e in every if e["id"].startswith(wanted)]
    if not hits:
        known = ", ".join(e["id"] for e in every)
        sys.exit(f"no pack id starts with {wanted!r}\nknown: {known}")
    return hits


def build_argv(entry: dict, refresh: bool) -> list[str]:
    argv = [sys.executable, str(BUILD), "--version", entry["id"], "--label", entry["label"]]
    if entry.get("default"):
        argv.append("--default")
    if entry.get("hidden"):
        argv.append("--hidden")
    if refresh:
        argv.append("--refresh")
    return argv


def payload(path: Path) -> dict:
    """The pack as JSON, with the build date removed."""
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        pack = json.load(fh)
    pack.get("meta", {}).pop("built", None)
    return pack


def describe_difference(before: dict, after: dict) -> list[str]:
    """A short account of what moved - enough to judge, not a full diff."""
    notes = []
    for key in sorted(set(before) | set(after)):
        if key not in before:
            notes.append(f"+{key}")
        elif key not in after:
            notes.append(f"-{key}")
        elif before[key] != after[key]:
            if key == "meta":
                sub = sorted(k for k in set(before[key]) | set(after[key])
                             if before[key].get(k) != after[key].get(k))
                notes.append(f"meta: {', '.join(sub)}")
            elif isinstance(before[key], (list, dict)):
                notes.append(f"{key} ({len(before[key])} -> {len(after[key])})")
            else:
                notes.append(key)
    return notes


def verify(entry: dict, refresh: bool) -> bool:
    """Rebuild into a scratch copy, compare, restore. True when reproducible."""
    pack_rel = f"site/{entry['file']}"
    pack_path = ROOT / pack_rel

    if git("status", "--porcelain", "--", pack_rel).strip():
        print(f"{RED}refusing{RESET} {pack_rel} has uncommitted changes - "
              f"commit or stash them first")
        return False
    if not pack_path.exists():
        print(f"{RED}refusing{RESET} {pack_rel} does not exist yet - build it first")
        return False

    keep = pack_path.with_suffix(".gz.committed")
    shutil.copy2(pack_path, keep)
    try:
        before_bytes = keep.read_bytes()
        before = payload(keep)

        print(f"{DIM}rebuilding {entry['id']} ...{RESET}")
        proc = subprocess.run(build_argv(entry, refresh), cwd=ROOT, check=False)
        if proc.returncode != 0:
            print(f"{RED}build failed{RESET} exit {proc.returncode}")
            return False

        after_bytes = pack_path.read_bytes()
        after = payload(pack_path)

        if after_bytes == before_bytes:
            print(f"{GREEN}identical{RESET}  {entry['id']} reproduced byte for byte")
            return True
        if after == before:
            print(f"{GREEN}date only{RESET}  {entry['id']} is reproducible; only "
                  f"meta.built moved {DIM}(restoring - do not commit this){RESET}")
            return True
        notes = describe_difference(before, after)
        print(f"{YELLOW}CONTENT DIFFERS{RESET}  {entry['id']}: {'; '.join(notes) or 'values changed'}")
        print(f"{DIM}  the sources or the build logic changed - inspect before trusting{RESET}")
        return False
    finally:
        shutil.move(str(keep), str(pack_path))
        git("checkout", "--", "site/data/versions.json")
        print(f"{DIM}  restored {pack_rel} and versions.json{RESET}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("version", nargs="?", help="pack id or a prefix of one (default: all)")
    ap.add_argument("--verify", action="store_true",
                    help="deterministic-build oracle: rebuild, compare, restore")
    ap.add_argument("--refresh", action="store_true", help="re-download sources even if cached")
    ap.add_argument("--list", action="store_true", help="print the commands, run nothing")
    args = ap.parse_args()

    chosen = select(args.version)
    if args.verify and not args.version:
        chosen = [e for e in chosen if e.get("default")] or chosen[:1]

    if args.list:
        for entry in chosen:
            printable = " ".join(f'"{a}"' if " " in a else a for a in build_argv(entry, args.refresh)[1:])
            print(f"python {printable}")
        return 0

    if args.verify:
        return 0 if all([verify(entry, args.refresh) for entry in chosen]) else 1

    for i, entry in enumerate(chosen, 1):
        print(f"{DIM}[{i}/{len(chosen)}] {entry['id']}  {entry['label']}{RESET}")
        proc = subprocess.run(build_argv(entry, args.refresh), cwd=ROOT, check=False)
        if proc.returncode != 0:
            print(f"{RED}build failed{RESET} {entry['id']} exit {proc.returncode}")
            return 1
    print(f"{GREEN}built {len(chosen)} pack(s){RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
