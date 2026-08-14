"""The roster manifest: which packs exist, and what busts their caches.

One entry per shipped pack, carrying a content hash so a browser refetches
exactly when the data changed and not because a version string moved. It is
pure output -- rebuilt from what is on disk plus the pack just written -- so
anything that must survive a rebuild belongs on the roster row instead.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


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
    """
    kept = [other for other in _read(manifest_path) if other["id"] != made["id"]]
    if made.get("default"):
        for other in kept:
            other.pop("default", None)
    kept.append(made)
    kept.sort(key=lambda one: _order(str(one["id"])))
    # Bytes, so the newlines are the ones written here rather than whatever the
    # platform would translate them into.
    manifest_path.write_bytes((json.dumps(kept, indent=2) + "\n").encode("utf-8"))


def _order(pack_id: str) -> tuple[tuple[int, ...], bool, str]:
    """Where one pack sits in the manifest, oldest build first."""
    return version_key(pack_id), "-" in pack_id, pack_id
