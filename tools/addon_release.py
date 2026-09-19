#!/usr/bin/env python3
"""Package the addon for a release, and hand GitHub a draft of it.

    uv run python tools/addon_release.py                  # test, build, write the archive
    uv run python tools/addon_release.py --version 0.3    # name the version rather than read the toc
    uv run python tools/addon_release.py --draft          # and create a draft release holding it

Publishing is never done here. The archive is written under `addon/build/release/` so it can be
unpacked into a client and judged first, and `--draft` creates a release only its owner can see:
making it public is a click on the release page, or `gh release edit <tag> --draft=false`.

The archive holds the two directories a client needs and nothing else: the reader, with its version
stamped into the toc, and the full data, since the reader is always handed a whole pack. An addon
built on the reader's surface rather than part of it is left out.

The draft is tagged at the commit being packaged, so that commit has to be on the remote already; a
release that names a commit nobody else can fetch is refused rather than created.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from repo import ROOT, log, survive_console_encoding  # noqa: E402  pylint: disable=wrong-import-position

CODE = ROOT / "addon" / "Epsilook"
DATA = ROOT / "addon" / "build" / "full" / "Epsilook_Data"
OUT = ROOT / "addon" / "build" / "release"
TAG_PREFIX = "addon-v"
"""What a release of the addon is tagged with, apart from anything the site is tagged with."""

VERSION_LINE = re.compile(r"^## Version:\s*(\S+)\s*$", re.MULTILINE)

RELEASE_FIELD = "X-Epsilook-Release"
"""The field the data's toc names its release in, so the reader can tell data from another download.

The reader's own release is its version. The data's version is the pack it was built from, which two
releases can share, so the release goes in a field of its own. Only a packaged download carries it: a data
built for development has none, and the reader never calls that mismatched.
"""


def run(*command: str) -> str:
    """Run a command from the repository root and return what it printed, exiting on failure."""
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=False)
    if result.returncode:
        sys.exit(f"error: {' '.join(command)} failed\n{result.stdout}{result.stderr}")
    return result.stdout.strip()


def toc_version() -> str:
    """The version the reader's toc declares."""
    found = VERSION_LINE.search((CODE / "Epsilook.toc").read_text(encoding="utf-8"))
    if not found:
        sys.exit("error: Epsilook.toc declares no version")
    return found.group(1)


def data_line() -> str:
    """The pack and the day it was built, read off the data's own toc and index."""
    toc = (DATA / "Epsilook_Data.toc").read_text(encoding="utf-8")
    pack = re.search(r"^## X-Epsilook-Pack:\s*(\S+)", toc, re.MULTILINE)
    head = (DATA / "index.lua").read_text(encoding="utf-8")[:600]
    built = re.search(r'\["built"\]="([^"]+)"', head)
    return f"{pack.group(1) if pack else 'unknown pack'}, built {built.group(1) if built else 'unknown'}"


def stamped_data_toc(text: str, version: str) -> str:
    """The data's toc with the release written into it, replacing any the build left there."""
    lines = [line for line in text.splitlines() if not line.startswith(f"## {RELEASE_FIELD}:")]
    # After the last header line, so the field reads as one of them rather than as a file to load.
    last = max((i for i, line in enumerate(lines) if line.startswith("## ")), default=-1)
    lines.insert(last + 1, f"## {RELEASE_FIELD}: {version}")
    return "\n".join(lines) + "\n"


def archive(version: str) -> Path:
    """Write the release archive and return its path.

    Both tocs carry the release: the reader's as its version and the data's in its own field, which is
    what lets a reader say it has been handed data from another download.
    """
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"Epsilook-{version}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for root in (CODE, DATA):
            for path in sorted(item for item in root.rglob("*") if item.is_file()):
                name = f"{root.name}/{path.relative_to(root).as_posix()}"
                if path == CODE / "Epsilook.toc":
                    stamped = VERSION_LINE.sub(f"## Version: {version}", path.read_text(encoding="utf-8"), count=1)
                    bundle.writestr(name, stamped)
                elif path == DATA / "Epsilook_Data.toc":
                    bundle.writestr(name, stamped_data_toc(path.read_text(encoding="utf-8"), version))
                else:
                    bundle.write(path, name)
    return target


def notes(version: str) -> str:
    """The text a draft release opens with; its owner rewrites it before publishing."""
    return (
        f"Epsilook {version} for Epsilon (9.2.7).\n\n"
        f"Data: {data_line()}.\n\n"
        "Install: unpack into `_retail_/Interface/AddOns`, so that `Epsilook` and `Epsilook_Data` sit side by "
        "side, then `/reload`. `/elo help` lists the commands and `/elo test` checks the install.\n"
    )


def draft(version: str, bundle: Path) -> None:
    """Create a draft release holding the archive, tagged at the commit being packaged."""
    commit = run("git", "rev-parse", "HEAD")
    if not run("git", "branch", "-r", "--contains", commit):
        sys.exit(f"error: {commit[:10]} is not on the remote yet; push it, then draft the release")
    tag = f"{TAG_PREFIX}{version}"
    if tag in run("gh", "release", "list", "--limit", "100").split():
        sys.exit(f"error: a release tagged {tag} already exists")
    text = OUT / f"Epsilook-{version}.notes.md"
    text.write_text(notes(version), encoding="utf-8")
    created = run(
        "gh",
        "release",
        "create",
        tag,
        str(bundle),
        "--draft",
        "--target",
        commit,
        "--title",
        f"Epsilook addon {version}",
        "--notes-file",
        str(text),
    )
    log(f"Draft created, visible to the repository's owner only: {created}")
    log(f"Publish it from that page, or with: gh release edit {tag} --draft=false")


def main() -> None:
    """Test, build and package; draft a release only when asked."""
    survive_console_encoding()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default="", help="the version to stamp; the toc's own by default")
    parser.add_argument("--draft", action="store_true", help="create a draft GitHub release holding the archive")
    parser.add_argument("--skip-tests", action="store_true", help="package without running the addon's tests")
    args = parser.parse_args()

    version = args.version or toc_version()
    if not re.fullmatch(r"\d+(\.\d+){1,2}", version):
        sys.exit(f"error: {version!r} is not a version such as 0.3 or 0.3.1")
    dirty = run("git", "status", "--porcelain", "--", "addon/Epsilook")
    if dirty:
        sys.exit(f"error: the reader has uncommitted changes, so no commit describes this archive\n{dirty}")

    log("Building the full data")
    run(sys.executable, str(ROOT / "tools" / "addon.py"), "--variation", "full")
    if not args.skip_tests:
        log("Running the addon's tests")
        run("uv", "run", "pytest", "addon/test", "-q")
    bundle = archive(version)
    log(f"Wrote {bundle} ({bundle.stat().st_size / 1e6:.1f} MB), {data_line()}")
    if args.draft:
        draft(version, bundle)
    else:
        log("Not uploaded. Unpack it into a client to judge it, then rerun with --draft.")


if __name__ == "__main__":
    main()
