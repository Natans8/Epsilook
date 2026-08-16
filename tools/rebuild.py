#!/usr/bin/env python3
"""Rebuild data packs with the labels they already have, and prove the build.

    python tools/rebuild.py --list           # what would run, for every pack
    python tools/rebuild.py 9.2.7            # rebuild one pack (prefix match)
    python tools/rebuild.py                  # rebuild the whole roster
    python tools/rebuild.py --verify         # the oracle, on the DEFAULT pack
    python tools/rebuild.py --verify 11.2.7  # ... against another pack
    python tools/rebuild.py --verify --all   # ... against every pack

WHY IT EXISTS. The build takes --label and --default on every invocation and
forgets them otherwise, so a rebuild that omits them silently renames a pack to
its build id and drops the default flag. Those values are already written down
in tools/packs.py - this reads them back instead of asking a human to retype a
dozen labels correctly.

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
import json
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import packfile
from packs import PACKS, Pack, select, stale_cache
from repo import DIM, GREEN, RED, RESET, YELLOW

ROOT = Path(__file__).resolve().parent.parent
BUILD = "pack"
"""The build package, run as a module.

A module rather than a path because it IS a package: running its directory as a
script gives it no parent, so its own relative imports fail.
"""

BUILD_ROOT = ROOT / "build"
"""Where the package is importable from, which is what `cwd` is set to."""
DATA = ROOT / "site" / "data"
MANIFEST = DATA / "versions.json"
UV_RUN = ["uv", "run", "python"]
"""How every Python the repository owns is launched (see `build_argv`)."""



def git(*args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                             encoding="utf-8", errors="replace", check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""
    return out.stdout or ""


def build_argv(pack: Pack, refresh: bool, timing: bool = False) -> list[str]:
    """The command that builds one pack, run through the pinned environment.

    `uv run` rather than this script's own interpreter: the build takes runtime
    dependencies now (sqlglot reads the TDB dump's DDL), and they are pinned by
    uv.lock. Spawning the ambient interpreter picks up whichever site-packages
    happen to be on the machine, which on a clean checkout is none of them.
    """
    argv = [*UV_RUN, "-m", BUILD, "--version", pack.build, "--label", pack.label]
    if pack.id != pack.build:
        argv += ["--id", pack.id]
    # Named only where the roster names them: a client that publishes every
    # language says nothing, and gets every language the build declares.
    for locale in pack.locales:
        argv += ["--locale", locale]
    if pack.client:
        argv += ["--client", pack.client]
    if pack.default:
        argv.append("--default")
    if pack.hidden:
        argv.append("--hidden")
    if refresh:
        argv.append("--refresh")
    if timing:
        argv.append("--timing")
    return argv


def jobs_for(asked: int, chosen: Sequence[Pack]) -> int:
    """How many builds to run at once.

    Defaults to every chosen pack rather than to a core count, because the
    roster is smaller than the machine: twelve independent programs against far
    more logical cores than that, so a pool sized from cores would only make
    packs queue for slots that are not scarce.

    Each build holds its own spell graph, so the resource that could bind this
    is memory rather than cores. `--jobs` is the knob for a machine where it
    does; nothing here measures it, so a build host with less headroom than the
    roster needs is expected to say so rather than to be detected.
    """
    if asked > 0:
        return min(asked, len(chosen))
    return max(1, len(chosen))


def prewarm(chosen: Sequence[Pack], refresh: bool) -> int:
    """Fetch every chosen pack's sources, one at a time. Non-zero on failure.

    THE FETCH PHASE, AND IT RUNS SERIALLY ON PURPOSE -- separating acquisition
    from execution is what makes the fan-out safe. Builds share sources, and two
    of them downloading one file into one path is the race this removes: the
    loser reads a half-written file as though it were the source, which is a
    wrong pack rather than a failed one.

    Deduplicated by build id, because that is what a cache directory is keyed
    by: a test line sharing a patch with live reads exactly the same sources, so
    warming them twice would only pay the interpreter's startup again.

    What a build's languages are is the UNION over the packs on it, not the
    first one's. Two packs can sit on one build and want different languages,
    and warming only one of the two would leave the other's fetched by the
    build itself -- concurrently, into the one path, which is the race this
    exists to remove.
    """
    by_build: dict[str, list[Pack]] = {}
    for pack in chosen:
        by_build.setdefault(pack.build, []).append(pack)

    for build, packs in by_build.items():
        # Empty means every declared language here exactly as it does on a
        # roster row, so one pack asking for all of them settles the build.
        locales = (set() if any(not pack.locales for pack in packs)
                   else {code for pack in packs for code in pack.locales})
        argv = [*UV_RUN, "-m", BUILD, "--version", build, "--sources-only"]
        for locale in sorted(locales):
            argv += ["--locale", locale]
        if refresh:
            argv.append("--refresh")
        proc = subprocess.run(argv, cwd=BUILD_ROOT, capture_output=True,
                              encoding="utf-8", errors="replace", check=False)
        if proc.returncode != 0:
            print(f"{RED}fetch failed{RESET} {build} exit {proc.returncode}")
            print(proc.stdout or "", proc.stderr or "", sep="")
            return proc.returncode
    return 0


def build_one(pack: Pack, refresh: bool, timing: bool,
              capture: bool) -> tuple[Pack, int, str]:
    """Run one pack's build to completion, and bring back what it said.

    `capture` is false for a lone build, which is the development loop: its
    output goes straight to the terminal so a build in progress can be watched,
    exactly as it did before there was a pool. Captured output would turn a
    twenty-five second build into twenty-five seconds of silence.
    """
    proc = subprocess.run(build_argv(pack, refresh, timing), cwd=BUILD_ROOT,
                          capture_output=capture, encoding="utf-8",
                          errors="replace", check=False)
    if not capture:
        return pack, proc.returncode, ""
    return pack, proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def run_serially(chosen: Sequence[Pack], refresh: bool, timing: bool) -> int:
    """Build the packs one after another, streaming. How many failed.

    Stops at the first failure, which is what a single-pack development loop
    wants: the next pack's output would only bury the traceback.
    """
    for at, pack in enumerate(chosen, 1):
        print(f"{DIM}[{at}/{len(chosen)}] {pack.id}  {pack.label}{RESET}")
        _pack, code, _output = build_one(pack, refresh, timing, capture=False)
        if code != 0:
            print(f"{RED}build failed{RESET} {pack.id} exit {code}")
            return 1
    return 0


def run_together(chosen: Sequence[Pack], refresh: bool, timing: bool,
                 jobs: int) -> int:
    """Build the packs at once, printing each whole. How many failed.

    Every pack is attempted even after one fails, because they are independent
    and a fan-out that abandoned the rest would leave the tree holding some
    packs from this build and some from the last.
    """
    failed = 0
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        running = [pool.submit(build_one, pack, refresh, timing, True)
                   for pack in chosen]
        for done, future in enumerate(as_completed(running), 1):
            pack, code, output = future.result()
            print(f"{DIM}[{done}/{len(chosen)}] {pack.id}  {pack.label}{RESET}")
            print(output, end="" if output.endswith("\n") else "\n")
            if code != 0:
                print(f"{RED}build failed{RESET} {pack.id} exit {code}")
                failed += 1
    return failed


def build_all(chosen: Sequence[Pack], refresh: bool, timing: bool,
              jobs: int) -> int:
    """Build every chosen pack. Zero when they all succeeded.

    Subprocesses supervised by threads rather than a process pool: a build is
    already a separate program, so a pool of Python workers would only be
    processes that go on to start these ones. The threads do nothing but wait,
    which is work the interpreter lock does not hold.

    Fanned out, output is captured per build and printed whole when that build
    finishes: twelve builds writing to one terminal at once interleave into
    something nobody can read, and a phase table is worth nothing shredded. One
    at a time it streams instead, because that path is the development loop and
    watching a build is the point of its progress lines.
    """
    started = time.monotonic()
    if jobs == 1:
        failed = run_serially(chosen, refresh, timing)
    else:
        print(f"{DIM}fetching sources for {len(chosen)} pack(s) ...{RESET}")
        fetched = time.monotonic()
        if (code := prewarm(chosen, refresh)) != 0:
            return code
        print(f"{DIM}sources ready [{time.monotonic() - fetched:.1f}s]{RESET}")
        failed = run_together(chosen, refresh, timing, jobs)
    elapsed = time.monotonic() - started
    if failed:
        print(f"{RED}{failed} of {len(chosen)} build(s) failed{RESET}")
        return 1
    print(f"{DIM}built {len(chosen)} pack(s) across {jobs} job(s) "
          f"[{elapsed:.1f}s]{RESET}")
    return 0


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


def prune_modules() -> tuple[int, int]:
    """Delete module files no pack's manifest names. Count and bytes freed.

    A module is named by its own content, so changing one writes a new file
    beside the old rather than over it. Nothing breaks when the old one stays --
    every manifest already points at the new one -- but these are LFS objects
    and the repository keeps paying for them.

    Safe on a targeted rebuild as well as a full one: what counts as named is
    read from EVERY pack's manifest on disk, so a pack nobody rebuilt still
    speaks for the modules it uses.
    """
    directory = DATA / "modules"
    if not directory.is_dir():
        return 0, 0

    named: set[str] = set()
    for manifest_path in DATA.glob("*/manifest.json"):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        named.update(Path(file).name for file in packfile.files(manifest))

    gone, freed = 0, 0
    for path in sorted(directory.iterdir()):
        if not path.is_file() or path.name in named:
            continue
        freed += path.stat().st_size
        git("rm", "--quiet", "--", f"site/data/modules/{path.name}")
        path.unlink(missing_ok=True)
        gone += 1
    return gone, freed


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
    """The pack's manifest as JSON, with the build date removed.

    THE MANIFEST IS ENOUGH TO PROVE THE WHOLE PACK. A module is named by the
    hash of its own bytes, so two manifests naming the same files name modules
    whose contents are identical -- there is nothing left to compare. Reading
    the modules as well would re-derive hashes the filenames already state.

    Only `meta.built` is normalised away, and only because it is today's date:
    it rides in the manifest rather than in a module precisely so that a rebuild
    on a later day leaves every module's name untouched.
    """
    manifest = json.loads(path.read_text(encoding="utf-8"))
    meta = manifest.get("meta")
    if isinstance(meta, dict):
        meta.pop("built", None)
    return manifest


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


def verify(pack: Pack, refresh: bool, timing: bool = False) -> bool:
    """Rebuild into a scratch copy, compare, restore. True when reproducible."""
    pack_rel = f"site/data/{pack.id}/manifest.json"
    pack_path = ROOT / pack_rel

    if git("status", "--porcelain", "--", pack_rel).strip():
        print(f"{RED}refusing{RESET} {pack_rel} has uncommitted changes - "
              f"commit or stash them first")
        return False
    if not pack_path.exists():
        print(f"{RED}refusing{RESET} {pack_rel} does not exist yet - build it first")
        return False

    # Named so the manifest glob elsewhere in this file cannot pick it up: a
    # scratch copy counted as a pack would speak for modules twice.
    keep = pack_path.with_name("manifest.committed.json")
    shutil.copy2(pack_path, keep)
    try:
        before_bytes = keep.read_bytes()
        before = payload(keep)

        print(f"{DIM}rebuilding {pack.id} ...{RESET}")
        proc = subprocess.run(build_argv(pack, refresh, timing), cwd=BUILD_ROOT, check=False)
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
    ap.add_argument("--all", action="store_true",
                    help="with --verify, check every pack rather than the "
                         "default one")
    ap.add_argument("--verify", action="store_true",
                    help="deterministic-build oracle: rebuild, compare, restore")
    ap.add_argument("--refresh", action="store_true", help="re-download sources even if cached")
    ap.add_argument("--list", action="store_true", help="print the commands, run nothing")
    ap.add_argument("--timing", action="store_true",
                    help="have each build print where its time went, phase by phase")
    ap.add_argument("--jobs", type=int, default=0, metavar="N",
                    help="how many packs to build at once (default: all of "
                         "them; 1 builds one after another)")
    ap.add_argument("--prune-cache", action="store_true",
                    help="delete the download caches no pack needs, and stop "
                         "(a rebuild does this for you)")
    ap.add_argument("--prune-modules", action="store_true",
                    help="delete the module files no pack's manifest names, "
                         "and stop (a rebuild does this for you)")
    args = ap.parse_args()

    if args.prune_cache:
        freed = prune_cache()
        print(f"{GREEN}freed {freed / 1e6:,.0f} MB{RESET}" if freed
              else f"{GREEN}cache is current{RESET}")
        return 0

    if args.prune_modules:
        stale, reclaimed = prune_modules()
        print(f"{GREEN}pruned {stale} module(s), {reclaimed / 1e6:,.0f} MB{RESET}"
              if stale else f"{GREEN}every module on disk is named{RESET}")
        return 0

    chosen = select(args.version)
    if args.verify and not args.version and not args.all:
        # One pack by default because a rebuild is minutes and the oracle is
        # usually asked about a change just made. Narrowing SILENTLY was the
        # bug: the run then looks like a whole-roster proof it never was.
        chosen = [p for p in chosen if p.default] or chosen[:1]

    if args.list:
        for pack in chosen:
            printable = " ".join(f'"{a}"' if " " in a else a
                                 for a in build_argv(pack, args.refresh, args.timing))
            print(printable)
        return 0

    if args.verify:
        print(f"verifying {len(chosen)} of {len(PACKS)} pack(s): "
              f"{', '.join(p.id for p in chosen)}"
              + ("" if args.all or args.version
                 else f"  {DIM}(--all for the whole roster){RESET}"))
        failed = [pack.id for pack in chosen
                  if not verify(pack, args.refresh, args.timing)]
        # Said again at the end, because a rebuild prints thousands of lines
        # and the verdict is the one thing a reader scrolls to.
        verdict = RED if failed else GREEN
        print(f"\n{verdict}{len(chosen) - len(failed)}/{len(chosen)} reproduced{RESET}"
              + (f" - differs: {', '.join(failed)}" if failed else ""))
        return 1 if failed else 0

    if build_all(chosen, args.refresh, args.timing, jobs_for(args.jobs, chosen)) != 0:
        return 1

    # Only after every requested build SUCCEEDED. Retiring first would delete a
    # shipped pack and then leave nothing in its place if the build then failed.
    for name in retire_superseded(chosen):
        print(f"{DIM}retired    site/data/{name} (no longer in the roster){RESET}")
    stale, reclaimed = prune_modules()
    if stale:
        print(f"{DIM}pruned     {stale} module(s) no manifest names, "
              f"{reclaimed / 1e6:,.0f} MB{RESET}")
    freed = prune_cache()

    note = f", freed {freed / 1e6:,.0f} MB of cache" if freed else ""
    print(f"{GREEN}built {len(chosen)} pack(s){RESET}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
