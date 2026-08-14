"""Asset paths: the file ids a build references, named.

Tables in, values out, like every other route. It reads the listfile through the
provider seam, so whether the names come from the community listfile alone or
from that listfile supplemented by another source is a question about how the
`Tables` was wired and not one this reader can see.
"""

from __future__ import annotations

from ..tables.listfile_tables import ID, PATH, TABLE
from ..tables.provider import Tables


def resolve_paths(listfile: Tables, wanted: set[int]) -> dict[int, str]:
    """The asset paths of the file ids asked for.

    Streamed and filtered rather than collected: the listfile runs to a few
    million rows and one build references a fraction of them.

    Args:
        listfile: the listfile provider, already composed with any supplement.
        wanted: the file ids to keep. Anything else is discarded as it is read.

    Returns:
        File id to its path, holding only the ids the source names. A wanted id
        with no row is simply absent.
    """
    found: dict[int, str] = {}
    for fid_text, path in listfile.rows(TABLE, [ID, PATH]):
        try:
            fid = int(fid_text)
        except ValueError:
            continue
        # Trimmed here rather than in the provider: a provider hands back what
        # its source says, and this is the reader that turns it into a name.
        if fid in wanted:
            found[fid] = path.strip()
    return found
