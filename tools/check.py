#!/usr/bin/env python3
"""Epsilook's one-command gate: run every check before a push.

    python tools/check.py                 # everything, base = origin/main
    python tools/check.py --fast          # skip the toolchain checks (no npx/mypy)
    python tools/check.py --base HEAD~1   # compare against a different deploy
    python tools/check.py --quiet         # only failures and warnings

Two families of check live here.

  TOOLCHAIN - tsc, node --check, mypy, pyflakes. Nothing repo-specific; they
  just used to be four commands to remember.

  REPO GUARDS - the invariants CLAUDE.md states in prose and a human has to
  remember: the ?v= string is one string in all thirteen places, it is bumped
  whenever css/js changed against what is deployed, every module in docs/js is
  actually referenced by index.html, the committed blobs are LF, and
  versions.json agrees with the packs on disk down to the content hash.

A guard belongs here when it is mechanical and its failure is invisible. The
?v= bump is the archetype: nothing breaks at the time, the site just serves new
markup against cached css until someone notices. Judgement calls stay warnings
(see check_docs) - this script must never be a thing to argue with.

Exit status is 0 when nothing FAILED. Warnings do not fail the run; they are
things to look at, not things to fix before pushing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
INDEX = DOCS / "index.html"
MANIFEST = DOCS / "data" / "versions.json"

# vendored: not ours to lint, and they carry no // @ts-check
VENDORED = {"bufo.js", "js-blp.js"}

# <link href="css/app.css?v=X"> / <script src="js/app.js?v=X">
ASSET_RE = re.compile(r'(?:href|src)="((?:css|js)/[^"?]+)\?v=([0-9a-z]+)"')

# a css/js change needs a bump; an html-only or data-only change does not
BUMP_PATHS = ("docs/css", "docs/js")

# warn-only: a change on the left usually means the doc on the right is stale.
# The triggers are CLAUDE.md's own, restated where they can fire on their own.
DOC_TRIGGERS = (
    (("build/build_data.py",), "DATA_ROUTES.md"),
    (("docs/js/pills.js", "docs/js/pilltypes.js"), "PILLS.md"),
    (("docs/js/config.js",), "README.md"),
)

RED, GREEN, YELLOW, DIM, RESET = "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[0m"


class Report:
    """Accumulates check results and decides the exit status."""

    def __init__(self, quiet: bool = False) -> None:
        self.quiet = quiet
        self.failed = 0
        self.warned = 0

    def _say(self, colour: str, tag: str, name: str, detail: str) -> None:
        pad = " " * max(0, 26 - len(name))
        print(f"{colour}{tag:>4}{RESET}  {name}{pad}{DIM}{detail}{RESET}" if detail
              else f"{colour}{tag:>4}{RESET}  {name}")

    def ok(self, name: str, detail: str = "") -> None:
        if not self.quiet:
            self._say(GREEN, "ok", name, detail)

    def fail(self, name: str, detail: str) -> None:
        self.failed += 1
        self._say(RED, "FAIL", name, detail)

    def warn(self, name: str, detail: str) -> None:
        self.warned += 1
        self._say(YELLOW, "warn", name, detail)

    def skip(self, name: str, detail: str) -> None:
        if not self.quiet:
            self._say(DIM, "skip", name, detail)


def git(*args: str) -> str:
    """Run git in the repo and return stdout; '' on any failure.

    The encoding is spelled out because the console default on Windows is
    cp1252, which cannot decode a UTF-8 tree - and subprocess swallows the
    resulting error in its reader thread and hands back None.
    """
    try:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                             encoding="utf-8", errors="replace", check=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""
    return out.stdout or ""


def have_ref(ref: str) -> bool:
    return bool(git("rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").strip())


def asset_versions(html: str) -> list[tuple[str, str]]:
    return ASSET_RE.findall(html)


# --------------------------------------------------------------- repo guards


def check_assets(rep: Report) -> str | None:
    """One ?v= string, every module referenced, every reference resolving.

    Returns the current version string, or None if index.html has no assets.
    """
    html = INDEX.read_text(encoding="utf-8")
    found = asset_versions(html)
    if not found:
        rep.fail("asset ?v=", "index.html references no versioned css/js at all")
        return None

    versions = {v for _, v in found}
    if len(versions) > 1:
        listing = ", ".join(sorted(versions))
        rep.fail("asset ?v=", f"{len(versions)} different strings in index.html: {listing}")
        return None
    version = versions.pop()
    rep.ok("asset ?v=", f"{version} on all {len(found)} references")

    referenced = {p for p, _ in found}
    missing = sorted(p for p in referenced if not (DOCS / p).exists())
    if missing:
        rep.fail("asset files", f"referenced but absent: {', '.join(missing)}")
    else:
        rep.ok("asset files", f"all {len(referenced)} resolve")

    # the other direction: a module added to docs/js that index.html never loads
    on_disk = {f"js/{p.name}" for p in (DOCS / "js").glob("*.js")}
    on_disk |= {f"css/{p.name}" for p in (DOCS / "css").glob("*.css")}
    orphans = sorted(on_disk - referenced)
    if orphans:
        rep.fail("asset wiring", f"present but never loaded: {', '.join(orphans)}")
    else:
        rep.ok("asset wiring", "no unreferenced modules")
    return version


def check_bump(rep: Report, base: str, version: str | None) -> None:
    """A css/js change against the deployed tree must move the ?v= string."""
    if version is None:
        return
    if not have_ref(base):
        rep.skip("?v= bump", f"{base} not available here")
        return

    changed = [f for f in git("diff", "--name-only", base, "--", *BUMP_PATHS).splitlines() if f]
    deployed_html = git("show", f"{base}:docs/index.html")
    deployed = {v for _, v in asset_versions(deployed_html)}

    if not changed:
        rep.ok("?v= bump", f"no css/js change against {base}")
        return
    if not deployed:
        rep.skip("?v= bump", f"cannot read the ?v= at {base}")
        return
    if version in deployed:
        head = ", ".join(sorted(changed)[:3])
        more = f" (+{len(changed) - 3} more)" if len(changed) > 3 else ""
        rep.fail("?v= bump",
                 f"{len(changed)} css/js file(s) changed but ?v= is still "
                 f"{version} - run tools/bump.py  [{head}{more}]")
    else:
        rep.ok("?v= bump", f"{sorted(deployed)[0]} -> {version}, {len(changed)} file(s)")


def check_line_endings(rep: Report) -> None:
    """The committed blobs are LF. A scripted rewrite is what flips them."""
    if not have_ref("HEAD"):
        rep.skip("line endings", "no commits yet")
        return
    # every tracked text file, so a new directory is covered without being listed
    names = [f for f in git("ls-files").splitlines()
             if f.endswith((".js", ".css", ".html", ".py", ".md", ".json", ".ts", ".svg", ".yml"))]
    bad = []
    for name in names:
        blob = subprocess.run(["git", "-C", str(ROOT), "show", f"HEAD:{name}"],
                              capture_output=True, check=False).stdout
        if b"\r\n" in blob:
            bad.append(name)
    if bad:
        rep.fail("line endings", f"CRLF in committed blobs: {', '.join(bad[:4])}")
    else:
        rep.ok("line endings", f"{len(names)} tracked text files are LF")


def check_manifest(rep: Report) -> None:
    """versions.json agrees with the packs on disk, hash included."""
    if not MANIFEST.exists():
        rep.fail("data manifest", "docs/data/versions.json is missing")
        return
    try:
        entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        rep.fail("data manifest", f"unparseable: {exc}")
        return

    problems: list[str] = []
    listed: set[str] = set()
    for entry in entries:
        for key in ("id", "label", "file", "built", "hash"):
            if key not in entry:
                problems.append(f"{entry.get('id', '?')}: no {key}")
        path = DOCS / entry.get("file", "")
        listed.add(entry.get("id", ""))
        if not path.exists():
            problems.append(f"{entry.get('id')}: {entry.get('file')} missing")
            continue
        actual = hashlib.sha256(path.read_bytes()).hexdigest()[:10]
        if actual != entry.get("hash"):
            problems.append(f"{entry.get('id')}: hash {entry.get('hash')} but pack is {actual}")

    on_disk = {p.name for p in (DOCS / "data").iterdir()
               if p.is_dir() and (p / "spelldata.json.gz").exists()}
    for orphan in sorted(on_disk - listed):
        problems.append(f"{orphan}: pack on disk, no manifest entry")

    defaults = [e.get("id") for e in entries if e.get("default")]
    if len(defaults) != 1:
        problems.append(f"{len(defaults)} entries flagged default (want exactly 1)")

    if problems:
        rep.fail("data manifest", "; ".join(problems[:3]))
    else:
        rep.ok("data manifest", f"{len(entries)} packs, hashes match, default={defaults[0]}")


def check_docs(rep: Report, base: str) -> None:
    """Warn-only: the sibling docs have triggers and they are easy to neglect."""
    if not have_ref(base):
        return
    changed = set(f for f in git("diff", "--name-only", base).splitlines() if f)
    if not changed:
        return
    for sources, doc in DOC_TRIGGERS:
        hits = sorted(s for s in sources if s in changed)
        if hits and doc not in changed:
            rep.warn(f"{doc} freshness", f"{', '.join(hits)} changed, {doc} did not")


# ----------------------------------------------------------------- toolchain


def run_tool(rep: Report, name: str, cmd: list[str], detail: str = "") -> None:
    exe = shutil.which(cmd[0])
    if exe is None:
        rep.skip(name, f"{cmd[0]} not on PATH")
        return
    proc = subprocess.run([exe, *cmd[1:]], cwd=ROOT, capture_output=True,
                          encoding="utf-8", errors="replace", check=False)
    if proc.returncode == 0:
        rep.ok(name, detail)
        return
    output = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
    rep.fail(name, output[0] if output else f"exit {proc.returncode}")
    for line in output[1:12]:
        print(f"        {DIM}{line}{RESET}")
    if len(output) > 12:
        print(f"        {DIM}... {len(output) - 12} more lines{RESET}")


def check_toolchain(rep: Report) -> None:
    ours = sorted(p for p in (DOCS / "js").glob("*.js") if p.name not in VENDORED)
    run_tool(rep, "node --check", ["node", "--check", *[str(p) for p in ours]],
             f"{len(ours)} hand-written modules")
    run_tool(rep, "tsc", ["npx", "-p", "typescript", "tsc", "-p", "docs/jsconfig.json"],
             "docs/jsconfig.json")
    run_tool(rep, "mypy", ["python", "-m", "mypy", "build/build_data.py", "tools"])
    run_tool(rep, "pyflakes", ["python", "-m", "pyflakes", "build/build_data.py", "tools"])


# ---------------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="origin/main",
                    help="the deployed tree to compare against (default: origin/main)")
    ap.add_argument("--fast", action="store_true",
                    help="repo guards only - skip tsc/node/mypy/pyflakes")
    ap.add_argument("--quiet", action="store_true", help="print only failures and warnings")
    args = ap.parse_args()

    rep = Report(quiet=args.quiet)
    version = check_assets(rep)
    check_bump(rep, args.base, version)
    check_line_endings(rep)
    check_manifest(rep)
    if not args.fast:
        check_toolchain(rep)
    check_docs(rep, args.base)

    print()
    if rep.failed:
        print(f"{RED}{rep.failed} check(s) failed{RESET}"
              + (f", {rep.warned} warning(s)" if rep.warned else ""))
        return 1
    print(f"{GREEN}all checks passed{RESET}"
          + (f", {YELLOW}{rep.warned} warning(s){RESET}" if rep.warned else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
