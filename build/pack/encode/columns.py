"""Per-column layouts: how a produced column becomes what ships.

A section produces one plain list per column. What that list turns into is the
column's declared `Encoding`, applied here and nowhere else, so a section says
what it means and this layer says what it costs.

The layouts are not interchangeable dialects of the same thing: each one is the
shape a particular cardinality wants. A total mapping is dense, because every
row has a value and an index into a pool would cost more than the value. A
mapping many rows share is deduped, because the pool is smaller than the
repeats. Choosing between them is a property of the data, which is why it is
declared per column rather than decided here.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence

from ..model.section import Encoding

EMPTY_SLOT = ""
"""What slot 0 of a deduped pool always holds.

A row with nothing to say indexes it, so absence costs one integer rather than
a repeated empty string, and a reader never has to test for a missing index.
"""


def dense(values: Sequence[object]) -> object:
    """The column as it was produced.

    The right answer wherever a value exists for every row: the array IS the
    mapping, and its position is its key.
    """
    return list(values)


def deduped(values: Sequence[object]) -> object:
    """The column as a pool of distinct values plus one index per row.

    What many-rows-to-one-value costs when it is stored as though it were
    one-to-one. The pool holds each distinct value once with `EMPTY_SLOT` at
    slot 0; `of` indexes into it, parallel to the rows the column was produced
    against.

    Insertion order is the pool's order, so the array is the dict -- and the
    order a row first appears is stable for a given input, which is what keeps
    the encoding deterministic without a sort that would reorder equal strings.
    """
    pool: dict[object, int] = {EMPTY_SLOT: 0}
    index = [pool.setdefault(value, len(pool)) for value in values]
    return {"text": list(pool), "of": index}


LAYOUTS: Mapping[Encoding, Callable[[Sequence[object]], object]] = {
    Encoding.DENSE: dense,
    Encoding.DEDUP: deduped,
}
"""Every encoding, by the value a section declares.

A declaration with no layout here is a hard error rather than a silent
pass-through: shipping a column in a shape nobody chose is how an artifact
starts disagreeing with the record that describes it.
"""


def encode_column(values: Sequence[object], encoding: Encoding) -> object:
    """One column, laid out as it declared.

    Raises:
        KeyError: the encoding has no layout.
    """
    return LAYOUTS[encoding](values)
