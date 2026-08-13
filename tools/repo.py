"""The git queries bump.py and check.py both ask, and the one list they must agree on.

These lived in both scripts, byte-identical, plus a THIRD copy of the paths
tuple written inline in bump.py. That is the failure mode CLAUDE.md keeps
warning about: the two are halves of one decision ("does this change need a
?v= bump?"), so a path added to check.py's list and not bump.py's produces a
deadlock - check.py demands a bump that bump.py refuses to make, and the
message blames the user for not running a script that just told them there was
nothing to do.

`tools/` is a source root, so a sibling import resolves the same way
`builddb.py` already imports `dbd`.
"""
from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path


def survive_console_encoding() -> None:
    """Degrade characters the console cannot encode instead of dying on them.

    A piped stdout on Windows is cp1252, and these tools print warning signs,
    arrows and box drawing. Without this a report dies on its own detail --
    argparse cannot even print `--help` when the epilog holds one -- and the
    traceback hides whatever the tool was trying to say.

    Called by each entry point rather than on import, because a library import
    should not reach into the caller's streams.
    """
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(errors="replace")

ROOT = Path(__file__).resolve().parent.parent

# Everything generated: downloaded game tables, the distilled TrinityCore
# dumps, the exploration database, the freshness answers. Gitignored, and the
# one place in the tree the build may write to.
#
# Named here rather than rebuilt from parts in each tool, because it was
# spelled out in seven of them and a directory written down seven times is a
# directory that cannot move. The build package declares its own copy: it runs
# on a different path root and must not import from `tools/`.
CACHE = ROOT / ".cache"

# A change to the css, the bundle's SOURCES or the build itself needs a bump.
# site/js is generated and gitignored, so it can never appear in a diff - which
# is why src/ is watched instead of the bundle it produces. An html-only or
# data-only change needs nothing (data packs self-bust via versions.json).
BUMP_PATHS = ("site/css", "src", "tools/build.mjs")


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


def main_checkout() -> Path:
    """The checkout the JetBrains IDEs have open, which is not always ROOT.

    A git worktree has its own root but shares one .git, so `--git-common-dir`
    names the MAIN checkout's .git from either side and its parent is the
    directory WebStorm and PyCharm actually opened. `main_checkout() != ROOT`
    is therefore "this is a worktree", and it is the one question two scripts
    both need: ide.py refuses to run (it would format the OTHER tree's copy of
    every file), and check.py stops claiming the inspectors mean anything.

    Falls back to ROOT when git cannot answer. The guard is worth having, but
    not at the price of refusing to run on a machine with an older git.
    """
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir").strip()
    return Path(common).resolve().parent if common else ROOT


def changed_under(base: str, paths: tuple[str, ...] = BUMP_PATHS) -> list[str]:
    """Files under `paths` that differ from `base`, UNTRACKED ONES INCLUDED.

    esbuild bundles what is on disk, so a module that has not been `git add`ed
    still reaches the deploy - and a diff alone would report nothing to bump.
    """
    out = {f for f in git("diff", "--name-only", base, "--", *paths).splitlines() if f}
    for line in git("status", "--porcelain", "--untracked-files=all", "--", *paths).splitlines():
        name = line[3:].strip()
        if name:
            out.add(name)
    return sorted(out)
