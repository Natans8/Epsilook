#!/usr/bin/env python3
"""Format and lint through the JetBrains IDEs — one command, no MCP needed.

    python tools/ide.py                 # everything changed against origin/main
    python tools/ide.py src/data.ts     # specific files
    python tools/ide.py --lint-only     # skip the reformat pass
    python tools/ide.py --status        # which IDEs are up, and exit

WHY THIS EXISTS
    The required pre-commit pass is `read_file -> reformat -> lint -> fix ->
    reformat`, split across two IDEs by ownership, and on 2026-08-05 it failed
    twice in one session for reasons that were both environmental:

      * PyCharm's MCP tools were NOT REGISTERED (a server that starts after the
        session does not register), and the recorded status line said "DOWN".
        The IDE was running the whole time. Believing the note cost the entire
        Python inspection pass.
      * Driving the endpoint by hand each time is a five-call dance nobody
        remembers, so it gets skipped.

    Both are mechanical, so they belong to a script. This talks to the IDE's
    HTTP endpoint directly, which works whether or not MCP registered it.

OWNERSHIP (CLAUDE.md > Format, then lint)
    WebStorm owns src/, css, html, md, json, yml.  PyCharm owns build/ and
    tools/. They agree byte-for-byte on Python formatting, but the INSPECTIONS
    differ, so routing matters for lint even where it does not for format.

WHAT IT DOES NOT DO
    It does not fix anything. Reformatting is the IDE's; the findings are
    yours to triage — see docs/DECISIONS.md for the standing noise that must
    NOT be "fixed".

    It REFUSES to run from a git worktree. The JetBrains MCP resolves every
    path against the project the IDE has OPEN, which is the main checkout, so
    a run from a worktree formats and lints the main checkout's copy of each
    file instead — silently, because both trees hold the same paths. Measured
    2026-08-06; see CLAUDE.md > Working next to other sessions.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from repo import main_checkout

ROOT = Path(__file__).resolve().parent.parent

# CLAUDE.md > Checks. `datagrip` is deliberately absent: it was only ever a SQL
# surface and the duckdb MCP replaced it.
IDES = {"webstorm": 64542, "pycharm": 64462}

# Longest prefix wins, so tools/*.py goes to PyCharm even though .py is not in
# WebStorm's extension list at all.
OWNER_PREFIX = (("build/", "pycharm"), ("tools/", "pycharm"))
OWNER_SUFFIX = (".ts", ".js", ".css", ".html", ".md", ".json", ".yml", ".yaml")

# src/vendor is upstream verbatim, site/js is build output — CLAUDE.md's two
# formatting exclusions, and the only ones.
SKIP_PREFIX = ("src/vendor/", "site/js/", "build/cache/")

RED, GREEN, YELLOW, DIM, BOLD, RESET = (
    "\033[31m", "\033[32m", "\033[33m", "\033[2m", "\033[1m", "\033[0m")


class Ide:
    """One JetBrains MCP endpoint, driven over plain HTTP.

    initialize -> keep the mcp-session-id header -> notifications/initialized
    -> tools/call. The response may be SSE, in which case the answer is the
    LAST `data:` line.
    """

    def __init__(self, name: str, port: int) -> None:
        self.name, self.port = name, port
        self.url = f"http://127.0.0.1:{port}/stream"
        self.session: str | None = None

    def call(self, method: str, params: dict | None = None, notify: bool = False):
        body: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            body["params"] = params
        if not notify:
            body["id"] = 1
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if self.session:
            headers["mcp-session-id"] = self.session
        request = urllib.request.Request(self.url, json.dumps(body).encode(), headers)
        with urllib.request.urlopen(request, timeout=180) as response:
            if not self.session:
                self.session = response.headers.get("mcp-session-id")
            raw = response.read().decode("utf-8", "replace")
        if notify or not raw.strip():
            return None
        # An SSE reply carries the payload on `data:` lines and the LAST one is
        # the answer. The guard used to be `if "data:" in raw`, which is true of
        # any body that merely CONTAINS the string — including one whose data
        # lines are absent or wrapped — and then `[-1]` on the empty list raised
        # IndexError and lost the rest of the run (a known defect, hit again
        # 2026-08-10 when whole-file reads made large replies common). Test what
        # is actually being indexed, not a substring that suggests it.
        lines = [ln[5:].strip() for ln in raw.splitlines() if ln.startswith("data:")]
        if lines:
            raw = lines[-1]
        elif "data:" in raw:
            return None  # an SSE frame carrying no data line: nothing to report
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def up(self) -> bool:
        try:
            self.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                     "clientInfo": {"name": "epsilook", "version": "1"}})
            self.call("notifications/initialized", notify=True)
            return True
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def tool(self, name: str, arguments: dict):
        out = self.call("tools/call", {"name": name, "arguments": arguments})
        content = ((out or {}).get("result", {}).get("content") or [{}])[0].get("text", "")
        try:
            return json.loads(content)
        except (ValueError, TypeError):
            return content


def owner(path: str) -> str | None:
    """Which IDE owns this file, or None if nothing should touch it."""
    rel = path.replace("\\", "/")
    if any(rel.startswith(p) for p in SKIP_PREFIX):
        return None
    for prefix, ide in OWNER_PREFIX:
        if rel.startswith(prefix):
            return ide
    if rel.endswith(".py"):
        return "pycharm"
    return "webstorm" if rel.endswith(OWNER_SUFFIX) else None


def changed_files(base: str) -> list[str]:
    """Everything modified or added against `base`, plus untracked files.

    Untracked counts because a new module reaches the deploy (esbuild bundles
    what is on disk) and a new tool is still code someone has to read.
    """

    def git(*args: str) -> list[str]:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                             encoding="utf-8", errors="replace", check=False)
        return [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]

    files = git("diff", "--name-only", base) + git("diff", "--name-only")
    files += git("ls-files", "--others", "--exclude-standard")
    # The working notes are excluded in .git/info/exclude ON PURPOSE, so every
    # git-based listing hides them — including --others, which honours the
    # exclude file. They are still text files the formatting rule covers, and
    # they are the ones edited most often, so name them.
    files += [str(p.relative_to(ROOT)) for p in
              [ROOT / "CLAUDE.md", ROOT / "docs" / "DECISIONS.md"]
              + sorted((ROOT / "docs").glob("PROCESS-LOG-*.md"))
              if p.is_file()]
    return sorted({f.replace("\\", "/") for f in files if (ROOT / f).is_file()})


def run(ide: Ide, files: list[str], lint_only: bool) -> int:
    """Refresh, reformat, lint. Returns the number of problems reported."""
    # THE REFRESH IS LOAD-BEARING, NOT POLITENESS: the IDE serves a STALE buffer
    # to the first request after an out-of-IDE edit, and reformat_file does not
    # itself trigger the VFS refresh — so a reformat straight after an Edit can
    # write the old content back over it. Any other call refreshes first.
    #
    # ⚠ ONE READ OF ONE FILE IS NOT ENOUGH, measured 2026-08-10: this used to
    # read `limit: 1` of files[0] only, and a reformat of docs/SEARCH.md
    # SILENTLY DELETED a freshly-added section — twice, reproducibly, with the
    # file named on its own so it WAS files[0]. The refresh is per-file and a
    # one-line read does not carry it. Read every file, whole. The cost is one
    # call per file against silent data loss, which is not a trade worth making
    # the other way.
    for f in files:
        ide.tool("read_file", {"file_path": f, "projectPath": str(ROOT)})

    if not lint_only:
        ide.tool("reformat_file", {"files": files, "projectPath": str(ROOT)})

    # Batch in fives: a big batch comes back with `timedOut: true` and an EMPTY
    # problems array for the files it silently dropped, which reads exactly like
    # a pass. Small batches make that impossible.
    problems = 0
    for start in range(0, len(files), 5):
        batch = files[start:start + 5]
        out = ide.tool("lint_files", {"files": batch, "projectPath": str(ROOT),
                                      "timeout": 120000, "min_severity": "warning"})
        if not isinstance(out, dict):
            print(f"  {RED}?{RESET} unexpected reply for {', '.join(batch)}: {out}")
            problems += 1
            continue
        if out.get("more"):
            print(f"  {YELLOW}!{RESET} batch truncated - rerun on fewer files")
        for item in out.get("items", []):
            if item.get("timedOut"):
                print(f"  {YELLOW}!{RESET} {item.get('filePath')} TIMED OUT - not analysed")
                problems += 1
            for p in item.get("problems", []):
                problems += 1
                print(f"  {RED if p.get('severity') == 'ERROR' else YELLOW}"
                      f"{p.get('severity', '?')}{RESET} {item.get('filePath')}"
                      f":{p.get('line')}  {p.get('description')}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", help="files to pass (default: changed vs --base)")
    ap.add_argument("--base", default="origin/main", help="diff base (default: origin/main)")
    ap.add_argument("--lint-only", action="store_true", help="skip the reformat pass")
    ap.add_argument("--status", action="store_true", help="report which IDEs answer, and exit")
    args = ap.parse_args()

    # A worktree run is silently WRONG, not merely unsupported: relative paths
    # resolve against the open project, so it reformats the main checkout's
    # copy — another session's working tree — and leaves yours untouched. An
    # absolute path out of the project fares no better; it answers `{"items":
    # []}`, which reads as a clean pass. Both were measured on 2026-08-06.
    main_root = main_checkout()
    if main_root != ROOT:
        print(f"{RED}refusing to run from a worktree{RESET}\n"
              f"  this tree:    {ROOT}\n"
              f"  IDE project:  {main_root}\n"
              f"{DIM}The IDE resolves every path against the project it has open, so this "
              f"would format and lint the MAIN checkout's copy of each file - silently, "
              f"since both trees hold the same paths. Do the format/lint pass in the main "
              f"checkout after merging.{RESET}", file=sys.stderr)
        return 2

    ides = {name: Ide(name, port) for name, port in IDES.items()}
    live = {name: ide for name, ide in ides.items() if ide.up()}

    if args.status:
        for name, ide in ides.items():
            mark = f"{GREEN}up{RESET}" if name in live else f"{RED}down{RESET}"
            print(f"  {name:<10} :{ide.port}  {mark}")
        return 0

    files = args.files or changed_files(args.base)
    routed: dict[str, list[str]] = {}
    for f in files:
        who = owner(f)
        if who:
            routed.setdefault(who, []).append(f.replace("\\", "/"))

    if not routed:
        print(f"{DIM}nothing to format or lint{RESET}")
        return 0

    total, blocked = 0, False
    for name, group in sorted(routed.items()):
        print(f"{BOLD}{name}{RESET} {DIM}{len(group)} file(s){RESET}")
        if name not in live:
            # A closed IDE is the one failure that reads as a pass, so it is an
            # ERROR here rather than a note. See CLAUDE.md > Checks.
            print(f"  {RED}DOWN{RESET} - launch {name}; these files were NOT inspected:")
            for f in group:
                print(f"      {f}")
            blocked = True
            continue
        total += run(live[name], group, args.lint_only)

    print()
    if blocked:
        print(f"{RED}incomplete{RESET} - an IDE was down, so some files went unchecked")
        return 1
    if total:
        print(f"{YELLOW}{total} problem(s){RESET} - triage before fixing "
              f"{DIM}(docs/DECISIONS.md lists the standing noise){RESET}")
        return 1
    print(f"{GREEN}clean{RESET}  formatted and inspected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
