"""Reconstruct the vendored asset-name supplement, one route at a time.

The supplement is the only source the build cannot fetch: it names the assets a
private client adds, which no public listfile knows about. This is the procedure
that rebuilds it, and the reason it is a script rather than a note is that the
routes disagree about cost by four orders of magnitude -- one reads a file in the
install, another needs somebody to log in and walk a client API for an evening --
so which routes to run is a decision, and a decision needs the numbers in front
of it.

    python tools/supplement.py                 run every route that can run, and merge
    python tools/supplement.py --list          what each route needs, and what it costs
    python tools/supplement.py --only icons    one route
    python tools/supplement.py --verify        check each route against a known-good copy
    python tools/supplement.py --diff          compare the result against what is vendored

Routes are declared, not branched on: a new one is a row in `ROUTES` naming what
it needs and what it yields, and the merge, the report and the verification all
read that row. Order in `ROUTES` is priority order -- where two routes name the
same file, the earlier one wins, because they are listed from names the game
itself uses down to names derived from where a file hangs.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from epsilon_names import (ICON_DIRECTORY, ROOT_BUCKET, icon_names,  # noqa: E402
                           object_names, read_object_dump)
from repo import (DIM, GREEN, RED, RESET, ROOT, YELLOW, log,  # noqa: E402
                  survive_console_encoding)

SUPPLEMENT_FLOOR = 18_000_000
"""The id below which this may not name anything.

Declared here as well as beside the code that applies it, because reaching that
one would drag the whole acquisition layer onto a bare interpreter for a single
integer. `check.py` reconciles the two: the drift would not break anything
loudly, it would quietly let a row through that overwrites a real name.
"""

VENDORED = ROOT / "build" / "sources" / "epsilon-listfile-supplement.csv.gz"
"""What the build reads. This script does not write it; see the module docs."""

WORK = ROOT / ".cache" / "supplement"
"""Where each route's own output lands, so any one can be re-run alone."""

REFERENCE = ROOT / ".claude" / "data" / "epsilon"
"""Where the exploration's saved artefacts live.

Two different things live here and they are worth telling apart. The known-good
copies `--verify` reads are conveniences: losing one costs a verification, not a
route. `dump_gob_names.json` is not -- it is the only surviving copy of a walk
that costs an evening in game, and no route can rebuild it.
"""


@dataclass(frozen=True)
class Route:
    """One way of learning what a file is called.

    Args:
        name: what to pass to `--only`.
        summary: what the route reads, in one line.
        needs: what must be present for it to run at all.
        cost: roughly what running it takes, for the listing.
        produce: the route itself, returning file id to asset path. It is free
            to return ids outside the custom space; the merge is what confines
            them, so no route has to remember the rule.
        golden: a known-good copy to verify against, under `REFERENCE`.
        reference: reads that copy into rows comparable with `produce`. The
            copies were written by the exploration that found each route and
            are in whatever shape it happened to use, so the conversion belongs
            to the route rather than to the verification.
        compare: narrows produced rows to the part the copy covers, for a copy
            that records only some of what the route now yields.
    """

    name: str
    summary: str
    needs: str
    cost: str
    produce: Callable[[], dict[int, str]]
    golden: str | None = None
    reference: Callable[[dict[str, str]], dict[int, str]] | None = None
    compare: Callable[[dict[int, str]], dict[int, str]] | None = None


def _icons() -> dict[int, str]:
    return icon_names()


def _objects() -> dict[int, str]:
    return object_names(read_object_dump(cached=REFERENCE / "dump_gob_names.json"),
                        SUPPLEMENT_FLOOR)


ROUTES: tuple[Route, ...] = (
    Route(name="icons",
          summary="the client's own icon database, in an addon it ships",
          needs="the install",
          cost="a second",
          produce=_icons,
          golden="epsilon_icon_names.json",
          # The copy holds bare icon names; the route yields the paths they
          # resolve to, and covers the stock icons this one does not.
          reference=lambda raw: {int(fid): f"{ICON_DIRECTORY}/{name}.blp"
                                 for fid, name in raw.items()
                                 if int(fid) > SUPPLEMENT_FLOOR},
          compare=lambda rows: {fid: path for fid, path in rows.items()
                                if fid > SUPPLEMENT_FLOOR}),
    Route(name="objects",
          summary="the gameobject-display walk through the client API",
          needs="a captured dump",
          cost="an evening in game, once",
          produce=_objects,
          golden="pseudo_paths.json",
          # The copy records only the names that had to be derived, not the
          # ones the client already reported as paths.
          reference=lambda raw: {int(fid): path for fid, path in raw.items()},
          compare=lambda rows: {fid: path for fid, path in rows.items()
                                if path.startswith(f"{ROOT_BUCKET}/")}),
)
"""Every route, in priority order.

Highest first, and the ordering principle is how much the name is worth rather
than how much it cost: a name the game itself uses beats one the client reports,
which beats one derived from where a file hangs.
"""


def read_rows(path: Path) -> dict[int, str]:
    """One `<file id>;<path>` file, plain or gzipped."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:  # type: ignore[operator]
        rows = {}
        for line in handle:
            fid, separator, asset = line.partition(";")
            if separator:
                rows[int(fid)] = asset.strip()
    return rows


def write_rows(path: Path, rows: dict[int, str]) -> None:
    """Write `<file id>;<path>`, sorted by id.

    Sorted so that two runs of the same routes produce the same bytes, which is
    what lets an unchanged rebuild stage nothing.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, delimiter=";", lineterminator="\n")
        for fid in sorted(rows):
            writer.writerow([fid, rows[fid]])


def golden_rows(route: Route) -> dict[int, str] | None:
    """The known-good copy of a route's output, in the shape the route returns.

    Returns None when there is no copy on disk, which is not a failure: the
    copies are a convenience for checking a rewrite, not an input.
    """
    if route.golden is None or route.reference is None:
        return None
    path = REFERENCE / route.golden
    if not path.exists():
        return None
    return route.reference(json.loads(path.read_text(encoding="utf-8")))


def run_route(route: Route) -> dict[int, str]:
    """Run one route and write its own output file."""
    rows = route.produce()
    write_rows(WORK / f"{route.name}.csv", rows)
    return rows


def merge(produced: dict[str, dict[int, str]]) -> tuple[dict[int, str], list[str]]:
    """Fold every route's rows into one supplement, in priority order.

    Args:
        produced: route name to its rows.

    Returns:
        The merged rows, and one report line per route saying what it added.
    """
    merged: dict[int, str] = {}
    report = []
    for route in ROUTES:
        rows = produced.get(route.name)
        if rows is None:
            continue
        admitted = {fid: path for fid, path in rows.items() if fid > SUPPLEMENT_FLOOR}
        fresh = {fid: path for fid, path in admitted.items() if fid not in merged}
        merged.update(fresh)
        below = len(rows) - len(admitted)
        note = f", {below:,} below the floor" if below else ""
        report.append(f"  {route.name:12} {len(rows):>8,} rows, "
                      f"{len(fresh):>8,} new{note}")
    return merged, report


def show_list() -> None:
    """Print what each route needs and costs, without running anything."""
    log(f"\n  {'route':12} {'needs':18} {'cost':24} what it reads")
    for route in ROUTES:
        log(f"  {route.name:12} {route.needs:18} {route.cost:24} {DIM}{route.summary}{RESET}")
    log("")


def verify() -> int:
    """Check every route that has a known-good copy against it.

    Returns:
        A process exit status: non-zero if any route disagrees with its copy.
    """
    failures = 0
    for route in ROUTES:
        expected = golden_rows(route)
        if expected is None:
            log(f"  {YELLOW}skip{RESET}  {route.name:12} {DIM}no reference copy on disk{RESET}")
            continue
        actual = route.produce()
        if route.compare is not None:
            actual = route.compare(actual)

        if actual == expected:
            log(f"  {GREEN}ok{RESET}    {route.name:12} {DIM}{len(actual):,} rows "
                f"reproduced exactly{RESET}")
            continue
        failures += 1
        missing, extra = set(expected) - set(actual), set(actual) - set(expected)
        differing = [fid for fid in set(actual) & set(expected)
                     if actual[fid] != expected[fid]]
        log(f"  {RED}FAIL{RESET}  {route.name:12} {len(missing):,} missing, "
            f"{len(extra):,} unexpected, {len(differing):,} differing")
        for fid in sorted(differing)[:3]:
            log(f"          {fid}  got {actual[fid]}")
            log(f"          {' ' * len(str(fid))}  want {expected[fid]}")
    return 1 if failures else 0


def diff_against_vendored(merged: dict[int, str]) -> None:
    """Report how the reconstruction differs from what the build reads."""
    if not VENDORED.exists():
        log(f"  {YELLOW}warn{RESET}  nothing vendored at {VENDORED}")
        return
    current = read_rows(VENDORED)
    added = {fid for fid in merged if fid not in current}
    lost = {fid for fid in current if fid not in merged}
    changed = {fid for fid in set(merged) & set(current) if merged[fid] != current[fid]}

    log(f"\n  vendored      {len(current):,}")
    log(f"  reconstructed {len(merged):,}")
    log(f"  added         {len(added):,}")
    log(f"  {'lost' if lost else 'lost':13} {len(lost):,}"
        + (f"   {RED}a vendored name this run cannot reproduce{RESET}" if lost else ""))
    log(f"  changed       {len(changed):,}")
    for fid in sorted(lost)[:5]:
        log(f"    {DIM}lost{RESET} {fid}  {current[fid]}")
    for fid in sorted(changed)[:5]:
        log(f"    {DIM}was{RESET}  {fid}  {current[fid]}")
        log(f"    {DIM}now{RESET}  {fid}  {merged[fid]}")


def main() -> int:
    """Run the routes asked for, merge them, and report."""
    survive_console_encoding()
    parser = argparse.ArgumentParser(
        description="Reconstruct the Epsilon asset-name supplement.")
    parser.add_argument("--list", action="store_true",
                        help="what each route needs and costs; run nothing")
    parser.add_argument("--only", metavar="ROUTE", action="append",
                        choices=[route.name for route in ROUTES],
                        help="run only this route (repeatable)")
    parser.add_argument("--verify", action="store_true",
                        help="check each route against its known-good copy")
    parser.add_argument("--diff", action="store_true",
                        help="compare the merged result against the vendored file")
    args = parser.parse_args()

    if args.list:
        show_list()
        return 0
    if args.verify:
        return verify()

    wanted = [route for route in ROUTES
              if args.only is None or route.name in args.only]
    produced: dict[str, dict[int, str]] = {}
    for route in wanted:
        try:
            produced[route.name] = run_route(route)
        except (OSError, ValueError) as exc:
            log(f"  {RED}FAIL{RESET}  {route.name:12} {exc}")
            return 1

    merged, report = merge(produced)
    log("")
    for line in report:
        log(line)
    write_rows(WORK / "supplement.csv", merged)
    log(f"\n  merged        {len(merged):,} rows -> {WORK / 'supplement.csv'}")

    if args.diff:
        diff_against_vendored(merged)
    return 0


if __name__ == "__main__":
    sys.exit(main())
