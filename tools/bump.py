#!/usr/bin/env python3
"""Move the ?v= cache-busting string in docs/index.html.

    python tools/bump.py              # bump if the deployed tree needs it
    python tools/bump.py --dry-run    # say what it would do, touch nothing
    python tools/bump.py --set 20260801a
    python tools/bump.py --no-fetch   # trust the local origin/main

WHAT IT IS MEASURED AGAINST. The string only has to differ from what is
DEPLOYED - that is origin/main, not this branch's parent and not yesterday's
value. So this fetches origin/main first by default: CLAUDE.md's hard-won rule
is that the answer changes the moment someone else pushes, and a stale
origin/main is how a branch decides it can ride a bump that has already
shipped. Serving new markup against cached css is silent, so it is worth a
network round trip.

IDEMPOTENT. Run it twice and the second run does nothing - once the string
already differs from the deployed one, the deploy is covered, and bumping
again would only make more users re-download. That is what lets it be called
unconditionally from a routine instead of only when someone remembers.

The format is YYYYMMDD plus a letter: a new day starts at 'a', a second deploy
the same day goes to 'b'. Past 'z' it continues 'aa', 'ab' - the string is
compared for difference, never ordered, so that is only a readability choice.
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "docs" / "index.html"

ASSET_RE = re.compile(r'((?:href|src)="(?:css|js)/[^"?]+\?v=)([0-9a-z]+)(")')
PARSE_RE = re.compile(r"^(\d{8})([a-z]*)$")

GREEN, YELLOW, DIM, RESET = "\033[32m", "\033[33m", "\033[2m", "\033[0m"


def git(*args: str, check: bool = False) -> str:
    try:
        out = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                             encoding="utf-8", errors="replace", check=check)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""
    return out.stdout or ""


def versions_in(html: str) -> set[str]:
    return {m.group(2) for m in ASSET_RE.finditer(html)}


def next_suffix(suffix: str) -> str:
    """'a' -> 'b', 'z' -> 'aa', 'az' -> 'ba' - spreadsheet columns."""
    if not suffix:
        return "a"
    chars = list(suffix)
    i = len(chars) - 1
    while i >= 0:
        if chars[i] != "z":
            chars[i] = chr(ord(chars[i]) + 1)
            return "".join(chars)
        chars[i] = "a"
        i -= 1
    return "a" + "".join(chars)


def next_version(deployed: str, today: str) -> str:
    """The next string after `deployed`, given today's date."""
    m = PARSE_RE.match(deployed)
    if not m or m.group(1) != today:
        return f"{today}a"          # a new day (or an unparseable old string)
    return f"{today}{next_suffix(m.group(2))}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="origin/main", help="the deployed tree (default: origin/main)")
    ap.add_argument("--set", dest="explicit", help="use this exact string instead of computing one")
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    ap.add_argument("--no-fetch", action="store_true", help="do not refresh origin/main first")
    ap.add_argument("--force", action="store_true",
                    help="bump even when the current string already differs from the deployed one")
    args = ap.parse_args()

    html = INDEX.read_text(encoding="utf-8")
    current = versions_in(html)
    if not current:
        print("docs/index.html references no versioned assets", file=sys.stderr)
        return 1
    if len(current) > 1:
        print(f"{YELLOW}index.html carries {len(current)} different strings "
              f"({', '.join(sorted(current))}) - rewriting all of them{RESET}")

    if not args.no_fetch and not args.explicit:
        remote, _, branch = args.base.partition("/")
        git("fetch", "--quiet", remote, branch or "main")

    deployed_html = git("show", f"{args.base}:docs/index.html")
    deployed = versions_in(deployed_html) if deployed_html else set()
    if not deployed:
        print(f"{YELLOW}cannot read the deployed ?v= from {args.base} - "
              f"falling back to the local string{RESET}")
        deployed = set(current)

    now = sorted(current)[0]
    was = sorted(deployed)[0]
    changed = [f for f in git("diff", "--name-only", args.base, "--",
                              "docs/css", "docs/js").splitlines() if f]

    if args.explicit:
        new = args.explicit
    elif not changed and not args.force:
        # bumping costs every user a re-download of css and js; spend it only
        # on a deploy that actually changes them
        print(f"{GREEN}nothing to do{RESET}  no css/js change against {args.base} "
              f"{DIM}(still {now}){RESET}")
        return 0
    elif not (current & deployed) and not args.force:
        print(f"{GREEN}nothing to do{RESET}  local {now} already differs from "
              f"deployed {was} {DIM}(this deploy is covered){RESET}")
        return 0
    else:
        new = next_version(was, dt.date.today().strftime("%Y%m%d"))
        while new in current | deployed:            # never re-use a live string
            new = next_version(new, new[:8])

    html2, count = ASSET_RE.subn(lambda m: f"{m.group(1)}{new}{m.group(3)}", html)
    verb = "would rewrite" if args.dry_run else "rewrote"
    if not args.dry_run:
        INDEX.write_text(html2, encoding="utf-8", newline="\n")
    print(f"{GREEN}{was} -> {new}{RESET}  {DIM}{verb} {count} references "
          f"in docs/index.html{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
