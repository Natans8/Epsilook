"""Epsilon's content storage, read from the install first and the network second.

The build's own reader addresses a service over the network, which is the right
shape for a build: it needs no game installed and it always sees the live
content. Reconstructing the supplement is the opposite case. It walks tens of
thousands of small files, most of which are already on the disk of the machine
doing the walking, and going to the network for those turns a few minutes into
hours of round trips.

So this adds the half the build deliberately omits -- the client's own index over
its downloaded archives -- and leaves everything else to the build's reader,
which stays the one implementation of the service, the encoding file and the
root.

What the install holds is not what the service holds. Roughly nine tenths of all
file ids are on disk, but under half of the ids this is interested in are: a
private client's own additions are the least-cached part of any install, because
they are downloaded on demand. That is why every walk takes a local-only switch
and why it is the default. Reading the rest costs one request per file.
"""

from __future__ import annotations

import struct
import sys
import zlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))

from pack.sources.casc import (Service, Storage, decode_blte,  # noqa: E402
                               find_encoding_keys)

EPSILON = Service(host="tact.epsilonwow.net")
"""The client's own content service."""

_INDEX_SIZE_AT = 0x20
"""Where an index file records how many bytes of entries follow.

The entries block is aligned after the header rather than following it directly.
Reading the count and the entries at the unaligned offsets yields zero entries
and an install that looks entirely empty, which reads as "nothing is cached"
rather than as a defect.
"""

_INDEX_ENTRIES_AT = 0x28

_INDEX_ENTRY = 18
"""One entry: a nine-byte key prefix, a five-byte big-endian packed location,
and a four-byte little-endian size."""

_KEY_PREFIX = 9
"""How much of an encoding key an index entry stores. Enough to be unique."""

_OFFSET_BITS = 30

_ENTRY_HEADER = 30
"""Bytes of per-file header inside an archive, before the container begins."""


class Reads(Protocol):
    """What a walk needs of a storage: resolve ids, say what is local, read.

    Narrower than the storage itself on purpose. A walk is the part worth
    testing and it is pure given these three answers, so stating them as a
    protocol lets a test supply a handful of files instead of an installation
    and a service.
    """

    def encoding_keys(self, file_ids: Iterable[int]) -> dict[int, bytes]:
        """Resolve many file ids at once."""

    def holds_locally(self, file_id: int) -> bool:
        """Whether reading this file costs no request."""

    def read(self, file_id: int, *, local_only: bool = False) -> bytes | None:
        """One file's decoded bytes."""


@dataclass(frozen=True)
class Located:
    """Where one file's bytes sit inside a local archive."""

    archive: int
    offset: int
    size: int


class LocalArchives:
    """The client's own index over the archives it has downloaded.

    Keyed on the leading bytes of an encoding key, which is what the index
    stores and what makes a lookup possible without the encoding file.
    """

    def __init__(self, install: Path) -> None:
        """Read every current index file.

        Args:
            install: the client's installation directory.
        """
        self.data = install / "Data" / "data"
        self.entries: dict[bytes, Located] = {}
        for path in self._current():
            self.entries.update(self._read(path))

    def _current(self) -> list[Path]:
        """The newest index file per bucket.

        A client leaves older versions of an index in place beside the current
        one. Taking the highest-named per bucket is what the client does, and
        reading them all would resolve a key to whichever file was read last.
        """
        newest: dict[str, Path] = {}
        for path in sorted(self.data.glob("*.idx")):
            bucket = path.stem[:2]
            if bucket not in newest or path.stem > newest[bucket].stem:
                newest[bucket] = path
        return sorted(newest.values())

    @staticmethod
    def _read(path: Path) -> dict[bytes, Located]:
        """One index file's entries."""
        raw = path.read_bytes()
        size = struct.unpack_from("<I", raw, _INDEX_SIZE_AT)[0]
        found: dict[bytes, Located] = {}
        at = _INDEX_ENTRIES_AT
        for _ in range(size // _INDEX_ENTRY):
            key = raw[at:at + _KEY_PREFIX]
            packed = int.from_bytes(raw[at + _KEY_PREFIX:at + _KEY_PREFIX + 5], "big")
            length = struct.unpack_from("<I", raw, at + 14)[0]
            found[key] = Located(packed >> _OFFSET_BITS,
                                 packed & ((1 << _OFFSET_BITS) - 1), length)
            at += _INDEX_ENTRY
        return found

    def holds(self, encoding_key: bytes) -> bool:
        """Whether the install already has this file's bytes."""
        return encoding_key[:_KEY_PREFIX] in self.entries

    def read(self, encoding_key: bytes) -> bytes | None:
        """One file's decoded bytes from local storage.

        Returns:
            The decoded bytes, or None if the install does not hold the file or
            holds it in a form this cannot decode. A caller that needs the file
            either way falls back to the network.
        """
        found = self.entries.get(encoding_key[:_KEY_PREFIX])
        if found is None:
            return None
        path = self.data / f"data.{found.archive:03d}"
        try:
            with path.open("rb") as handle:
                handle.seek(found.offset + _ENTRY_HEADER)
                raw = handle.read(found.size - _ENTRY_HEADER)
        except OSError:
            return None
        try:
            return decode_blte(raw)
        except (ValueError, zlib.error):
            return None


class EpsilonStorage:
    """The client's storage, addressed by file id, install first.

    Wraps the build's service reader rather than replacing it: the service, the
    encoding file and the root are read there, and this adds only the local
    route and the bulk key resolution a walk needs.
    """

    def __init__(self, install: Path, *, remote: Storage | None = None) -> None:
        """Open the storage.

        Args:
            install: the client's installation directory.
            remote: an already-opened service reader, for a caller that has one.
        """
        self.remote = remote or Storage(EPSILON)
        self.local = LocalArchives(install)
        self._keys: dict[int, bytes] = {}

    @property
    def file_ids(self) -> Iterable[int]:
        """Every file id the root declares."""
        return self.remote.root.keys.keys()

    def custom_fids(self, floor: int) -> list[int]:
        """Every file id this client added, sorted.

        Args:
            floor: the id above which a file is the client's own rather than
                one it inherited.
        """
        return sorted(fid for fid in self.remote.root.keys if fid > floor)

    def encoding_keys(self, file_ids: Iterable[int]) -> dict[int, bytes]:
        """Resolve many file ids to encoding keys in one pass.

        The encoding file is large, and resolving one key at a time scans it
        once per file, which dominates a walk of any size. Results are kept, so
        a second walk over an overlapping set costs nothing.

        Args:
            file_ids: the ids to resolve.

        Returns:
            Id to encoding key, for the ids the storage can address.
        """
        wanted = {fid: key for fid in file_ids
                  if (key := self.remote.root.keys.get(fid)) is not None
                  and fid not in self._keys}
        if wanted:
            resolved = find_encoding_keys(self.remote.encoding, set(wanted.values()))
            for fid, content_key in wanted.items():
                encoding_key = resolved.get(content_key)
                if encoding_key is not None:
                    self._keys[fid] = encoding_key
        return {fid: self._keys[fid] for fid in file_ids if fid in self._keys}

    def holds_locally(self, file_id: int) -> bool:
        """Whether the install has this file, so reading it costs no request."""
        key = self._keys.get(file_id)
        return key is not None and self.local.holds(key)

    def read(self, file_id: int, *, local_only: bool = False) -> bytes | None:
        """One file's decoded bytes.

        Args:
            file_id: the id to read.
            local_only: refuse to reach the network, returning None instead.

        Returns:
            The bytes, or None when no permitted route has them.
        """
        key = self._keys.get(file_id) or self.encoding_keys([file_id]).get(file_id)
        if key is None:
            return None
        found = self.local.read(key)
        if found is not None or local_only:
            return found
        try:
            return self.remote.open(file_id)
        except (LookupError, OSError, ValueError, zlib.error):
            return None


def chunks(raw: bytes, *, reversed_tags: bool = False) -> Iterator[tuple[bytes, bytes]]:
    """Walk a chunked file, yielding each tag and its body.

    The two chunked formats disagree about the byte order of a tag and nothing
    in a file says which it uses: a model stores its tags forward, while a world
    model and a terrain tile store them reversed. Getting it wrong never fails.
    Every tag simply matches nothing, and the file reads as referencing no other
    file at all -- so the caller states which order it expects rather than this
    guessing.

    Args:
        raw: the whole file.
        reversed_tags: whether the format stores each tag back to front.

    Yields:
        The tag, in reading order, and the chunk's body.
    """
    at, size = 0, len(raw)
    while at + 8 <= size:
        tag = raw[at:at + 4]
        length = struct.unpack_from("<I", raw, at + 4)[0]
        body = raw[at + 8:at + 8 + length]
        if len(body) < length:
            return
        yield (tag[::-1] if reversed_tags else tag), body
        at += 8 + length
