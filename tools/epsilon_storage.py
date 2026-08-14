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

from pack.sources.casc import (EPSILON, Located as Remote,  # noqa: E402
                               Storage, decode_blte, find_encoding_keys)
from tqdm import tqdm  # noqa: E402

HEAD_CAP = 16 * 1024
"""How much of a container a head read asks for.

Measured over the files this install lacks: a sixteen kilobyte cap is a tenth
of fetching them whole, and four thousand of the ten thousand are smaller than
it, so those arrive complete for nothing.
"""

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

_INDEX_FOOTER = 28
"""Trailing bytes of an archive index that describe how to read the rest."""


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

    def prepare_network(self) -> None:
        """Do whatever the first networked read would do, once and in advance."""


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
        self.indices = install / "Data" / "indices"
        self.entries: dict[bytes, Located] = {}
        for path in self._current():
            self.entries.update(self._read(path))

    def archive_locations(self, wanted: set[bytes]) -> dict[bytes, Remote]:
        """Where the service's archives hold each wanted file, read from disk.

        The client keeps its own copy of every archive index the service
        publishes, which is the same set a networked reader would otherwise
        download in full -- some gigabytes of it -- purely to find out where a
        few thousand files sit. Reading them here costs a disk pass instead.

        Only the wanted keys are kept. The full set runs to millions of entries
        and there is no reason to hold the ones nothing is going to ask for.

        Args:
            wanted: the encoding keys to locate.

        Returns:
            Encoding key to its place in a named archive, for those found.
        """
        found: dict[bytes, Remote] = {}
        if not self.indices.is_dir():
            return found
        for path in tqdm(sorted(self.indices.glob("*.index")),
                         desc="archive indices (install)", unit="index"):
            found.update(self._read_archive(path, wanted))
        return found

    @staticmethod
    def _read_archive(path: Path, wanted: set[bytes]) -> dict[bytes, Remote]:
        """One archive index: which of a named archive's bytes are which file.

        The archive's name is the index's own filename, which is what makes a
        local copy usable against the service without asking it anything.

        Args:
            path: the index file.
            wanted: the only keys worth keeping.
        """
        blob = path.read_bytes()
        if len(blob) < _INDEX_FOOTER:
            return {}
        footer = len(blob) - _INDEX_FOOTER
        block_bytes = blob[footer + 11] * 1024
        offset_bytes = blob[footer + 12]
        size_bytes = blob[footer + 13]
        key_bytes = blob[footer + 14]
        entries = struct.unpack_from("<I", blob, footer + 16)[0]
        # Four-byte offsets are an ordinary archive index. Six means a group
        # index, whose leading bytes are an archive number rather than part of
        # the offset, so reading it this way resolves keys to nonsense.
        if offset_bytes != 4 or not block_bytes:
            return {}

        width = key_bytes + size_bytes + offset_bytes
        per_block = block_bytes // width
        archive = path.stem
        found: dict[bytes, Remote] = {}
        read = 0
        while read < entries:
            at = (read // per_block) * block_bytes
            for _ in range(min(per_block, entries - read)):
                key = blob[at:at + key_bytes]
                size = int.from_bytes(blob[at + key_bytes:at + key_bytes + size_bytes],
                                      "big")
                offset = int.from_bytes(
                    blob[at + key_bytes + size_bytes:at + width], "big")
                # Filtered here rather than after: the full set across every
                # index runs to millions of entries, and holding them to throw
                # nearly all away costs more than the read does.
                if key in wanted:
                    found[key] = Remote(archive, offset, size)
                at += width
                read += 1
        return found

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
        self._mapped: set[bytes] = set()
        self._unlocated: set[bytes] = set()
        """Keys the install's indices do not carry, so they are asked for once."""
        self._located: dict[bytes, Remote] = {}
        """Where the install's indices say a file sits, kept so a head read
        asks the archive directly instead of taking a 404 off the loose URL
        first."""

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

    def prepare_network(self) -> None:
        """Resolve where the archived files sit, before any concurrent read.

        Two problems, one answer. The service reader builds its archive map
        lazily and not thread safely, so a walk that goes wide before the map
        exists has every worker build the whole thing at once. And building it
        at all means downloading every archive index the service publishes,
        which is gigabytes fetched to locate a few thousand small files.

        The client already keeps its own copy of those indices, so they are
        read from disk and handed to the reader before it can want them. If the
        install has no copy, the reader falls back to its own way of getting
        them, which is correct and merely expensive.
        """
        wanted = {key for key in self._keys.values()
                  if not self.local.holds(key)} - self._mapped
        if not wanted:
            return
        # Merged rather than built once: each walk resolves its own parents, so
        # a map built for the first would not carry the second's, and a miss
        # there reads as the file being unavailable rather than unlooked-for.
        self._mapped |= wanted
        found = self.local.archive_locations(wanted)
        if found:
            # Handing the map over rather than letting it be built: the reader
            # exposes no way to seed it, and the alternative is a second
            # implementation of the ranged read that uses it.
            existing = self.remote._archives or {}  # pylint: disable=protected-access
            self.remote._archives = existing | found  # pylint: disable=protected-access
            print(f"  archive map: {len(found):,} of {len(wanted):,} located "
                  f"from the install, nothing downloaded")
        else:
            self.remote.archives()

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
            # Fetched by the key already resolved rather than by asking the
            # reader to open the id. Its own entry point resolves a key by
            # scanning the whole encoding file, which is fine for the handful
            # of tables a build opens and ruinous across tens of thousands:
            # every read would re-scan a hundred and forty megabytes.
            raw = self.remote._fetch(key, f"fid{file_id}")  # pylint: disable=protected-access
            return decode_blte(raw)
        except (LookupError, OSError, ValueError, zlib.error):
            return None

    def locate(self, file_ids: Iterable[int]) -> None:
        """Find where the archives hold these files, in ONE pass over the index.

        `archive_locations` reads every index the install keeps, so asking it
        per file reads eighteen hundred files per fetch and a walk that should
        take minutes takes hours. It is the same shape as resolving encoding
        keys one at a time, and it has the same fix.

        Args:
            file_ids: the files a head read is about to want.
        """
        keys = self.encoding_keys(file_ids)
        wanted = {key for key in keys.values() if key not in self._located}
        wanted -= self._unlocated
        if not wanted:
            return
        self._located.update(self.local.archive_locations(wanted))
        # Remembered so a file the indices do not carry is asked for once and
        # then goes down the loose route, rather than re-reading every index.
        self._unlocated |= {key for key in wanted if key not in self._located}

    def read_head(self, file_id: int, cap: int = HEAD_CAP) -> bytes | None:
        """As much of a file's start as `cap` container bytes yield.

        The routes that read a file for its own name want its head: a world
        model states the retail id it came from in the first chunk, and a model
        states its name in the header. Fetching the whole file to reach that is
        most of a gigabyte across the files this client does not hold locally,
        against roughly a tenth of it capped -- and the cap is free for the
        third of them that are smaller than it anyway.

        Two requests become one as well. The reader tries the loose URL first
        and falls back to the archive on a 404, which is right when nothing
        knows where the file is; here the install's own indices already say,
        so the archive is asked directly.

        Args:
            file_id: the id to read.
            cap: how many container bytes to ask for.

        Returns:
            The decoded prefix, which may be short of the whole file, or None
            when no route has it. A local file is returned whole, since reading
            it costs nothing.
        """
        key = self._keys.get(file_id) or self.encoding_keys([file_id]).get(file_id)
        if key is None:
            return None
        found = self.local.read(key)
        if found is not None:
            return found
        # Deliberately does NOT locate a key it has not been given. Finding one
        # reads every index the install keeps, and a reader that does that per
        # call turns a wide fetch into eighteen hundred file reads per worker.
        # A caller that wants the cheap route calls `locate` for its whole set
        # first; without that this takes the loose address, which costs a
        # request more but only for the files nobody located.
        where = self._located.get(key)
        try:
            if where is not None:
                self._located[key] = where
                end = where.offset + min(where.size, cap) - 1
                blob = self.remote._get(  # pylint: disable=protected-access
                    self.remote.cdn.data_url(where.archive),
                    headers={"Range": f"bytes={where.offset}-{end}"})
            else:
                blob = self.remote._get(  # pylint: disable=protected-access
                    self.remote.cdn.data_url(key.hex()),
                    headers={"Range": f"bytes=0-{cap - 1}"})
        except (LookupError, OSError, ValueError):
            return None
        return decode_blte_prefix(blob)


def decode_blte_prefix(blob: bytes) -> bytes:
    """Decode every complete chunk of a container that may be cut short.

    `decode_blte` assumes the whole container is present and walks its chunk
    table to the end; given a prefix it reads a length past the buffer and
    raises. This stops at the first chunk that did not arrive whole, which is
    the point of asking for a prefix at all.

    Args:
        blob: the start of a container.

    Returns:
        The decoded bytes of the chunks that arrived complete. Empty when the
        blob is not a container or nothing complete arrived.
    """
    if blob[:4] != b"BLTE":
        return b""
    header_size = struct.unpack_from(">I", blob, 4)[0]
    if header_size == 0:
        # One unchunked body, so a prefix of it is a prefix of the compression
        # stream; the decompressor is what tolerates the truncation.
        return _decode_prefix_chunk(blob[8:])
    if len(blob) < 12:
        return b""
    count = struct.unpack_from(">I", b"\0" + blob[9:12])[0]
    out = bytearray()
    at, position = 12, header_size
    for _ in range(count):
        if at + 24 > len(blob):
            break
        compressed = struct.unpack_from(">I", blob, at)[0]
        at += 24
        if position + compressed > len(blob):
            out += _decode_prefix_chunk(blob[position:])
            break
        out += _decode_prefix_chunk(blob[position:position + compressed])
        position += compressed
    return bytes(out)


def _decode_prefix_chunk(chunk: bytes) -> bytes:
    """One chunk that may be cut short, by its leading mode byte."""
    if not chunk:
        return b""
    mode, body = chunk[:1], chunk[1:]
    if mode == b"N":
        return body
    if mode == b"Z":
        # A streaming decompressor returns what the prefix supports instead of
        # refusing the whole chunk for want of its tail.
        try:
            return zlib.decompressobj().decompress(body)
        except zlib.error:
            return b""
    return b""


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
