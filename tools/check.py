#!/usr/bin/env python3
"""Epsilook's one-command gate: run every check before a push.

    uv run python tools/check.py                 # everything, base = origin/main
    uv run python tools/check.py --fast          # skip the toolchain checks (no npx/mypy)
    uv run python tools/check.py --base HEAD~1   # compare against a different deploy
    uv run python tools/check.py --quiet         # only failures and warnings

The `uv run` is load-bearing, unlike the other tools/ scripts: the declaration
guards below import the build's acquisition layer, which pulls in sqlglot, and
that is pinned in pyproject.toml rather than installed on a bare interpreter.

Two families of check live here.

  TOOLCHAIN - tsc, node --check, mypy, pyflakes. Nothing repo-specific; they
  just used to be four commands to remember.

  REPO GUARDS - the invariants CLAUDE.md states in prose and a human has to
  remember: the ?v= string is one string in both places (1 css + 1 js), it is
  bumped whenever the css or the bundle's SOURCES changed against what is
  deployed, the committed blobs are LF, and versions.json agrees with the
  packs on disk down to the content hash - or with their LFS pointers, which
  carry that same hash as their oid. The old "every module in site/js is
  loaded by index.html" guard lives in tools/build.mjs now: site/js is the
  BUILD OUTPUT, and the build fails on a source file its import graph never
  reaches.

A guard belongs here when it is mechanical and its failure is invisible. The
?v= bump is the archetype: nothing breaks at the time, the site just serves new
markup against cached css until someone notices. Judgement calls stay warnings
(see check_docs) - this script must never be a thing to argue with.

Exit status is 0 when nothing FAILED. Warnings do not fail the run; they are
things to look at, not things to fix before pushing.
"""

from __future__ import annotations

import argparse
import ast
import gzip
import hashlib
import io
import zlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tempfile
import tokenize
from collections.abc import Iterable, Iterator
from pathlib import Path

import mermaid
import packfile
import packs
from repo import (BUMP_PATHS, CACHE, DIM, GREEN, LISTFILE_ASSET, RED, RESET, ROOT, YELLOW,
                  changed_under, deploy_branches, git, have_ref, survive_console_encoding)

# A failure detail quotes whatever the failing tool printed, and node --test
# opens every line with U+25B6.
survive_console_encoding()

SITE = ROOT / "site"
MANIFEST = SITE / "data" / "versions.json"

# <link href="css/app.css?v=X"> / <script src="js/app.js?v=X">, in EVERY page
# under site/. 404.html loads the same stylesheet by a root-absolute href
# (/Epsilook/css/...) on purpose, so the leading path is matched loosely and
# only the css/js tail is captured - that tail is what resolves against site/.
ASSET_RE = re.compile(r'(?:href|src)="[^"]*?((?:css|js)/[^"?/]+)\?v=([0-9a-z]+)"')

# An LFS pointer is a ~130-byte text stub whose oid IS the sha256 of the real
# file - the same number versions.json stores. So the manifest can be checked
# without pulling a single LFS object, and this script keeps working on a
# checkout that never smudged them. See CLAUDE.md, "The packs left git history".
LFS_POINTER_MAGIC = b"version https://git-lfs.github.com/spec/v1"
LFS_OID_RE = re.compile(rb"oid sha256:([0-9a-f]{64})")

# warn-only: a change on the left usually means the doc on the right is stale.
#
# Only TRACKED docs can appear here. The design documents are kept outside the
# repository, so git never reports them as changed and a trigger naming one
# would warn on every run until it was ignored.
DOC_TRIGGERS = (
    (("build/pack",), "docs/DATA_ROUTES.md"),
    (("src/config.ts",), "README.md"),
    # The supplement is the one source no build can fetch, so its procedure is
    # the only record of how the vendored file was produced. A route added or
    # a rule changed without the procedure following it is how that record goes
    # stale, and nothing else would notice.
    (("tools/supplement.py", "tools/epsilon_names.py", "tools/epsilon_walks.py",
      "tools/epsilon_storage.py"), "docs/SUPPLEMENT.md"),
)

# A PACK FORMAT BUMP MEANS THE PACK'S SHAPE CHANGED, and these consume that
# shape. Warn-only because a given bump need not touch all of them (a pure
# target-mask addition does not change what dossier prints) — but every one is
# a surface that goes quietly INCOMPLETE rather than breaking, which is exactly
# the failure a human does not notice. 2026-08-05: `spellAttrs` shipped and
# dossier.py and export.ts were both forgotten until the user asked.
FORMAT_CONSUMERS = (
    "src/packrows.ts",
    "tools/dataset.ts",
    "tools/dossier.py",
    "docs/DATA_ROUTES.md",
)
"""What has to move when the artifact's shape does.

The shipped 1.0 engine is deliberately absent. It is being replaced rather than
carried, so a pack shape it cannot read is not a defect and warning that it did
not follow the format would be asking for exactly the bridging that is not
wanted.
"""

# Where PACK_FORMAT is declared. Named because the guard above reads the diff
# of this file and nothing else: point it at a file the number has moved out
# of and it stops firing, silently, which is the one failure a warn-only check
# cannot survive. check_format_declaration is what keeps this path honest.
PACK_FORMAT_HOME = "build/pack/emit/meta.py"

# THE DATA/QUERY LAYER. These modules answer a query and know nothing about how
# it is shown, which is what makes the two halves mutually replaceable: `data +
# query + search + pilltypes` is a complete headless search engine, and the GUI
# is one consumer of it rather than the thing it is welded to.
#
# The boundary held by accident until 2026-08-08 and was breached in two places
# at once (pills.ts built DOM elements; the tokenizer sat behind app/state.ts's
# top-level `document.getElementById`, so importing it threw). Both are fixed —
# and this guard is what keeps them fixed, because the breach is INVISIBLE while
# a browser is the only caller. Nothing fails; the layer just quietly stops
# being liftable.
DATA_MODULES = (
    "src/data.ts",
    "src/query.ts",
    "src/search.ts",
    "src/pills.ts",
    "src/pilltypes.ts",
    "src/config.ts",
    "src/util.ts",
)

# THE SECOND SEAM - search 2.0's layering rule.
#
# The DOM seam above keeps the engine liftable out of a browser. This one keeps
# the schema and vocabulary free of the evaluator: value-types declares which
# operators a type accepts, and value-matching implements them. If the schema
# starts importing the matcher, the accepted-operator table can no longer be
# read, validated or rendered into help without running the matcher, and the
# two stop being separable.
SEARCH_CORE = "src/search/"

# The seam is a DIRECTORY boundary rather than a list of module names, so a new
# module lands on the correct side by where it is put. The list this replaced
# had to be edited by hand for every new file, and its hole was silent: an
# evaluating module nobody remembered to list counted as declarative, and the
# declarations could then import it with this check saying nothing.
#
# Below the seam: the evaluator, and the rewriter — whose implication oracle is
# grounded in running the registered matchers, never in a second copy of any
# matching rule.
SEARCH_EVALUATING = ("evaluate", "rewrite")

# Above it: everything that only declares. `index.ts` sits at the root and is
# the one module the seam does not apply to, because re-exporting both halves is
# its whole job.
SEARCH_DECLARING = ("text", "vocabulary", "schema", "language")

# index.ts is the public surface and re-exports both halves on purpose, so it
# is the one module in the directory the seam does not apply to.
SEARCH_SURFACE = "index"

# Names belonging to the evaluator and to the row model it will grow. Naming one
# in the schema puts a single evaluator's data model into a contract every other
# one would then have to satisfy.
MATCHER_NAMES = ("Row", "candidates")

# The presentation layer: the one tree that may import React, and the one where
# .tsx is a legal extension. Everything else in src/ stays framework-free — the
# engine must keep running headless in Node (the CLIs, the tests, check.py).
UI_TREE = "src/ui/"

# The framework's packages, matched as the specifier root: "react",
# "react-dom", and any subpath of either ("react-dom/client",
# "react/jsx-runtime" — the automatic runtime esbuild injects).
REACT_PACKAGES = ("react", "react-dom")

# Engine trees that must never depend on the presentation layer. The app shell
# (src/main.ts) legitimately imports the ui door at takeover; the engine never
# does in any future.
ENGINE_TREES = ("src/search/", "src/i18n/")

# Browser globals and DOM types. Matched as whole words on code with comments
# and strings stripped — several of these words (`document`, `Element`) are
# ordinary English and appear in the prose above them constantly.
DOM_NAMES = (
    "document", "window", "navigator", "localStorage", "sessionStorage",
    "HTMLElement", "HTMLImageElement", "HTMLAnchorElement", "HTMLButtonElement",
    "HTMLInputElement", "Element", "Node", "NodeList", "ParentNode", "Event",
    "customElements", "requestAnimationFrame", "getComputedStyle",
)

# THE THIRD SEAM - the data build's layering rule.
#
# The pack build reads game tables, interprets them and writes an artifact. Each
# of those is a layer, and the value of the split is that a layer can be
# replaced without the others noticing: a different table source, a different
# artifact shape. That only holds while imports flow one way, so the order here
# IS the rule - a layer may import the layers below it and nothing above.
#
# `__main__` is the top of it: the entry point owns argv and where the artifact
# lands, and nothing in the package may import it. Naming it here is what makes
# that true - left out, it reads as package-root vocabulary, and the rule for
# that vocabulary is that it may import no layer at all.
BUILD_PACKAGE = "build/pack"
PYTHON_TESTS = "test/py"

# The addon is a sub-project with its own test tree, written to depend on
# nothing outside addon/ but the interpreter, so that the directory can move to
# a repository of its own whole. It carries its own conftest.py and support.py,
# the same names test/py carries, so every tool runs over it as a second
# invocation rather than in one sweep with the repository's sources.
ADDON_TESTS = "addon/test"
BUILD_LAYERS = ("sources", "tables", "routes", "derive", "model", "encode",
                "emit", "pipeline", "__main__")

# The layer that wires the rest together, and the one exemption to the reading
# rule below. Every other layer is written not to know what is around it - a
# route is handed a provider and never asks where it came from - so something
# has to hold both ends, and the layer that does is the only place a source and
# a route are named in the same breath. It constructs providers; it does not
# read rows through them, which is what the rule is protecting.
BUILD_WIRING_LAYER = "pipeline"

# The layers that must not touch the filesystem or the network. Acquisition owns
# the input side and emission owns the output side; everything between them is
# handed its bytes and hands its results on, which is what makes the source
# swappable and the artifact reshapeable without editing a route.
BUILD_PLACELESS = ("routes", "derive", "model", "encode")

# The layers holding a game table, and the one layer allowed to read them.
# Importing downward is legal by the rule above, so without this a derivation
# could quietly go back to the source instead of working from what a route
# produced - and the split stops meaning anything the moment two layers both
# read tables. Keeping the reach short is also what makes everything above
# routes/ testable from plain values, with no source to stand up at all.
BUILD_SOURCE_LAYERS = ("sources", "tables")
BUILD_READING_LAYER = "routes"

# Names that mean "I am reaching for a file or a URL". Matched as parsed
# identifiers rather than as text, so a word in a comment or a docstring is not
# a violation - several of these are ordinary English.
PLACE_NAMES = ("Path", "open", "urlopen", "urllib", "requests", "listdir", "glob")

# Every Python path the checkers read, named once so mypy, pyflakes and pylint
# cannot drift on what they cover. The versions they run at are pinned by
# uv.lock rather than by whatever the machine happens to have installed, which
# is why all three go through `uv run`.
PYTHON_SOURCES = (BUILD_PACKAGE,
                  PYTHON_TESTS, "tools")

# How long a pack-freshness answer stays good. Blizzard patches weekly at
# most, so a day is generous and keeps a normal working day to one request.
FRESHNESS_CACHE_HOURS = 24


LOG = CACHE / "check.log"
"""Where the last run's whole report is written, colourless.

A run is usually read through a pipe, and a pipe truncates: `| tail` keeps the
summary and throws away the FAIL lines that say what to do about it, and the
pipe's own exit status hides the failure too. The log is written whatever the
console did with the output, so the answer to "what actually failed" is always
one file away rather than one re-run away.
"""


class Report:
    """Accumulates check results and decides the exit status."""

    def __init__(self, quiet: bool = False) -> None:
        self.quiet = quiet
        self.failed = 0
        self.warned = 0
        self.lines: list[str] = []

    def _say(self, colour: str, tag: str, name: str, detail: str) -> None:
        pad = " " * max(0, 26 - len(name))
        self.lines.append(f"{tag:>4}  {name}{pad}{detail}".rstrip())
        print(f"{colour}{tag:>4}{RESET}  {name}{pad}{DIM}{detail}{RESET}" if detail
              else f"{colour}{tag:>4}{RESET}  {name}")

    def detail(self, lines: Iterable[str]) -> None:
        """Keep a failing tool's whole output in the log without printing it.

        The console shows a preview and elides the rest, which is right for
        reading but wrong for diagnosing: the line that names the broken test
        is routinely past the preview. The log takes the lot.
        """
        self.lines.extend(f"        {line}" for line in lines)

    def written(self, summary: str) -> Path | None:
        """Write the run to the log and hand back where, or nothing if it could not be."""
        self.lines.append("")
        self.lines.append(summary)
        try:
            LOG.parent.mkdir(parents=True, exist_ok=True)
            LOG.write_text("\n".join(self.lines) + "\n", encoding="utf-8")
        except OSError:
            # A log nobody can write is not a reason to fail a run that passed.
            return None
        return LOG

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


def asset_versions(html: str) -> list[tuple[str, str]]:
    return ASSET_RE.findall(html)


def site_pages() -> list[Path]:
    return sorted(SITE.glob("*.html"))


# --------------------------------------------------------------- repo guards


def check_assets(rep: Report, built: bool) -> str | None:
    """One ?v= string, every reference resolving.

    Returns the current version string, or None if site/ has no assets.
    `built` says whether the bundle was (re)built this run: site/js is
    generated and gitignored, so on a fresh checkout its absence means "not
    built yet", not "broken" - only a run that built may insist it exists.

    Every page under site/ counts, not just index.html: they share one
    stylesheet, so a page left behind by a bump serves it from a stale URL.
    """
    pages = site_pages()
    found = [ref for p in pages for ref in asset_versions(p.read_text(encoding="utf-8"))]
    if not found:
        rep.fail("asset ?v=", "site/*.html reference no versioned css/js at all")
        return None

    versions = {v for _, v in found}
    if len(versions) > 1:
        listing = ", ".join(sorted(versions))
        names = ", ".join(p.name for p in pages)
        rep.fail("asset ?v=", f"{len(versions)} different strings across {names}: {listing}")
        return None
    version = versions.pop()
    rep.ok("asset ?v=", f"{version} on all {len(found)} references")

    referenced = {p for p, _ in found}
    generated = {p for p in referenced if p.startswith("js/")}
    required = referenced if built else referenced - generated
    missing = sorted(p for p in required if not (SITE / p).exists())
    if missing:
        rep.fail("asset files", f"referenced but absent: {', '.join(missing)}")
    elif built:
        rep.ok("asset files", f"all {len(referenced)} resolve")
    else:
        rep.ok("asset files",
               f"{len(required)} committed assets resolve"
               f" ({len(generated)} built ones unchecked - no build this run)")

    # the other direction, for the committed css only: site/js is generated
    # wholesale, and an unreachable SOURCE file fails in tools/build.mjs
    on_disk = {f"css/{p.name}" for p in (SITE / "css").glob("*.css")}
    orphans = sorted(on_disk - referenced)
    if orphans:
        rep.fail("asset wiring", f"present but never loaded: {', '.join(orphans)}")
    else:
        rep.ok("asset wiring", "no unreferenced stylesheets")
    return version


def deploying_ref() -> str | None:
    """The branch this run's changes are headed for, or None when nothing says.

    A pull request names its target in GITHUB_BASE_REF, and it is asked first:
    on a push that variable is empty, so the order costs nothing and a PR into
    the deploying branch is judged against the branch it will land on rather
    than against its own name. A CI push names itself in GITHUB_REF_NAME, and
    off CI the answer is whatever is checked out. A detached HEAD reports
    "HEAD", which names no branch and so decides nothing.
    """
    for variable in ("GITHUB_BASE_REF", "GITHUB_REF_NAME"):
        ref = os.environ.get(variable, "").strip()
        if ref:
            return ref
    branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
    return branch if branch and branch != "HEAD" else None


def check_bump(rep: Report, base: str, version: str | None) -> None:
    """A css/js change against the deployed tree must move the ?v= string.

    Only where the change actually deploys. This is the one check that gates a
    deploy rather than describing the tree, so on a branch that publishes
    nothing it measures against a deployment that will never happen: a long
    feature branch would fail every push touching src/, and the mail it sent
    would say a stylesheet is stale on a site that has not seen the commit.
    The bump such a branch owes is one bump for the whole branch, and it comes
    due against origin/main at the merge, where this check is what collects it.
    """
    if version is None:
        return

    deploys = deploy_branches()
    ref = deploying_ref()
    if deploys and ref and ref not in deploys:
        rep.skip("?v= bump", f"{ref} does not deploy - {', '.join(deploys)} does")
        return

    if not have_ref(base):
        rep.skip("?v= bump", f"{base} not available here")
        return

    changed = changed_under(base, BUMP_PATHS)
    deployed = {v
                for p in site_pages()
                for _, v in asset_versions(git("show", f"{base}:site/{p.name}"))}

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
        rep.ok("?v= bump", f"{max(deployed)} -> {version}, {len(changed)} file(s)")


# Every tracked text extension, so a new directory is covered without being listed.
TEXT_EXTS = (".js", ".css", ".html", ".py", ".md", ".json", ".ts", ".tsx", ".svg",
             ".yml", ".sh", ".conf", ".mjs")


def text_files() -> list[str]:
    """The tracked files whose line endings are meant to be LF."""
    return [f for f in git("ls-files").splitlines()
            if f.endswith(TEXT_EXTS) or Path(f).name == "Dockerfile" or f.endswith(".dockerignore")]


def check_line_endings(rep: Report) -> None:
    """The committed blobs are LF. A scripted rewrite is what flips them.

    .sh/.conf/Dockerfile matter more than the rest: they are read by a Linux
    container, where a CRLF line fails as `command not found: ...^M`. Their
    working copies are pinned by .gitattributes; this is the backstop.
    """
    if not have_ref("HEAD"):
        rep.skip("line endings", "no commits yet")
        return
    names = text_files()
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


def check_binary_text(rep: Report) -> None:
    """A NUL byte in a text file turns the line-ending normalisation off.

    core.autocrlf is true here, so a working copy is CRLF and git converts it
    back on the way in -- for files it reads as TEXT. A NUL byte makes it read
    the file as binary instead, the conversion stops, and the next tool that
    rewrites the file stages every line as changed. The blob check above sees
    that one commit too late; a NUL byte also defeats grep, which reports the
    file as binary rather than searching it.
    """
    bad = [name for name in text_files()
           if (ROOT / name).is_file() and b"\x00" in (ROOT / name).read_bytes()]
    if bad:
        rep.fail("binary text", "NUL byte in a text file, so its line endings stop being normalised: "
                                f"{', '.join(bad[:4])}")
    else:
        rep.ok("binary text", "no tracked text file reads as binary")


def pack_hash(path: Path) -> tuple[str, bool]:
    """The pack's content hash, read from the file or from its LFS pointer.

    Returns (first 10 hex of its sha256, whether it came from a pointer). An
    unsmudged pack is not an error here: the oid is a content address, so it
    answers the manifest's question exactly, and hashing the stub instead
    would fail with a mismatch that reads like a corrupt pack.
    """
    raw = path.read_bytes()
    if raw.startswith(LFS_POINTER_MAGIC):
        found = LFS_OID_RE.search(raw)
        if found:
            return found.group(1).decode()[:10], True
    return hashlib.sha256(raw).hexdigest()[:10], False


def module_files(entries: list[dict[str, object]]) -> set[str]:
    """Every module file the roster's packs name, as site-relative paths.

    Read out of the per-pack manifests rather than off the directory, because
    the manifests are what a browser follows: a module nothing names is not
    part of any pack however present it looks.
    """
    named: set[str] = set()
    for entry in entries:
        manifest_path = SITE / str(entry.get("file", ""))
        if not manifest_path.exists():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        named.update(packfile.files(manifest))
    return named


def unreferenced_modules(entries: list[dict[str, object]]) -> list[str]:
    """Module files on disk that no pack's manifest names.

    A module is content-addressed, so a rebuild that changes one writes a new
    file and leaves the old one behind. Nothing breaks -- the manifests point
    at the new one -- but the repository keeps paying for it, and these are LFS
    objects. Reported rather than swept here, since a checker deleting data is
    the wrong shape; `rebuild.py` sweeps them.
    """
    directory = SITE / "data" / "modules"
    if not directory.is_dir():
        return []
    named = module_files(entries)
    stale = sorted(path.name for path in directory.iterdir()
                   if path.is_file()
                   and f"data/modules/{path.name}" not in named)
    if not stale:
        return []
    return [f"{len(stale)} module(s) no manifest names, e.g. {stale[0]} "
            f"- run tools/rebuild.py --prune-modules"]


def check_manifest(rep: Report) -> None:
    """versions.json agrees with the packs on disk, hash included."""
    if not MANIFEST.exists():
        rep.fail("data manifest", "site/data/versions.json is missing")
        return
    try:
        entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        rep.fail("data manifest", f"unparseable: {exc}")
        return

    problems: list[str] = []
    listed: set[str] = set()
    pointers = 0
    for entry in entries:
        for key in ("id", "label", "file", "built", "hash"):
            if key not in entry:
                problems.append(f"{entry.get('id', '?')}: no {key}")
        path = SITE / entry.get("file", "")
        listed.add(entry.get("id", ""))
        if not path.exists():
            problems.append(f"{entry.get('id')}: {entry.get('file')} missing")
            continue
        actual, from_pointer = pack_hash(path)
        if from_pointer:
            pointers += 1
        if actual != entry.get("hash"):
            problems.append(f"{entry.get('id')}: hash {entry.get('hash')} but pack is {actual}")

    on_disk = {p.name for p in (SITE / "data").iterdir()
               if p.is_dir() and (p / "manifest.json").exists()}
    for orphan in sorted(on_disk - listed):
        problems.append(f"{orphan}: pack on disk, no manifest entry")

    problems += unreferenced_modules(entries)

    defaults = [e.get("id") for e in entries if e.get("default")]
    if len(defaults) != 1:
        problems.append(f"{len(defaults)} entries flagged default (want exactly 1)")

    if problems:
        rep.fail("data manifest", "; ".join(problems[:3]))
    else:
        via = f", {pointers} via LFS pointer" if pointers else ""
        rep.ok("data manifest",
               f"{len(entries)} packs, hashes match{via}, default={defaults[0]}")


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

    # A format bump is the precise signal that the pack's SHAPE moved.
    if PACK_FORMAT_HOME in changed and _format_moved(base):
        missed = [f for f in FORMAT_CONSUMERS if f not in changed]
        if missed:
            rep.warn("pack format consumers",
                     f"PACK_FORMAT moved but {', '.join(missed)} did not")


def _format_moved(base: str) -> bool:
    """Did this diff change PACK_FORMAT? Read off the diff, not the file."""
    diff = git("diff", "-U0", base, "--", PACK_FORMAT_HOME)
    return any(line.startswith(("+PACK_FORMAT", "-PACK_FORMAT"))
               for line in diff.splitlines())


def check_format_declaration(rep: Report) -> None:
    """PACK_FORMAT is where the format guard expects to find it.

    The consumer warning above watches one file's diff. Move the declaration
    and that warning does not break - it simply never fires again, so the next
    bump ships with data.ts and dossier.py none the wiser. This is the guard
    that turns a silent stop into a loud one.
    """
    home = ROOT / PACK_FORMAT_HOME
    if not home.exists():
        rep.fail("pack format home", f"{PACK_FORMAT_HOME} does not exist")
        return
    if not re.search(r"^PACK_FORMAT\s*=\s*\d+", home.read_text(encoding="utf-8"),
                     re.M):
        rep.fail("pack format home",
                 f"{PACK_FORMAT_HOME} declares no PACK_FORMAT; the format "
                 f"consumer warning is watching the wrong file")
        return
    rep.ok("pack format home", PACK_FORMAT_HOME)


def pack_sections() -> tuple[dict[str, object] | None, str]:
    """The default pack's sections, merged across its modules.

    Read once here because two checks want it and each reading the module set
    for itself is two accounts of what a pack is -- and joined by `packfile`,
    which is the one account every other tool reads a pack through.

    Returns:
        The sections keyed by name, or `None` with the reason a caller should
        skip on.
    """
    if not MANIFEST.exists():
        return None, "no versions.json"
    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    default = next((e for e in entries if e.get("default")),
                   entries[0] if entries else None)
    if not default:
        return None, "no default pack"
    pack_dir = SITE / Path(default["file"]).parent
    if not (pack_dir / "manifest.json").exists():
        return None, "default pack has no manifest"

    for file in packfile.files(packfile.manifest_of(pack_dir)):
        module_path = SITE / file
        if (not module_path.exists()
                or module_path.read_bytes()[:len(LFS_POINTER_MAGIC)] == LFS_POINTER_MAGIC):
            return None, f"{file} not smudged locally"

    try:
        sections = packfile.load(pack_dir)
    except ValueError as exc:
        # A pack older than the shape the reader expects. Reported as something
        # to skip rather than raised: this script's job is to say what is
        # wrong, and `check_manifest` is what fails on a pack out of step.
        return None, str(exc)
    sections.pop("meta", None)
    return sections, ""


def check_pack_sections(rep: Report) -> None:
    """Every section the pack SHIPS must be reached by some reader.

    Mechanical, and its failure is invisible in the worst way: a route can be
    built, gzipped and deployed to ten packs while the app never reads a byte
    of it. Nothing errors — the column is simply empty forever. The pack is the
    artifact, so this reads the built file rather than parsing the builder.
    """
    loaded, why = pack_sections()
    if loaded is None:
        rep.skip("pack sections", why)
        return
    sections = set(loaded)

    # The readers, which are no longer one file: the shipped engine reads the
    # vocabularies it always did, search 2.0 reads the row tables, and the
    # addon reads the pack through its own API, by section name.
    source = "".join(
        (ROOT / part).read_text(encoding="utf-8")
        for part in ("src/data.ts", "src/packrows.ts", "tools/dataset.ts",
                     "addon/Epsilook/API.lua"))

    # Two kinds of section are reached by DECLARATION rather than by name, so
    # no reader mentions them and searching the source for one would report a
    # section that is read on every query as dead. A row table is addressed by
    # its column, and a vocabulary is named by the row table pointing at it.
    vocabs = loaded.get("rowVocabs")
    declared = {str(where.get("in", ""))
                for where in (vocabs.values() if isinstance(vocabs, dict) else ())
                if isinstance(where, dict)}
    rows = {name for name, block in loaded.items()
            if isinstance(block, dict) and {"kinds", "sizes", "refs"} <= set(block)}

    unread = sorted(sections - rows - declared - {s for s in sections if s in source})
    if unread:
        rep.fail("pack sections", f"shipped but read by nothing: {', '.join(unread)}")
    else:
        rep.ok("pack sections",
               f"all {len(sections)} read: {len(rows)} row tables, "
               f"{len(declared)} vocabularies they name, the rest by name")


def _blank(text: str) -> str:
    """A span replaced by spaces, keeping newlines so line numbers survive."""
    return "".join(ch if ch == "\n" else " " for ch in text)


def strip_ts_comments(src: str) -> str:
    """TypeScript with comments blanked out, string literals INTACT.

    The import scan needs the module specifier, which is a string — so it reads
    this form. The DOM-name scan blanks strings too (see strip_ts_noise); doing
    both in one pass is what silently disarmed two thirds of this guard when it
    was first written.
    """
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] in "/*":
            if src[i + 1] == "*":
                end = src.find("*/", i + 2)
                end = n if end < 0 else end + 2
            else:
                end = src.find("\n", i)
                end = n if end < 0 else end
            out.append(_blank(src[i:end]))
            i = end
        elif c in "\"'`":
            j, quote = i + 1, c
            while j < n and src[j] != quote:
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1])
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def strip_ts_noise(src: str) -> str:
    """TypeScript with comments AND string/template literals blanked out.

    Every name the DOM scan hunts for is also an ordinary English word, and
    these modules are heavily commented — so scanning raw text would report
    "document" out of a sentence about documentation, and `Element` out of
    every doc comment that mentions one.
    """
    out, i, n = [], 0, len(src)
    src = strip_ts_comments(src)
    while i < n:
        c = src[i]
        if c in "\"'`":
            j, quote = i + 1, c
            while j < n and src[j] != quote:
                j += 2 if src[j] == "\\" else 1
            out.append(_blank(src[i:j + 1]))
            i = j + 1
        else:
            out.append(c)
            i += 1
    return "".join(out)


def declared_kinds() -> dict[str, set[str]]:
    """Every kind the catalogue declares, and the properties it gives each.

    Read out of the declaration text rather than by running it, because the
    catalogue is TypeScript that reaches the string registry and a bundle just
    to answer a question its source already spells out. A kind is a
    `defineKind({...})` call; its word is the `word:` field, or its column's key
    where it declares none, and its properties are the keys of `props`.
    """
    source = (ROOT / "src" / "search" / "schema" / "catalogue.ts").read_text(
        encoding="utf-8")
    kinds: dict[str, set[str]] = {}
    for call in re.finditer(r"defineKind\(\{(.*?)\n\}\);", source, re.DOTALL):
        body = call.group(1)
        word = re.search(r'\bword:\s*"([^"]+)"', body)
        column = re.search(r"\bcolumn:\s*(\w+)Column", body)
        if not column:
            continue
        name = word.group(1) if word else column.group(1)
        kinds[name] = top_level_keys(body, "props")
    return kinds


def top_level_keys(body: str, field: str) -> set[str]:
    """The keys of one object literal's OWN level, ignoring anything nested.

    Depth-tracked rather than matched by indentation, because a property is
    written both ways in the catalogue -- on its own line, and inline where the
    kind has one -- and an indentation rule would silently report the inline
    ones as having no properties at all. Nested objects are real: a property
    declares `sentinels`, whose keys are numbers and not properties.
    """
    start = body.find(f"{field}: {{")
    if start < 0:
        return set()
    at = body.index("{", start)
    keys: set[str] = set()
    depth, key_start = 0, at + 1
    for position in range(at, len(body)):
        char = body[position]
        if char in "{[(":
            depth += 1
            if depth == 1:
                key_start = position + 1
        elif char in "}])":
            depth -= 1
            if depth == 0:
                break
        elif char == "," and depth == 1:
            key_start = position + 1
        elif char == ":" and depth == 1:
            found = re.fullmatch(r"\s*(\w+)\s*", body[key_start:position])
            if found:
                keys.add(found.group(1))
    return keys


def check_row_schema(rep: Report) -> None:
    """Every kind and property the pack SHIPS must be declared in the catalogue.

    The pack carries rows now: a kind word, and per kind the properties its
    values are under. The catalogue is what says the properties MEAN -- which
    notation reads them, what a bare word matches. A property the pack ships and
    the catalogue does not declare is read by nothing and silently dropped,
    which is the same invisible failure `check_pack_sections` exists for, one
    level further in.

    The other direction is legitimate and not checked: the catalogue may declare
    a property no build can answer yet.
    """
    sections, why = pack_sections()
    if sections is None:
        rep.skip("row schema", why)
        return
    tables = {name: block for name, block in sections.items()
              if name.endswith("Rows") and isinstance(block, dict)}
    if not tables:
        rep.skip("row schema", "pack ships no row tables")
        return

    catalogue = declared_kinds()
    problems: list[str] = []
    shipped = 0
    for table, block in sorted(tables.items()):
        for kind in block.get("kinds", []):
            if kind not in catalogue:
                problems.append(f"{table} ships kind {kind!r}, which no kind declares")
                continue
            props = set(block.get("values", {}).get(kind, {}))
            shipped += 1
            stray = sorted(props - catalogue[kind])
            if stray:
                problems.append(
                    f"{kind} ships {', '.join(stray)}, which it does not declare")
    if problems:
        rep.fail("row schema", "; ".join(problems))
    else:
        rep.ok("row schema", f"{shipped} shipped kinds declared in the catalogue")


def check_row_vocabularies(rep: Report) -> None:
    """Every vocabulary the shipped rows resolve through must resolve.

    A row property stores a number and names a vocabulary; the vocabulary names
    a section and, inside it, the columns a reader pairs into a map. That chain
    is internal to the pack, so `check_row_schema`'s catalogue reconciliation
    never sees it -- and a broken link is silent in the worst way: the lookup
    misses, the property keeps the raw number a name was meant to replace, and
    every query on it answers nothing forever. The registry-side half of this
    guard is `test/py/sections_test.py`; this one reads the built artifact, so
    it also catches a pack out of step with the tree that would rebuild it.
    """
    sections, why = pack_sections()
    if sections is None:
        rep.skip("row vocabularies", why)
        return
    vocabs = sections.get("rowVocabs")
    if not isinstance(vocabs, dict):
        rep.skip("row vocabularies", "pack ships no rowVocabs")
        return

    problems: list[str] = []
    for table, block in sorted(sections.items()):
        if not table.endswith("Rows") or not isinstance(block, dict):
            continue
        for kind, named in sorted(block.get("vocab", {}).items()):
            for prop, vocab in sorted(named.items()):
                if vocab not in vocabs:
                    problems.append(f"{table}.{kind}.{prop} resolves through "
                                    f"{vocab!r}, which rowVocabs does not declare")

    for name, where in sorted(vocabs.items()):
        if not isinstance(where, dict):
            problems.append(f"rowVocabs.{name} is not a mapping")
            continue
        home = sections.get(str(where.get("in", "")))
        if home is None:
            problems.append(f"rowVocabs.{name} lives in {where.get('in')!r}, "
                            f"which the pack does not ship")
            continue
        for half in ("keys", "values"):
            if half in where and (not isinstance(home, dict)
                                  or where[half] not in home):
                problems.append(f"rowVocabs.{name} reads {where['in']}."
                                f"{where[half]}, which the shipped section "
                                f"does not carry")

    if problems:
        rep.fail("row vocabularies", "; ".join(problems))
    else:
        rep.ok("row vocabularies",
               f"{len(vocabs)} vocabularies resolve in the shipped pack")


MODULE_GZIP_FINGERPRINT = "18bfeb6a365aa843"
"""What this repository's packs were compressed by.

A module's FILE NAME is the hash of its compressed bytes, so which zlib the
interpreter links decides what every module is called. CPython's Windows
binaries ship zlib-ng and a typical Linux interpreter uses the system zlib, and
the two emit different bytes for identical input -- so a rebuild on the other
kind renames every module in all twelve packs while the data is unchanged.

Recorded as the compressed digest of a fixed payload rather than as a version
string, because what matters is the bytes that come out, not which library
claims to have produced them.
"""


def gzip_fingerprint() -> str:
    """This interpreter's compressed form of a fixed payload.

    Compressed exactly as `emit/module.py` compresses a module -- level nine
    with the timestamp zeroed -- so the fingerprint moves only when a module's
    bytes would.
    """
    payload = b"Epsilook module compression fingerprint" * 64
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", compresslevel=9, mtime=0) as out:
        out.write(payload)
    return hashlib.sha256(buffer.getvalue()).hexdigest()[:16]


def check_gzip_flavour(rep: Report) -> None:
    """Warn when this machine would rename every module it rebuilt.

    A warning and not a failure: nothing is wrong with the checkout, and a
    machine that compresses differently still builds a correct pack. What it
    cannot do is rebuild ONE pack -- the modules it writes get new names, the
    packs it did not rebuild go on naming the old ones, and the shared modules
    that made the roster cheap quietly stop being shared.
    """
    here = gzip_fingerprint()
    if here == MODULE_GZIP_FINGERPRINT:
        rep.ok("gzip flavour", f"module bytes match the shipped packs ({here})")
        return
    flavour = getattr(zlib, "ZLIBNG_VERSION", "")
    rep.warn(
        "gzip flavour",
        f"this interpreter compresses differently ({here} against "
        f"{MODULE_GZIP_FINGERPRINT}{', zlib-ng ' + flavour if flavour else ''}); "
        f"rebuilding one pack here renames its modules and unshares them, so "
        f"rebuild the whole roster or none of it")


def check_layers(rep: Report) -> None:
    """The data/query layer must not reach into the GUI.

    Two directions, both fatal to "mutually replaceable" and both silent:
    importing anything from src/app/ (or src/dom.ts) welds the engine to this
    app, and naming a DOM global welds it to a browser. Either one is invisible
    while a page is the only caller — the code runs fine, it just stops being
    liftable into a worker, a CLI or a test.
    """
    missing = [m for m in DATA_MODULES if not (ROOT / m).exists()]
    if missing:
        rep.fail("layer boundary", f"declared module absent: {', '.join(missing)}")
        return

    word = re.compile(r"\b(" + "|".join(DOM_NAMES) + r")\b")
    # the `from` clause is OPTIONAL, because a side-effect import has none:
    # `import "./app/boot";` pulls in the entire GUI and was invisible here
    # until 2026-08-09 — the one violation shape this guard had never been
    # tested against.
    imports = re.compile(
        r"""^\s*(?:import|export)\b\s*(?:[^;]*?from\s*)?["']([^"']+)["']""", re.M)
    problems: list[str] = []
    for mod in DATA_MODULES:
        src = (ROOT / mod).read_text(encoding="utf-8")
        for target in imports.findall(strip_ts_comments(src)):
            stem = target.rsplit("/", 1)[-1]
            if "app/" in target or stem == "dom":
                problems.append(f"{mod} imports GUI module {target}")
        for line_no, line in enumerate(strip_ts_noise(src).splitlines(), 1):
            hit = word.search(line)
            if hit:
                problems.append(f"{mod}:{line_no} names DOM global `{hit.group(1)}`")

    if problems:
        for p in problems[:6]:
            rep.fail("layer boundary", p)
        if len(problems) > 6:
            rep.fail("layer boundary", f"...and {len(problems) - 6} more")
    else:
        rep.ok("layer boundary", f"{len(DATA_MODULES)} data/query modules free of DOM + app imports")

    check_matcher_seam(rep, imports)
    check_react_seam(rep, imports)


def check_react_seam(rep: Report, imports: re.Pattern[str]) -> None:
    """React stays inside the presentation layer.

    The engine's portability rests on the framework never reaching it: a React
    import outside src/ui welds that module to the view layer's runtime, and an
    engine module importing from src/ui inverts the dependency the seams keep
    one-way. Both are silent — the bundle builds either way. A .tsx extension
    is the same claim made by filename, so it is held to the same boundary.
    """
    react_roots = tuple(p + "/" for p in REACT_PACKAGES)
    problems: list[str] = []
    scanned = 0
    for mod in sorted((ROOT / "src").rglob("*.ts*")):
        rel = mod.relative_to(ROOT).as_posix()
        if rel.startswith((UI_TREE, "src/vendor/")) or rel.endswith(".d.ts"):
            continue
        scanned += 1
        if rel.endswith(".tsx"):
            problems.append(f"{rel} is .tsx outside {UI_TREE}")
            continue
        src = mod.read_text(encoding="utf-8")
        for target in imports.findall(strip_ts_comments(src)):
            if target in REACT_PACKAGES or target.startswith(react_roots):
                problems.append(f"{rel} imports {target}")
            elif rel.startswith(ENGINE_TREES) and "/ui/" in f"/{target}/":
                problems.append(f"{rel} imports presentation module {target}")

    if problems:
        for p in problems[:6]:
            rep.fail("react seam", p)
        if len(problems) > 6:
            rep.fail("react seam", f"...and {len(problems) - 6} more")
    else:
        rep.ok("react seam", f"{scanned} modules outside {UI_TREE} free of React")


def check_matcher_seam(rep: Report, imports: re.Pattern[str]) -> None:
    """The declarative half of search must not depend on the matching half.

    Two directions, both silent. Importing an evaluation module means the
    accepted-operator table can no longer be read, validated or rendered into
    help without running the matcher. Naming `Row` or `candidates` puts one
    evaluator's data model into a contract the declarations should not know
    about.

    Skipped rather than failed while the tree is absent, so this check does not
    become the reason a checkout without it cannot commit.
    """
    root = ROOT / SEARCH_CORE
    core = sorted(p for layer in SEARCH_DECLARING for p in (root / layer).rglob("*.ts")) if root.is_dir() else []
    if not core:
        rep.skip("matcher seam", f"{SEARCH_CORE} not present yet")
        return

    stray = [p.relative_to(ROOT).as_posix() for p in root.glob("*.ts") if p.stem != SEARCH_SURFACE]
    if stray:
        rep.fail("matcher seam", f"module outside every layer, so no side of the seam claims it: {stray[0]}")
        return

    word = re.compile(r"\b(" + "|".join(MATCHER_NAMES) + r")\b")
    problems: list[str] = []
    for mod in core:
        name = mod.relative_to(ROOT).as_posix()
        src = mod.read_text(encoding="utf-8")
        for target in imports.findall(strip_ts_comments(src)):
            # A relative specifier names the layer it reaches into, so the side of the seam is in the path itself.
            if any(f"/{layer}/" in f"/{target}" for layer in SEARCH_EVALUATING):
                problems.append(f"{name} imports {target}")
        for line_no, line in enumerate(strip_ts_noise(src).splitlines(), 1):
            hit = word.search(line)
            if hit:
                problems.append(f"{name}:{line_no} names evaluator concept `{hit.group(1)}`")

    if problems:
        for p in problems[:6]:
            rep.fail("matcher seam", p)
        if len(problems) > 6:
            rep.fail("matcher seam", f"...and {len(problems) - 6} more")
    else:
        rep.ok("matcher seam",
               f"{len(core)} modules in {'/, '.join(SEARCH_DECLARING)}/ free of {'/, '.join(SEARCH_EVALUATING)}/")


def build_layer_of(module: str) -> str | None:
    """Which build layer a dotted module name belongs to, or None for the
    package-root vocabulary that every layer may read."""
    parts = module.split(".")
    return parts[1] if len(parts) > 1 and parts[1] in BUILD_LAYERS else None


def imported_modules(tree: ast.Module, package: str) -> list[str]:
    """Every module an AST imports, with relative specifiers resolved absolute.

    `package` is the importing module's PACKAGE, not the module itself - which
    is what a relative specifier counts dots from. One dot means that package,
    each further dot one level out.
    """
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            if not node.level:
                out.append(node.module or "")
                continue
            parts = package.split(".")
            base = parts[:len(parts) - node.level + 1]
            out.append(".".join([*base, node.module] if node.module else base))
    return out


def check_build_layers(rep: Report) -> None:
    """The data build's layers must only depend downward, and the middle of the
    pipeline must not name a file or a URL itself.

    Both directions are silent. A route importing an emitter welds the reading
    of a game table to one artifact shape, so the pack cannot be reshaped
    without editing routes; a route opening a file welds it to one source, so
    the provider seam stops being real the moment anything reads around it.
    Neither breaks a build - the code runs fine, it just quietly stops being
    the thing the split was for.

    The path half is a test on parsed identifiers, so it proves a module names
    no path DIRECTLY. It does not prove the layer never reaches a file: a
    module may still call something one layer down that opens one, which is how
    the checked-in enum declarations are read. Widening it to reject that would
    reject reading a declaration the build owns, which is not the same thing as
    reaching for a source.

    Tests are exempt from both rules and deliberately so: a test's job is often
    to assert that two layers agree, and it is not part of the graph the rules
    protect. `conftest.py` is exempt for the same reason - it is where a test
    builds the source a placeless layer is not allowed to name.

    Skipped rather than failed while the package is absent, so this check does
    not become the reason a checkout without it cannot commit.
    """
    root = ROOT / BUILD_PACKAGE
    modules = sorted(p for p in root.rglob("*.py")
                     if not p.name.endswith("_test.py")
                     and p.name != "conftest.py") if root.is_dir() else []
    if not modules:
        rep.skip("build layers", f"{BUILD_PACKAGE} not present yet")
        return

    problems: list[str] = []
    placeless = 0
    for path in modules:
        relative = path.relative_to(root.parent).with_suffix("")
        # A module's package is its directory; an __init__ IS its package, so a
        # relative import inside one resolves against itself.
        package = ".".join(relative.parts[:-1])
        dotted = package if relative.name == "__init__" else ".".join(relative.parts)
        layer = build_layer_of(dotted)
        placeless += layer in BUILD_PLACELESS
        name = path.relative_to(ROOT).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=name)

        for target in imported_modules(tree, package):
            reached = build_layer_of(target)
            if reached is None or reached == layer:
                continue
            if layer is None:
                problems.append(f"{name} is package-root vocabulary but imports {reached}/")
            elif BUILD_LAYERS.index(reached) > BUILD_LAYERS.index(layer):
                problems.append(f"{name} imports upward, into {reached}/")
            elif (reached in BUILD_SOURCE_LAYERS
                  and layer != BUILD_WIRING_LAYER
                  and BUILD_LAYERS.index(layer) > BUILD_LAYERS.index(BUILD_READING_LAYER)):
                problems.append(f"{name} reads a game table directly, from {reached}/; "
                                f"only {BUILD_READING_LAYER}/ may")

        if layer not in BUILD_PLACELESS:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id in PLACE_NAMES:
                problems.append(f"{name}:{node.lineno} reaches for a file: `{node.id}`")
            elif isinstance(node, ast.Constant) and isinstance(node.value, str) \
                    and node.value.startswith(("http://", "https://")):
                problems.append(f"{name}:{node.lineno} names a URL")

    if problems:
        for problem in problems[:6]:
            rep.fail("build layers", problem)
        if len(problems) > 6:
            rep.fail("build layers", f"...and {len(problems) - 6} more")
    else:
        rep.ok("build layers",
               f"{len(modules)} modules import downward only, and no further "
               f"than {BUILD_READING_LAYER}/ for a table; {placeless} in "
               f"{'/, '.join(BUILD_PLACELESS)}/ name no path or URL directly")


PROSE_RULES: list[tuple[str, re.Pattern[str], str]] = [
    ("decoration", re.compile(r"[←-⯿─-╿\U0001F000-\U0001FAFF]|[-=#]{5,}"),
     "emoji or a decorative rule; use plain prose"),
    ("shouting", re.compile(r"(?:\b[A-Z][A-Z'’-]+\b[ ,]+){3,}\b[A-Z][A-Z'’-]+\b"),
     "an all-caps sentence; use an ordinary one"),
    ("dated", re.compile(r"\b(?:19|20)\d\d-\d\d-\d\d\b"),
     "a date; describe the code as it is now"),
    ("attributed", re.compile(r"\b(?:the )?users?'?s?\s+(?:call|own|rule|verdict|"
                              r"spec|priority|question)\b|\(user[,)]|\bwe agreed\b",
                              re.IGNORECASE),
     "a decision attributed to a person; state the rule instead"),
    ("cross-referenced", re.compile(r"\bPHASE\s*\d|\bsection\s*\d+[a-z]?\b|§",
                                    re.IGNORECASE),
     "a plan section or phase number; name the concept instead"),
]
"""What a comment may not contain, with the wording to use instead.

Each is a rule `docs/CODE_STYLE.md` states in prose that a reader has to
remember. They are mechanical and their failure is invisible, which is what
makes them guards rather than review notes: nothing breaks when a comment
shouts or cites a planning document, the documentation just stops being for the
developer reading the code and starts being a record of how it was written.
"""


def prose_of(source: str, name: str) -> Iterator[tuple[int, str]]:
    """Yield the `(line, text)` of every comment block and docstring in a module.

    Tokenised rather than matched line by line, so a rule cannot fire on code
    that merely looks like prose - a regex literal, a URL, a table of
    constants.

    A run of `#` lines is joined into one block before it is yielded. Python
    tokenises each of them separately, so a rule applied per token reads every
    wrapped sentence as several short ones and misses anything spanning a line
    break, which is most of what a wrapped comment says.

    Args:
        source: the module's text.
        name: its path, for the error a syntax failure raises.

    Yields:
        One pair per comment block or string literal, in source order. The line
        is where the block starts.

    Raises:
        ValueError: if the module does not tokenise.
    """
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError) as broken:
        raise ValueError(f"{name}: {broken}") from broken

    start = 0
    block: list[str] = []
    for token in tokens:
        if token.type is tokenize.COMMENT:
            # A blank line or any code between two `#` lines ends the block.
            if block and token.start[0] != start + len(block):
                yield start, " ".join(block)
                block = []
            if not block:
                start = token.start[0]
            block.append(token.string.lstrip("#").strip())
            continue
        if block and token.type not in (tokenize.NL, tokenize.NEWLINE):
            yield start, " ".join(block)
            block = []
        # A docstring is a triple-quoted string opening its own line. The
        # prefix letters are stripped rather than enumerated, so `r'''` and
        # `f"""` are covered without listing every combination.
        if token.type is tokenize.STRING and token.line.lstrip().lstrip(
                "rbfuRBFU").startswith(('"""', "'''")):
            yield token.start[0], token.string
    if block:
        yield start, " ".join(block)


def check_comment_style(rep: Report) -> None:
    """The data build's comments must follow the documentation style guide.

    Documentation is written for a developer reading the code, which is a
    different thing from a record of how the code came to look the way it
    does. The difference is invisible at the time and expensive later: a
    comment citing a plan section outlives the plan, one attributing a choice
    to somebody sends the next reader looking for them instead of for the
    reason, and one that shouts trains readers to skim.

    The data build and its tests are covered. Every rule here applies
    repository-wide, but these are the modules written to it, and a guard that
    fails on code predating it is a guard people learn to bypass.

    Skipped rather than failed while the package is absent, so this does not
    become the reason a checkout without it cannot commit.
    """
    roots = [ROOT / BUILD_PACKAGE, ROOT / PYTHON_TESTS, ROOT / ADDON_TESTS]
    modules = sorted(path for root in roots if root.is_dir()
                     for path in root.rglob("*.py"))
    if not modules:
        rep.skip("comment style", f"{BUILD_PACKAGE} not present yet")
        return

    problems: list[str] = []
    for path in modules:
        name = path.relative_to(ROOT).as_posix()
        for line, text in prose_of(path.read_text(encoding="utf-8"), name):
            for rule, pattern, advice in PROSE_RULES:
                if (found := pattern.search(text)) is None:
                    continue
                offending = found.group(0).strip()[:40]
                problems.append(f"{name}:{line} {rule}: {offending!r} - {advice}")
                break

    if problems:
        for problem in problems[:8]:
            rep.fail("comment style", problem)
        if len(problems) > 8:
            rep.fail("comment style", f"...and {len(problems) - 8} more")
    else:
        rep.ok("comment style",
               f"{len(modules)} modules free of emoji, shouting, dates, "
               f"attribution and plan references")


def check_cache_declaration(rep: Report) -> None:
    """The build and its tooling must agree on where the cache is.

    The path is declared twice on purpose: `tools/repo.py` for the scripts, and
    `build/pack/sources/cache.py` for the build, which runs on a different path
    root and must not import from `tools/`. Two declarations of one fact drift,
    and this one drifts silently in every direction that matters -- the build
    fills one directory while rebuild.py sweeps another, check_cache reports a
    rotation that never happens, and listfile.py reads a listfile nothing
    refreshed. Nothing fails; the two halves just stop sharing a cache.
    """
    if not (ROOT / "build" / "pack" / "sources" / "cache.py").exists():
        rep.skip("cache declaration", "build/pack/sources/cache.py not present yet")
        return
    try:
        sys.path.insert(0, str(ROOT / "build"))
        from pack.sources.cache import CACHE_DIR as theirs  # pylint: disable=import-outside-toplevel
    except ImportError as exc:
        rep.fail("cache declaration", f"could not read the build's declaration: {exc}")
        return
    if theirs.resolve() != CACHE.resolve():
        rep.fail("cache declaration",
                 f"the build caches in {theirs}, the tools in {CACHE}")
    else:
        rep.ok("cache declaration", f"build and tools agree on {CACHE.name}/")


LANG_COLUMN_RE = re.compile(r"^[A-Za-z0-9_]+_lang$")
"""How the client's exports spell a column the game translates."""


def check_localized_tables(rep: Report) -> None:
    """Every table a route reads translated text from must be fetched per language.

    The roster of tables re-downloaded for a language is a declaration, and
    what makes it right is somewhere else entirely: a route naming a `_lang`
    column. Miss one and the build reads that column in the default language
    while everything around it is in another -- which is not merely a missing
    translation. `UiMap` was the case that earned this guard: the area's map
    button is the map NAMED THE SAME as the area, so reading the two names in
    different languages matched nothing and the button vanished from a whole
    language.

    The test is per statement: wherever a `_lang` column is named, a table the
    roster covers has to be named alongside it. That reads both spellings the
    build uses -- a table asked for a column outright, and the drift lists that
    pair a table with its columns for a build to choose between.
    """
    root = ROOT / BUILD_PACKAGE
    modules = sorted(p for p in root.rglob("*.py")
                     if not p.name.endswith("_test.py")) if root.is_dir() else []
    if not modules:
        rep.skip("localized tables", f"{BUILD_PACKAGE} not present yet")
        return
    try:
        sys.path.insert(0, str(ROOT / "build"))
        from pack.sources.wago import (  # pylint: disable=import-outside-toplevel
            LOCALIZED_TABLES, READ_IN_ONE_LANGUAGE)
    except ImportError as exc:
        rep.fail("localized tables", f"could not read the build's roster: {exc}")
        return

    covered = set(LOCALIZED_TABLES) | set(READ_IN_ONE_LANGUAGE)
    problems: list[str] = []
    named = 0
    for path in modules:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        wanted: set[int] = set()
        answered: set[int] = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.stmt):
                continue
            texts, lines = set(), set()
            for inner in ast.walk(node):
                if isinstance(inner, ast.Constant) and isinstance(inner.value, str):
                    texts.add(inner.value)
                    if LANG_COLUMN_RE.match(inner.value):
                        lines.add(inner.lineno)
            wanted |= lines
            if texts & covered:
                answered |= lines
        named += len(wanted)
        for line in sorted(wanted - answered):
            problems.append(f"{path.relative_to(ROOT).as_posix()}:{line} reads a "
                            f"_lang column from a table neither LOCALIZED_TABLES "
                            f"nor READ_IN_ONE_LANGUAGE names")

    if problems:
        rep.fail("localized tables", "; ".join(problems[:3]))
    else:
        rep.ok("localized tables",
               f"{named} lines naming a translated column, all from the "
               f"{len(covered)} declared tables")


def check_locale_declaration(rep: Report) -> None:
    """The build and its tooling must agree which language a pack defaults to.

    Declared twice for the reason the cache directory is: `tools/packfile.py`
    serves every tool that reads a pack off disk and must not put the build
    package on its path to do it.

    The drift is quiet in the way that costs most. Every reader here falls back
    to the default when a pack does not carry the language asked for, so a
    tools-side default naming a language no pack ships would send every reader
    down the fallback and report English as though it were the answer.

    Three copies, because the third reader is TypeScript and cannot import
    either of the other two.
    """
    if not (ROOT / BUILD_PACKAGE / "derive" / "locales.py").exists():
        rep.skip("locale declaration", "build/pack/derive/locales.py not present yet")
        return
    try:
        sys.path.insert(0, str(ROOT / "build"))
        from pack.derive.locales import DEFAULT_LOCALE, LOCALES  # pylint: disable=import-outside-toplevel
    except ImportError as exc:
        rep.fail("locale declaration", f"could not read the build's declaration: {exc}")
        return
    if DEFAULT_LOCALE != packfile.DEFAULT_LOCALE:
        rep.fail("locale declaration",
                 f"the build defaults to {DEFAULT_LOCALE}, the tools to "
                 f"{packfile.DEFAULT_LOCALE}")
        return
    if DEFAULT_LOCALE not in {locale.code for locale in LOCALES}:
        rep.fail("locale declaration",
                 f"{DEFAULT_LOCALE} is the default but no pack is built in it")
        return
    found = re.search(r'^export const DEFAULT_LOCALE = "([^"]+)"',
                      (ROOT / "tools" / "packfile.ts").read_text(encoding="utf-8"),
                      re.MULTILINE)
    if found is None:
        rep.fail("locale declaration",
                 "tools/packfile.ts no longer declares DEFAULT_LOCALE")
        return
    if found.group(1) != DEFAULT_LOCALE:
        rep.fail("locale declaration",
                 f"the build defaults to {DEFAULT_LOCALE}, packfile.ts to "
                 f"{found.group(1)}")
        return
    rep.ok("locale declaration",
           f"build, tools and the bundle agree on {DEFAULT_LOCALE}, "
           f"{len(LOCALES)} language(s) built")


def check_delivery_declaration(rep: Report) -> None:
    """The delivery flag bits must agree between the build and the app's readers.

    The build writes `spellDelivery.flags`; the row reader decodes it. The bits
    are declared apart because nothing above the pack may import the build, so
    the drift this reconciles is quiet: a renumbered bit makes cast-and-channel
    queries answer with the wrong rows while everything still runs.
    """
    try:
        sys.path.insert(0, str(ROOT / "build"))
        from pack.routes.delivery import BREAKS_ON_MOVE, CHANNELLED  # pylint: disable=import-outside-toplevel
    except ImportError as exc:
        rep.fail("delivery flag bits", f"could not read the build's declaration: {exc}")
        return
    source = (ROOT / "src" / "packrows.ts").read_text(encoding="utf-8")
    found: dict[str, int] = {}
    for name in ("DELIVERY_CHANNELLED", "DELIVERY_BREAKS_ON_MOVE"):
        match = re.search(rf"^export const {name} = 1 << (\d+);", source, re.MULTILINE)
        if match is None:
            rep.fail("delivery flag bits", f"src/packrows.ts no longer declares {name}")
            return
        found[name] = 1 << int(match.group(1))
    if found["DELIVERY_CHANNELLED"] != CHANNELLED or found["DELIVERY_BREAKS_ON_MOVE"] != BREAKS_ON_MOVE:
        rep.fail("delivery flag bits",
                 f"the build writes CHANNELLED={CHANNELLED} BREAKS_ON_MOVE={BREAKS_ON_MOVE}, "
                 f"packrows.ts reads {found['DELIVERY_CHANNELLED']}/{found['DELIVERY_BREAKS_ON_MOVE']}")
        return
    # The addon reads the same flags, and can import the build no more than the
    # app can; its declaration is one line and is reconciled here the same way.
    lua = (ROOT / "addon" / "Epsilook" / "Engine" / "Search.lua").read_text(encoding="utf-8")
    match = re.search(r"^local DELIVERY_CHANNELLED, DELIVERY_BREAKS_ON_MOVE = (\d+), (\d+)$", lua, re.MULTILINE)
    if match is None:
        rep.fail("delivery flag bits",
                 "addon/Epsilook/Engine/Search.lua no longer declares the two bits on one line")
        return
    if int(match.group(1)) != CHANNELLED or int(match.group(2)) != BREAKS_ON_MOVE:
        rep.fail("delivery flag bits",
                 f"the build writes CHANNELLED={CHANNELLED} BREAKS_ON_MOVE={BREAKS_ON_MOVE}, "
                 f"Search.lua reads {match.group(1)}/{match.group(2)}")
        return
    rep.ok("delivery flag bits", "build, row reader and addon agree on both bits")


def check_range_declaration(rep: Report) -> None:
    """The reach flag bits must agree between the build and the app's readers.

    The same reconciliation the delivery bits get, for the same reason: the
    build writes `spellRanges.flags`, two readers decode it, and nothing above
    the pack may import the build. A renumbered bit here would report melee
    spells as weapon ones while everything still runs.
    """
    try:
        sys.path.insert(0, str(ROOT / "build"))
        from pack.routes.reach import MELEE, WEAPON  # pylint: disable=import-outside-toplevel
    except ImportError as exc:
        rep.fail("range flag bits", f"could not read the build's declaration: {exc}")
        return
    source = (ROOT / "src" / "packrows.ts").read_text(encoding="utf-8")
    found: dict[str, int] = {}
    for name in ("RANGE_MELEE", "RANGE_WEAPON"):
        match = re.search(rf"^export const {name} = 1 << (\d+);", source, re.MULTILINE)
        if match is None:
            rep.fail("range flag bits", f"src/packrows.ts no longer declares {name}")
            return
        found[name] = 1 << int(match.group(1))
    if found["RANGE_MELEE"] != MELEE or found["RANGE_WEAPON"] != WEAPON:
        rep.fail("range flag bits",
                 f"the build writes MELEE={MELEE} WEAPON={WEAPON}, "
                 f"packrows.ts reads {found['RANGE_MELEE']}/{found['RANGE_WEAPON']}")
        return
    lua = (ROOT / "addon" / "Epsilook" / "Engine" / "Search.lua").read_text(encoding="utf-8")
    match = re.search(r"^local RANGE_MELEE, RANGE_WEAPON = (\d+), (\d+)$", lua, re.MULTILINE)
    if match is None:
        rep.fail("range flag bits",
                 "addon/Epsilook/Engine/Search.lua no longer declares the two bits on one line")
        return
    if int(match.group(1)) != MELEE or int(match.group(2)) != WEAPON:
        rep.fail("range flag bits",
                 f"the build writes MELEE={MELEE} WEAPON={WEAPON}, "
                 f"Search.lua reads {match.group(1)}/{match.group(2)}")
        return
    rep.ok("range flag bits", "build, row reader and addon agree on both bits")


def check_locale_catalogs(rep: Report) -> None:
    """Every interface language mirrors the English catalogs and registers itself.

    English is the source language: its namespace files define which catalogs
    exist and which keys they may hold. A translation may be incomplete —
    missing keys fall back per key at runtime — but a key English does not
    declare is one no call site can ever read, so it can only be a typo or a
    leftover, and it fails here. `query.json` is the one non-catalog file a
    locale may carry: the query-word table, validated against the schema by
    the search tests rather than against English keys.

    Registration is checked by mention because a locale directory nothing
    imports is invisible at runtime: the bundle only carries what
    `src/i18n/resources.ts` and the query-word registry name.
    """
    base = ROOT / "src" / "locales"
    english = base / "en"
    if not english.is_dir():
        rep.fail("locale catalogs", "src/locales/en/ is missing")
        return

    def keys_of(path: Path) -> set[str]:
        def walk(node: object, prefix: str) -> set[str]:
            if not isinstance(node, dict):
                return {prefix}
            found: set[str] = set()
            for name, child in node.items():
                found |= walk(child, f"{prefix}.{name}" if prefix else str(name))
            return found
        return walk(json.loads(path.read_text(encoding="utf-8")), "")

    namespaces = {path.stem: keys_of(path)
                  for path in sorted(english.glob("*.json")) if path.stem != "query"}
    if not namespaces:
        rep.fail("locale catalogs", "src/locales/en/ holds no catalogs")
        return

    registry = (ROOT / "src" / "i18n" / "resources.ts").read_text(encoding="utf-8")
    word_registry = ROOT / "src" / "search" / "language" / "query-words.ts"
    if not word_registry.exists():
        rep.fail("locale catalogs", "the query-word registry moved — update this check's path to it")
        return
    words = word_registry.read_text(encoding="utf-8")
    problems: list[str] = []
    declared = set(namespaces)
    others = [path for path in sorted(base.iterdir()) if path.is_dir() and path.name != "en"]
    for locale in others:
        if f"locales/{locale.name}/" not in registry:
            problems.append(f"{locale.name}/ exists but resources.ts never imports it")
        found = {path.stem for path in locale.glob("*.json")}
        for namespace in sorted(declared - found):
            problems.append(f"{locale.name}/{namespace}.json is missing")
        for extra in sorted(found - declared - {"query"}):
            problems.append(f"{locale.name}/{extra}.json has no English namespace")
        if "query" in found and f"locales/{locale.name}/query.json" not in words:
            problems.append(f"{locale.name}/query.json exists but the query-word registry never imports it")
        for namespace in sorted(declared & found):
            stale = keys_of(locale / f"{namespace}.json") - namespaces[namespace]
            for key in sorted(stale):
                problems.append(f"{locale.name}/{namespace}.json key \"{key}\" is not in English — never read")
    if problems:
        rep.fail("locale catalogs", "; ".join(problems))
        return
    rep.ok("locale catalogs",
           f"{len(others)} language(s) beside English, every key within the English set")


def check_listfile_declaration(rep: Report) -> None:
    """The build and its tooling must read the same listfile asset.

    A release carries several listfiles differing only in case, and the build
    takes the capitalised one because the paths are shown to a reader. The two
    tools that read the same cache repeat that name rather than importing it,
    because importing drags the acquisition layer's dependencies onto a bare
    interpreter.

    The drift is silent and it inverts an answer rather than breaking one:
    `tools/listfile.py` compares a pack's names against the listfile, so
    reading the lowercase file while packs carry capitals makes every name
    differ and reports every pack stale forever. That reads exactly like a real
    listfile release, and acting on it re-ships every pack for nothing.

    Two declarations, not one per reader: `tools/repo.py` serves every tool and
    the build declares its own, exactly as they split over the cache directory
    above, and for the same reason -- the build runs on a different path root
    and must not import from `tools/`.
    """
    if not (ROOT / "build" / "pack" / "sources" / "listfile.py").exists():
        rep.skip("listfile declaration", "build/pack/sources/listfile.py not present yet")
        return
    try:
        sys.path.insert(0, str(ROOT / "build"))
        from pack.sources.listfile import LISTFILE_ASSET as theirs  # pylint: disable=import-outside-toplevel
    except ImportError as exc:
        rep.fail("listfile declaration", f"could not read the build's declaration: {exc}")
        return
    if theirs != LISTFILE_ASSET:
        rep.fail("listfile declaration",
                 f"the build reads {theirs}, the tools read {LISTFILE_ASSET}")
        return
    rep.ok("listfile declaration", f"build and tools agree on {theirs}")


def check_soundkit_declaration(rep: Report) -> None:
    """The build and the cache sweeper must agree which build is pinned.

    Sound-kit names come from one frozen build that no roster row names, so the
    sweeper has to be told to spare its cache directory. It repeats the constant
    rather than importing it, because `tools/rebuild.py` -- the tool that does
    the deleting -- runs on a bare interpreter, and the build's own module
    reaches the acquisition layer's dependencies.

    The drift deletes data rather than reporting it: an out-of-step constant
    makes the pinned directory look like a retired build's leftovers, the sweep
    removes it after every rebuild, and the next build fails on a missing
    SoundKitName.csv naming a directory nothing in the roster explains.
    """
    if not (ROOT / BUILD_PACKAGE / "sources" / "wago.py").exists():
        rep.skip("sound-kit declaration", "build/pack/sources/wago.py not present yet")
        return
    # Read as text rather than imported: this check must answer the same way on
    # the bare interpreter the sweeper runs on, and importing would make it
    # agree with an oracle the sweeper cannot reach.
    source = (ROOT / BUILD_PACKAGE / "sources" / "wago.py").read_text(encoding="utf-8")
    found = re.search(r'^SOUNDKITNAME_BUILD\s*=\s*"([^"]+)"', source, re.MULTILINE)
    if found is None:
        rep.fail("sound-kit declaration",
                 "build/pack/sources/wago.py no longer declares SOUNDKITNAME_BUILD")
        return
    if found.group(1) != packs.SOUNDKITNAME_BUILD:
        rep.fail("sound-kit declaration",
                 f"the build pins {found.group(1)}, the sweeper spares "
                 f"{packs.SOUNDKITNAME_BUILD}")
        return
    rep.ok("sound-kit declaration", f"build and sweeper agree on {found.group(1)}")


def check_supplement(rep: Report) -> None:
    """The vendored asset-name supplement must hold what the build assumes it does.

    It is the one source no build can fetch, so nothing downstream re-derives
    it and nothing downstream would notice it going wrong. Three properties are
    worth a guard because each fails silently:

    The floor is declared twice, beside the code that applies it and beside the
    code that reconstructs it, for the same reason the listfile asset name is --
    reaching the build's copy drags the acquisition layer onto a bare
    interpreter. Drift here does not break a build, it quietly admits a row that
    overwrites a real community name with a private client's spelling of it.

    Sorted order and unique ids are what make an unchanged rebuild stage
    nothing, which is the whole argument for vendoring a derived file rather
    than a note saying how to derive it.
    """
    vendored = ROOT / "build" / "sources" / "epsilon-listfile-supplement.csv.gz"
    if not vendored.exists():
        rep.skip("supplement", "nothing vendored")
        return
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        from supplement import SUPPLEMENT_FLOOR as ours  # pylint: disable=import-outside-toplevel
        sys.path.insert(0, str(ROOT / "build"))
        from pack.sources.listfile import SUPPLEMENT_FLOOR as theirs  # pylint: disable=import-outside-toplevel
    except ImportError as exc:
        rep.fail("supplement", f"could not read a floor declaration: {exc}")
        return
    if ours != theirs:
        rep.fail("supplement",
                 f"the build admits above {theirs:,}, the reconstruction above {ours:,}")
        return

    previous, duplicates, below = -1, 0, 0
    unsorted = False
    count = 0
    with gzip.open(vendored, "rt", encoding="utf-8") as handle:
        for line in handle:
            fid, separator, _path = line.partition(";")
            if not separator:
                continue
            count += 1
            current = int(fid)
            if current == previous:
                duplicates += 1
            elif current < previous:
                unsorted = True
            if current <= theirs:
                below += 1
            previous = current

    problems = []
    if unsorted:
        problems.append("not sorted by file id")
    if duplicates:
        problems.append(f"{duplicates:,} duplicate ids")
    if below:
        problems.append(f"{below:,} rows at or below the floor")
    if problems:
        rep.fail("supplement", "; ".join(problems))
        return
    rep.ok("supplement", f"{count:,} rows, sorted, all above {theirs:,}")


def check_arcanum(rep: Report) -> None:
    """tools/arcanum.py must still produce strings Arcanum can import.

    The codec is a reimplementation of the addon's AceSerializer + LibDeflate
    chain, so it can drift from the real thing silently: a spell we emit still
    round-trips through our OWN decoder while the game rejects it. The selftest
    decodes a fixture the addon's actual Lua libraries produced, which is the
    half that cannot be faked from inside this file.
    """
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        import arcanum
    except ImportError as exc:
        rep.skip("arcanum codec", f"not importable ({exc})")
        return
    failures = arcanum.selftest()
    if failures:
        rep.fail("arcanum codec", failures[0].splitlines()[0])
    else:
        rep.ok("arcanum codec", f"{len(arcanum.load_catalog())} actions, golden fixture decodes")


def check_cache(rep: Report) -> None:
    """Warn-only: .cache holds downloads no pack in the roster needs.

    THE CACHE IS THE ONE THING HERE THAT GROWS WITHOUT ANYONE SEEING IT. A patch
    bump strands the previous build's tables - ~300 MB for a retail line - and
    they are gitignored, so no diff, no status line and no deploy ever mentions
    them. tools/rebuild.py sweeps after every build, which covers the machine
    that did the bump; this covers every other one, and the case where a roster
    edit landed without a rebuild.

    WARN, NEVER FAIL: disk that could be reclaimed is not a defect in the change
    being committed, and a gitignored directory is not part of what CI sees.
    """
    if os.environ.get("CI"):
        rep.skip("cache rotation", ".cache is not present in CI")
        return
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        from packs import stale_cache
    except ImportError as exc:  # pragma: no cover - packs.py is committed
        rep.skip("cache rotation", f"tools/packs.py not importable ({exc})")
        return

    stale = stale_cache()
    if not stale:
        rep.ok("cache rotation", ".cache holds only what the roster needs")
        return
    total = sum(size for _, size in stale)
    names = ", ".join(directory.name for directory, _ in stale[:3])
    more = f" +{len(stale) - 3} more" if len(stale) > 3 else ""
    rep.warn("cache rotation",
             f"{len(stale)} unused build cache(s), {total / 1e6:,.0f} MB "
             f"({names}{more}) - python tools/rebuild.py --prune-cache")


def check_pack_freshness(rep: Report) -> None:
    """A tracked game line must not have shipped a build past the pack we ship.

    THIS IS THE CONSUMER FOR THE WEEKLY WORKFLOW'S ISSUE. That workflow can
    only file one; nothing makes anyone read it, which is this repo's own
    "prose cannot fire" failure with an issue tracker standing in for the prose.
    Here it fires where work actually happens - the command everyone runs before
    a commit.

    WARN, NEVER FAIL, and the distinction is the whole design: Blizzard shipping
    a hotfix is not a defect in the change being committed, and blocking an
    unrelated commit on it would train people to pass --fast forever. It is a
    nudge with a command attached.

    Cached for CACHE_HOURS so a normal day costs one request, not one per run.
    """
    if os.environ.get("CI"):
        rep.skip("pack freshness", "the weekly workflow owns this in CI")
        return
    try:
        sys.path.insert(0, str(ROOT / "tools"))
        from packs import PACKS, availability, live_build, patch_key
    except ImportError as exc:  # pragma: no cover - packs.py is committed
        rep.skip("pack freshness", f"tools/packs.py not importable ({exc})")
        return

    tracked = [p for p in PACKS if p.tracked]
    cache = CACHE / "pack-freshness.json"
    now = time.time()
    if cache.exists() and now - cache.stat().st_mtime < FRESHNESS_CACHE_HOURS * 3600:
        try:
            latest = json.loads(cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            latest = {}
    else:
        latest = {}
        for pack in tracked:
            build = live_build(pack.flavour)
            if not build:  # offline, or Blizzard is having a moment
                rep.skip("pack freshness", "could not reach Blizzard's version service")
                return
            latest[pack.flavour] = build
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(latest, indent=2), encoding="utf-8")

    # PATCH, not build — the user's call. A microbuild moving is not a reason to
    # re-ship eleven packs, and warning about one would make this noise.
    behind = [(p, latest[p.flavour]) for p in tracked
              if p.flavour in latest
              and patch_key(latest[p.flavour]) > patch_key(p.build)]
    if behind:
        # Only now is the availability probe worth its two requests: it answers
        # whether the bump is even possible yet, before anyone edits the roster.
        detail = "; ".join(f"{p.key} {p.patch} -> {new}{availability(new)}"
                           for p, new in behind)
        rep.warn("pack freshness",
                 f"{detail}  (edit build= in tools/packs.py, then "
                 f"python tools/rebuild.py {behind[0][0].key})")
    else:
        rep.ok("pack freshness", f"{len(tracked)} tracked line(s) current")


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
    rep.detail(output[1:])
    for line in output[1:12]:
        print(f"        {DIM}{line}{RESET}")
    if len(output) > 12:
        print(f"        {DIM}... {len(output) - 12} more lines, all of them in the log{RESET}")


def check_browser_matrix(rep: Report) -> None:
    """The input-layer interaction matrix, driven through a real browser.

    test/browser/ encodes the ruled gesture-by-position matrix as Playwright
    specs against the dev harness, with native keyboard and mouse input —
    the half of the contract the Node test suite cannot exercise. It needs a
    browser build that `npx playwright install firefox` puts under
    Playwright's registry directory, which CI and a fresh machine do not
    have, so this gate SKIPS when no Firefox is installed there — the same
    shape as the pytest tests that need a local cache.

    The suite owns its server: playwright.config.ts starts `npm run harness`
    and probes the port first, reusing an instance another session already
    runs (the harness rebuilds per request, so any instance serves current
    source).
    """
    if not (ROOT / "node_modules" / "@playwright" / "test").is_dir():
        rep.skip("browser matrix", "@playwright/test not installed")
        return
    registry: Path | None
    held = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if held is not None:
        registry = Path(held)
    elif sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA")
        registry = Path(base) / "ms-playwright" if base else None
    elif sys.platform == "darwin":
        registry = Path.home() / "Library" / "Caches" / "ms-playwright"
    else:
        registry = Path.home() / ".cache" / "ms-playwright"
    if registry is None or not any(registry.glob("firefox-*")):
        rep.skip("browser matrix", "no Playwright Firefox (npx playwright install firefox)")
        return
    run_tool(rep, "browser matrix", ["npx", "playwright", "test"],
             "test/browser/ against the harness, real input, Firefox")


def check_cli_entries(rep: Report) -> None:
    """Every command-line entry point is BUNDLED and TYPECHECKED, not one or
    the other.

    A CLI entry has to be named twice — `CLI_ENTRIES` in tools/build.mjs so
    esbuild emits it, and `include` in tsconfig.tools.json so tsc reads it —
    and neither file notices the other's omission. Missing from the tsconfig,
    the tool still bundles and still runs, so it type-checks only by accident
    and rots the first time src/ changes under it; missing from build.mjs, the
    npm script runs a stale .mjs or none at all.

    A guard rather than a comment, per this repo's own rule: prose cannot fire.
    """
    build = (ROOT / "tools" / "build.mjs").read_text(encoding="utf-8")
    tsconf = (ROOT / "tsconfig.tools.json").read_text(encoding="utf-8")
    m = re.search(r"CLI_ENTRIES\s*=\s*\[(.*?)]", build, re.S)
    if not m:
        rep.fail("cli entries", "no CLI_ENTRIES list in tools/build.mjs")
        return
    bundled = set(re.findall(r"[\"']([\w.-]+)[\"']", m.group(1)))
    typed = {p.rsplit("/", 1)[-1].removesuffix(".ts")
             for p in re.findall(r"[\"'](tools/[\w.-]+\.ts)[\"']", tsconf)}
    problems = [f"{n}: bundled, not in tsconfig.tools.json" for n in sorted(bundled - typed)]
    problems += [f"{n}: typechecked, not in CLI_ENTRIES" for n in sorted(typed - bundled)]
    if problems:
        rep.fail("cli entries", "; ".join(problems))
    else:
        rep.ok("cli entries", f"{len(bundled)} bundled and typechecked: "
                              f"{', '.join(sorted(bundled))}")


def check_license_scope(rep: Report) -> None:
    """Every directory under site/ is classified in NOTICE.

    NOTICE splits this tree by who owns what: the AGPL in LICENSE covers the
    code, while the data packs and the expansion marks are only redistributed -
    the first under no claim at all, the second under CC BY-SA. A directory
    that reaches site/ without being recorded there falls under the AGPL by
    default, which is the one failure a licence must not have. Nothing breaks
    and no test goes red; the repository simply starts asserting terms over
    material it has no right to grant.

    Directories, not files: the lists record provenance, and a new file inside
    an already-classified directory inherits the provenance of the one it
    joins. The two obligations NOTICE also carries - a vendored file keeping
    its header, and a bundled dependency's notice reaching site/js/ - are
    judgement rather than arithmetic and stay with whoever makes the change.
    """
    notice = ROOT / "NOTICE"
    if not notice.exists():
        rep.fail("license scope", "no NOTICE file to classify site/ against")
        return
    text = notice.read_text(encoding="utf-8")
    names = sorted(p.name for p in SITE.iterdir() if p.is_dir())
    missing = [n for n in names if f"site/{n}" not in text]
    if missing:
        rep.fail("license scope",
                 "under site/ but unclassified in NOTICE: " + ", ".join(f"site/{n}" for n in missing))
    else:
        rep.ok("license scope", f"{len(names)} site/ directories classified: {', '.join(names)}")


def check_dependencies(rep: Report) -> None:
    """Report npm dependencies with a newer release available.

    WARN, never fail: a new minor of esbuild is not a defect in the change being
    committed. It fires here because a dependency bump is worth EVALUATING
    before a deploy rather than discovering months later - a newer toolchain
    sometimes unties a hand (type-aware linting on TypeScript 7 arrived that
    way). Cached for the same interval as the pack check so a normal day costs
    one request.
    """
    if os.environ.get("CI"):
        rep.skip("dependencies", "not a CI concern")
        return
    cache = CACHE / "npm-outdated.json"
    now = time.time()
    if cache.exists() and now - cache.stat().st_mtime < FRESHNESS_CACHE_HOURS * 3600:
        try:
            stale = json.loads(cache.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            stale = {}
    else:
        exe = shutil.which("npm")
        if exe is None:
            rep.skip("dependencies", "npm not on PATH")
            return
        # `npm outdated` exits 1 when anything is outdated, which is not an error
        proc = subprocess.run([exe, "outdated", "--json"], cwd=ROOT, capture_output=True,
                              encoding="utf-8", errors="replace", check=False)
        try:
            stale = json.loads(proc.stdout or "{}")
        except json.JSONDecodeError:
            rep.skip("dependencies", "npm outdated returned no usable JSON")
            return
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(stale), encoding="utf-8")

    behind = {name: info for name, info in stale.items()
              if info.get("current") != info.get("latest")}
    if not behind:
        rep.ok("dependencies", "every npm dependency is at its latest release")
        return
    listing = ", ".join(f"{n} {i.get('current')}->{i.get('latest')}"
                        for n, i in sorted(behind.items())[:4])
    more = f" (+{len(behind) - 4} more)" if len(behind) > 4 else ""
    rep.warn("dependencies", f"{len(behind)} behind: {listing}{more} - evaluate before deploying")


def check_mermaid(rep: Report) -> None:
    """Every diagram in a tracked doc must parse, or GitHub shows an error card.

    Nothing else notices: the markdown is valid, the file commits, and the
    breakage is visible only to a human who scrolls to it. The renderer is a
    real headless browser, so it agrees with GitHub about what parses — which
    also makes it the one check here that cannot run without being installed.
    It resolves with `npx --no-install` and skips rather than downloading a
    browser, so a machine without it says so instead of reporting a pass.
    """
    cmd = mermaid.renderer()
    if cmd is None:
        rep.skip("mermaid", f"npx --no-install {mermaid.MERMAID_CLI} does not resolve")
        return
    work = [(f, mermaid.blocks_of(f)) for f in mermaid.markdown_files() if f.exists()]
    work = [(f, b) for f, b in work if b]
    total = sum(len(b) for _, b in work)
    if not total:
        rep.skip("mermaid", "no diagrams in tracked docs")
        return
    failures = 0
    with tempfile.TemporaryDirectory() as scratch:
        for path, blocks in work:
            rel = path.relative_to(ROOT).as_posix()
            out = Path(scratch) / f"{rel.replace('/', '_')}.svg"
            if mermaid.render_file(cmd, path, out) is None:
                continue
            for line, error in mermaid.failing_blocks(cmd, path, blocks, Path(scratch)):
                failures += 1
                rep.fail("mermaid", f"{rel}:{line}  {error}")
    if not failures:
        rep.ok("mermaid", f"{total} diagrams render")


def check_toolchain(rep: Report) -> None:
    """tsc needs `npm install` once (typescript and esbuild are pinned
    devDependencies); the build doubles as the module-graph guard.

    THREE tsc targets, one per runtime on the one engine. tsconfig.json is the
    browser (DOM lib, `types: []` so Node globals stay out of src/);
    tsconfig.tools.json is everything that runs on NODE — the command-line entry
    points and the test suite (Node types, no DOM); test/browser/tsconfig.json
    is the Playwright suite, Node code whose evaluate callbacks execute in the
    page and so need both. Checking only the first would let them rot
    silently — and tools/query.ts is the proof that the engine detaches, so it
    has to compile.

    The tests run here rather than in a habit anyone has to remember, so there
    is one definition of "does this pass" and CI runs the same one. `npm test`
    bundles them first: Node strips TYPES but does not resolve extensionless
    imports, and every module in this repo writes `from "./y"`.

    A new entry point has to be listed in BOTH tools/build.mjs and
    tsconfig.tools.json; check_cli_entries below is what makes forgetting one
    of them fail rather than pass.
    """
    run_tool(rep, "tsc", ["npx", "tsc"], "strict, tsconfig.json (browser)")
    run_tool(rep, "tsc (cli)", ["npx", "tsc", "-p", "tsconfig.tools.json"],
             "strict, tsconfig.tools.json (node)")
    run_tool(rep, "tsc (browser suite)", ["npx", "tsc", "-p", "test/browser"],
             "strict, test/browser/tsconfig.json (playwright)")
    run_tool(rep, "bundle", ["npm", "run", "--silent", "build"],
             "esbuild src/main.ts -> site/js/app.js")
    run_tool(rep, "cli bundle", ["node", "tools/build.mjs", "--cli"],
             "esbuild tools/*.ts -> tools/*.mjs (query, measure)")
    run_tool(rep, "tests", ["npm", "test", "--silent"], "node --test over test/*.test.ts")
    # Gated on everything 2.0 is being built out of: the engine (src/search),
    # the presentation layer (src/ui), the tools and the tests. .oxlintrc.json
    # already names src/ui in the strict override block, so what this path list
    # decides is only whether the tree is CHECKED, not how strictly.
    # src/app is the one exclusion, and it is deliberate rather than an
    # oversight: 1.0 is dead code that PHASE 14 deletes, it carries a backlog
    # of ~100 findings predating the linter, and the standing rule is to spend
    # nothing there. `npx oxlint --type-aware` with no path shows them.
    run_tool(rep, "oxlint", ["npx", "oxlint", "--type-aware", "src/search", "src/ui", "test", "tools"],
             "correctness + type-aware rules, .oxlintrc.json")
    # The addon's Lua, held to the client's own interpreter. selene.toml pins
    # std = lua51, which is what stops a construct that parses on a modern Lua
    # and fails in the game from reaching a commit. It skips when selene is
    # not installed, like the browser matrix does: a single binary from winget,
    # not something a checkout can assume.
    run_tool(rep, "selene", ["selene", "addon"],
             "lua 5.1 correctness over addon/, selene.toml")
    run_tool(rep, "mypy", ["uv", "run", "mypy", *PYTHON_SOURCES])
    run_tool(rep, "mypy addon", ["uv", "run", "mypy", ADDON_TESTS])
    run_tool(rep, "pyflakes", ["uv", "run", "pyflakes", *PYTHON_SOURCES, ADDON_TESTS])
    # --recursive walks a directory that is not an import package. test/py is
    # deliberately one of those: pytest's importlib mode wants no __init__.py,
    # and without this pylint reports the absent file as a parse error.
    run_tool(rep, "pylint", ["uv", "run", "pylint", "--errors-only", "--score=n",
                             "--recursive=y", *PYTHON_SOURCES],
             "errors only; style findings are advisory (.pylintrc)")
    run_tool(rep, "pylint addon", ["uv", "run", "pylint", "--errors-only", "--score=n",
                                   "--recursive=y", ADDON_TESTS])
    run_tool(rep, "pytest", ["uv", "run", "pytest"], "test/py/*_test.py")
    run_tool(rep, "pytest addon", ["uv", "run", "pytest", ADDON_TESTS], "addon/test/*_test.py, under lupa")
    check_browser_matrix(rep)
    check_mermaid(rep)


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
    # toolchain first: the build must exist before the asset check may
    # insist the bundle does
    if not args.fast:
        check_toolchain(rep)
    version = check_assets(rep, built=not args.fast)
    check_bump(rep, args.base, version)
    check_line_endings(rep)
    check_binary_text(rep)
    check_manifest(rep)
    check_format_declaration(rep)
    check_pack_sections(rep)
    check_row_schema(rep)
    check_row_vocabularies(rep)
    check_gzip_flavour(rep)
    check_layers(rep)
    check_cache_declaration(rep)
    check_build_layers(rep)
    check_comment_style(rep)
    check_cli_entries(rep)
    check_license_scope(rep)
    check_listfile_declaration(rep)
    check_localized_tables(rep)
    check_locale_declaration(rep)
    check_locale_catalogs(rep)
    check_delivery_declaration(rep)
    check_range_declaration(rep)
    check_soundkit_declaration(rep)
    check_supplement(rep)
    check_arcanum(rep)
    check_pack_freshness(rep)
    check_cache(rep)
    check_dependencies(rep)
    check_docs(rep, args.base)

    print()
    warned = f", {rep.warned} warning(s)" if rep.warned else ""
    summary = f"{rep.failed} check(s) failed{warned}" if rep.failed else f"all checks passed{warned}"
    log = rep.written(summary)
    if rep.failed:
        print(f"{RED}{rep.failed} check(s) failed{RESET}" + warned)
        if log is not None:
            print(f"{DIM}the whole report, whatever the console kept: {log}{RESET}")
        return 1
    print(f"{GREEN}all checks passed{RESET}"
          + (f", {YELLOW}{rep.warned} warning(s){RESET}" if rep.warned else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
