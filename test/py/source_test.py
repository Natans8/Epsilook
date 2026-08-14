"""The contract every source and every fetch policy must satisfy.

Parametrised over the implementations; each case is a semantic something above
this layer depends on. What a source is -- located, gotten, turned into rows --
is stated in `pack.sources.source`, and this is where the statement is held to.

The network is a dictionary here rather than a stand-in for one policy or
another, so each policy is exercised as written: the difference between them
is exactly which requests they make, and a fake at a higher seam would be
asserting the fake instead.
"""

from __future__ import annotations

import email.message
import io
import json
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from pack.sources.cache import Pinned, Revalidated, Volatile, tracked_source
from pack.sources.listfile import LISTFILE_ASSET, latest_release
from pack.sources.source import (Extracted, Fetch, Fetched, Gathered, Origin,
                                 Source)
from pack.sources.tdb import TDB_TABLES, Distill

BODY = b"ID,Name\n1,Fireball\n"

ASSET = "https://example.invalid/asset.csv"
RELEASES = "https://example.invalid/releases/latest"


@dataclass
class Network:
    """The network, as addresses mapped to bodies.

    Installed over `urllib.request.urlopen`, which every fetch policy reaches
    through. An address it does not carry answers 404, which is how a build
    that predates a table finds out.
    """

    bodies: dict[str, bytes] = field(default_factory=dict)

    asked: Counter[str] = field(default_factory=Counter)
    """One count per request made, so a policy that should not have made one
    can be caught doing it."""

    def open(self, request: urllib.request.Request, timeout: float | None = None
             ) -> io.BytesIO:
        """Stand in for `urlopen`: bytes, as a context manager."""
        address = request.full_url
        self.asked[address] += 1
        body = self.bodies.get(address)
        if body is None:
            raise urllib.error.HTTPError(address, 404, "Not Found",
                                         email.message.Message(), None)
        return io.BytesIO(body)


@pytest.fixture(name="network")
def _network(monkeypatch: pytest.MonkeyPatch) -> Network:
    served = Network()
    monkeypatch.setattr(urllib.request, "urlopen", served.open)
    return served


# The `Source` contract.


@dataclass
class Copied:
    """A fetch standing in for a network: it has the bytes, or it does not.

    Enough of a policy for the source contract, which is about what a source
    does with a fetch rather than about which fetch it was handed.
    """

    bodies: dict[str, bytes]
    work: list[str]

    refreshes: list[bool] = field(default_factory=list)
    """The flag each call was made with, for the cases about what reaches it."""

    def get(self, origin: Origin, dest: Path, refresh: bool) -> bool:
        if origin.address not in self.bodies:
            return False
        self.refreshes.append(refresh)
        self.work.append(f"get {origin.address}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(self.bodies[origin.address])
        return True


@dataclass
class Rows:
    """An extraction standing in for one that parses a real format."""

    work: list[str]

    def complete(self, into: Path) -> bool:
        return (into / "rows.csv").exists()

    def run(self, located: Path, into: Path) -> None:
        self.work.append(f"extract {located.name}")
        (into / "rows.csv").write_bytes(located.read_bytes())


@dataclass
class Built:
    """One `Source` implementation, wired so the contract can be checked."""

    source: Source

    landing: Path
    """What `acquire` must return while the source is there."""

    work: list[str]
    """One entry per unit of work done, appended by the stand-ins above."""


def _fetched(tmp_path: Path, present: bool) -> Built:
    """A source that is its bytes: one table export."""
    work: list[str] = []
    dest = tmp_path / "cache" / "Spell.csv"
    fetch = Copied({"spell": BODY} if present else {}, work)
    return Built(Fetched(name="one table", origin=Origin("spell"), dest=dest,
                         fetch=fetch), dest, work)


def _gathered(tmp_path: Path, present: bool) -> Built:
    """Several sources landing in one directory: a build's table exports."""
    work: list[str] = []
    into = tmp_path / "cache" / "9.9.9.99999"
    bodies = {"spell": BODY, "visual": BODY} if present else {}
    parts = [Fetched(name=table, origin=Origin(address),
                     dest=into / f"{table}.csv", fetch=Copied(bodies, work))
             for table, address in (("Spell", "spell"), ("SpellVisual", "visual"))]
    return Built(Gathered(name="a build's tables", into=into, parts=parts),
                 into, work)


def _extracted(tmp_path: Path, present: bool) -> Built:
    """A source whose bytes become rows: an archive, distilled."""
    work: list[str] = []
    into = tmp_path / "cache" / "release"
    archive = Fetched(name="the archive", origin=Origin("dump"),
                      dest=tmp_path / "cache" / "dump.7z",
                      fetch=Copied({"dump": BODY} if present else {}, work))
    return Built(Extracted(name="a distilled release", inner=archive,
                           extract=Rows(work), into=into), into, work)


SOURCES: list[tuple[str, Callable[[Path, bool], Built]]] = [
    ("Fetched", _fetched),
    ("Gathered", _gathered),
    ("Extracted", _extracted),
]


@pytest.fixture(name="build", params=[f for _, f in SOURCES],
                ids=[n for n, _ in SOURCES])
def _build(request: pytest.FixtureRequest) -> Callable[[Path, bool], Built]:
    return request.param


def test_acquiring_yields_a_path_that_is_there(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """A path a provider is about to open, so a path that exists."""
    built = build(tmp_path, True)
    assert built.source.acquire(False) == built.landing
    assert built.landing.exists()


def test_acquiring_twice_yields_the_same_path(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """Where a source lands follows from what it is, not from when it ran."""
    built = build(tmp_path, True)
    assert built.source.acquire(False) == built.source.acquire(False)


def test_acquiring_twice_leaves_the_same_bytes(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """A second build over a warm cache is the ordinary case, and it must not
    be the one that produces a different pack."""
    built = build(tmp_path, True)
    built.source.acquire(False)
    before = sorted((p.name, p.read_bytes()) for p in _files(built.landing))
    built.source.acquire(False)
    assert sorted((p.name, p.read_bytes()) for p in _files(built.landing)) == before


def test_an_absent_source_yields_none(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """How a build that predates a source reports it, with no per-version
    branch above this layer."""
    assert build(tmp_path, False).source.acquire(False) is None


def test_an_absent_source_leaves_nothing_behind(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """The one outcome worth being careful about: an empty artifact a later
    run finds and takes for a complete one."""
    built = build(tmp_path, False)
    built.source.acquire(False)
    assert not built.landing.exists()


def test_origins_are_named_without_acquiring_anything(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """What lets a build say what it reads on a machine with no network."""
    built = build(tmp_path, True)
    assert [origin.describe() for origin in built.source.origins()]
    assert built.work == []
    assert not built.landing.exists()


def test_refreshing_still_yields_the_landing(
        build: Callable[[Path, bool], Built], tmp_path: Path) -> None:
    """Refresh may reach nothing in a given source, but it may never cost that
    source its bytes: one flag reaches all of them."""
    built = build(tmp_path, True)
    built.source.acquire(False)
    assert built.source.acquire(True) == built.landing
    assert built.landing.exists()


def _files(landing: Path) -> list[Path]:
    """Everything a source left, whether it landed as a file or a directory."""
    if not landing.exists():
        return []
    return sorted(landing.rglob("*")) if landing.is_dir() else [landing]


def test_a_cached_extraction_does_not_reach_for_its_bytes(tmp_path: Path) -> None:
    """The reason completeness is on the interface rather than inside each
    extraction: for an archive, the bytes are a download somebody would
    otherwise pay for on every build."""
    built = _extracted(tmp_path, True)
    built.source.acquire(False)
    built.work.clear()
    assert built.source.acquire(False) == built.landing
    assert built.work == []


def test_a_refresh_does_not_override_a_completeness_test(tmp_path: Path) -> None:
    """The test compares what the cache holds against what would be written,
    exactly, so a cache that passes it is one no re-run could improve.
    Overriding it would re-scan a solid archive -- and where that archive was
    since pruned, fetch it again -- to arrive at the same rows."""
    built = _extracted(tmp_path, True)
    built.source.acquire(False)
    built.work.clear()
    assert built.source.acquire(True) == built.landing
    assert built.work == []


def test_a_refresh_does_not_reach_the_bytes_under_an_extraction(
        tmp_path: Path) -> None:
    """Refresh answers "the rows may be wrong", which re-running the extraction
    is what settles. The bytes below it have their own policy and it already
    knows whether they moved: an archive published against a fixed release is
    the same file however often it is asked for, so forwarding the flag would
    re-transfer hundreds of megabytes to arrive at what is already there."""
    work: list[str] = []
    fetch = Copied({"dump": BODY}, work)
    into = tmp_path / "cache" / "release"
    archive = Fetched(name="the archive", origin=Origin("dump"),
                      dest=tmp_path / "cache" / "dump.7z", fetch=fetch)
    source = Extracted(name="a distilled release", inner=archive,
                       extract=Rows(work), into=into)
    source.acquire(False)
    (into / "rows.csv").unlink()
    source.acquire(True)
    assert fetch.refreshes == [False, False]


def test_an_incomplete_extraction_is_redone(tmp_path: Path) -> None:
    """The other half: what refresh does not need to force, an incomplete
    cache asks for on its own."""
    built = _extracted(tmp_path, True)
    built.source.acquire(False)
    (built.landing / "rows.csv").unlink()
    built.work.clear()
    assert built.source.acquire(False) == built.landing
    assert "extract dump.7z" in built.work


def test_a_gathered_source_survives_a_part_this_build_predates(
        tmp_path: Path) -> None:
    """Optionality is per file: a table added after this client shipped is
    absent on its own, and the directory is still the source."""
    work: list[str] = []
    into = tmp_path / "cache" / "old"
    parts = [Fetched(name="Spell", origin=Origin("spell"), dest=into / "Spell.csv",
                     fetch=Copied({"spell": BODY}, work)),
             Fetched(name="UiMap", origin=Origin("uimap"), dest=into / "UiMap.csv",
                     fetch=Copied({}, work))]
    assert Gathered(name="tables", into=into, parts=parts).acquire(False) == into
    assert not (into / "UiMap.csv").exists()


# The `Fetch` contract.


@dataclass
class Wired:
    """One fetch policy, with somewhere for its bytes to come from."""

    fetch: Fetch
    origin: Origin
    dest: Path


def _pinned(tmp_path: Path, network: Network) -> Wired:
    network.bodies[ASSET] = BODY
    return Wired(Pinned(), Origin(ASSET), tmp_path / "cache" / "Spell.csv")


def _volatile(tmp_path: Path, network: Network) -> Wired:
    network.bodies[ASSET] = BODY
    return Wired(Volatile(), Origin(ASSET), tmp_path / "cache" / "names.dbde")


def _tracked(tmp_path: Path, network: Network) -> Wired:
    dest = tmp_path / "vendored" / "supplement.csv.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(BODY)
    source = tracked_source("a vendored file", dest)
    return Wired(source.fetch, source.origin, source.dest)


def _revalidated(tmp_path: Path, network: Network) -> Wired:
    network.bodies[ASSET] = BODY
    return Wired(Revalidated(resolve=lambda address: ("v1", ASSET),
                             token_file=tmp_path / "cache" / "token.txt"),
                 Origin(RELEASES, "the one asset that matters"),
                 tmp_path / "cache" / "listfile.csv")


POLICIES: list[tuple[str, Callable[[Path, Network], Wired]]] = [
    ("Pinned", _pinned),
    ("Volatile", _volatile),
    ("Tracked", _tracked),
    ("Revalidated", _revalidated),
]


@pytest.fixture(name="policy", params=[f for _, f in POLICIES],
                ids=[n for n, _ in POLICIES])
def _policy(request: pytest.FixtureRequest, tmp_path: Path,
            network: Network) -> Wired:
    return request.param(tmp_path, network)


def test_getting_puts_the_bytes_where_the_source_will_be_read(
        policy: Wired) -> None:
    assert policy.fetch.get(policy.origin, policy.dest, False)
    assert policy.dest.read_bytes() == BODY


def test_getting_again_leaves_the_same_bytes(policy: Wired) -> None:
    """Whether a policy refetches is its own business; what it leaves is not."""
    policy.fetch.get(policy.origin, policy.dest, False)
    assert policy.fetch.get(policy.origin, policy.dest, False)
    assert policy.dest.read_bytes() == BODY


def test_refreshing_leaves_the_bytes(policy: Wired) -> None:
    """Refresh may mean nothing to a policy, but it may never cost it its
    bytes: every caller above passes the same flag to all of them."""
    policy.fetch.get(policy.origin, policy.dest, False)
    assert policy.fetch.get(policy.origin, policy.dest, True)
    assert policy.dest.read_bytes() == BODY


def test_a_pinned_source_is_fetched_once(tmp_path: Path,
                                         network: Network) -> None:
    """An export of a client already released cannot change, so the second
    build reads the cache."""
    wired = _pinned(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    wired.fetch.get(wired.origin, wired.dest, False)
    assert network.asked[ASSET] == 1


def test_a_pinned_source_this_build_predates_is_absent(
        tmp_path: Path, network: Network) -> None:
    """A 404 on a declared-optional table is the build saying it predates it."""
    wired = _pinned(tmp_path, network)
    network.bodies.clear()
    assert not Pinned(optional=True).get(wired.origin, wired.dest, False)
    assert not wired.dest.exists()


def test_a_pinned_source_that_vanishes_takes_its_stale_copy_with_it(
        tmp_path: Path, network: Network) -> None:
    """Otherwise a table dropped upstream keeps being packed out of the cache,
    from whichever build last had it."""
    wired = _pinned(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    network.bodies.clear()
    assert not Pinned(optional=True).get(wired.origin, wired.dest, True)
    assert not wired.dest.exists()


def test_a_pinned_source_that_is_not_optional_raises_on_a_404(
        tmp_path: Path, network: Network) -> None:
    """Undeclared absence is the failure worth stopping for: it is a table
    nothing knew could be missing."""
    wired = _pinned(tmp_path, network)
    network.bodies.clear()
    with pytest.raises(urllib.error.HTTPError):
        wired.fetch.get(wired.origin, wired.dest, False)


def test_a_volatile_source_is_fetched_every_build(tmp_path: Path,
                                                  network: Network) -> None:
    """The whole difference from pinned: these lists keep being corrected for
    game builds that shipped years ago."""
    wired = _volatile(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    wired.fetch.get(wired.origin, wired.dest, False)
    assert network.asked[ASSET] == 2


def test_a_volatile_source_falls_back_to_the_copy_it_has(
        tmp_path: Path, network: Network) -> None:
    """A correction nobody can reach is not a reason to stop building."""
    wired = _volatile(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    network.bodies.clear()
    assert wired.fetch.get(wired.origin, wired.dest, False)
    assert wired.dest.read_bytes() == BODY


def test_a_volatile_source_with_nothing_cached_raises(
        tmp_path: Path, network: Network) -> None:
    wired = _volatile(tmp_path, network)
    network.bodies.clear()
    with pytest.raises(urllib.error.HTTPError):
        wired.fetch.get(wired.origin, wired.dest, False)


def test_a_tracked_source_makes_no_request(tmp_path: Path,
                                           network: Network) -> None:
    """It is in the checkout; there is nowhere to ask."""
    wired = _tracked(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, True)
    assert not network.asked


def test_a_tracked_source_that_is_missing_exits(tmp_path: Path,
                                                network: Network) -> None:
    """Named where it is missing from, rather than found later as whichever
    route came up short."""
    wired = _tracked(tmp_path, network)
    wired.dest.unlink()
    with pytest.raises(SystemExit):
        wired.fetch.get(wired.origin, wired.dest, False)


def test_a_revalidated_source_is_not_refetched_while_the_token_stands(
        tmp_path: Path, network: Network) -> None:
    """The point of the oracle: one small request against a body of a hundred
    megabytes."""
    wired = _revalidated(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    wired.fetch.get(wired.origin, wired.dest, False)
    assert network.asked[ASSET] == 1


def test_a_revalidated_source_is_refetched_once_the_token_moves(
        tmp_path: Path, network: Network) -> None:
    """A file id with no name last month may have one today, and the token is
    how that becomes visible."""
    wired = _revalidated(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    moved = Revalidated(resolve=lambda address: ("v2", ASSET),
                        token_file=tmp_path / "cache" / "token.txt")
    moved.get(wired.origin, wired.dest, False)
    assert network.asked[ASSET] == 2


def test_a_revalidated_source_refetches_a_body_that_came_back_empty(
        tmp_path: Path, network: Network) -> None:
    """The body is written before its token, so a response carrying nothing
    leaves a file that exists beside a token saying it is current. On the token
    alone that agrees with the oracle forever, and the listfile ships empty:
    every asset path in the pack silently missing, with nothing failing."""
    wired = _revalidated(tmp_path, network)
    network.bodies[ASSET] = b""
    wired.fetch.get(wired.origin, wired.dest, False)
    network.bodies[ASSET] = BODY
    assert wired.fetch.get(wired.origin, wired.dest, False)
    assert wired.dest.read_bytes() == BODY


def test_a_revalidated_source_with_an_empty_body_does_not_stand_in_for_one(
        tmp_path: Path, network: Network) -> None:
    """And an unreachable oracle over that same empty file is fatal, because
    there is no cached copy to fall back to."""
    wired = _revalidated(tmp_path, network)
    network.bodies[ASSET] = b""
    wired.fetch.get(wired.origin, wired.dest, False)
    stuck = Revalidated(resolve=_unreachable,
                        token_file=tmp_path / "cache" / "token.txt")
    with pytest.raises(OSError):
        stuck.get(wired.origin, wired.dest, False)


def test_a_revalidated_source_falls_back_to_the_copy_it_has(
        tmp_path: Path, network: Network) -> None:
    """Behind by a release is not a reason to stop building over a source that
    only ever grows."""
    wired = _revalidated(tmp_path, network)
    wired.fetch.get(wired.origin, wired.dest, False)
    stuck = Revalidated(resolve=_unreachable,
                        token_file=tmp_path / "cache" / "token.txt")
    assert stuck.get(wired.origin, wired.dest, False)
    assert wired.dest.read_bytes() == BODY


def test_a_revalidated_source_with_nothing_cached_raises(
        tmp_path: Path, network: Network) -> None:
    """With no copy there is nothing to be behind, so the failure is the
    answer."""
    wired = _revalidated(tmp_path, network)
    stuck = Revalidated(resolve=_unreachable,
                        token_file=tmp_path / "cache" / "token.txt")
    with pytest.raises(OSError):
        stuck.get(wired.origin, wired.dest, False)


def _unreachable(address: str) -> tuple[str, str]:
    """An oracle that cannot be reached."""
    raise OSError(f"nothing answers at {address}")


# What an origin says, and what one extraction makes of a directory.


def test_an_origin_names_its_address() -> None:
    assert Origin(ASSET).describe() == ASSET


def test_an_origin_names_what_is_taken_from_the_address() -> None:
    """A release and a storage both publish many things at one address, and
    which one a build reads is half of where it comes from."""
    assert Origin(RELEASES, "the listfile asset").describe() == (
        f"{RELEASES} (the listfile asset)")


def test_a_tracked_source_states_its_path_once() -> None:
    """Its address and its destination are one path, and the check reports on
    what it tested only while they cannot drift apart."""
    source = tracked_source("a vendored file", Path("vendored") / "thing.gz")
    assert source.origin.address == str(source.dest)


# The oracle a revalidated fetch asks. Its three failure shapes are what
# `Revalidated` keys its fallback on, so they are pinned here rather than
# through the policy, which is handed a stand-in.


def _release(tag: str, assets: dict[str, str]) -> bytes:
    """A releases document, as the endpoint publishes one."""
    return json.dumps({"tag_name": tag,
                       "assets": [{"name": name, "browser_download_url": url}
                                  for name, url in assets.items()]}).encode()


def test_the_oracle_reads_the_tag_and_the_asset_url(network: Network) -> None:
    network.bodies[RELEASES] = _release("202608131431", {LISTFILE_ASSET: ASSET})
    assert latest_release(RELEASES) == ("202608131431", ASSET)


def test_a_release_carrying_no_listfile_is_not_an_unreachable_one(
        network: Network) -> None:
    """Told apart on purpose. Both landing in one message would leave the build
    running on a cached listfile forever while reporting something nobody can
    act on, so this one names what the release does carry."""
    network.bodies[RELEASES] = _release("v9", {"something-else.csv": ASSET})
    with pytest.raises(LookupError, match="something-else.csv"):
        latest_release(RELEASES)


def test_an_unreachable_endpoint_raises_an_os_error(network: Network) -> None:
    """Which is the shape the fallback to a cached copy is keyed on."""
    with pytest.raises(OSError):
        latest_release(RELEASES)


def test_a_body_that_is_not_the_document_raises_a_value_error(
        network: Network) -> None:
    """A proxy or a captive portal answers with a page, not with a failure."""
    network.bodies[RELEASES] = b"<html>sign in to continue</html>"
    with pytest.raises(ValueError):
        latest_release(RELEASES)


def _distilled(into: Path, want: dict[str, list[str]]) -> None:
    """Write out what a distillation of these tables would leave."""
    into.mkdir(parents=True, exist_ok=True)
    for table, columns in want.items():
        (into / f"{table}.csv").write_text(",".join(columns) + "\n",
                                           encoding="utf-8", newline="")


def test_a_distillation_is_complete_only_with_every_column_it_declares(
        tmp_path: Path) -> None:
    """Existence is not the test: a column added to the roster leaves every
    cached release looking finished and quietly missing it."""
    distill = Distill(kinds=("hotfixes",), members={"hotfixes": "dump.sql"})
    _distilled(tmp_path, distill.wanted())
    assert distill.complete(tmp_path)

    table = next(iter(distill.wanted()))
    _distilled(tmp_path, {table: distill.wanted()[table][:-1]})
    assert not distill.complete(tmp_path)


def test_a_world_only_release_is_complete_without_the_hotfix_tables(
        tmp_path: Path) -> None:
    """The 3.3.5 branch ships one dump, and wanting the other would leave it
    permanently undistilled."""
    distill = Distill(kinds=("world",), members={"world": "dump.sql"})
    assert set(distill.wanted()) == set(TDB_TABLES["world"])
    _distilled(tmp_path, distill.wanted())
    assert distill.complete(tmp_path)


def test_a_distillation_asked_for_other_tables_answers_on_those(
        tmp_path: Path) -> None:
    """One archive is scanned for more than one set of tables: the pack's, and
    the `*_locale` tables a language overlay reads out of the same world dump.
    The roster being a field is what gives the second one the same header test
    as the first, rather than a check of its own that column edits slip past."""
    locale = {"world": {"creature_template_locale": ["entry", "locale", "Name"]}}
    distill = Distill(kinds=("world",), members={"world": "dump.sql"},
                      want=locale, required=frozenset())
    assert distill.wanted() == locale["world"]

    _distilled(tmp_path, distill.wanted())
    assert distill.complete(tmp_path)

    _distilled(tmp_path, {"creature_template_locale": ["entry", "locale"]})
    assert not distill.complete(tmp_path)
