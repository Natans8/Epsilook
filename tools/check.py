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
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from repo import BUMP_PATHS, CACHE, ROOT, changed_under, git, have_ref

# A piped stdout on Windows is cp1252, and a failure detail quotes whatever the
# failing tool printed (node --test opens every line with U+25B6). A report
# that dies on its own detail hides the failure it exists to show, so degrade
# unencodable characters instead of raising.
for _stream in (sys.stdout, sys.stderr):
    if isinstance(_stream, io.TextIOWrapper):
        _stream.reconfigure(errors="replace")

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
    (("build/build_data.py", "build/pack"), "docs/DATA_ROUTES.md"),
    (("src/config.ts",), "README.md"),
)

# A PACK FORMAT BUMP MEANS THE PACK'S SHAPE CHANGED, and these consume that
# shape. Warn-only because a given bump need not touch all of them (a pure
# target-mask addition does not change what dossier prints) — but every one is
# a surface that goes quietly INCOMPLETE rather than breaking, which is exactly
# the failure a human does not notice. 2026-08-05: `spellAttrs` shipped and
# dossier.py and export.ts were both forgotten until the user asked.
FORMAT_CONSUMERS = (
    "src/data.ts",
    "src/export.ts",
    "tools/dossier.py",
    "docs/DATA_ROUTES.md",
)

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
BUILD_PACKAGE = "build/pack"
BUILD_LAYERS = ("sources", "tables", "routes", "derive", "model", "encode", "emit")

# The layers that must not touch the filesystem or the network. Acquisition owns
# the input side and emission owns the output side; everything between them is
# handed its bytes and hands its results on, which is what makes the source
# swappable and the artifact reshapeable without editing a route.
BUILD_PLACELESS = ("routes", "derive", "model", "encode")

# Names that mean "I am reaching for a file or a URL". Matched as parsed
# identifiers rather than as text, so a word in a comment or a docstring is not
# a violation - several of these are ordinary English.
PLACE_NAMES = ("Path", "open", "urlopen", "urllib", "requests", "listdir", "glob")

# Every Python path the checkers read, named once so mypy, pyflakes and pylint
# cannot drift on what they cover. The versions they run at are pinned by
# uv.lock rather than by whatever the machine happens to have installed, which
# is why all three go through `uv run`.
PYTHON_SOURCES = ("build/build_data.py", "build/locale_data.py", "build/pack", "tools")

# How long a pack-freshness answer stays good. Blizzard patches weekly at
# most, so a day is generous and keeps a normal working day to one request.
FRESHNESS_CACHE_HOURS = 24

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


def check_bump(rep: Report, base: str, version: str | None) -> None:
    """A css/js change against the deployed tree must move the ?v= string."""
    if version is None:
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


def check_line_endings(rep: Report) -> None:
    """The committed blobs are LF. A scripted rewrite is what flips them.

    .sh/.conf/Dockerfile matter more than the rest: they are read by a Linux
    container, where a CRLF line fails as `command not found: ...^M`. Their
    working copies are pinned by .gitattributes; this is the backstop.
    """
    if not have_ref("HEAD"):
        rep.skip("line endings", "no commits yet")
        return
    # every tracked text file, so a new directory is covered without being listed
    exts = (".js", ".css", ".html", ".py", ".md", ".json", ".ts", ".svg", ".yml",
            ".sh", ".conf", ".mjs")
    names = [f for f in git("ls-files").splitlines()
             if f.endswith(exts) or Path(f).name == "Dockerfile" or f.endswith(".dockerignore")]
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
               if p.is_dir() and (p / "spelldata.json.gz").exists()}
    for orphan in sorted(on_disk - listed):
        problems.append(f"{orphan}: pack on disk, no manifest entry")

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
    if "build/build_data.py" in changed and _format_moved(base):
        missed = [f for f in FORMAT_CONSUMERS if f not in changed]
        if missed:
            rep.warn("pack format consumers",
                     f"PACK_FORMAT moved but {', '.join(missed)} did not")


def _format_moved(base: str) -> bool:
    """Did this diff change PACK_FORMAT? Read off the diff, not the file."""
    diff = git("diff", "-U0", base, "--", "build/build_data.py")
    return any(line.startswith(("+PACK_FORMAT", "-PACK_FORMAT"))
               for line in diff.splitlines())


def check_pack_sections(rep: Report) -> None:
    """Every section the pack SHIPS must be named in src/data.ts.

    Mechanical, and its failure is invisible in the worst way: a route can be
    built, gzipped and deployed to ten packs while the app never reads a byte
    of it. Nothing errors — the column is simply empty forever. The pack is the
    artifact, so this reads the built file rather than parsing the builder.
    """
    if not MANIFEST.exists():
        rep.skip("pack sections", "no versions.json")
        return
    entries = json.loads(MANIFEST.read_text(encoding="utf-8"))
    default = next((e for e in entries if e.get("default")), entries[0] if entries else None)
    if not default:
        rep.skip("pack sections", "no default pack")
        return
    pack = SITE / default["file"]
    if not pack.exists() or pack.read_bytes()[:len(LFS_POINTER_MAGIC)] == LFS_POINTER_MAGIC:
        rep.skip("pack sections", "default pack not smudged locally")
        return
    with gzip.open(pack, "rt", encoding="utf-8") as fh:
        sections = set(json.load(fh)) - {"meta"}
    source = (ROOT / "src" / "data.ts").read_text(encoding="utf-8")
    unread = sorted(s for s in sections if s not in source)
    if unread:
        rep.fail("pack sections", f"shipped but unread by data.ts: {', '.join(unread)}")
    else:
        rep.ok("pack sections", f"all {len(sections)} read by data.ts")


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
    """The data build's layers must only depend downward, and only the ends of
    the pipeline may touch a file or a URL.

    Both directions are silent. A route importing an emitter welds the reading
    of a game table to one artifact shape, so the pack cannot be reshaped
    without editing routes; a route opening a file welds it to one source, so
    the provider seam stops being real the moment anything reads around it.
    Neither breaks a build - the code runs fine, it just quietly stops being
    the thing the split was for.

    Tests are exempt from both rules and deliberately so: a test's job is often
    to assert that two layers agree, and it is not part of the graph the rules
    protect.

    Skipped rather than failed while the package is absent, so this check does
    not become the reason a checkout without it cannot commit.
    """
    root = ROOT / BUILD_PACKAGE
    modules = sorted(p for p in root.rglob("*.py")
                     if not p.name.endswith("_test.py")) if root.is_dir() else []
    if not modules:
        rep.skip("build layers", f"{BUILD_PACKAGE} not present yet")
        return

    problems: list[str] = []
    for path in modules:
        relative = path.relative_to(root.parent).with_suffix("")
        # A module's package is its directory; an __init__ IS its package.
        package = ".".join(relative.parts[:-1])
        dotted = package if relative.name == "__init__" else ".".join(relative.parts)
        layer = build_layer_of(dotted)
        name = path.relative_to(ROOT).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=name)

        for target in imported_modules(tree, dotted if relative.name == "__init__" else package):
            reached = build_layer_of(target)
            if reached is None or reached == layer:
                continue
            if layer is None:
                problems.append(f"{name} is package-root vocabulary but imports {reached}/")
            elif BUILD_LAYERS.index(reached) > BUILD_LAYERS.index(layer):
                problems.append(f"{name} imports upward, into {reached}/")

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
        placeless = sum(1 for p in modules if build_layer_of(
            ".".join(p.relative_to(root.parent).with_suffix("").parts)) in BUILD_PLACELESS)
        rep.ok("build layers",
               f"{len(modules)} modules import downward only; {placeless} in "
               f"{'/, '.join(BUILD_PLACELESS)}/ free of paths and URLs")


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
        from packs import ARCHIVE, FROZEN, PACKS, availability, live_build, patch_key
    except ImportError as exc:  # pragma: no cover - packs.py is committed
        rep.skip("pack freshness", f"tools/packs.py not importable ({exc})")
        return

    tracked = [p for p in PACKS if p.product not in (FROZEN, ARCHIVE)]
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
            build = live_build(pack.product)
            if not build:  # offline, or Blizzard is having a moment
                rep.skip("pack freshness", "could not reach Blizzard's version service")
                return
            latest[pack.product] = build
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(latest, indent=2), encoding="utf-8")

    # PATCH, not build — the user's call. A microbuild moving is not a reason to
    # re-ship eleven packs, and warning about one would make this noise.
    behind = [(p, latest[p.product]) for p in tracked
              if p.product in latest
              and patch_key(latest[p.product]) > patch_key(p.build)]
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
    for line in output[1:12]:
        print(f"        {DIM}{line}{RESET}")
    if len(output) > 12:
        print(f"        {DIM}... {len(output) - 12} more lines{RESET}")


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


def check_toolchain(rep: Report) -> None:
    """tsc needs `npm install` once (typescript and esbuild are pinned
    devDependencies); the build doubles as the module-graph guard.

    TWO tsc targets, because there are two runtimes on one engine. tsconfig.json
    is the browser (DOM lib, `types: []` so Node globals stay out of src/);
    tsconfig.tools.json is everything that runs on NODE — the command-line entry
    points and the test suite (Node types, no DOM). Checking only the first
    would let them rot silently — and tools/query.ts is the proof that the
    engine detaches, so it has to compile.

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
    run_tool(rep, "bundle", ["npm", "run", "--silent", "build"],
             "esbuild src/main.ts -> site/js/app.js")
    run_tool(rep, "cli bundle", ["node", "tools/build.mjs", "--cli"],
             "esbuild tools/*.ts -> tools/*.mjs (query, measure)")
    run_tool(rep, "tests", ["npm", "test", "--silent"], "node --test over test/*.test.ts")
    # Gated on the search 2.0 tree and the tools, which are held to the full
    # rule set. The 1.0 modules under src/app carry a backlog of ~100 findings
    # that predates the linter; `npx oxlint --type-aware` with no path shows
    # them, and they are worked down rather than blocking unrelated commits.
    run_tool(rep, "oxlint", ["npx", "oxlint", "--type-aware", "src/search", "test", "tools"],
             "correctness + type-aware rules, .oxlintrc.json")
    run_tool(rep, "mypy", ["uv", "run", "mypy", *PYTHON_SOURCES])
    run_tool(rep, "pyflakes", ["uv", "run", "pyflakes", *PYTHON_SOURCES])
    run_tool(rep, "pylint", ["uv", "run", "pylint", "--errors-only", "--score=n",
                             *PYTHON_SOURCES],
             "errors only; style findings are advisory (.pylintrc)")
    run_tool(rep, "pytest", ["uv", "run", "pytest"],
             "build/pack/**/*_test.py, beside the code they test")


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
    check_manifest(rep)
    check_pack_sections(rep)
    check_layers(rep)
    check_build_layers(rep)
    check_cli_entries(rep)
    check_license_scope(rep)
    check_arcanum(rep)
    check_pack_freshness(rep)
    check_cache(rep)
    check_dependencies(rep)
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
