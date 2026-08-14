"""The download cache, and the two ways a source is fetched into it.

The two differ on whether the source can change under a build that already
shipped: a version-pinned table cannot, a community-maintained list can.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from pathlib import Path

from ..progress import log

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

