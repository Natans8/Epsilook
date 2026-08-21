#!/usr/bin/env python3
"""Distil the vendored client table into `build/visual_effect_names.json.gz`.

    python tools/fxnames.py            # rebuild the committed artifact
    python tools/fxnames.py --verify   # rebuild and diff, writing nothing

WHAT THIS RECOVERS. `SpellVisualEffectName` carried a human name and a model
path until the strings were stripped out of it during Mists of Pandaria. Every
build from Warlords onward identifies a visual effect by nothing but an id and a
model file id, so on a modern pack those rows have no name at all — 35,376 of
them at 9.2.7. The names still exist in a client old enough to predate the
removal, and the ids are stable enough to carry them forward.

WHY THE DUMP IS VENDORED. No public archive holds a client between 5.0.3 and
5.4, which is exactly the window where the names were last complete. The mirror
`tools/expansions.py` reads has a hole across those patches for every table, not
just this one, because client preservation follows emulation and emulation only
ever targets the final build of an expansion. So this arrived as a file rather
than as a fetch, the same way the Warlords rung of the expansion ladder did.

WHY IT IS NOT PINNED TO A BUILD NUMBER. The dump came out of an archive labelled
5.4.8, and it is not a 5.4.8 file: 5.4 stores the model path in the column the
definitions still call `Name`, while this one holds both a real name and a
separate path, which is the 5.0.1 through 5.3.0 layout. Mislabelled dumps are
the norm in that scene, so the artifact is identified by its content -- the
layout it decodes under and the number of rows it holds -- and never by what its
container claimed. `--verify` re-checks both.

WHAT THE BUILD DOES WITH IT. Nothing here decides which names are true. A name
is only carried onto a pack when that pack's own row for the same id still
points at the same asset, which is a per-pack question and belongs to the build.
This tool ships all three columns and lets the build judge.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import tempfile
from pathlib import Path
from typing import TypedDict

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "build"))

# pylint: disable=wrong-import-position
from pack.sources import dbd, wdbc  # noqa: E402
from pack.sources.cache import CACHE_DIR  # noqa: E402

TABLE = "SpellVisualEffectName"

VENDORED = REPO / "build" / "sources" / "mop-spellvisualeffectname.dbc.gz"
"""The client table itself, gzipped. Kept beside the artifact it produces so the
artifact can be re-derived rather than only trusted."""

OUT = REPO / "build" / "visual_effect_names.json.gz"
"""What the build reads. The tool is never on the build's path."""

LAYOUT_BUILD = (5, 3, 0, 17116)
"""Which layout to decode under: the last one that declares both strings.

A build number here selects a column layout and claims nothing about which
client this file came from. The record-size check in the reader is what makes a
wrong choice an error rather than a silent misread.
"""

EXPECTED_ROWS = 12597
"""How many records the vendored dump holds.

An identity check, not a limit. The distinguishing property of this file is that
it sits between the last archived build that still had the names and the first
that had lost them, so a replacement claiming to be the same source and holding
a different number of rows is a different file.
"""


class Distilled(TypedDict):
    """The artifact: three columns in row order, read together and never apart.

    Parallel arrays rather than a mapping because the build consumes all three
    at once and a mapping would make the stem, which exists only to be checked,
    look like something worth keeping.
    """

    ids: list[int]
    names: list[str]
    stems: list[str]


def stem(path: str) -> str:
    """The asset's bare filename, folded for comparison.

    `Spells\\Rake.mdx` becomes `rake`. This is the whole of what corroboration
    compares: a modern client stores the same asset under a file id whose
    listfile path still ends in the same name, and an id that has been reused
    for something else does not.
    """
    tail = path.replace("\\", "/").rsplit("/", 1)[-1]
    return tail.rsplit(".", 1)[0].lower()


def distil() -> Distilled:
    """Read the vendored dump into the three parallel columns the build wants.

    Returns:
        `ids`, `names` and `stems`, in row order, holding only rows that carry
        both a name and a model path. A row missing either cannot be
        corroborated, so shipping it would mean shipping a name nothing checks.
    """
    definition = dbd.load(TABLE, CACHE_DIR)
    if definition is None:
        sys.exit(f"error: no .dbd definition for {TABLE}")

    with gzip.open(VENDORED, "rb") as packed:
        raw = packed.read()
    # A temporary directory rather than the build cache: several sessions share
    # that cache and take exclusive locks on it, and this file is wanted for the
    # length of one read.
    with tempfile.TemporaryDirectory() as scratch:
        unpacked = Path(scratch) / f"{TABLE}.dbc"
        unpacked.write_bytes(raw)
        rows = wdbc.read(unpacked, definition, LAYOUT_BUILD)

    if len(rows) != EXPECTED_ROWS:
        sys.exit(f"error: {VENDORED.name} holds {len(rows):,} rows, expected "
                 f"{EXPECTED_ROWS:,} — this is not the vendored dump")

    ids: list[int] = []
    names: list[str] = []
    stems: list[str] = []
    for row in rows:
        name, path = row.get("Name", ""), row.get("FileName", "")
        if not name or not path or name.lower().endswith(".mdx"):
            continue
        ids.append(int(row["ID"]))
        names.append(name)
        stems.append(stem(path))
    return {"ids": ids, "names": names, "stems": stems}


def write(data: Distilled) -> None:
    """Write the artifact, byte-identically for identical input."""
    body = json.dumps(data, separators=(",", ":"), sort_keys=True).encode()
    with gzip.GzipFile(OUT, "wb", compresslevel=9, mtime=0) as out:
        out.write(body)


def main() -> int:
    """Rebuild the artifact, or compare it with what is committed."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--verify", action="store_true",
                        help="rebuild and compare with the committed file, writing nothing")
    args = parser.parse_args()

    data = distil()
    dropped = EXPECTED_ROWS - len(data["ids"])
    print(f"{TABLE}: {len(data['ids']):,} names with a model path "
          f"({dropped:,} rows dropped as uncorroboratable)")

    if args.verify:
        if not OUT.exists():
            print(f"missing: {OUT}")
            return 1
        with gzip.open(OUT, "rt", encoding="utf-8") as f:
            committed = json.load(f)
        same = committed == data
        print("verify:", "identical" if same else "DIFFERS from the committed artifact")
        return 0 if same else 1

    write(data)
    print(f"wrote {OUT.relative_to(REPO)} ({OUT.stat().st_size:,} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
