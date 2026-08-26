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

from ..model.section import Column, Encoding

EMPTY_SLOT = ""
"""What slot 0 of a deduped pool always holds.

A row with nothing to say indexes it, so absence costs one integer rather than
a repeated empty string, and a reader never has to test for a missing index.
"""


def dense(values: Column) -> object:
    """The column as it was produced.

    The right answer wherever a value exists for every row: the array IS the
    mapping, and its position is its key.

    A column whose keys are ids rather than positions arrives as a mapping and
    stays one. That is not a different encoding -- it is the same total mapping
    with an explicit key, which is what a vocabulary sparse in its own id space
    needs: a hundred and thirty target ids scattered through a range of
    thousands would otherwise ship as a mostly-empty array.
    """
    if isinstance(values, Mapping):
        return dict(values)
    return list(values)


def deduped(values: Column) -> object:
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


def sparse(values: Column, absent: object = EMPTY_SLOT) -> object:
    """The column as the values that exist, and which rows carry them.

    What a partial mapping costs when it is not padded out into a total one.
    `at` holds the row positions in order and `is` the value each carries, so a
    column where most rows have nothing ships only the few that do.

    `absent` is what the producer put in a row that has no value, and it is
    passed in rather than guessed: which value means nothing is a fact about
    the column, and a zero is a legitimate answer in most of them. Guessing it
    would silently drop real rows from whichever column disagreed.
    """
    present = [(row, value) for row, value in enumerate(values) if value != absent]
    return {"at": [row for row, _ in present], "is": [value for _, value in present]}


LAYOUTS: Mapping[Encoding, Callable[..., object]] = {
    Encoding.DENSE: dense,
    Encoding.SPARSE: sparse,
    Encoding.DEDUP: deduped,
}
"""Every encoding, by the value a section declares.

A declaration with no layout here is a hard error rather than a silent
pass-through: shipping a column in a shape nobody chose is how an artifact
starts disagreeing with the record that describes it.
"""


def encode_column(values: Column, encoding: Encoding, absent: object = EMPTY_SLOT) -> object:
    """One column, laid out as it declared.

    `absent` reaches only the layouts that need to tell a value from a gap.

    Raises:
        KeyError: the encoding has no layout.
    """
    if encoding is Encoding.SPARSE:
        return sparse(values, absent)
    return LAYOUTS[encoding](values)


def decode_column(shipped: object, encoding: Encoding, absent: object = EMPTY_SLOT, rows: int | None = None) -> Column:
    """A shipped column back as the section produced it.

    The inverse of `encode_column`, and it lives beside it because that is the
    only way the two stay each other's inverse. A reader that works the layouts
    out for itself is a second account of them, and the encodings are exactly
    the kind of thing that gets a fourth member one day.

    A dense column is already what was produced, so this is a copy; the other
    two are undone.

    Args:
        shipped: the column as the artifact carries it.
        encoding: the layout it was written in.
        absent: what the producer put in a row with no value. Sparse needs it
            for the same reason encoding did -- the filler is the column's own,
            and zero is a real answer in most columns.
        rows: how many rows the section has. A sparse column ships the rows
            that carry a value and nothing about the ones after the last of
            them, so a column whose tail is all gaps is the one case the
            payload cannot state: without this it decodes short. The other two
            layouts carry their own length and ignore it.

    Raises:
        ValueError: the payload is not the shape its encoding ships.
    """
    if encoding is Encoding.DENSE:
        if isinstance(shipped, Mapping):
            return dict(shipped)
        if not isinstance(shipped, Sequence):
            raise ValueError(f"a dense column ships a sequence or a mapping, not {type(shipped).__name__}")
        return list(shipped)
    if not isinstance(shipped, Mapping):
        raise ValueError(f"a {encoding.value} column ships a mapping, not {type(shipped).__name__}")
    if encoding is Encoding.DEDUP:
        pool, index = shipped["text"], shipped["of"]
        return [pool[position] for position in index]
    at, values = shipped["at"], shipped["is"]
    out: list[object] = [absent] * max(rows or 0, at[-1] + 1 if at else 0)
    for row, value in zip(at, values):
        out[row] = value
    return out
