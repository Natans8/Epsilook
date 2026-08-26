#!/usr/bin/env python3
"""Render every mermaid block in the repository's markdown, and report the ones that fail.

    python tools/mermaid.py                     # every tracked doc that holds a diagram
    python tools/mermaid.py docs/DATA_ROUTES.md # just these files
    python tools/mermaid.py --png out/          # keep the renders, to look at them

A diagram that does not parse renders as an error card on GitHub, and nothing in
the repository notices: the markdown is still valid, the file still commits, and
the breakage is only visible to a human who scrolls past it. That is the same
shape as the other guards here, so it is checked the same way.

The renderer is mermaid-cli, which drives a real headless browser and therefore
agrees with GitHub about what parses. It is resolved with `npx --no-install`, so
this never downloads a browser: a machine that has it validates, and one that
does not says so and stops rather than pretending.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from repo import DIM, GREEN, RED, RESET, ROOT, YELLOW, git

# A fenced block opening with the mermaid language tag, up to its closing fence.
# Indented fences are not matched on purpose: a diagram nested inside a list
# item would need its indentation stripped before it parsed, and none exist.
BLOCK_RE = re.compile(r"^```mermaid[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S)

MERMAID_CLI = "@mermaid-js/mermaid-cli"


def markdown_files() -> list[Path]:
    """Every tracked markdown file, in the order git lists them."""
    listing = git("ls-files", "*.md")
    return [ROOT / line for line in listing.splitlines() if line]


def blocks_of(path: Path) -> list[tuple[int, str]]:
    """Each mermaid block in one file, as (line number of the fence, source)."""
    text = path.read_text(encoding="utf-8")
    found = []
    for match in BLOCK_RE.finditer(text):
        line = text.count("\n", 0, match.start()) + 1
        found.append((line, match.group(1)))
    return found


def renderer() -> list[str] | None:
    """The mermaid-cli command, or None when it is not already installed."""
    npx = shutil.which("npx")
    if npx is None:
        return None
    cmd = [npx, "--no-install", MERMAID_CLI]
    probe = subprocess.run(
        [*cmd, "--version"], cwd=ROOT, capture_output=True, encoding="utf-8", errors="replace", check=False
    )
    return cmd if probe.returncode == 0 else None


def _run(cmd: list[str], src: Path, out: Path) -> str | None:
    """Run the renderer once. Returns None on success, or the error to report."""
    proc = subprocess.run(
        [*cmd, "--input", str(src), "--output", str(out)],
        cwd=ROOT,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode == 0:
        return None
    output = ((proc.stdout or "") + (proc.stderr or "")).strip().splitlines()
    for line in output:
        if "rror" in line:
            return line.strip()
    return output[0].strip() if output else f"exit {proc.returncode}"


def render_file(cmd: list[str], path: Path, out: Path) -> str | None:
    """Render every block in one file, in one browser launch.

    mermaid-cli writes its images beside the markdown it was given, so the file
    is copied out of the working tree first. It stops at the first block that
    fails, which is why a failure is followed by a per-block pass.
    """
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / path.name
        copy.write_bytes(path.read_bytes())
        return _run(cmd, copy, out)


def render_block(cmd: list[str], source: str, out: Path) -> str | None:
    """Render one block on its own, to attribute a failure to a line."""
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "diagram.mmd"
        src.write_text(source, encoding="utf-8")
        return _run(cmd, src, out)


def failing_blocks(cmd: list[str], path: Path, blocks: list[tuple[int, str]], scratch: Path) -> list[tuple[int, str]]:
    """Which blocks of a file fail, and why. Only worth running after one did."""
    bad = []
    for line, source in blocks:
        error = render_block(cmd, source, scratch / f"block-{line}.svg")
        if error is not None:
            bad.append((line, error))
    return bad


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="markdown files; default is every tracked one")
    parser.add_argument("--png", metavar="DIR", help="keep the renders in this directory")
    args = parser.parse_args()

    files = [Path(p).resolve() for p in args.paths] if args.paths else markdown_files()
    work = [(f, blocks_of(f)) for f in files if f.exists()]
    work = [(f, b) for f, b in work if b]
    total = sum(len(b) for _, b in work)
    if not total:
        print("no mermaid blocks found")
        return 0

    cmd = renderer()
    if cmd is None:
        print(
            f"{YELLOW}mermaid-cli is not installed{RESET}  "
            f"{DIM}npm i -g {MERMAID_CLI}, or npx {MERMAID_CLI} once{RESET}"
        )
        return 2

    keep = Path(args.png).resolve() if args.png else None
    if keep:
        keep.mkdir(parents=True, exist_ok=True)

    failures = 0
    with tempfile.TemporaryDirectory() as scratch:
        for path, blocks in work:
            rel = path.relative_to(ROOT).as_posix()
            stem = rel.replace("/", "_")
            out = (keep / f"{stem}.png") if keep else Path(scratch) / f"{stem}.svg"
            if render_file(cmd, path, out) is None:
                print(f"{GREEN}  ok{RESET}  {rel}  {DIM}{len(blocks)} diagrams{RESET}")
                continue
            for line, error in failing_blocks(cmd, path, blocks, Path(scratch)):
                failures += 1
                print(f"{RED}FAIL{RESET}  {rel}:{line}  {DIM}{error}{RESET}")

    print(f"\n{total} diagram{'s' if total != 1 else ''}, {failures} failing")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
