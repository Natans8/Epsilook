"""Reconstruct the vendored asset-name supplement, one route at a time.

The supplement is the only source the build cannot fetch: it names the assets a
private client adds, which no public listfile knows about. This is the procedure
that rebuilds it, and the reason it is a script rather than a note is that the
routes disagree about cost by four orders of magnitude -- one reads a file in the
install, another needs somebody to log in and walk a client API for an evening --
so which routes to run is a decision, and a decision needs the numbers in front
of it.

    uv run python tools/supplement.py              run every route, and merge
    uv run python tools/supplement.py --list       what each route needs and costs
    uv run python tools/supplement.py --only icons one route
    uv run python tools/supplement.py --verify     check routes against known-good copies
    uv run python tools/supplement.py --diff       compare against what is vendored
    uv run python tools/supplement.py --coverage   what is still unnamed, by kind
    uv run python tools/supplement.py --network    let the walks fetch what is not on disk

Routes are declared, not branched on: a new one is a row in `ROUTES` naming what
it needs and what it yields, and the merge, the report and the verification all
read that row. Order in `ROUTES` is priority order -- where two routes name the
same file, the earlier one wins, because they are listed from names the game
itself uses down to names derived from where a file hangs.

The written procedure, including what to check by hand and what is still
unnamed, is `docs/SUPPLEMENT.md`.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import sys
from collections import Counter
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
        produce: the route itself, given every name the routes before it
            settled and returning file id to asset path. Most ignore what they
            are given; a walk cannot, because it derives a child's path from its
            parent's name and so can only reach what is already named. It is
            free to return ids outside the custom space; the merge is what
            confines them, so no route has to remember the rule.
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
    produce: Callable[[dict[int, str]], dict[int, str]]
    golden: str | None = None
    reference: Callable[[dict[str, str]], dict[int, str]] | None = None
    compare: Callable[[dict[int, str]], dict[int, str]] | None = None


_STORAGE: object | None = None

# How many custom files the storage declares. Only the walks need it, and
# opening it costs a service round trip and a pass over the encoding file, so
# nothing opens it until a walk asks.
LOCAL_ONLY = True
"""Whether a walk refuses to reach the network.

The default, and it is a measured choice rather than caution. The install holds
under half the files a walk would want, but overlap saturates: reading the other
half took a walk from 4,151 derived names to 4,861, for sixty per cent more
files and a great many more requests. The switch exists because that last few
hundred is sometimes worth it, not because the default is a compromise.
"""


def storage() -> object:
    """The opened storage, shared between the walks that need it."""
    global _STORAGE  # pylint: disable=global-statement
    if _STORAGE is None:
        # Imported here so that the routes which read no game content keep
        # running on an interpreter that has none of the build's dependencies.
        from epsilon_storage import EpsilonStorage  # pylint: disable=import-outside-toplevel
        from epsilon_names import INSTALL  # pylint: disable=import-outside-toplevel
        _STORAGE = EpsilonStorage(INSTALL)
    return _STORAGE


def _icons(_known: dict[int, str]) -> dict[int, str]:
    return icon_names()


def _objects(_known: dict[int, str]) -> dict[int, str]:
    return object_names(read_object_dump(cached=REFERENCE / "dump_gob_names.json"),
                        SUPPLEMENT_FLOOR)


def _terrain(_known: dict[int, str]) -> dict[int, str]:
    from epsilon_walks import terrain_names  # pylint: disable=import-outside-toplevel
    return terrain_names(storage(), SUPPLEMENT_FLOOR)  # type: ignore[arg-type]


def _customization(_known: dict[int, str]) -> dict[int, str]:
    from epsilon_walks import customization_names  # pylint: disable=import-outside-toplevel
    return customization_names(storage(), SUPPLEMENT_FLOOR)  # type: ignore[arg-type]


def _unnamed(known: dict[int, str]) -> set[int]:
    """Every custom file id no route has named yet."""
    return set(storage().custom_fids(SUPPLEMENT_FLOOR)) - known.keys()  # type: ignore[attr-defined]


def _world_models(known: dict[int, str]) -> dict[int, str]:
    from epsilon_walks import world_model_children  # pylint: disable=import-outside-toplevel
    return world_model_children(storage(), known, _unnamed(known),  # type: ignore[arg-type]
                                local_only=LOCAL_ONLY).names


def _models(known: dict[int, str]) -> dict[int, str]:
    from epsilon_walks import model_children  # pylint: disable=import-outside-toplevel
    return model_children(storage(), known, _unnamed(known),  # type: ignore[arg-type]
                          local_only=LOCAL_ONLY).names


ROUTES: tuple[Route, ...] = (
    Route(name="terrain",
          summary="the map table, and each map's own grid of tiles",
          needs="the storage",
          cost="a minute",
          produce=_terrain),
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
    Route(name="customization",
          summary="textures named by the character option and choice they paint",
          needs="the storage",
          cost="a minute",
          produce=_customization),
    Route(name="worldmodels",
          summary="group geometry and material textures, from the models using them",
          needs="the storage",
          cost="minutes",
          produce=_world_models),
    Route(name="models",
          summary="skins, textures and animations, from the models using them",
          needs="the storage",
          cost="minutes",
          produce=_models),
)
"""Every route, in priority order.

Highest first, and the ordering principle is how much the name is worth rather
than how much it cost: a name the game itself uses beats one the client reports,
which beats one derived from where a file hangs.
"""


_NAME_WIDTH = max(len(route.name) for route in ROUTES)
"""How wide a route's name column is, so every report lines up."""


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


def run(wanted: list[Route], seed: dict[int, str]) -> tuple[dict[int, str], list[str]]:
    """Run routes in priority order, merging as it goes.

    Merging between routes rather than after them all is what lets a walk work:
    it derives a child's path from its parent's name, so it has to see what the
    routes before it settled. That also makes the order meaningful in two ways
    at once -- earlier wins a conflict, and earlier feeds what comes later.

    Args:
        wanted: the routes to run, already in priority order.
        seed: names to start from, for a run of only some routes.

    Returns:
        The merged rows, and one report line per route.
    """
    merged = dict(seed)
    report = []
    for route in wanted:
        rows = route.produce(merged)
        write_rows(WORK / f"{route.name}.csv", rows)
        admitted = {fid: path for fid, path in rows.items() if fid > SUPPLEMENT_FLOOR}
        fresh = {fid: path for fid, path in admitted.items() if fid not in merged}
        merged.update(fresh)
        below = len(rows) - len(admitted)
        note = f", {below:,} below the floor" if below else ""
        report.append(f"  {route.name:{_NAME_WIDTH}} {len(rows):>8,} rows, "
                      f"{len(fresh):>8,} new{note}")
    return merged, report


def show_list() -> None:
    """Print what each route needs and costs, without running anything."""
    # Widths come from the routes rather than from a guess, so adding one whose
    # name is longer than the rest does not silently break the alignment.
    name = max(len(route.name) for route in ROUTES)
    needs = max(len(route.needs) for route in ROUTES)
    cost = max(len(route.cost) for route in ROUTES)
    log(f"\n  {'route':{name}} {'needs':{needs}} {'cost':{cost}} what it reads")
    for route in ROUTES:
        log(f"  {route.name:{name}} {route.needs:{needs}} {route.cost:{cost}} "
            f"{DIM}{route.summary}{RESET}")
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
            log(f"  {YELLOW}skip{RESET}  {route.name:{_NAME_WIDTH}} "
                f"{DIM}no reference copy on disk{RESET}")
            continue
        actual = route.produce({})
        if route.compare is not None:
            actual = route.compare(actual)

        if actual == expected:
            log(f"  {GREEN}ok{RESET}    {route.name:{_NAME_WIDTH}} "
                f"{DIM}{len(actual):,} rows reproduced exactly{RESET}")
            continue
        failures += 1
        missing, extra = set(expected) - set(actual), set(actual) - set(expected)
        differing = [fid for fid in set(actual) & set(expected)
                     if actual[fid] != expected[fid]]
        log(f"  {RED}FAIL{RESET}  {route.name:{_NAME_WIDTH}} {len(missing):,} missing, "
            f"{len(extra):,} unexpected, {len(differing):,} differing")
        for fid in sorted(differing)[:3]:
            log(f"          {fid}  got {actual[fid]}")
            log(f"          {' ' * len(str(fid))}  want {expected[fid]}")
    return 1 if failures else 0


def coverage(merged: dict[int, str]) -> None:
    """Report what is named, and classify what is not.

    Total coverage is the goal, so the remainder is the output that matters:
    a count says how far there is to go, and the classification says which
    route would go there. Only files the install already holds are opened,
    because this is a report rather than a walk.
    """
    from epsilon_walks import classify  # pylint: disable=import-outside-toplevel

    from tqdm import tqdm  # pylint: disable=import-outside-toplevel

    custom = storage().custom_fids(SUPPLEMENT_FLOOR)  # type: ignore[attr-defined]
    named = [fid for fid in custom if fid in merged]
    unnamed = [fid for fid in custom if fid not in merged]
    log(f"\n  custom files  {len(custom):,}")
    log(f"  named         {len(named):,} ({len(named) / len(custom):.1%})")
    log(f"  unnamed       {len(unnamed):,}")

    storage().encoding_keys(unnamed)  # type: ignore[attr-defined]
    here = [fid for fid in unnamed
            if storage().holds_locally(fid)]  # type: ignore[attr-defined]

    # With the network allowed there is no reason to report on a subset. The
    # question this answers is what the remainder IS, and an answer drawn only
    # from the files that happen to be cached describes the cache instead.
    opening = here if LOCAL_ONLY else unnamed
    if opening is not here:
        storage().prepare_network()  # type: ignore[attr-defined]

    kinds: Counter[str] = Counter()
    unreadable = 0
    for fid in tqdm(opening, desc="classifying", unit="file"):
        raw = storage().read(fid, local_only=LOCAL_ONLY)  # type: ignore[attr-defined]
        if raw is None:
            unreadable += 1
        else:
            kinds[classify(raw)] += 1

    scope = "unnamed the install holds" if LOCAL_ONLY else "unnamed"
    log(f"\n  of the {len(opening):,} {scope}:")
    for kind, count in kinds.most_common():
        log(f"    {kind:22} {count:>7,}")
    if unreadable:
        log(f"    {'unreadable':22} {unreadable:>7,}")
    if len(opening) < len(unnamed):
        log(f"    {DIM}{len(unnamed) - len(opening):,} more are not held locally "
            f"and were not opened; --network includes them{RESET}")


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
    parser.add_argument("--network", action="store_true",
                        help="let the walks read files the install does not hold")
    parser.add_argument("--coverage", action="store_true",
                        help="report what is still unnamed, classified by kind")
    args = parser.parse_args()

    if args.list:
        show_list()
        return 0
    if args.verify:
        return verify()

    global LOCAL_ONLY  # pylint: disable=global-statement
    LOCAL_ONLY = not args.network

    wanted = [route for route in ROUTES
              if args.only is None or route.name in args.only]

    # A walk run on its own still needs the names the routes before it settled,
    # so a partial run starts from the last full one rather than from nothing.
    seed: dict[int, str] = {}
    previous = WORK / "supplement.csv"
    if args.only and previous.exists():
        seed = read_rows(previous)
        log(f"  {DIM}starting from {len(seed):,} names in {previous.name}{RESET}")

    try:
        merged, report = run(wanted, seed)
    except (OSError, ValueError, LookupError) as exc:
        log(f"  {RED}FAIL{RESET}  {exc}")
        return 1
    log("")
    for line in report:
        log(line)
    write_rows(WORK / "supplement.csv", merged)
    log(f"\n  merged        {len(merged):,} rows -> {WORK / 'supplement.csv'}")

    if args.diff:
        diff_against_vendored(merged)
    if args.coverage:
        coverage(merged)
    return 0


if __name__ == "__main__":
    sys.exit(main())
