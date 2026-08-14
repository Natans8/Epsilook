"""Locating a build on a service, and reading whichever root it publishes.

Two services are known and they differ in exactly two places: where the
versions document is, and which host serves the content it names. Everything
below that is shared, so what is worth holding down here is the pair of shapes
and the root header that decides how the file after it is read.

The documents are the ones the services actually publish, trimmed to the rows
under test. Roots are built from plain values: a synthetic one states its own
wire format, which is the thing being asserted, and no service is stood up to
produce it.
"""

from __future__ import annotations

import io
import struct
import urllib.error
import urllib.request
from collections.abc import Sequence
from pathlib import Path

import pytest

from pack.sources.casc import (EPSILON, RETAIL, Blizzard, Cdn, Header, Root,
                               SelfHosted, Storage)

LOCALE_ENUS = 0x2
LOCALE_KOKR = 0x4

NO_NAME_HASH = 0x10000000

DIGEST = "bd275481f39b6f0d5fde63de0720e302"

CDNS = (
    "Name!STRING:0|Path!STRING:0|Hosts!STRING:0|ConfigPath!STRING:0\n"
    "## seqn = 3518786\n"
    "us|tpr/wow|level3.blizzard.com us.cdn.blizzard.com|tpr/configs/data\n"
    "eu|tpr/wow|level3.blizzard.com|tpr/configs/data\n"
)
"""The vendor's own document, as published. Its rows are keyed `Name`, where
the versions document beside it keys them `Region`."""


def refuses(url: str) -> str:
    """A reader that fails the test if a service asks it for anything."""
    raise AssertionError(f"asked for {url}")


def canned(**bodies: str):
    """A reader answering the given addresses and nothing else."""

    def read(url: str) -> str:
        assert url in bodies, url
        return bodies[url]

    return read


def deltas(fids: Sequence[int]) -> list[int]:
    """The gaps a root stores, given the ids it means."""
    out, previous = [], -1
    for fid in fids:
        out.append(fid - previous - 1)
        previous = fid
    return out


def key(number: int) -> bytes:
    """One content key, distinguishable from another."""
    return bytes([number]) * 16


def arrays(fids: Sequence[int], *, names: bool) -> bytes:
    """A block's three arrays: the id gaps, the keys, and the name hashes."""
    body = struct.pack(f"<{len(fids)}i", *deltas(fids))
    body += b"".join(key(fid) for fid in fids)
    if names:
        body += b"\0" * (8 * len(fids))
    return body


def block_v1(fids: Sequence[int], *, flags: int = 0, locale: int = LOCALE_ENUS,
             names: bool = True) -> bytes:
    """One block in the older shape: content flags, then the locale mask."""
    return struct.pack("<III", len(fids), flags, locale) + arrays(fids, names=names)


def block_v2(fids: Sequence[int], *, low: int = 0, high: int = 0, top: int = 0,
             locale: int = LOCALE_ENUS, names: bool = True) -> bytes:
    """One block in the newer shape: the locale mask first, then three fields
    where the older one had a single content flags word."""
    return (struct.pack("<IIIIB", len(fids), locale, low, high, top)
            + arrays(fids, names=names))


TOTAL = 4000000
NAMED = 3000000
"""What a root counts. Stated in the millions because that is what separates
the two headers: the older one puts a file count where the newer one puts its
own length."""


def root_v1(*blocks: bytes, total: int = TOTAL, named: int = NAMED) -> bytes:
    """A root whose header is the magic and two counts."""
    return b"TSFM" + struct.pack("<II", total, named) + b"".join(blocks)


def root_v2(*blocks: bytes, version: int = 2, total: int = TOTAL,
            named: int = NAMED) -> bytes:
    """A root whose header states its own length and its manifest version."""
    return (b"TSFM" + struct.pack("<IIIII", 24, version, total, named, 0)
            + b"".join(blocks))


def test_config_url_is_not_the_path_the_document_advertises() -> None:
    """Both services advertise one config path and serve another."""
    cdn = Cdn("level3.blizzard.com")
    assert cdn.config_url(DIGEST) == (
        f"http://level3.blizzard.com/tpr/wow/config/bd/27/{DIGEST}")
    assert "tpr/configs/data" not in cdn.config_url(DIGEST)


def test_data_url_shards_on_the_first_two_byte_pairs() -> None:
    assert Cdn("host", "tpr/wow").data_url("55921441") == (
        "http://host/tpr/wow/data/55/92/55921441")


def test_a_self_hosted_service_answers_for_its_own_content() -> None:
    """No document is read: the service and the network are one host."""
    assert EPSILON.cdn(refuses) == Cdn("tact.epsilonwow.net", "tpr/wow")
    assert EPSILON.versions_url == "http://tact.epsilonwow.net/wow/versions"
    assert EPSILON.label == "tact.epsilonwow.net"


def test_a_self_hosted_service_keeps_its_product_in_the_versions_url() -> None:
    service = SelfHosted(host="tact.example.invalid", product="wow_classic")
    assert service.versions_url == (
        "http://tact.example.invalid/wow_classic/versions")


def test_the_vendor_publishes_versions_on_the_version_service() -> None:
    assert RETAIL.versions_url == (
        "https://eu.version.battle.net/v2/products/wow/versions")
    assert RETAIL.cdns_url == (
        "https://eu.version.battle.net/v2/products/wow/cdns")


def test_the_vendor_label_names_the_product() -> None:
    """One host serves every line, so the host cannot name the cache."""
    assert RETAIL.label == "blizzard-wow"
    assert Blizzard(product="wow_classic").label == "blizzard-wow_classic"


def test_the_vendor_takes_the_region_row_and_its_first_host() -> None:
    cdn = RETAIL.cdn(canned(**{RETAIL.cdns_url: CDNS}))
    assert cdn == Cdn("level3.blizzard.com", "tpr/wow")


def test_a_region_naming_several_hosts_takes_the_first() -> None:
    service = Blizzard(region="us")
    assert service.cdn(canned(**{service.cdns_url: CDNS})).host == (
        "level3.blizzard.com")


def test_an_unpublished_region_falls_back_to_the_first_row() -> None:
    service = Blizzard(region="xx")
    assert service.cdn(canned(**{service.cdns_url: CDNS})).host == (
        "level3.blizzard.com")


def test_a_document_naming_no_host_is_an_error() -> None:
    empty = "Name!STRING:0|Path!STRING:0|Hosts!STRING:0\neu|tpr/wow|\n"
    with pytest.raises(LookupError):
        RETAIL.cdn(canned(**{RETAIL.cdns_url: empty}))


def test_the_older_header_carries_counts_where_the_newer_carries_a_size() -> None:
    header = Header.parse(root_v1())
    assert (header.version, header.blocks_at) == (0, 12)
    assert (header.total, header.named) == (TOTAL, NAMED)


def test_the_newer_header_states_its_own_length_and_version() -> None:
    header = Header.parse(root_v2())
    assert (header.version, header.blocks_at) == (2, 24)
    assert (header.total, header.named) == (TOTAL, NAMED)


def test_anything_else_is_not_a_root_file() -> None:
    with pytest.raises(ValueError):
        Header.parse(b"MFST" + b"\0" * 32)


def test_only_the_wanted_locale_is_kept() -> None:
    root = Root.parse(root_v1(block_v1([5, 6, 9]),
                              block_v1([5, 6], locale=LOCALE_KOKR)))
    assert sorted(root.keys) == [5, 6, 9]
    assert (root.blocks, root.records) == (2, 5)


def test_a_flagged_block_is_eight_bytes_narrower_per_record() -> None:
    """The stride is what the next block's ids depend on, so a second block
    reading correctly is the assertion."""
    root = Root.parse(root_v1(block_v1([1, 2], flags=NO_NAME_HASH, names=False),
                              block_v1([40, 41])))
    assert sorted(root.keys) == [1, 2, 40, 41]
    assert root.keys[40] == key(40)


def test_a_root_naming_every_record_keeps_the_name_hashes() -> None:
    """The flag is not honoured where the header says nothing is unnamed, and
    a reader that skipped those bytes anyway would misread what follows."""
    root = Root.parse(root_v1(block_v1([1, 2], flags=NO_NAME_HASH),
                              block_v1([40, 41]),
                              total=TOTAL, named=TOTAL))
    assert sorted(root.keys) == [1, 2, 40, 41]
    assert root.keys[40] == key(40)


def test_the_newer_block_puts_the_locale_first() -> None:
    root = Root.parse(root_v2(block_v2([5, 6, 9]),
                              block_v2([70], locale=LOCALE_KOKR)))
    assert sorted(root.keys) == [5, 6, 9]
    assert root.header.version == 2
    assert (root.blocks, root.records) == (2, 4)


def test_the_newer_block_splits_the_content_flags_across_three_fields() -> None:
    """The flag reaches the stride from the second field, and the third is
    shifted into place rather than read where it sits."""
    root = Root.parse(root_v2(block_v2([1, 2], high=NO_NAME_HASH, top=0x1,
                                       names=False),
                              block_v2([40, 41])))
    assert sorted(root.keys) == [1, 2, 40, 41]
    assert root.keys[40] == key(40)


# The whole chain, over a service that exists only here. What it is for is the
# one difference a real read found: a network that will not say whether an
# object exists answers a loose miss 403, and the archive route is reached
# through that answer.

PAGE = 4096
"""The page and block size the synthetic tables below are written in."""

FID = 7
"""The one file the fake service carries, reachable only from an archive."""


def blte(payload: bytes) -> bytes:
    """The smallest container: no chunk table, one uncompressed chunk."""
    return b"BLTE" + struct.pack(">I", 0) + b"N" + payload


def encoding_file(pairs: dict[bytes, bytes]) -> bytes:
    """An encoding table of one page, mapping each content key to one
    encoding key."""
    page = b"".join(bytes([1]) + b"\0" * 5 + content + encoding
                    for content, encoding in pairs.items())
    header = (b"EN" + bytes([1, 16, 16]) + struct.pack(">HH", PAGE // 1024, 4)
              + struct.pack(">II", 1, 0) + bytes([0]) + struct.pack(">I", 0))
    return header + b"\0" * 32 + page.ljust(PAGE, b"\0")


def archive_index(located: dict[bytes, tuple[int, int]]) -> bytes:
    """An ordinary archive index: one block of entries, then the footer that
    says how to read it."""
    block = b"".join(ekey + size.to_bytes(4, "big") + offset.to_bytes(4, "big")
                     for ekey, (offset, size) in located.items())
    footer = bytearray(28)
    footer[11] = PAGE // 1024
    footer[12] = 4
    footer[13] = 4
    footer[14] = 16
    footer[16:20] = struct.pack("<I", len(located))
    return block.ljust(PAGE, b"\0") + bytes(footer)


PAYLOAD = b"the file's own bytes"
AT = 64
"""Where the file sits inside its archive, so a whole-archive read would
return something other than the file."""


class FakeNetwork:
    """The addresses a service publishes, and nothing else.

    An address it does not carry answers 403 rather than 404, which is what
    the vendor's own network does and what the loose-then-archive fallback
    has to read as a miss.
    """

    def __init__(self, bodies: dict[str, bytes]) -> None:
        self.bodies = bodies
        self.asked: list[tuple[str, str]] = []
        """Each request as its address and the range it wanted, if any."""

    def open(self, request: urllib.request.Request,
             timeout: float | None = None) -> io.BytesIO:
        wanted = request.headers.get("Range", "")
        self.asked.append((request.full_url, wanted))
        body = self.bodies.get(request.full_url)
        if body is None:
            raise urllib.error.HTTPError(request.full_url, 403, "Forbidden",
                                         None, None)  # type: ignore[arg-type]
        if wanted:
            first, last = wanted.removeprefix("bytes=").split("-")
            body = body[int(first):int(last) + 1]
        return io.BytesIO(body)


@pytest.fixture(name="network")
def _network(monkeypatch: pytest.MonkeyPatch) -> FakeNetwork:
    """A whole build, published where a `Blizzard` service would look for it.

    Its one file sits inside an archive rather than loose, which is the shape
    of nearly everything on the vendor's network, and the root names it by the
    content key `block_v1` writes for that id.
    """
    build, cdn_config, archive = "aa" * 16, "cc" * 16, "ab" * 16
    encoding_key, root_content, root_key = key(1), key(2), key(3)
    file_content, file_key = key(FID), key(4)
    contained = blte(PAYLOAD)
    cdn = Cdn("cdn.example.invalid")

    network = FakeNetwork({
        RETAIL.versions_url:
            "Region!STRING:0|BuildConfig!HEX:16|CDNConfig!HEX:16|"
            "VersionsName!String:0\n"
            f"us|{'ff' * 16}|{cdn_config}|9.9.9.9\n"
            f"eu|{build}|{cdn_config}|1.0.0.1\n".encode(),
        RETAIL.cdns_url:
            "Name!STRING:0|Path!STRING:0|Hosts!STRING:0\n"
            f"eu|{cdn.path}|{cdn.host}\n".encode(),
        cdn.config_url(build):
            f"root = {root_content.hex()}\n"
            f"encoding = {'00' * 16} {encoding_key.hex()}\n".encode(),
        cdn.config_url(cdn_config): f"archives = {archive}\n".encode(),
        cdn.data_url(encoding_key.hex()): blte(encoding_file({
            root_content: root_key, file_content: file_key})),
        cdn.data_url(root_key.hex()): blte(root_v1(block_v1([FID]))),
        f"{cdn.data_url(archive)}.index":
            archive_index({file_key: (AT, len(contained))}),
        cdn.data_url(archive): b"\0" * AT + contained,
    })
    monkeypatch.setattr(urllib.request, "urlopen", network.open)
    return network


def test_the_whole_chain_reaches_a_file_the_archive_holds(
        network: FakeNetwork, tmp_path: Path) -> None:
    """Versions, the region's row, the network, both configs, the encoding
    table, the root, and one file that is not served loose."""
    storage = Storage(RETAIL, cache=tmp_path / "cache")
    assert (storage.build, storage.cdn) == ("1.0.0.1", Cdn("cdn.example.invalid"))
    assert storage.open(FID) == PAYLOAD


def test_a_loose_miss_answered_403_still_reaches_the_archive(
        network: FakeNetwork, tmp_path: Path) -> None:
    """A reader keyed on 404 alone raises here rather than falling through,
    and on a network that archives almost everything that is every file."""
    storage = Storage(RETAIL, cache=tmp_path / "cache")
    storage.open(FID)
    refused = Cdn("cdn.example.invalid").data_url(key(4).hex())
    assert (refused, "") in network.asked
    assert any(url.endswith(".index") for url, _ in network.asked)


def test_the_archive_is_read_by_range_rather_than_whole(
        network: FakeNetwork, tmp_path: Path) -> None:
    storage = Storage(RETAIL, cache=tmp_path / "cache")
    storage.open(FID)
    archive = Cdn("cdn.example.invalid").data_url("ab" * 16)
    ranges = [wanted for url, wanted in network.asked if url == archive]
    assert ranges == [f"bytes={AT}-{AT + len(blte(PAYLOAD)) - 1}"]


def test_a_second_open_asks_the_network_for_nothing(
        network: FakeNetwork, tmp_path: Path) -> None:
    """Every fetched blob is cached under the service's own label, so the
    second run of anything costs nothing."""
    cache = tmp_path / "cache"
    Storage(RETAIL, cache=cache).open(FID)
    network.asked.clear()
    assert Storage(RETAIL, cache=cache).open(FID) == PAYLOAD
    assert [url for url, _ in network.asked] == [RETAIL.versions_url,
                                                 RETAIL.cdns_url]
