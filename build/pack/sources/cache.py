"""The download cache, and the policies a source is fetched into it under.

The policies differ on whether the source can change under a build that
already shipped: a version-pinned table cannot, a community-maintained list
can, and a file tracked in this repository is not fetched at all.
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..progress import log
from .source import Fetched, Origin, Part, each

BUILD_DIR = Path(__file__).resolve().parents[2]
"""The build's own directory: where its checked-in sources live, tracked."""

CACHE_DIR = BUILD_DIR.parent / ".cache"
"""Where every downloaded source lands, and the only directory the build writes.

Declared again in ``tools/repo.py``, for the scripts that run on a different
path root. ``check_cache_declaration`` reconciles the two, which is what keeps
a build and its tooling reading one cache."""


def cached(dest: Path) -> bool:
    """Whether a copy is already held, so a fetch can be spared.

    Empty counts as absent. A body is written before anything that records what
    it is, so a response carrying nothing must not read as a copy already held:
    whatever remembers it would then agree with its oracle forever, and the
    source would be served empty rather than refetched.
    """
    return dest.exists() and dest.stat().st_size > 0


ABSENT = (404,)
"""What an ordinary server answers for something it does not have.

A tuple because it is the network's vocabulary rather than a universal: one
that will not disclose whether an object exists refuses the request instead,
and reads as 403. Which codes mean absent is declared where a source is wired,
so a policy never has to guess.
"""


def download(url: str, dest: Path, refresh: bool, headers: dict | None = None,
             optional: bool = False, absent: tuple[int, ...] = ABSENT) -> bool:
    """Download url to dest unless it is already cached (or refresh is set).

    Args:
        url: where the bytes are.
        dest: where they must be once this returns.
        refresh: fetch again even where a cached copy would pass.
        headers: anything the request needs beyond the agent, a byte range in
            particular.
        optional: the source declares this build may not have it, so an
            upstream saying so is an answer rather than a failure.
        absent: which statuses say so. See `ABSENT`.

    Returns:
        True once the source is cached; False when an `optional` source is
        absent, which is how a build that predates a db2 table reports it. Any
        other error raises.
    """
    if cached(dest) and not refresh:
        log(f"  cached   {dest.name} ({dest.stat().st_size:,} bytes)")
        return True
    log(f"  fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "epsilook-build", **(headers or {})})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp, open(tmp, "wb") as out:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
    except urllib.error.HTTPError as e:
        tmp.unlink(missing_ok=True)
        if optional and e.code in absent:
            dest.unlink(missing_ok=True)  # a stale pack's table must not linger
            log(f"  absent   {dest.name} (this build predates the table)")
            return False
        raise
    tmp.replace(dest)
    log(f"  saved    {dest.name} ({dest.stat().st_size:,} bytes)")
    return True


def download_volatile(url: str, dest: Path) -> None:
    """Fetch a small source that changes under builds already shipped.

    The enum and animation name lists keep being corrected for game builds that
    shipped long ago, so caching one forever serves a name upstream has since
    fixed. A cached copy is kept only when the network is unavailable.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "epsilook-build"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
    except (urllib.error.URLError, OSError) as exc:
        if not dest.exists():
            raise
        log(f"  WARNING  {dest.name}: {exc}; using cached copy")
        return
    changed = not dest.exists() or dest.read_bytes() != body
    if changed:
        dest.write_bytes(body)
    log(f"  {'updated ' if changed else 'current '} {dest.name} ({len(body):,} bytes)")


@dataclass(frozen=True)
class Pinned:
    """Getting a source that cannot change under a build that already shipped.

    A version-pinned export is the case: the bytes at that address are a fact
    about a client already released, so the first fetch is the last one. So is
    anything a network addresses by its own content, which cannot change
    without becoming a different address.
    """

    absent: tuple[int, ...] = ABSENT
    """Which statuses this network says "not here" with. See `ABSENT`."""

    def get(self, origin: Origin, dest: Path, refresh: bool,
            optional: bool = False) -> bool:
        """Download once, and reuse the cached copy on every later build."""
        return download(origin.address, dest, refresh, optional=optional,
                        absent=self.absent)

    def get_many(self, parts: Sequence[Part], into: Path,
                 refresh: bool) -> list[Path]:
        """One request each: separate addresses share nothing to resolve."""
        return each(self, parts, into, refresh)


@dataclass(frozen=True)
class Volatile:
    """Getting a source that keeps being corrected for builds long shipped.

    The community's enum and animation name lists: caching one forever serves
    a name upstream has since fixed, so it is fetched every build and the
    cached copy is kept only for a run with no network.
    """

    def get(self, origin: Origin, dest: Path, refresh: bool,
            optional: bool = False) -> bool:
        """Fetch unconditionally, which is what makes this policy the one it is."""
        download_volatile(origin.address, dest)
        return True

    def get_many(self, parts: Sequence[Part], into: Path,
                 refresh: bool) -> list[Path]:
        """One request each: separate addresses share nothing to resolve."""
        return each(self, parts, into, refresh)


@dataclass(frozen=True)
class Tracked:
    """Getting a source that is in this repository rather than on a network.

    Nothing is gotten, so ``refresh`` decides nothing here. What is left is
    the check, and it earns its place: a tracked file that is missing names
    itself at acquisition, where the same absence found later names only
    whichever route came up short.
    """

    def get(self, origin: Origin, dest: Path, refresh: bool,
            optional: bool = False) -> bool:
        """Confirm the file is in the checkout."""
        if not dest.exists():
            if optional:
                return False
            sys.exit(f"error: {dest} is tracked in this repository and is not "
                     f"there; the checkout is incomplete")
        log(f"  tracked  {dest.name} ({dest.stat().st_size:,} bytes)")
        return True

    def get_many(self, parts: Sequence[Part], into: Path,
                 refresh: bool) -> list[Path]:
        """One check each: nothing is fetched, so nothing is shared."""
        return each(self, parts, into, refresh)


def tracked_source(name: str, path: Path) -> Fetched:
    """A file in the checkout, as a source: acquiring it checks it is there.

    Built here rather than at each declaration because a tracked file's
    address and its destination are one path, and stating it twice is what
    would let the error name a file that was never the one checked.
    """
    return Fetched(name=name, origin=Origin(str(path)), dest=path, fetch=Tracked())


Resolve = Callable[[str], tuple[str, str]]
"""An origin's address, mapped to what is published there now and where its
bytes are.

The token identifies the publication rather than the bytes, so it stays cheap
where the body is not: it is what decides whether the body is fetched at all.

Raises:
    OSError, ValueError or LookupError: the three shapes of "it did not
    resolve". A network failure is a `URLError` and so an `OSError`; a body
    that is not what it should be -- a proxy or captive-portal page -- is a
    `ValueError`; a document missing something it must carry is a
    `LookupError`.
"""


@dataclass(frozen=True)
class Revalidated:
    """Getting a source that grows under builds that already shipped.

    The community listfile is the case: a file id with no name last month may
    have one today, so age alone never makes a cached copy good. The body is a
    hundred megabytes and the publication it belongs to is one small request,
    so the token decides and the body is fetched only where it moved.

    An oracle that cannot be reached is fatal only with nothing cached.
    Otherwise the cached copy stands, possibly missing the newest rows, and a
    warning says so -- a source that only ever grows has no version to be
    wrong about, so refusing to build over one that is merely behind trades
    every build for a freshness nothing depends on.
    """

    resolve: Resolve
    """How the address is turned into a token and the address of the bytes."""

    token_file: Path
    """Where the token of the cached copy is remembered.

    Kept beside the bytes rather than derived from them: the token names the
    publication, so anything else reading a copy out of the same directory is
    reading the same token.
    """

    def get_many(self, parts: Sequence[Part], into: Path,
                 refresh: bool) -> list[Path]:
        """One revalidation each: every part has its own publication."""
        return each(self, parts, into, refresh)

    def get(self, origin: Origin, dest: Path, refresh: bool,
            optional: bool = False) -> bool:
        """Fetch the body only where the oracle says the publication moved."""
        remembered = (self.token_file.read_text(encoding="utf-8").strip()
                      if self.token_file.exists() else "")
        have = cached(dest)
        try:
            token, address = self.resolve(origin.address)
        except (OSError, ValueError, LookupError) as exc:
            if not have:
                raise
            log(f"  WARNING  could not resolve {origin.describe()} ({exc}); "
                f"using the cached copy (token {remembered or 'unknown'})")
            return True
        if refresh or not have or remembered != token:
            if remembered and remembered != token:
                log(f"  stale    cached token {remembered} -> {token}")
            download(address, dest, refresh=True)
            self.token_file.parent.mkdir(parents=True, exist_ok=True)
            self.token_file.write_text(token, encoding="utf-8")
        else:
            log(f"  current  {dest.name} (token {token}, "
                f"{dest.stat().st_size:,} bytes)")
        return True

