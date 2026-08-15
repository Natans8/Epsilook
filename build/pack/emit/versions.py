"""The roster manifest: which packs exist, and what busts their caches.

One entry per shipped pack, carrying a content hash so a browser refetches
exactly when the data changed and not because a version string moved. It is
pure output -- rebuilt from what is on disk plus the pack just written -- so
anything that must survive a rebuild belongs on the roster row instead.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

LOCK_TIMEOUT = 120.0
"""How long to wait for another build's roster update, in seconds.

Generous because the critical section is a read and a write of a file measured
in kilobytes: anything approaching this is a crashed build rather than a slow
one, and waiting longer would only delay saying so.
"""

LOCK_POLL = 0.05
"""How often to retry the lock. Short enough that twelve builds finishing
together are not serialised by the polling itself."""


@contextmanager
def _exclusive(manifest_path: Path) -> Iterator[None]:
    """Hold the roster against other processes for the length of the block.

    The roster is the one file two builds both write. Everything else a build
    produces is either its own (its manifest) or named by its own content (a
    module), so concurrent builds cannot disagree about it. This is
    read-modify-write over shared mutable state, which is exactly the shape that
    loses an entry when two builds interleave: both read the roster, both append
    their own pack, and whichever writes second drops the other.

    An exclusive-create sidecar rather than `fcntl` or `msvcrt`: those are the
    two halves of a platform split, and the atomicity of `O_CREAT | O_EXCL` is
    the one guarantee both platforms already make. The pid is written into it so
    a lock left by a killed build names the process that abandoned it.
    """
    lock = manifest_path.with_suffix(manifest_path.suffix + ".lock")
    deadline = time.monotonic() + LOCK_TIMEOUT
    while True:
        try:
            handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"waited {LOCK_TIMEOUT:.0f}s for {lock}. A build was most "
                    f"likely killed while holding it; delete the file and run "
                    f"again.") from None
            time.sleep(LOCK_POLL)
    try:
        try:
            os.write(handle, str(os.getpid()).encode("ascii"))
        finally:
            # Closed on the way out whatever happened, because on Windows the
            # unlink below cannot remove a file this process still holds open --
            # a leaked descriptor here would strand the lock for every later
            # build rather than only failing this one.
            os.close(handle)
        yield
    finally:
        # missing_ok because the timeout path above leaves a human to clean up,
        # and a second failure here would bury the message that says so.
        lock.unlink(missing_ok=True)


def _read(manifest_path: Path) -> list[dict[str, object]]:
    """The manifest as it stands, or nothing at all on a fresh checkout."""
    if not manifest_path.exists():
        return []
    loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert isinstance(loaded, list)
    return loaded


def version_key(version: str) -> tuple[int, ...]:
    """Sort key for a build id, numeric per part.

    Sorting these as plain strings puts a ten before a nine, which would
    silently hand the app the wrong newest-version default.
    """
    return tuple(int(part) if part.isdigit() else 0 for part in version.split("."))


def _made(pack_id: str, label: str, file: str, built: str, digest: str, *,
          hidden: bool, default: bool) -> dict[str, object]:
    """One entry, with its optional flags absent rather than false.

    The app tests for the keys, so writing them false would mark every ordinary
    pack as carrying a property it does not have.
    """
    made: dict[str, object] = {"id": pack_id, "label": label, "file": file,
                               "built": built, "hash": digest}
    if hidden:
        made["hidden"] = True
    if default:
        made["default"] = True
    return made


def entry(pack_id: str, label: str, built: str, payload: bytes, *,
          hidden: bool = False, default: bool = False) -> dict[str, object]:
    """One pack's roster entry, naming the manifest that names its modules.

    The hash is over the manifest, not over the pack: the modules are already
    content-addressed, so their names change when their bytes do and nothing
    has to bust them. What needs busting is the one file whose name is fixed,
    which is the manifest -- and because it names every module, its hash moves
    exactly when any of them does.
    """
    return _made(pack_id, label, f"data/{pack_id}/manifest.json", built,
                 hashlib.sha256(payload).hexdigest()[:10],
                 hidden=hidden, default=default)


def update(manifest_path: Path, made: dict[str, object]) -> None:
    """Fold one entry into the manifest on disk and rewrite it.

    An entry replaces the one whose id matches exactly. Marking a default
    clears the flag everywhere else, since only one pack can be the one served
    when the url names no version.

    A tagged pack id sorts identically to the build it shadows, so the plain
    build comes first and a test line reads as a variant of it rather than as a
    separate rung -- without that tie-break the order would depend on which of
    the two was rebuilt last.

    The read and the write are one critical section, because concurrent builds
    both perform them: without it two builds read the same roster, each adds its
    own pack, and the one that writes second drops the other's entry.
    """
    with _exclusive(manifest_path):
        kept = [other for other in _read(manifest_path) if other["id"] != made["id"]]
        if made.get("default"):
            for other in kept:
                other.pop("default", None)
        kept.append(made)
        kept.sort(key=lambda one: _order(str(one["id"])))
        # Bytes, so the newlines are the ones written here rather than whatever
        # the platform would translate them into. Renamed in from a sibling
        # scratch file so a reader outside the lock -- the app, a checker --
        # sees one whole roster or the other and never a half-written one.
        scratch = manifest_path.with_name(f"{manifest_path.name}.{os.getpid()}.part")
        scratch.write_bytes((json.dumps(kept, indent=2) + "\n").encode("utf-8"))
        os.replace(scratch, manifest_path)


def _order(pack_id: str) -> tuple[tuple[int, ...], bool, str]:
    """Where one pack sits in the manifest, oldest build first."""
    return version_key(pack_id), "-" in pack_id, pack_id
