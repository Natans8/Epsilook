"""Build one pack and write it, which is what the rebuild tool runs.

    cd build && uv run python -m pack --version 9.2.7.45745 --label "Shadowlands 9.2.7"

One pack per invocation, because a build is long, exclusive over the download
cache, and worth being able to stop between. Driving the whole roster is the
rebuild tool's job, and it is the caller that knows the roster.

A pack is a set of module files plus a manifest naming them. The modules are
content-addressed and land in one directory shared by every pack, which is what
makes sharing cost nothing to arrange: two builds whose sections serialise
alike produce one file and both manifests point at it.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from . import pipeline
from .emit import versions
from .emit.module import Module
from .progress import log, phase, report

DATA_DIR = Path(__file__).resolve().parents[2] / "site" / "data"
"""Where a pack lands.

Said here rather than in `emit/` because that layer shapes bytes and is handed
the place to put them -- which is what lets one pack be written to a scratch
directory for comparison without the emitter learning a second path.
"""

MODULE_LOCATION = "data/modules"
"""Where the modules sit, as the page fetching them addresses it.

The manifest carries this rather than the app deriving it, so the layout is
declared once, here, by the half that creates it.
"""

MODULE_DIR = DATA_DIR / "modules"
"""Every pack's modules, in one directory.

Shared rather than per-pack because a module is named by its own content, and
two packs land on one file exactly when their bytes agree: for `core`, `names`
and `text` that means the same game build, and for `universal` it means a
vocabulary that does not vary by build at all. A per-pack directory would
write those identical bytes once per pack and lose the saving.
"""

ROSTER = DATA_DIR / "versions.json"


PLACE_TIMEOUT = 5.0
"""How long to keep trying to move a finished module onto its name, in seconds.

Generous next to the operation, which is a directory entry being rewritten: the
wait exists for a reader holding the file open, and a reader that holds a module
longer than this is doing something other than reading it.
"""

PLACE_POLL = 0.1
"""How often to retry the move while a reader has the destination open."""


def place(scratch: Path, landing: Path) -> None:
    """Move a finished module onto its content-addressed name.

    Two things are true on Windows that are not on POSIX, and both of them bite
    here. The rename is not promised to be atomic -- Python attributes that
    guarantee to POSIX, and the call it makes underneath promises nothing of the
    kind -- and it is refused outright while another process holds the
    destination open, because an ordinary open asks for no share-delete and
    delete access is what governs a rename too.

    Neither is theoretical for this build. Every pack produces a `universal`
    module from the same vocabulary, so its bytes are identical on all twelve
    and all twelve race for one name.

    So the two mitigations that ship in the tools with this same problem: retry
    for a moment, and treat "the destination exists now" as success rather than
    as failure. It IS success. The name is the hash of the content, so whoever
    won the race wrote precisely the bytes this one was about to write.
    """
    deadline = time.monotonic() + PLACE_TIMEOUT
    while True:
        try:
            os.replace(scratch, landing)
            return
        except OSError:
            if landing.exists():
                scratch.unlink(missing_ok=True)
                return
            if time.monotonic() > deadline:
                raise
            time.sleep(PLACE_POLL)


def write_modules(modules: list[Module]) -> int:
    """Write the modules that are not already on disk, and say how many.

    A module's name is its content hash, so a file that exists already holds
    exactly these bytes and rewriting it would only churn its timestamp. That
    is what makes a rebuild after a one-string fix re-ship one module instead
    of the whole pack.
    """
    MODULE_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for module in modules:
        landing = MODULE_DIR / module.filename
        if landing.exists():
            continue
        # Written beside its name and renamed into place. A module's name states
        # its content, so anything that finds the file is entitled to read it
        # immediately -- and a half-written file under the right name is
        # indistinguishable from the whole one. The scratch file is a sibling,
        # so the rename stays on one volume, which is the case `os.replace`
        # carries out as a single directory operation rather than as a copy.
        #
        # No lock, and that is not an oversight: two builds racing to write one
        # module are writing the SAME BYTES, because the name is what those
        # bytes hash to. Whichever lands second replaces the file with its own
        # content, which is why last-writer-wins is not merely tolerable here
        # but exactly right. The pid keeps the two scratch files apart.
        scratch = landing.with_name(f"{landing.name}.{os.getpid()}.part")
        scratch.write_bytes(module.payload)
        place(scratch, landing)
        written += 1
    return written


def main() -> None:
    """Build the pack named on the command line and write it."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True,
                        help="the game build to pack, e.g. 9.2.7.45745")
    parser.add_argument("--label", help="the name the version picker shows")
    parser.add_argument("--id", dest="pack_id",
                        help="the pack's identity, when it differs from the "
                             "build -- a test line sharing a patch with live")
    parser.add_argument("--refresh", action="store_true",
                        help="re-fetch every source even where a cached copy "
                             "would do")
    parser.add_argument("--hidden", action="store_true",
                        help="reachable only by an explicit version url, so "
                             "nobody downloads it without asking for it")
    parser.add_argument("--default", dest="is_default", action="store_true",
                        help="serve this pack when the url names no version, "
                             "clearing the flag on every other entry")
    parser.add_argument("--timing", action="store_true",
                        help="print where the build's time went, phase by "
                             "phase, once it finishes")
    parser.add_argument("--sources-only", action="store_true",
                        help="fetch this build's sources and stop, so that "
                             "builds sharing them can then run at once")
    args = parser.parse_args()

    if args.sources_only:
        pipeline.acquire(args.version, refresh=args.refresh)
        return

    started = time.perf_counter()
    label = args.label or args.version
    pack_id = args.pack_id or args.version
    modules, manifest = pipeline.modules(args.version, label,
                                         refresh=args.refresh, pack_id=pack_id,
                                         location=MODULE_LOCATION)

    with phase("write modules"):
        written = write_modules(modules)
    shared = len(modules) - written
    log(f"Wrote {written} module(s) to {MODULE_DIR}"
        + (f", {shared} already shared" if shared else ""))

    destination = DATA_DIR / pack_id / "manifest.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Bytes rather than text, and the same bytes that get hashed. `write_text`
    # translates newlines on Windows, so the file on disk would not be what the
    # roster says it is -- a hash that can never match, on every pack.
    payload = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    destination.write_bytes(payload)
    total = sum(len(module.payload) for module in modules)
    log(f"Wrote {destination}  ({total:,} gzipped across {len(modules)} modules)")

    stated = manifest["meta"]
    assert isinstance(stated, dict)
    built = str(stated["built"])
    versions.update(ROSTER, versions.entry(
        pack_id, label, built, payload,
        hidden=args.hidden, default=args.is_default))
    log(f"Updated {ROSTER}")

    if args.timing:
        report(time.perf_counter() - started)


if __name__ == "__main__":
    main()
