"""File data id to asset path, from the community listfile.

Revalidated on every build, unlike every other source here: the listfile keeps
growing for builds already shipped, so a file id with no name last month may
have one today. The release tag is the cheap oracle -- one API call, and the
body is refetched only when the tag moved.

One listfile serves the whole roster. It is keyed on a file id, which is global
and stable across builds, so the name a file id gets does not depend on which
build is being packed; the only per-build thing is which subset of ids that
build's spell data points at. Every shipped pack agreeing on every name it
shares is therefore a property of the source rather than a coincidence worth
checking for.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path

from ..progress import log
from .cache import CACHE_DIR, download

LISTFILE_RELEASE_API = "https://api.github.com/repos/wowdev/wow-listfile/releases/latest"

LISTFILE_ASSET = "community-listfile-withcapitals.csv"
"""Which of the release's listfiles to take.

Two axes, and both are decided by what the pack is for. Community over
verified, because verified carries only hash-confirmed names and drops roughly
half of them -- a name we do not have is an asset a reader cannot find, which
is the opposite of the point. Capitals over the normalised lowercase, because
these paths are shown to a reader rather than only matched against: the two
files hold identical rows differing in case alone, most carry real casing, and
a vanishing few come back fully uppercase from the era when only the hash of an
uppercased path survived.

The casing is a display choice and never a matching one. Anything comparing
paths folds case at the comparison, so this constant cannot decide whether a
search finds something.
"""


def fetch_listfile(refresh: bool) -> Path:
    """Ensure the community listfile is current, and return its path.

    An unreachable release API is fatal only with nothing cached; otherwise the
    cached copy is used, possibly missing the newest names.

    Args:
        refresh: download even when the cached tag is already the latest.

    Returns:
        Where the listfile is on disk.

    Raises:
        OSError: if the release cannot be reached and nothing is cached.
    """
    listfile_dir = CACHE_DIR / "listfile"
    listfile = listfile_dir / LISTFILE_ASSET
    # The tag names the RELEASE, not the asset, so it is shared with anything
    # else reading a listfile out of this cache. Switching asset while the tag
    # stands still is covered by the existence check below.
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
        assets = {asset["name"]: asset["browser_download_url"]
                  for asset in release["assets"]}
        # Told apart from an unreachable API on purpose. A release that stops
        # carrying this asset reads as "the network is down" if both land in
        # one message, and the build then runs on a cached listfile forever
        # while reporting a problem nobody can act on.
        if LISTFILE_ASSET not in assets:
            raise LookupError(
                f"release {latest_tag} carries no {LISTFILE_ASSET} "
                f"(it has {', '.join(sorted(assets))})")
        asset_url = assets[LISTFILE_ASSET]
    # Three shapes of the same answer, "the latest release did not resolve": a
    # network failure is a `URLError` and so an `OSError`; a body that is not
    # JSON at all -- a proxy or captive-portal page -- is a `JSONDecodeError`
    # and so a `ValueError`; JSON missing a key we need is a `LookupError`,
    # which is also what the absent-asset check above raises.
    except (OSError, ValueError, LookupError) as exc:
        if not listfile.exists():
            raise
        log(f"  WARNING  could not resolve the latest release ({exc}); "
            f"using cached listfile (tag {cached_tag or 'unknown'})")
        # Cleared so the download below cannot run on a tag whose url never
        # resolved, which would fetch the empty string.
        latest_tag = ""

    if latest_tag and (refresh or not listfile.exists() or cached_tag != latest_tag):
        if cached_tag and cached_tag != latest_tag:
            log(f"  stale    cached tag {cached_tag} -> {latest_tag}")
        download(asset_url, listfile, refresh=True)
        tag_file.write_text(latest_tag, encoding="utf-8")
    elif latest_tag:
        log(f"  current  {listfile.name} (tag {latest_tag}, "
            f"{listfile.stat().st_size:,} bytes)")
    return listfile


def resolve_paths(listfile: Path, wanted: set[int]) -> dict[int, str]:
    """The asset paths of the file ids asked for.

    Streamed and filtered rather than loaded: the listfile is some 150 MB over
    a few million rows, and one build references a fraction of them.

    Args:
        listfile: the cached listfile.
        wanted: the file ids to keep. Anything else is discarded as it is read.

    Returns:
        File id to its path, holding only the ids the listfile names. A wanted
        id the listfile has no row for is simply absent.
    """
    found: dict[int, str] = {}
    with listfile.open(newline="", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            fid_text, separator, path = line.partition(";")
            if not separator:
                continue
            try:
                fid = int(fid_text)
            except ValueError:
                continue
            if fid in wanted:
                found[fid] = path.strip()
    return found
