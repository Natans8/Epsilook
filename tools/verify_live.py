#!/usr/bin/env python3
"""Wait for GitHub Pages to publish, then check what it actually serves.

    python tools/verify_live.py              # wait for this tree's ?v=, then check
    python tools/verify_live.py --now        # do not wait; check what is up now
    python tools/verify_live.py --timeout 300

Pages takes about a minute to publish and caches hard, so every request here
carries a cachebust parameter. The routine this replaces is: push, wait, load
the site, confirm the new ?v= is being served and nothing 404s.

It checks the MECHANICAL half only - that the deploy landed and every file it
references is reachable. Whether the feature looks right is still a human
looking at the page, and this prints the URL to do that with.

Exit status is 0 when the expected ?v= is live and every asset resolves.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import packfile
from repo import DIM, GREEN, RED, RESET, YELLOW

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "site" / "index.html"
SITE = "https://natans8.github.io/Epsilook/"

ASSET_RE = re.compile(r'(?:href|src)="((?:css|js)/[^"?]+\?v=[0-9a-z]+)"')
VERSION_RE = re.compile(r'(?:href|src)="(?:css|js)/[^"?]+\?v=([0-9a-z]+)"')


def bust(url: str, token: int) -> str:
    return f"{url}{'&' if '?' in url else '?'}cachebust={token}"


def fetch_once(url: str, token: int, head: bool = False) -> tuple[int, bytes, dict]:
    """One request, cache-busted. Returns (status, body, headers); 0 = no reply."""
    req = urllib.request.Request(
        bust(url, token),
        method="HEAD" if head else "GET",
        headers={"Cache-Control": "no-cache", "User-Agent": "epsilook-verify"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, (b"" if head else resp.read()), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, b"", {}
    except (urllib.error.URLError, TimeoutError):
        return 0, b"", {}


def get(url: str, token: int, head: bool = False, tries: int = 3) -> tuple[int, bytes, dict]:
    """Fetch, retrying what is only transient.

    Pages sits behind a CDN that occasionally answers a perfectly good file
    with a 503 - observed once on js/pills.js during this script's own first
    run, 200 on the very next request. Reporting that as a broken deploy is
    worse than not checking at all, because a verifier that cries wolf stops
    being read. A 4xx is never retried: that is a real answer.
    """
    for attempt in range(1, tries + 1):
        status, body, headers = fetch_once(url, token + attempt, head)
        transient = status == 0 or status in (429, 500, 502, 503, 504)
        if not transient or attempt == tries:
            if transient and attempt > 1:
                print(f"{DIM}  gave up after {tries} tries{RESET}")
            return status, body, headers
        print(
            f"{DIM}  HTTP {status or 'no reply'} on {url.rsplit('/', 1)[-1]}, retrying ({attempt}/{tries - 1}){RESET}"
        )
        time.sleep(2 * attempt)
    return 0, b"", {}


def git(*args: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), *args], capture_output=True, encoding="utf-8", errors="replace", check=True
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""
    return out.stdout or ""


def check_pushed() -> None:
    """A local commit that was never pushed will never appear on Pages."""
    local = git("rev-parse", "HEAD").strip()
    git("fetch", "--quiet", "origin", "main")
    remote = git("rev-parse", "origin/main").strip()
    if local and remote and local != remote:
        ahead = git("rev-list", "--count", "origin/main..HEAD").strip() or "?"
        print(
            f"{YELLOW}warning{RESET}  HEAD is {ahead} commit(s) ahead of origin/main "
            f"{DIM}- push before this can pass{RESET}"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--expect", help="the ?v= to wait for (default: this tree's)")
    ap.add_argument("--timeout", type=int, default=300, help="seconds to wait (default: 300)")
    ap.add_argument("--now", action="store_true", help="check what is live now, do not wait")
    ap.add_argument("--site", default=SITE, help=f"base URL (default: {SITE})")
    args = ap.parse_args()

    expected = args.expect
    if not expected:
        found = VERSION_RE.findall(INDEX.read_text(encoding="utf-8"))
        if not found:
            print("site/index.html references no versioned assets", file=sys.stderr)
            return 1
        expected = sorted(set(found))[0]

    check_pushed()

    # 1. wait for the new index.html to be the one Pages serves
    deadline = time.time() + (0 if args.now else args.timeout)
    attempt = 0
    while True:
        attempt += 1
        status, body, _ = get(args.site, int(time.time() * 1000))
        html = body.decode("utf-8", "replace")
        live = sorted(set(VERSION_RE.findall(html)))
        served = live[0] if live else "?"
        if status == 200 and expected in live:
            print(f"{GREEN}live{RESET}  {expected} is being served {DIM}(attempt {attempt}){RESET}")
            break
        if time.time() >= deadline:
            if args.now:
                print(f"{YELLOW}serving {served}{RESET}, expected {expected} {DIM}(--now, did not wait){RESET}")
            else:
                print(f"{RED}timeout{RESET}  after {args.timeout}s Pages still serves {served}, expected {expected}")
            return 1
        print(f"{DIM}  serving {served}, waiting for {expected} ...{RESET}")
        time.sleep(10)

    failures = 0

    # 1b. wait for the MANIFEST to be the one we just built.
    #
    # ⚠ STEP 1 CANNOT SEE A DATA-ONLY DEPLOY, and reporting its absence as
    # success is worse than not checking. The packs self-bust on a content hash,
    # so rebuilding them changes no ?v= at all — the string step 1 waits for is
    # already live the moment it is asked, it breaks out immediately, and every
    # pack below is then compared against a CDN that has not caught up. That is
    # exactly what happened on 2026-08-09: ten "FAIL ... bytes live" lines for a
    # deploy that was fine and simply had not propagated.
    #
    # versions.json carries a content hash per pack, so it IS the oracle for
    # this half, the same way index.html's ?v= is for the other.
    local_manifest: list[dict] = json.loads((ROOT / "site" / "data" / "versions.json").read_text(encoding="utf-8"))
    attempt = 0
    while True:
        attempt += 1
        status, body, _ = get(args.site + "data/versions.json", int(time.time() * 1000))
        try:
            served_manifest = json.loads(body) if status == 200 else None
        except json.JSONDecodeError:
            served_manifest = None
        if served_manifest == local_manifest:
            print(f"{GREEN}live{RESET}  manifest matches {DIM}({len(local_manifest)} packs, attempt {attempt}){RESET}")
            break
        if time.time() >= deadline:
            stale = "unreadable" if served_manifest is None else "still the previous one"
            if args.now:
                print(f"{YELLOW}manifest {stale}{RESET} {DIM}(--now, did not wait){RESET}")
            else:
                print(f"{RED}timeout{RESET}  after {args.timeout}s the served manifest is {stale}")
            return 1
        print(f"{DIM}  manifest not propagated yet, waiting ...{RESET}")
        time.sleep(10)

    # 2. every versioned asset the live page references must resolve
    assets = sorted(set(ASSET_RE.findall(html)))
    for asset in assets:
        status, body, _ = get(args.site + asset, int(time.time() * 1000))
        if status != 200 or not body:
            failures += 1
            print(f"{RED}FAIL{RESET}  {asset} {DIM}HTTP {status}, {len(body)} bytes{RESET}")
    if not failures:
        print(f"{GREEN}ok{RESET}    {len(assets)} versioned assets resolve")

    # 3. the packs: the manifest is the app's own index, so walk it. 1b only
    # breaks once the SERVED manifest equals this one, so iterating the local
    # copy walks exactly what is live — and is a list rather than `Any | None`.
    # A pack is its manifest plus the modules that manifest names, and the
    # modules are what the bytes are in — so checking only the manifest would
    # pass on a deploy that shipped an index to files it never uploaded. Named
    # modules are collected across packs first: builds on one game build share
    # a file, and requesting it once per pack would be the same HEAD repeatedly.
    manifest = local_manifest
    wanted: dict[str, str] = {}
    for entry in manifest:
        url = args.site + entry["file"] + f"?v={entry['hash']}"
        status, body, _ = get(url, int(time.time() * 1000))
        if status != 200:
            failures += 1
            print(f"{RED}FAIL{RESET}  {entry['id']} manifest HTTP {status}")
            continue
        # Every language, not the one a reader picks: a deploy is complete only
        # when the file behind each of them is up.
        for file in packfile.files(json.loads(body)):
            wanted[file] = entry["id"]

    for file, owner in sorted(wanted.items()):
        status, _, headers = get(args.site + file, int(time.time() * 1000), head=True)
        size = int(headers.get("Content-Length", 0) or 0)
        local = ROOT / "site" / file
        local_size = local.stat().st_size if local.exists() else -1
        if status != 200:
            failures += 1
            print(f"{RED}FAIL{RESET}  {owner} module {file} HTTP {status}")
        elif local_size >= 0 and size != local_size:
            failures += 1
            print(f"{RED}FAIL{RESET}  {file} is {size:,} bytes live, {local_size:,} local")
    if not failures:
        print(f"{GREEN}ok{RESET}    {len(manifest)} packs served over {len(wanted)} module(s), sizes match local")

    print()
    if failures:
        print(f"{RED}{failures} problem(s) live{RESET}")
        return 1
    print(f"{GREEN}deploy verified{RESET}  {DIM}{args.site}{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
