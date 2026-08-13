"""File data id to asset path, from the community listfile.

Revalidated on every build, unlike every other source here. The listfile keeps
growing for builds already shipped: a file id that had no name last month may
have one today, and an existence check silently keeps serving the old answer.

The release tag is the cheap oracle -- one API call, and the 148 MB body is
only refetched when the tag actually moved.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

from ..progress import log
from .cache import CACHE_DIR, download

LISTFILE_RELEASE_API = "https://api.github.com/repos/wowdev/wow-listfile/releases/latest"


def fetch_listfile(refresh: bool) -> Path:
    """Ensure the community listfile is current, and return its path.

    An unreachable release API is not fatal: a cached copy still builds a
    correct pack, just possibly missing the newest names, so it says so and
    carries on. Only an unreachable API with nothing cached raises.
    """
    listfile_dir = CACHE_DIR / "listfile"
    listfile = listfile_dir / "community-listfile.csv"
    tag_file = listfile_dir / "release-tag.txt"
    log("Listfile (wowdev/wow-listfile):")
    cached_tag = tag_file.read_text(encoding="utf-8").strip() if tag_file.exists() else ""
    latest_tag, asset_url = "", ""
    try:
        with urllib.request.urlopen(
                urllib.request.Request(LISTFILE_RELEASE_API,
                                       headers={"User-Agent": "epsilook-build"}), timeout=60
        ) as response:
            release = json.load(response)
        latest_tag = release["tag_name"]
        asset_url = next(asset["browser_download_url"] for asset in release["assets"]
                         if asset["name"] == "community-listfile.csv")
    except (urllib.error.URLError, OSError, KeyError, StopIteration) as exc:
        if not listfile.exists():
            raise
        log(f"  WARNING  could not reach the release API ({exc}); "
            f"using cached listfile (tag {cached_tag or 'unknown'})")

    if latest_tag and (refresh or not listfile.exists() or cached_tag != latest_tag):
        if cached_tag and cached_tag != latest_tag:
            log(f"  stale    cached tag {cached_tag} -> {latest_tag}")
        download(asset_url, listfile, refresh=True)
        tag_file.write_text(latest_tag, encoding="utf-8")
    elif latest_tag:
        log(f"  current  {listfile.name} (tag {latest_tag}, "
            f"{listfile.stat().st_size:,} bytes)")
    return listfile
