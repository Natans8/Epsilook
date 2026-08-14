"""The download cache, and the policies a source is fetched into it under.

The policies differ on whether the source can change under a build that
already shipped: a version-pinned table cannot, a community-maintained list
can, and a file tracked in this repository is not fetched at all.
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from ..progress import log
from .source import Fetched, Origin

BUILD_DIR = Path(__file__).resolve().parents[2]
"""The build's own directory: where its checked-in sources live, tracked."""

CACHE_DIR = BUILD_DIR.parent / ".cache"
"""Where every downloaded source lands, and the only directory the build writes.

Declared again in ``tools/repo.py``, which runs on a different path root and
must not import this package."""


def download(url: str, dest: Path, refresh: bool, headers: dict | None = None,
             optional: bool = False) -> bool:
    """Download url to dest unless it is already cached (or refresh is set).

    Returns:
        True once the source is cached; False when an `optional` source is
        absent (HTTP 404), which is how a build that predates a db2 table
        reports it. Any other error raises.
    """
    if dest.exists() and dest.stat().st_size > 0 and not refresh:
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
        if optional and e.code == 404:
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
    dest.write_bytes(body)
    log(f"  {'updated ' if changed else 'current '} {dest.name} ({len(body):,} bytes)")


@dataclass(frozen=True)
class Pinned:
    """Getting a source that cannot change under a build that already shipped.

    A version-pinned export is the case: the bytes at that address are a fact
    about a client already released, so the first fetch is the last one.
    """

    optional: bool = False
    """Whether a 404 means this build predates the source rather than that the
    fetch failed."""

    def get(self, origin: Origin, dest: Path, refresh: bool) -> bool:
        """Download once, and reuse the cached copy on every later build."""
        return download(origin.address, dest, refresh, optional=self.optional)


@dataclass(frozen=True)
class Volatile:
    """Getting a source that keeps being corrected for builds long shipped.

    The community's enum and animation name lists: caching one forever serves
    a name upstream has since fixed, so it is fetched every build and the
    cached copy is kept only for a run with no network.
    """

    def get(self, origin: Origin, dest: Path, refresh: bool) -> bool:
        """Fetch unconditionally, which is what makes this policy the one it is."""
        download_volatile(origin.address, dest)
        return True


@dataclass(frozen=True)
class Tracked:
    """Getting a source that is in this repository rather than on a network.

    Nothing is gotten, so ``refresh`` decides nothing here. What is left is
    the check, and it earns its place: a tracked file that is missing names
    itself at acquisition, where the same absence found later names only
    whichever route came up short.
    """

    def get(self, origin: Origin, dest: Path, refresh: bool) -> bool:
        """Confirm the file is in the checkout."""
        if not dest.exists():
            sys.exit(f"error: {dest} is tracked in this repository and is not "
                     f"there; the checkout is incomplete")
        log(f"  tracked  {dest.name} ({dest.stat().st_size:,} bytes)")
        return True


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

    def get(self, origin: Origin, dest: Path, refresh: bool) -> bool:
        """Fetch the body only where the oracle says the publication moved."""
        cached = (self.token_file.read_text(encoding="utf-8").strip()
                  if self.token_file.exists() else "")
        # Empty counts as absent, the way `download` treats its own cache. A
        # body is written before its token, so a response that carried nothing
        # leaves a file that exists and a token that says it is current --
        # after which the token alone would agree with the oracle forever, and
        # the source would be served empty rather than refetched.
        have = dest.exists() and dest.stat().st_size > 0
        try:
            token, address = self.resolve(origin.address)
        except (OSError, ValueError, LookupError) as exc:
            if not have:
                raise
            log(f"  WARNING  could not resolve {origin.describe()} ({exc}); "
                f"using the cached copy (token {cached or 'unknown'})")
            return True
        if refresh or not have or cached != token:
            if cached and cached != token:
                log(f"  stale    cached token {cached} -> {token}")
            download(address, dest, refresh=True)
            self.token_file.parent.mkdir(parents=True, exist_ok=True)
            self.token_file.write_text(token, encoding="utf-8")
        else:
            log(f"  current  {dest.name} (token {token}, "
                f"{dest.stat().st_size:,} bytes)")
        return True

