"""Per-column layouts: dense, sparse, dedup.

Implements the encodings the section records declare, column by column, and
assembles the encoded columns into the payload a section ships as.
"""

from __future__ import annotations

from collections.abc import Mapping

from ..model.section import (Cardinality, Encoding, Layout, Section,
                             SectionColumns)
from .columns import (EMPTY_SLOT, LAYOUTS, dense, deduped, encode_column,
                      sparse)
from .policy import FEWEST_BYTES, FEWEST_ENTRIES, layout_of

__all__ = [
    "FEWEST_BYTES",
    "FEWEST_ENTRIES",
    "EMPTY_SLOT",
    "LAYOUTS",
    "dense",
    "deduped",
    "encode_column",
    "encode_section",
    "layout_for",
    "layout_of",
    "sparse",
]


def encode_section(section: Section, produced: SectionColumns,
                   policy: Mapping[Cardinality, Encoding] = FEWEST_BYTES) -> object:
    """One section's produced columns, laid out as the record declares.

    Args:
        section: the record, which names the columns and their encodings.
        produced: what its `produce` returned.

    Returns:
        The payload as it ships: the single column's value for a bare section,
        otherwise a dict in the record's column order rather than the order
        `produce` happened to build them in. Column order is part of the
        artifact, so it is read from the declaration.

    Raises:
        ValueError: `produce` returned a different set of columns than the
            record declares. The record is what every other consumer -- the
            documentation, the guard, the mirror -- believes, so a producer
            disagreeing with it is a defect in one of the two and never
            something to paper over.
    """
    if set(produced) != set(section.columns):
        missing = sorted(set(section.columns) - set(produced))
        extra = sorted(set(produced) - set(section.columns))
        raise ValueError(
            f"{section.name} declares {section.columns} but produced "
            f"{sorted(produced)}"
            + (f"; missing {', '.join(missing)}" if missing else "")
            + (f"; unexpected {', '.join(extra)}" if extra else ""))

    encoded = {name: encode_column(produced[name],
                                   layout_for(section, name, policy),
                                   section.absent.get(name, EMPTY_SLOT))
               for name in section.columns}
    if section.layout is Layout.BARE:
        return encoded[section.columns[0]]
    return encoded


def layout_for(section: Section, column: str,
               policy: Mapping[Cardinality, Encoding]) -> Encoding:
    """The layout one column ships in.

    A layout the section named outright wins; otherwise the column's declared
    kind decides under `policy`, and a column that declares neither is total,
    which is what a column parallel to its rows is.
    """
    if column in section.encoding:
        return section.encoding[column]
    return layout_of(section.cardinality.get(column, Cardinality.TOTAL), policy)
