"""What a column of numbers looks like in one pack.

Package-root vocabulary: it names no layer and reads nothing, because it is
arithmetic over values somebody else already has. A section declares a domain
over the column it ships, and this is what "a domain" means.

Measured per pack rather than declared once, because bounds taken from one
build are wrong on the other ten. That is what lets the app draw a numeric
control without walking a quarter of a million values on every load.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from typing import Any

PICKER_MAX = 24
"""How few distinct values a control lists outright instead of offering a range.

Above this the options stop being scannable and a range is the better control;
at or below it the pack ships the options themselves, so the control is
generated rather than hand-listed anywhere in the app.
"""


def numeric_domain(values: Iterable[float], sentinels: Iterable[float] = ()) -> dict[str, Any] | None:
    """Everything derivable about one numeric axis in this pack.

    Args:
        values: the column's values, in any order.
        sentinels: markers rather than quantities -- a channel's -1 means "no
            limit", not minus a millisecond. Counted out before any bound is
            taken, since one of them at either end silently ruins every bound.

    Returns:
        The measured domain, or None when the axis has no values here. None is
        how a pack that lacks the data ends up with no entry rather than a
        fabricated empty one.
    """
    skip = set(sentinels)
    raw = list(values)
    if not raw:
        return None
    kept = sorted(value for value in raw if value not in skip)
    if not kept:
        return None
    distinct = sorted(set(kept))
    mode, mode_count = Counter(kept).most_common(1)[0]

    def at(quantile: float) -> float:
        return kept[min(len(kept) - 1, int(len(kept) * quantile))]

    low, high, p1, p99 = kept[0], kept[-1], at(0.01), at(0.99)
    domain: dict[str, Any] = {
        "n": len(kept),
        "min": low,
        "max": high,
        "distinct": len(distinct),
        "mean": round(sum(kept) / len(kept), 4),
        "median": at(0.5),
        "p1": p1,
        "p99": p99,
        "clipped": p1 != low or p99 != high,
        # Rounded because these are floats: the gap between 25.2 and 25.4 comes
        # out of binary as 0.19999999999999996, and a control offering that as
        # its step is arithmetic noise leaking into the interface.
        "step": round(min((later - earlier for earlier, later in zip(distinct, distinct[1:])), default=0), 6),
        "mode": mode,
        "modeShare": round(mode_count / len(kept), 4),
        "signed": low < 0,
        "sentinels": len(raw) - len(kept),
        "ui": "picker" if len(distinct) <= PICKER_MAX else "range",
    }
    if len(distinct) <= PICKER_MAX:
        domain["values"] = distinct
    return domain
