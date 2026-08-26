"""Build progress output, flushed per line so a running build can be watched.

Also the build's stopwatch. Timing lives here rather than in a module of its own
because a phase boundary is a thing worth SAYING as much as a thing worth
measuring: the same names appear in the running commentary and in the table at
the end, so a build that looks stuck and a build that is slow are read off one
vocabulary.

Every span recorded is a LEAF -- spans do not nest. That is what lets the table
sum: the total is wall clock, the phases add up to something less, and the
difference is honest unaccounted time rather than a parent counted twice
alongside its children. A name recorded more than once accumulates, which is how
a per-item cost inside a loop is measured without one row per item.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager

_ELAPSED: dict[str, float] = {}
"""Seconds spent per phase name, summed over every span recorded under it.

Read back in insertion order, which is the order the build first reached each
phase. Sorting by duration would rank them, but the build is a pipeline and
reading it in the order it happens is what makes a number explicable.
"""

_DETAIL: dict[str, dict[str, float]] = {}
"""Seconds inside a phase, broken down by whatever the phase counts as an item.

A second ledger rather than more names in the first, because these are NOT
leaves: they sit inside a phase that is already measured, and adding them to the
main table would count the same seconds twice. The main table stays a partition
of wall clock and this drills into one of its rows.
"""

DETAIL_ROWS = 12
"""How many items a breakdown prints. Enough to show whether one item dominates
or the cost is spread, which is the only question a breakdown answers."""


def log(message: str) -> None:
    """Print one line of build progress."""
    print(message, flush=True)


def record(name: str, seconds: float) -> None:
    """Add one span to a phase's running total."""
    _ELAPSED[name] = _ELAPSED.get(name, 0.0) + seconds


@contextmanager
def phase(name: str) -> Iterator[None]:
    """Time one step of the build, whatever it exits by.

    The total is recorded on the way out even when the body raises, so a build
    that fails half way still says where the time went -- which is exactly when
    that is worth knowing.
    """
    started = time.perf_counter()
    try:
        yield
    finally:
        record(name, time.perf_counter() - started)


@contextmanager
def detail(phase_name: str, item: str) -> Iterator[None]:
    """Time one item inside an already-measured phase.

    Recorded apart from the phases so the main table stays a partition of wall
    clock: these seconds are already counted by the phase that contains them.
    """
    started = time.perf_counter()
    try:
        yield
    finally:
        inside = _DETAIL.setdefault(phase_name, {})
        inside[item] = inside.get(item, 0.0) + time.perf_counter() - started


@contextmanager
def timed(name: str, item: str) -> Iterator[None]:
    """Time a phase and one item within it, naming the phase once.

    The two are always entered together where a phase runs per item, and naming
    it twice is how the item ends up filed under a phase that does not exist.
    """
    with phase(name), detail(name, item):
        yield


@contextmanager
def step(name: str, message: str) -> Iterator[None]:
    """Announce a step and time it under `name`.

    The pairing most of the build wants: the commentary that says what is
    happening now and the measurement of how long it took, from one statement so
    the two cannot drift apart.
    """
    log(message)
    with phase(name):
        yield


def timings() -> list[tuple[str, float]]:
    """Each phase and its seconds, in the order the build ran them."""
    return list(_ELAPSED.items())


def report(total: float) -> None:
    """Print the phase table: seconds and share of wall clock, slowest marked.

    Args:
        total: wall clock for the whole build, which the caller measures -- it
            is the one span that is not a phase, and deriving it by summing
            these would report the sum rather than the elapsed time.
    """
    measured = sum(_ELAPSED.values())
    rows = timings()
    if not rows:
        return
    width = max(len(name) for name in _ELAPSED)
    peak = max(_ELAPSED.values())

    log("")
    log(f"{'phase'.ljust(width)}  {'seconds':>9}  {'share':>7}")
    log(f"{'-' * width}  {'-' * 9}  {'-' * 7}")
    for name, seconds in rows:
        share = seconds / total * 100 if total else 0.0
        mark = "  <--" if seconds == peak else ""
        log(f"{name.ljust(width)}  {seconds:9.2f}  {share:6.1f}%{mark}")
    log(f"{'-' * width}  {'-' * 9}  {'-' * 7}")
    log(f"{'measured'.ljust(width)}  {measured:9.2f}  {measured / total * 100 if total else 0:6.1f}%")
    log(
        f"{'unaccounted'.ljust(width)}  {total - measured:9.2f}  "
        f"{(total - measured) / total * 100 if total else 0:6.1f}%"
    )
    log(f"{'total'.ljust(width)}  {total:9.2f}  {100.0:6.1f}%")

    for phase_name, inside in _DETAIL.items():
        ranked = sorted(inside.items(), key=lambda pair: -pair[1])
        spent = sum(inside.values())
        log("")
        log(f"{phase_name} — {len(inside)} items, {spent:.2f}s, slowest first:")
        for item, seconds in ranked[:DETAIL_ROWS]:
            log(f"  {item.ljust(width - 2)}  {seconds:9.2f}  {seconds / spent * 100 if spent else 0:6.1f}%")
        if len(ranked) > DETAIL_ROWS:
            rest = sum(seconds for _item, seconds in ranked[DETAIL_ROWS:])
            log(
                f"  {f'... {len(ranked) - DETAIL_ROWS} more'.ljust(width - 2)}  "
                f"{rest:9.2f}  {rest / spent * 100 if spent else 0:6.1f}%"
            )
