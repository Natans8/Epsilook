"""What a column's kind costs: the one place storage is decided.

A section declares what KIND of mapping each of its columns carries. This turns
that into a layout. Keeping the two apart is what lets the whole artifact
change shape from one edit here instead of eighty edits across the registry --
and it is why a section never has to know what gzip does with an array of
repeated empty strings.

Two policies exist because the artifact has two readers and only one of them
has been taught the second shape yet. `COMPATIBLE` emits what the app reads
today. `COMPACT` emits what each kind actually wants -- partial columns stop
padding a value into every row that has none, which is a parse-time win rather
than a byte one, since gzip already eats the padding but `JSON.parse` still
walks every entry.

Switching is one name at the call site, and the app has to learn the sparse
shape in the same change: an encoder the reader does not understand is a
silently wrong pack, not a smaller one.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..model.section import Cardinality, Encoding

COMPATIBLE: Mapping[Cardinality, Encoding] = {
    Cardinality.TOTAL: Encoding.DENSE,
    # A partial column pads rather than skips, because that is the shape the
    # app reads today: it joins by position and has no way to ask which rows a
    # sparse column covers.
    Cardinality.PARTIAL: Encoding.DENSE,
    Cardinality.SHARED: Encoding.DEDUP,
}
"""The layouts the shipped app understands."""

COMPACT: Mapping[Cardinality, Encoding] = {
    Cardinality.TOTAL: Encoding.DENSE,
    Cardinality.PARTIAL: Encoding.SPARSE,
    Cardinality.SHARED: Encoding.DEDUP,
}
"""The layouts each kind wants, once a reader understands them all."""


def layout_of(kind: Cardinality,
              policy: Mapping[Cardinality, Encoding] = COMPATIBLE) -> Encoding:
    """The layout one kind of column gets under `policy`.

    Raises:
        KeyError: the policy names no layout for that kind. A kind with no
            layout is a policy that was extended without being finished, and
            guessing a layout for it would ship a column in a shape nobody
            chose.
    """
    return policy[kind]
