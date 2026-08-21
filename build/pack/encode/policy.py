"""What a column's kind costs: the one place storage is decided.

A section declares what KIND of mapping each of its columns carries. This turns
that into a layout. Keeping the two apart is what lets the whole artifact
change shape from one edit here instead of eighty edits across the registry --
and it is why a section never has to know what gzip does with an array of
repeated empty strings.

The two policies trade bytes against entries, and the trade was measured on the
product's own build rather than assumed. Over the whole module set, fewest
bytes comes to 12,579,734 against 13,565,500, and on a first load with the
prose deferred, 9,602,316 against 10,588,082.

Padding a partial column costs almost nothing on the wire, because gzip eats a
run of repeated fillers; what it costs is the reader walking every entry.
Skipping the padding inverts that -- the row indexes a sparse column carries
are incompressible, so it buys parse time at just under a megabyte. With no
latency budget and a first load measured in megabytes, bytes are what a person
waits for, so `FEWEST_BYTES` ships.

`FEWEST_ENTRIES` stays because the measurement is a fact about THIS data and
not a law: a column far emptier than these would invert it again. A section
that knows it has one can name `Encoding.SPARSE` outright without moving the
whole build. Whichever ships, the app must understand the shape -- an encoder
the reader does not know is a silently wrong pack, not a smaller one.
"""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

from ..model.section import Cardinality, Encoding

# Read-only at runtime rather than only in the annotation. Both policies are
# the default argument of every function that takes one, so a stray write here
# would not be a local mistake -- it would restate what the whole build packs,
# for every later call in the process.
FEWEST_BYTES: Mapping[Cardinality, Encoding] = MappingProxyType({
    Cardinality.TOTAL: Encoding.DENSE,
    # A partial column pads rather than skips: the filler compresses to nearly
    # nothing, and the row indexes that would replace it do not.
    Cardinality.PARTIAL: Encoding.DENSE,
    Cardinality.SHARED: Encoding.DEDUP,
})
"""What ships: the smallest artifact, measured."""

FEWEST_ENTRIES: Mapping[Cardinality, Encoding] = MappingProxyType({
    Cardinality.TOTAL: Encoding.DENSE,
    Cardinality.PARTIAL: Encoding.SPARSE,
    Cardinality.SHARED: Encoding.DEDUP,
})
"""The fewest values for a reader to walk, at a cost in bytes."""


def layout_of(kind: Cardinality,
              policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES) -> Encoding:
    """The layout one kind of column gets under `policy`.

    Raises:
        KeyError: the policy names no layout for that kind. A kind with no
            layout is a policy that was extended without being finished, and
            guessing a layout for it would ship a column in a shape nobody
            chose.
    """
    return policy[kind]
