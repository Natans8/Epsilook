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

That chain is the same wherever it is read, so a service says only the two
things services differ on: where its versions document is, and which host
serves the content it names. A private server answers both from one host; the
vendor publishes versions on a version service and content on a network it
names in a second document.

Six things here are easy to get wrong and fail quietly rather than loudly.
They are marked at the code that handles them, and they are: the config path a
service advertises is not the one it serves; a network that will not say
whether an object exists refuses a miss rather than denying it, so the archive
route is reached through two status codes; a page count read at the wrong
offset reads as billions of pages and looks like a hang; a localised file
appears in the root once per locale and keeping the first match returns
whichever sorts first; an archive index whose offsets are six bytes wide is a
group index whose leading bytes are an archive number rather than part of the
offset; and a root file states which manifest format it is in, so reading a
newer one at the older offsets yields file ids that are wrong rather than
absent.
"""

from __future__ import annotations

import struct
import urllib.error
import urllib.request
import zlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..progress import log
from .cache import CACHE_DIR

USER_AGENT = {"User-Agent": "epsilook-build"}

LOCALE_ENUS = 0x2
"""The root's locale mask for English. Filtering on it is not optional: a
localised file appears once per locale, each with its own content key."""

NO_NAME_HASH = 0x10000000
"""Content flag meaning a root block stores no name hashes, so its records are
eight bytes narrower each."""

STATED_HEADER_MAX = 1024
"""How large the root's own header may say it is.

The discriminator between the two root headers, and it is a size comparison
because the two formats differ by which number sits in the second word: the
older one puts a total file count there, in the millions, and the newer one
the length of its own header, which is a couple of dozen bytes. Nothing in
either says outright which it is.
"""

SPLIT_FLAGS_TOP_SHIFT = 17
"""Where the third part of a split content flags field belongs.

Manifest version two spends three fields on what one used to hold, and the
last of them is a single byte carrying the flags above bit seventeen.
"""


ReadText = Callable[[str], str]
"""One request, answered as text. What a service is handed when locating its
content costs a document of its own."""

CONTENT_PATH = "tpr/wow"
"""Where a network keeps this product, under whichever host serves it. Every
service measured here publishes the same one, so it is the default rather than
a per-service fact, and a document naming another is still believed."""

NOT_SERVED = (403, 404)
"""What a network answers for a blob it does not serve loose.

Two codes for one answer, because a bucket-backed network refuses to say
whether an object exists rather than saying it does not, and the vendor's is
one: it answers 403 where the private service answers 404. Reading only 404 as
the miss is what makes the difference expensive rather than cosmetic, because
the archive route is reached through it, and on a network where most files are
archived that is nearly every file.
"""


@dataclass(frozen=True)
class Cdn:
    """One content delivery network: the host and path that serve a build.

    Both halves of a build live under the one path: configuration files under
    ``config`` and every content blob under ``data``. A service names this,
    rather than being it, because the vendor's version service serves neither.
    """

    host: str
    """The host that serves the bytes, e.g. ``level3.blizzard.com``."""

    path: str = CONTENT_PATH
    """The content path under it, taken from a ``/cdns`` document's ``Path``."""

    def config_url(self, digest: str) -> str:
        """Where one configuration file lives.

        The path is ``<content path>/config``, and NOT the ``ConfigPath`` the
        ``/cdns`` document advertises. Both services measured here advertise
        ``tpr/configs/data`` and serve nothing under it: the vendor's own
        network answers 403 there and 200 under ``config``, and a private
        service copying the document inherits the same gap. The failure is
        quiet either way, because the miss returns an error document rather
        than nothing, so a caller that checks for bytes rather than for status
        gets a plausible answer that is not a configuration file.
        """
        return f"http://{self.host}/{self.path}/config/{_shard(digest)}"

    def data_url(self, digest: str) -> str:
        """Where one loose data file, or one whole archive, lives."""
        return f"http://{self.host}/{self.path}/data/{_shard(digest)}"


def _shard(digest: str) -> str:
    """``"55921441..."`` -> ``"55/92/55921441..."``, the two-level fan-out."""
    return f"{digest[0:2]}/{digest[2:4]}/{digest}"


class Service(Protocol):
    """One product's TACT service: which build is live, and where it is served.

    An implementation answers two questions and nothing else, because the two
    known shapes agree on everything below them. The chain from a build config
    to a file's bytes is identical, and so are the paths under a network's
    content path, which is why locating a build is the whole of this seam.
    """

    @property
    def label(self) -> str:
        """What this service is called on disk, and in the log.

        Read-only on the interface so a frozen implementation satisfies it, as
        with the sources' own contract.
        """
        raise NotImplementedError

    @property
    def region(self) -> str:
        """Which region's row to read. Regions normally carry identical builds."""
        raise NotImplementedError

    @property
    def versions_url(self) -> str:
        """Where the live build and configuration digests are published."""
        raise NotImplementedError

    def cdn(self, read: ReadText) -> Cdn:
        """Which network serves this service's content.

        Args:
            read: how to fetch a document, for a service that publishes the
                answer rather than being it. A service that serves its own
                content makes no request at all.

        Returns:
            Where this service's configuration files and data blobs live.
        """
        raise NotImplementedError


@dataclass(frozen=True)
class SelfHosted:
    """A service that is also its own network, as a private server is.

    One host answers for the versions document, the configuration files and
    the data blobs alike, so nothing has to be looked up to reach the content:
    the service is the network, and its own ``/cdns`` document says as much.
    """

    host: str
    """The service host, e.g. ``tact.epsilonwow.net``."""

    product: str = "wow"
    """The product path on the service, e.g. ``wow``."""

    path: str = CONTENT_PATH
    """The content path on the host, taken from its own ``/cdns``."""

    region: str = "eu"
    """Which region's row to read."""

    @property
    def label(self) -> str:
        """The host, which is the whole of what such a service is."""
        return self.host

    @property
    def versions_url(self) -> str:
        """The product's versions document, served by the host itself."""
        return f"http://{self.host}/{self.product}/versions"

    def cdn(self, read: ReadText) -> Cdn:
        """The host itself, without asking it. See `Service.cdn`."""
        return Cdn(self.host, self.path)


@dataclass(frozen=True)
class Blizzard:
    """The vendor's own service: versions in one place, content in another.

    The version service holds every region's row whichever region's host is
    asked, so the host and the region are two knobs rather than one: the host
    is who is asked, and the region is which row is read and which network's
    row is taken from the ``/cdns`` document beside it.

    A product is a whole line rather than a build, so every live client the
    vendor publishes is reachable by constructing this with that product's
    name. There is no second class for one.
    """

    product: str = "wow"
    """The product line, e.g. ``wow`` for retail or ``wow_classic``."""

    region: str = "eu"
    """Which region's row to read, in both documents."""

    host: str = "eu.version.battle.net"
    """Which version service host to ask. Version two over https: the older
    TACT host proxies this one, and the raw protocol on port 1119 is neither
    http nor reachable from a proxied network."""

    @property
    def label(self) -> str:
        """The product, qualified, because one host serves every line."""
        return f"blizzard-{self.product}"

    @property
    def versions_url(self) -> str:
        """The product's versions document on the version service."""
        return f"https://{self.host}/v2/products/{self.product}/versions"

    @property
    def cdns_url(self) -> str:
        """The document naming which networks serve this product."""
        return f"https://{self.host}/v2/products/{self.product}/cdns"

    def cdn(self, read: ReadText) -> Cdn:
        """The first host this region's row names. See `Service.cdn`.

        The rows are keyed ``Name`` rather than ``Region`` here, unlike the
        versions document beside it, and a region may name several hosts. The
        first is taken: they serve the same content, and choosing between them
        is a fallback policy rather than an address.

        Raises:
            LookupError: if the document names no host at all.
        """
        rows = read_bpsv(read(self.cdns_url))
        here = [row for row in rows if row.get("Name") == self.region] or rows
        hosts = here[0].get("Hosts", "").split() if here else []
        if not hosts:
            raise LookupError(
                f"{self.cdns_url} names no host for region {self.region}")
        return Cdn(hosts[0], here[0].get("Path") or CONTENT_PATH)


EPSILON = SelfHosted(host="tact.epsilonwow.net")
"""The Epsilon client's own content service."""

RETAIL = Blizzard()
"""The live retail line, on the vendor's own service."""


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
    """A chunk sealed with a key nothing here carries."""


def decode_blte(blob: bytes, *, skip_encrypted: bool = True) -> bytes:
    """Decode a BLTE container.

    Args:
        blob: the container, starting at its magic.
        skip_encrypted: treat an encrypted chunk as empty rather than failing.
            Nothing here carries a key, so a reader that refuses them cannot
            read the files that merely contain one -- and on the vendor's own
            network that is not a rare shape: a live table can be most of a
            file by chunk count and still be short of what it declares, which
            is the one way a file read here comes back incomplete rather than
            absent. The container's chunk table states the whole decoded size,
            so the gap is measurable against what this returns.

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
class Header:
    """What a root file says about itself before its first block.

    Two headers exist and neither is tagged. The older one is the magic and
    two counts; the newer states its own length and which manifest version
    follows, and both counts move along behind it. Reading the newer at the
    older offsets is the quiet failure this separates out: every number lands
    one field early, so the walk yields file ids rather than failing.
    """

    version: int
    """Which manifest version the blocks are in. Zero for the older header,
    which predates the field and always carries version one's blocks."""

    blocks_at: int
    """Where the first block begins."""

    total: int
    """How many records the file claims, across every locale."""

    named: int
    """How many of them carry a name hash."""

    @property
    def names_every_record(self) -> bool:
        """Whether a block's no-name-hash flag is honoured at all.

        A file in which every record is named stores a name hash in every
        block, flag or no flag, and a reader that skipped those eight bytes
        per record would walk off the end of the block.
        """
        return self.total == self.named

    @classmethod
    def parse(cls, blob: bytes) -> Header:
        """Read whichever header this is.

        Args:
            blob: the decoded root file.

        Returns:
            What it says about itself.

        Raises:
            ValueError: if the blob is not a root file.
        """
        if blob[:4] != b"TSFM":
            raise ValueError(f"not a root file: {blob[:4]!r}")
        stated = struct.unpack_from("<I", blob, 4)[0]
        if stated > STATED_HEADER_MAX:
            total, named = stated, struct.unpack_from("<I", blob, 8)[0]
            return cls(version=0, blocks_at=12, total=total, named=named)
        version = struct.unpack_from("<I", blob, 8)[0]
        total, named = struct.unpack_from("<II", blob, 12)
        return cls(version=version, blocks_at=stated, total=total, named=named)


@dataclass(frozen=True)
class Root:
    """The root file: a file data id to a content key, for one locale."""

    keys: dict[int, bytes]
    """File data id to its content key."""

    blocks: int
    """How many blocks the file held. A self-check on the read."""

    header: Header
    """What the file said about itself: how many records the walk had to find,
    and which block shape it was reading them in."""

    @classmethod
    def parse(cls, blob: bytes, locale: int = LOCALE_ENUS) -> Root:
        """Walk every block, keeping the records whose locale mask matches.

        Args:
            blob: the decoded root file.
            locale: the locale mask to keep.

        Returns:
            The parsed root.

        Raises:
            ValueError: if the blob is not a root file, or the walk did not
                land on the number of records the file itself declares. That
                second test is what turns a block layout this does not know
                into a failure: a stride that is wrong by any amount keeps
                consuming bytes and yields file ids that are merely wrong,
                which is the one outcome nothing downstream can detect. It
                holds on both known services, at 2,396,959 records and
                3,255,987.
        """
        header = Header.parse(blob)
        keys: dict[int, bytes] = {}
        blocks = records = 0
        at, size = header.blocks_at, len(blob)

        while at < size:
            count, content_flags, locale_flags, at = _block(blob, at, header)
            if count == 0:
                continue
            blocks += 1
            records += count

            deltas = struct.unpack_from(f"<{count}i", blob, at)
            at += 4 * count
            content_keys = at
            at += 16 * count
            if header.names_every_record or not content_flags & NO_NAME_HASH:
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
        if records != header.total:
            raise ValueError(
                f"root manifest version {header.version} walked {records:,} "
                f"records over {blocks:,} blocks, and the file declares "
                f"{header.total:,}")
        return cls(keys=keys, blocks=blocks, header=header)


def _block(blob: bytes, at: int, header: Header) -> tuple[int, int, int, int]:
    """One block header, in whichever shape the file declared.

    Version two spends seventeen bytes where version one spent twelve: the
    locale mask moved in front, and the content flags became three fields that
    are put back together here rather than anywhere a caller can see. The two
    orders are the reason this is read through the header rather than by
    matching on what the numbers look like.

    Returns:
        The record count, the content flags, the locale mask, and where the
        block's own arrays begin.
    """
    if header.version >= 2:
        count, locale_flags, low, high, top = struct.unpack_from("<IIIIB", blob, at)
        content_flags = low | high | (top << SPLIT_FLAGS_TOP_SHIFT)
        return count, content_flags, locale_flags, at + 17
    count, content_flags, locale_flags = struct.unpack_from("<Iii", blob, at)
    return count, content_flags, locale_flags, at + 12


@dataclass(frozen=True)
class Located:
    """Where one encoded file sits inside an archive."""

    archive: str
    offset: int
    size: int


INDEX_FOOTER = 28
"""Trailing bytes of an archive index that describe how to read the rest."""


def read_index(blob: bytes) -> Iterator[tuple[bytes, int, int]]:
    """Every encoding key an archive index declares, with where its bytes are.

    The archive is not named here because an index does not name it: a reader
    over the network knows it from what it asked for, and a reader over an
    install knows it from the file's own name. That is the whole of what the
    two differ on, which is why the walk is written once.

    Args:
        blob: the index file.

    Yields:
        Each ``(encoding key, offset, size)``, skipping the zero keys that are
        a block's padding rather than a file. Nothing at all for an index that
        is not an ordinary one: only offsets four bytes wide are. Six means a
        group index, whose leading two bytes are an archive number rather than
        part of the offset, so reading it this way resolves keys to nonsense;
        zero means a loose-file index.
    """
    if len(blob) < INDEX_FOOTER:
        return
    footer = len(blob) - INDEX_FOOTER
    block_bytes = blob[footer + 11] * 1024
    offset_bytes = blob[footer + 12]
    size_bytes = blob[footer + 13]
    key_bytes = blob[footer + 14]
    entries = struct.unpack_from("<I", blob, footer + 16)[0]
    if offset_bytes != 4 or not block_bytes:
        return

    width = key_bytes + size_bytes + offset_bytes
    per_block = block_bytes // width
    read = 0
    while read < entries:
        at = (read // per_block) * block_bytes
        for _ in range(min(per_block, entries - read)):
            key = blob[at:at + key_bytes]
            size = int.from_bytes(blob[at + key_bytes:at + key_bytes + size_bytes],
                                  "big")
            offset = int.from_bytes(blob[at + key_bytes + size_bytes:at + width],
                                    "big")
            if int.from_bytes(key, "big"):
                yield key, offset, size
            at += width
            read += 1


class Storage:
    """One build's CASC, addressed by file data id.

    Everything is fetched from the service and cached on disk, so a second run
    of anything costs nothing. Construction resolves the live build, the
    encoding file and the root; opening a file resolves its keys and fetches it.

    What a first read costs is set by the encoding file, which is fetched whole
    and held in memory before any file id resolves: 141 MB compressed on the
    private service's 9.2.7, and 187 MB on the vendor's retail line at 12.1.0.
    Reading one file from a service is not a small act, and nothing here
    pretends otherwise.
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
        self.cache = cache or CACHE_DIR / "casc" / service.label
        self.cache.mkdir(parents=True, exist_ok=True)

        versions = read_bpsv(self._get_text(service.versions_url))
        row = next((r for r in versions if r.get("Region") == service.region),
                   versions[0])
        self.build = row.get("VersionsName", "")
        self.build_config_digest = row["BuildConfig"]
        self.cdn_config_digest = row["CDNConfig"]
        self.cdn = service.cdn(self._get_text)
        log(f"  {service.label}: build {self.build} on {self.cdn.host}, "
            f"config {self.build_config_digest}")

        self.build_config = read_config(self._config(self.build_config_digest))
        self.cdn_config = read_config(self._config(self.cdn_config_digest))

        # The encoding file is the one thing addressed by an encoding key
        # directly, which is what breaks the circularity: everything else is
        # named by a content key and needs this file to be resolvable at all.
        encoding_key = bytes.fromhex(self.build_config["encoding"][1])
        self.encoding = decode_blte(self._fetch(encoding_key))

        root_content_key = bytes.fromhex(self.build_config["root"][0])
        root_key = find_encoding_keys(self.encoding, {root_content_key})
        if root_content_key not in root_key:
            raise LookupError("the root's content key is not in the encoding file")
        self.root = Root.parse(
            decode_blte(self._fetch(root_key[root_content_key])), locale)
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
                    self._fetch(encoding_key))
        return out

    def _config(self, digest: str) -> str:
        """One configuration file, cached."""
        return self._get_text(self.cdn.config_url(digest), name=digest)

    def _fetch(self, encoding_key: bytes) -> bytes:
        """The raw container for one encoding key, loose or from an archive.

        A loose fetch is tried first because it costs one request against an
        index over every archive the network declares, which is the expensive
        part of this module. Which of the two is the common case is a property
        of the network rather than of the file: a private service serves most
        of its content loose, and the vendor's serves almost none of it that
        way, so on retail this is a request spent to learn that.

        Cached under the encoding key, which is what the bytes are addressed
        by. Naming the file for what was wanted instead -- the encoding table,
        the root, a file data id -- outlives the build it was fetched for, and
        every one of those names is stable while its content is not: a service
        that has since patched would answer a warm cache with the previous
        build's bytes. Content addressing also shares what did not change,
        which between two builds is nearly everything.
        """
        cached = self.cache / f"{encoding_key.hex()}.blte"
        if cached.exists() and cached.stat().st_size:
            return cached.read_bytes()
        try:
            blob = self._get(self.cdn.data_url(encoding_key.hex()))
        except urllib.error.HTTPError as exc:
            if exc.code not in NOT_SERVED:
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
        return self._get(self.cdn.data_url(found.archive),
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
        """One archive index, named for the archive it was asked for.

        Returns:
            Encoding key to where it sits in this archive; empty for an index
            that is absent or is not an ordinary one.

        Raises:
            urllib.error.HTTPError: if the network failed to answer rather than
                answering that it does not serve this. The distinction is the
                whole point: reading any error as an empty index drops that
                archive's entire contents from the map, and the files in it
                then fail as "in no archive the network declares", which is a
                statement about the network that is not true.
        """
        try:
            blob = self._get(f"{self.cdn.data_url(name)}.index",
                             name=f"{name}.index")
        except urllib.error.HTTPError as exc:
            if exc.code not in NOT_SERVED:
                raise
            return {}
        return {key: Located(name, offset, size)
                for key, offset, size in read_index(blob)}

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
