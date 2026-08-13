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

from packs import PACKS, Pack, select, stale_cache
from repo import DIM, GREEN, RED, RESET, YELLOW

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build" / "build_data.py"
DATA = ROOT / "site" / "data"
MANIFEST = DATA / "versions.json"



def git(*args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                             encoding="utf-8", errors="replace", check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""
    return out.stdout or ""


def build_argv(pack: Pack, refresh: bool) -> list[str]:
    argv = [sys.executable, str(BUILD), "--version", pack.build, "--label", pack.label]
    if pack.id != pack.build:
        argv += ["--id", pack.id]
    if pack.default:
        argv.append("--default")
    if pack.hidden:
        argv.append("--hidden")
    if refresh:
        argv.append("--refresh")
    return argv


def retire_superseded(built: list[Pack]) -> list[str]:
    """Drop the packs the ones just built REPLACED, and say what went.

    THIS IS THE STEP A PATCH BUMP USED TO LEAVE TO A HUMAN. write_pack()
    replaces the manifest entry whose id matches EXACTLY, so bumping
    1.15.8.67156 -> 1.15.9.69109 adds a second entry and keeps the first: two
    Vanilla packs in the dropdown, the stale one still downloaded by anyone
    holding its ?v= link, and ~5 MB of LFS kept alive for nothing.

    ⚠ SCOPED TO WHAT WAS JUST BUILT, and that is not fussiness. "Delete anything
    the roster does not name" reads as equivalent and silently destroys a
    targeted rebuild: `rebuild.py vanilla` would also find the OLD tbc and mop
    directories unnamed by the bumped roster and delete them, with no
    replacement built — three packs gone to update one.

    A pack line is identified by its major version. So a directory is superseded
    when it shares a major with a pack that just built successfully — unless the
    roster still names it, which is what keeps a second pack on the same major
    (retail and its PTR) from retiring its sibling the moment either rebuilds.
    """
    majors = {pack.id.split(".")[0] for pack in built}
    current = {pack.id for pack in PACKS}
    gone = []

    for directory in sorted(DATA.iterdir()):
        if not directory.is_dir():
            continue
        if directory.name.split(".")[0] not in majors or directory.name in current:
            continue
        # git rm keeps the deletion staged and the LFS pointer in step. It fails
        # for a pack that was never committed, and git() swallows that — so the
        # rmtree below is the unconditional follow-up rather than an else branch.
        git("rm", "-r", "--quiet", "--", f"site/data/{directory.name}")
        shutil.rmtree(directory, ignore_errors=True)
        gone.append(directory.name)

    if gone and MANIFEST.exists():
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        kept = [e for e in manifest if e["id"] not in gone]
        MANIFEST.write_text(json.dumps(kept, indent=2) + "\n", encoding="utf-8")

    return gone


def prune_cache() -> int:
    """Delete the download caches no pack in the roster needs. Bytes freed.

    THE OTHER HALF OF retire_superseded, AND IT RUNS ON THE SAME EVENT. A bump
    retires the pack the new one replaced; the build directory that fed it is
    just as dead, and it is far larger — a retail build's tables are ~300 MB
    against an 18 MB pack. Sweeping here means the cache rotates as a
    consequence of the work rather than as a chore nobody is reminded of.

    Which directories qualify is packs.stale_cache()'s decision, so the pinned
    and shared ones are spared by one rule rather than by two lists.
    """
    freed = 0
    for directory, size in stale_cache():
        shutil.rmtree(directory, ignore_errors=True)
        print(f"{DIM}pruned     .cache/{directory.name} ({size / 1e6:,.0f} MB){RESET}")
        freed += size
    return freed


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


def verify(pack: Pack, refresh: bool) -> bool:
    """Rebuild into a scratch copy, compare, restore. True when reproducible."""
    pack_rel = f"site/data/{pack.id}/spelldata.json.gz"
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

        print(f"{DIM}rebuilding {pack.id} ...{RESET}")
        proc = subprocess.run(build_argv(pack, refresh), cwd=ROOT, check=False)
        if proc.returncode != 0:
            print(f"{RED}build failed{RESET} exit {proc.returncode}")
            return False

        after_bytes = pack_path.read_bytes()
        after = payload(pack_path)

        if after_bytes == before_bytes:
            print(f"{GREEN}identical{RESET}  {pack.id} reproduced byte for byte")
            return True
        if after == before:
            print(f"{GREEN}date only{RESET}  {pack.id} is reproducible; only "
                  f"meta.built moved {DIM}(restoring - do not commit this){RESET}")
            return True
        notes = describe_difference(before, after)
        print(f"{YELLOW}CONTENT DIFFERS{RESET}  {pack.id}: {'; '.join(notes) or 'values changed'}")
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
    ap.add_argument("--prune-cache", action="store_true",
                    help="delete the download caches no pack needs, and stop "
                         "(a rebuild does this for you)")
    args = ap.parse_args()

    if args.prune_cache:
        freed = prune_cache()
        print(f"{GREEN}freed {freed / 1e6:,.0f} MB{RESET}" if freed
              else f"{GREEN}cache is current{RESET}")
        return 0

    chosen = select(args.version)
    if args.verify and not args.version:
        chosen = [p for p in chosen if p.default] or chosen[:1]

    if args.list:
        for pack in chosen:
            printable = " ".join(f'"{a}"' if " " in a else a for a in build_argv(pack, args.refresh)[1:])
            print(f"python {printable}")
        return 0

    if args.verify:
        return 0 if all([verify(pack, args.refresh) for pack in chosen]) else 1

    for i, pack in enumerate(chosen, 1):
        print(f"{DIM}[{i}/{len(chosen)}] {pack.id}  {pack.label}{RESET}")
        proc = subprocess.run(build_argv(pack, args.refresh), cwd=ROOT, check=False)
        if proc.returncode != 0:
            print(f"{RED}build failed{RESET} {pack.id} exit {proc.returncode}")
            return 1

    # Only after every requested build SUCCEEDED. Retiring first would delete a
    # shipped pack and then leave nothing in its place if the build then failed.
    for name in retire_superseded(chosen):
        print(f"{DIM}retired    site/data/{name} (no longer in the roster){RESET}")
    freed = prune_cache()

    note = f", freed {freed / 1e6:,.0f} MB of cache" if freed else ""
    print(f"{GREEN}built {len(chosen)} pack(s){RESET}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
