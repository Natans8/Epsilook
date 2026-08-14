"""Per-column layouts: dense, sparse, dedup.

Implements the encodings the section records declare, column by column, and
assembles the encoded columns into the payload a section ships as.
"""

from __future__ import annotations

from ..model.section import Encoding, Layout, Section, SectionColumns
from .columns import EMPTY_SLOT, LAYOUTS, dense, deduped, encode_column

__all__ = [
    "EMPTY_SLOT",
    "LAYOUTS",
    "dense",
    "deduped",
    "encode_column",
    "encode_section",
]


def encode_section(section: Section, produced: SectionColumns) -> object:
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
                                   section.encoding.get(name, Encoding.DENSE))
               for name in section.columns}
    if section.layout is Layout.BARE:
        return encoded[section.columns[0]]
    return encoded
