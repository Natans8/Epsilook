"""Reading a CASC storage over its own content delivery network.

A private server that ships a modified client publishes the same TACT service
Blizzard does, so its data is reachable without the game installed at all. This
module is that route, and it deliberately uses nothing else: an install is a
cache, and treating it as a source would make what the build reads depend on
whose machine ran it.

The chain, once, because every step below is one link in it::

    /versions names the live build config
    the build config names the encoding file and the root, by content key
    the encoding file turns a content key into an encoding key
    the root turns a file data id into a content key
    the encoding key locates bytes, loose or inside an archive
    every located blob is a BLTE container

Four things here are easy to get wrong and fail quietly rather than loudly.
They are marked at the code that handles them, and they are: the config path the
service advertises is not the one it serves; a page count read at the wrong
offset reads as billions of pages and looks like a hang; a localised file appears
in the root once per locale and keeping the first match returns whichever sorts
first; and an archive index whose offsets are six bytes wide is a group index
whose leading bytes are an archive number rather than part of the offset.
"""

from __future__ import annotations

import struct
import urllib.error
import urllib.request
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from ..progress import log
from .cache import CACHE_DIR

USER_AGENT = {"User-Agent": "epsilook-build"}

LOCALE_ENUS = 0x2
"""The root's locale mask for English. Filtering on it is not optional: a
localised file appears once per locale, each with its own content key."""

NO_NAME_HASH = 0x10000000
"""Content flag meaning a root block stores no name hashes, so its records are
eight bytes narrower each."""


@dataclass(frozen=True)
class Service:
    """Where one product's TACT service and content delivery network live."""

    host: str
    """The service host, e.g. ``tact.epsilonwow.net``."""

    product: str = "wow"
    """The product path on the service, e.g. ``wow``."""

    path: str = "tpr/wow"
    """The content path on the network, taken from the service's own ``/cdns``."""

    region: str = "eu"
    """Which region's row to read. Regions normally carry identical builds."""

    @property
    def versions_url(self) -> str:
        """Where the live build and configuration digests are published."""
        return f"http://{self.host}/{self.product}/versions"

    def config_url(self, digest: str) -> str:
        """Where one configuration file lives.

        The path is ``<content path>/config``, and NOT the ``ConfigPath`` the
        service's own ``/cdns`` document advertises. A private service may
        publish the latter and serve only the former, and the failure is quiet:
        the miss returns an HTML error page, so a caller that checks for bytes
        rather than for status gets a plausible nothing.
        """
        return f"http://{self.host}/{self.path}/config/{_shard(digest)}"

    def data_url(self, digest: str) -> str:
        """Where one loose data file, or one whole archive, lives."""
        return f"http://{self.host}/{self.path}/data/{_shard(digest)}"


def _shard(digest: str) -> str:
    """``"55921441..."`` -> ``"55/92/55921441..."``, the two-level fan-out."""
    return f"{digest[0:2]}/{digest[2:4]}/{digest}"


def read_bpsv(text: str) -> list[dict[str, str]]:
    """Parse the pipe-separated format every TACT endpoint speaks.

    A header naming the columns as ``Name!TYPE:length``, a sequence-number
    comment, then one row per line.

    Args:
        text: the document body.

    Returns:
        One dict per row, keyed by column name.
    """
    rows: list[dict[str, str]] = []
    columns: list[str] = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("##"):
            continue
        fields = line.split("|")
        if not columns:
            columns = [field.split("!")[0] for field in fields]
            continue
        rows.append(dict(zip(columns, fields)))
    return rows


def read_config(text: str) -> dict[str, list[str]]:
    """Parse a TACT configuration file: ``key = value ...`` with ``#`` comments.

    Values stay a list because the ones that matter are pairs: ``encoding`` is a
    content key and an encoding key, and reading only the first would locate
    nothing.
    """
    out: dict[str, list[str]] = {}
    for line in text.splitlines():
        statement = line.split("#")[0].strip()
        key, separator, value = statement.partition("=")
        if separator:
            out[key.strip()] = value.split()
    return out


class Encrypted(Exception):
    """A chunk sealed with a key the public service does not publish."""


def decode_blte(blob: bytes, *, skip_encrypted: bool = True) -> bytes:
    """Decode a BLTE container.

    Args:
        blob: the container, starting at its magic.
        skip_encrypted: treat an encrypted chunk as empty rather than failing.
            Those chunks are a vendor's unreleased content and no public key
            opens them, so a reader that refuses them cannot read the files that
            merely contain one.

    Returns:
        The decoded bytes.

    Raises:
        ValueError: if the blob is not a container, or a chunk mode is unknown.
        Encrypted: if an encrypted chunk is met and skip_encrypted is False.
    """
    if blob[:4] != b"BLTE":
        raise ValueError(f"not a BLTE container: {blob[:4]!r}")
    header_size = struct.unpack_from(">I", blob, 4)[0]
    if header_size == 0:
        return _decode_chunk(blob[8:], skip_encrypted)

    count = struct.unpack_from(">I", b"\0" + blob[9:12])[0]
    out = bytearray()
    at, position = 12, header_size
    for _ in range(count):
        compressed = struct.unpack_from(">I", blob, at)[0]
        at += 24  # the compressed size, the decoded size, and a checksum
        out += _decode_chunk(blob[position:position + compressed], skip_encrypted)
        position += compressed
    return bytes(out)


def _decode_chunk(chunk: bytes, skip_encrypted: bool) -> bytes:
    """One chunk, dispatched on its leading mode byte."""
    if not chunk:
        return b""
    mode, body = chunk[:1], chunk[1:]
    if mode == b"N":
        return body
    if mode == b"Z":
        return zlib.decompress(body)
    if mode == b"F":
        return decode_blte(body, skip_encrypted=skip_encrypted)
    if mode == b"E":
        if skip_encrypted:
            return b""
        raise Encrypted("chunk is encrypted")
    raise ValueError(f"unknown BLTE chunk mode {mode!r}")


def find_encoding_keys(blob: bytes, wanted: set[bytes]) -> dict[bytes, bytes]:
    """Map the wanted content keys to encoding keys.

    Targeted rather than exhaustive. The whole table runs to millions of entries
    and half a gigabyte of dictionary, while every caller here wants a few dozen
    keys, so it stops as soon as it has them.

    Args:
        blob: the decoded encoding file.
        wanted: content keys to resolve.

    Returns:
        Content key to its first encoding key, for those found.
    """
    found: dict[bytes, bytes] = {}
    for content_key, encoding_key in _encoding_entries(blob):
        if content_key in wanted:
            found[content_key] = encoding_key
            if len(found) == len(wanted):
                break
    return found


def count_encoding_keys(blob: bytes) -> int:
    """How many content keys the encoding file holds. A self-check on the read."""
    return sum(1 for _ in _encoding_entries(blob))


def _encoding_entries(blob: bytes) -> Iterator[tuple[bytes, bytes]]:
    """Yield every ``(content key, first encoding key)`` pair, page by page.

    The header offsets are the part that fails quietly: a page count read at the
    wrong offset comes out in the billions, and the walk then looks like a hang
    rather than a malformed read.
    """
    if blob[:2] != b"EN":
        raise ValueError(f"not an encoding file: {blob[:2]!r}")
    content_key_size = blob[3]
    encoding_key_size = blob[4]
    page_bytes = struct.unpack_from(">H", blob, 5)[0] * 1024
    pages = struct.unpack_from(">I", blob, 9)[0]
    especs = struct.unpack_from(">I", blob, 18)[0]

    start = 22 + especs + pages * (content_key_size + 16)
    for page in range(pages):
        at = start + page * page_bytes
        end = at + page_bytes
        while at < end:
            keys = blob[at]
            if keys == 0:
                break  # the page is padding from here on
            content_key = blob[at + 6:at + 6 + content_key_size]
            first = at + 6 + content_key_size
            yield content_key, blob[first:first + encoding_key_size]
            at = first + keys * encoding_key_size


@dataclass(frozen=True)
class Root:
    """The root file: a file data id to a content key, for one locale."""

    keys: dict[int, bytes]
    """File data id to its content key."""

    blocks: int
    """How many blocks the file held. A self-check on the read."""

    records: int
    """How many records across every locale. Matches the file's own header."""

    @classmethod
    def parse(cls, blob: bytes, locale: int = LOCALE_ENUS) -> Root:
        """Walk every block, keeping the records whose locale mask matches.

        Args:
            blob: the decoded root file.
            locale: the locale mask to keep.

        Returns:
            The parsed root.

        Raises:
            ValueError: if the blob is not a root file.
        """
        if blob[:4] != b"TSFM":
            raise ValueError(f"not a root file: {blob[:4]!r}")
        keys: dict[int, bytes] = {}
        blocks = records = 0
        at, size = 12, len(blob)

        while at < size:
            count, content_flags, locale_flags = struct.unpack_from("<Iii", blob, at)
            at += 12
            if count == 0:
                continue
            blocks += 1
            records += count

            deltas = struct.unpack_from(f"<{count}i", blob, at)
            at += 4 * count
            content_keys = at
            at += 16 * count
            if not content_flags & NO_NAME_HASH:
                at += 8 * count

            # Filtering here rather than when a caller asks is the whole point:
            # a localised file appears once per locale with its own content key,
            # so keeping every block would resolve an id to whichever came last.
            if not locale_flags & locale:
                continue
            file_id = -1
            for index, delta in enumerate(deltas):
                file_id += delta + 1
                position = content_keys + 16 * index
                keys[file_id] = blob[position:position + 16]
        return cls(keys=keys, blocks=blocks, records=records)


@dataclass(frozen=True)
class Located:
    """Where one encoded file sits inside an archive."""

    archive: str
    offset: int
    size: int


class Storage:
    """One build's CASC, addressed by file data id.

    Everything is fetched from the service and cached on disk, so a second run
    of anything costs nothing. Construction resolves the live build, the
    encoding file and the root; opening a file resolves its keys and fetches it.
    """

    def __init__(self, service: Service, *, cache: Path | None = None,
                 locale: int = LOCALE_ENUS) -> None:
        """Resolve the live build and load what addressing a file needs.

        Args:
            service: which TACT service to read.
            cache: where fetched bytes are kept; a directory under the build's
                own cache by default.
            locale: the root locale mask to keep.
        """
        self.service = service
        self.cache = cache or CACHE_DIR / "casc" / service.host
        self.cache.mkdir(parents=True, exist_ok=True)

        versions = read_bpsv(self._get_text(service.versions_url))
        row = next((r for r in versions if r.get("Region") == service.region),
                   versions[0])
        self.build = row.get("VersionsName", "")
        self.build_config_digest = row["BuildConfig"]
        self.cdn_config_digest = row["CDNConfig"]
        log(f"  {service.host}: build {self.build}, "
            f"config {self.build_config_digest}")

        self.build_config = read_config(self._config(self.build_config_digest))
        self.cdn_config = read_config(self._config(self.cdn_config_digest))

        # The encoding file is the one thing addressed by an encoding key
        # directly, which is what breaks the circularity: everything else is
        # named by a content key and needs this file to be resolvable at all.
        encoding_key = bytes.fromhex(self.build_config["encoding"][1])
        self.encoding = decode_blte(self._fetch(encoding_key, "encoding"))

        root_content_key = bytes.fromhex(self.build_config["root"][0])
        root_key = find_encoding_keys(self.encoding, {root_content_key})
        if root_content_key not in root_key:
            raise LookupError("the root's content key is not in the encoding file")
        self.root = Root.parse(
            decode_blte(self._fetch(root_key[root_content_key], "root")), locale)
        log(f"  {len(self.root.keys):,} file ids, {self.root.blocks:,} blocks")
        self._archives: dict[bytes, Located] | None = None

    def open(self, file_id: int) -> bytes:
        """The decoded contents of one file data id.

        Args:
            file_id: the id to read.

        Returns:
            The file's bytes.

        Raises:
            LookupError: if the root does not carry the id, or the encoding file
                does not carry its content key.
        """
        return self.open_many([file_id])[file_id]

    def open_many(self, file_ids: list[int]) -> dict[int, bytes]:
        """Several files, resolving their keys in one pass over the encoding file.

        One pass rather than one per file is what makes reading a set of tables
        quick: the encoding file is large and scanning it repeatedly dominates
        everything else.

        Args:
            file_ids: the ids to read.

        Returns:
            Id to bytes, for the ids the storage carries.

        Raises:
            LookupError: if no requested id is in the root.
        """
        content_keys = {}
        for file_id in file_ids:
            key = self.root.keys.get(file_id)
            if key is not None:
                content_keys[file_id] = key
        if not content_keys:
            raise LookupError(f"none of {file_ids} is in the root")

        resolved = find_encoding_keys(self.encoding, set(content_keys.values()))
        out: dict[int, bytes] = {}
        for file_id, content_key in content_keys.items():
            encoding_key = resolved.get(content_key)
            if encoding_key is not None:
                out[file_id] = decode_blte(
                    self._fetch(encoding_key, f"fid{file_id}"))
        return out

    def _config(self, digest: str) -> str:
        """One configuration file, cached."""
        return self._get_text(self.service.config_url(digest), name=digest)

    def _fetch(self, encoding_key: bytes, name: str) -> bytes:
        """The raw container for one encoding key, loose or from an archive.

        A loose fetch is tried first because most files are served that way and
        it costs one request; the archive route needs an index over every archive
        the network declares, which is the expensive part of this module.
        """
        cached = self.cache / f"{name}.blte"
        if cached.exists() and cached.stat().st_size:
            return cached.read_bytes()
        try:
            blob = self._get(self.service.data_url(encoding_key.hex()))
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                raise
            blob = self._from_archive(encoding_key)
        cached.write_bytes(blob)
        return blob

    def _from_archive(self, encoding_key: bytes) -> bytes:
        """A ranged request for a file that is only inside an archive."""
        found = self.archives().get(encoding_key)
        if found is None:
            raise LookupError(
                f"{encoding_key.hex()} is neither loose nor in any archive the "
                f"network declares")
        end = found.offset + found.size - 1
        return self._get(self.service.data_url(found.archive),
                         headers={"Range": f"bytes={found.offset}-{end}"})

    def archives(self) -> dict[bytes, Located]:
        """Every archived file the network declares, by encoding key.

        Built once and cached in memory. Restricted to the archives the live
        configuration names, because a service also publishes patch archives
        whose contents are binary deltas rather than containers: a key matched
        there yields a plausible offset into the wrong thing, and the bytes come
        back real and fail to decode.
        """
        if self._archives is None:
            found: dict[bytes, Located] = {}
            names = self.cdn_config.get("archives", [])
            log(f"  indexing {len(names):,} archives")
            for name in names:
                found.update(self._read_archive_index(name))
            log(f"  {len(found):,} archived files")
            self._archives = found
        return self._archives

    def _read_archive_index(self, name: str) -> dict[bytes, Located]:
        """One archive index, whose entries are key, size and offset.

        Only an index whose offsets are four bytes wide is one of these. Six
        means a group index, where the leading two bytes are an archive number
        rather than part of the offset, so reading it as an ordinary index
        resolves keys to nonsense; zero means a loose-file index.

        Returns:
            Encoding key to where it sits in this archive; empty for an index
            that is absent or is not an ordinary one.
        """
        try:
            blob = self._get(f"{self.service.data_url(name)}.index",
                             name=f"{name}.index")
        except urllib.error.HTTPError:
            return {}
        if len(blob) < 28:
            return {}

        footer = len(blob) - 28
        block_bytes = blob[footer + 11] * 1024
        offset_bytes = blob[footer + 12]
        size_bytes = blob[footer + 13]
        key_bytes = blob[footer + 14]
        entries = struct.unpack_from("<I", blob, footer + 16)[0]
        if offset_bytes != 4:
            return {}

        width = key_bytes + size_bytes + offset_bytes
        per_block = block_bytes // width
        found: dict[bytes, Located] = {}
        read = 0
        while read < entries:
            at = (read // per_block) * block_bytes
            for _ in range(min(per_block, entries - read)):
                key = blob[at:at + key_bytes]
                size = int.from_bytes(blob[at + key_bytes:at + key_bytes + size_bytes],
                                      "big")
                offset = int.from_bytes(blob[at + key_bytes + size_bytes:at + width],
                                        "big")
                # A zero key is block padding rather than a file.
                if int.from_bytes(key, "big"):
                    found[key] = Located(name, offset, size)
                at += width
                read += 1
        return found

    def _get(self, url: str, headers: dict | None = None,
             name: str | None = None) -> bytes:
        """One request, through the on-disk cache when it is cacheable."""
        cached = self.cache / name if name else None
        if cached is not None and cached.exists() and cached.stat().st_size:
            return cached.read_bytes()
        request = urllib.request.Request(url, headers={**USER_AGENT,
                                                      **(headers or {})})
        with urllib.request.urlopen(request, timeout=600) as response:
            blob = response.read()
        if cached is not None:
            cached.write_bytes(blob)
        return blob

    def _get_text(self, url: str, name: str | None = None) -> str:
        """One request, decoded as text."""
        return self._get(url, name=name).decode("utf-8", errors="replace")
