#!/usr/bin/env python3
"""Mirror the SHIPPED PACKS into DuckDB, one schema per game version.

    uv run python tools/packdb.py              # every pack on disk
    uv run python tools/packdb.py 9.2.7        # one pack (prefix match)
    uv run python tools/packdb.py --list       # what would be built

THE SECOND DATABASE, AND THE DISTINCTION IS THE POINT.

    .cache/epsilook.duckdb        the SOURCES  (tools/builddb.py)
    .cache/epsilook-packs.duckdb  the ARTIFACT (this)

The first answers "what does the game data say"; this answers "what did we
actually ship". They are different questions and they disagree in interesting
ways -- a route that drops rows, a section that came out empty on one build, a
value the cooker elided. Neither can be checked against the other while only
one of them is queryable, which is the gap this closes.

It reads only `site/data/`, so it never touches the download cache and cannot
be confused by one. Nothing in the product reads the result: it is a
development tool, and deleting it costs the time to rebuild.

THE SHAPE OF A PACK, and why every section lands as a table. A pack is one
JSON object of ~80 sections in six shapes, all of which reduce to rows:

    parallel arrays   {ids: [...], names: [...]}  -> one column each
    ragged arrays     the same, where one column counts something else
                      -> split into a table per length, since a row must mean
                         one thing
    lookup            {"3": "Elite"}      -> (key, value)
    list              ["Stand", "Death"]  -> (idx, value), because position IS
                                             the id in every list a pack ships
    nested            meta                -> (key, value), values as JSON

That list is closed and checked: an unrecognised shape stops the build rather
than being guessed at, because a silently skipped section is the failure this
tool would otherwise have.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from pathlib import Path
from typing import Any

from packs import schema_name, select
from repo import (CACHE, DIM, GREEN, RESET, ROOT, YELLOW, log,
                  survive_console_encoding)

survive_console_encoding()

try:
    import duckdb  # type: ignore[import-not-found]
    import pyarrow  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - a development-tool dependency
    sys.exit(
        "tools/packdb.py needs DuckDB and PyArrow, which pyproject.toml declares:\n"
        "    uv run python tools/packdb.py"
    )

DATA = ROOT / "site" / "data"
DB_PATH = CACHE / "epsilook-packs.duckdb"


# DuckDB column types by the Python type a pack actually carries. A pack holds
# no floats outside meta, but a section is free to grow one.
SQL_TYPE = {bool: "BOOLEAN", int: "BIGINT", float: "DOUBLE", str: "VARCHAR"}


def column_type(values: list[Any]) -> str:
    """The SQL type for a column, from the first value that is not null.

    An all-null column is VARCHAR: it carries no evidence, and a wrong integer
    type would refuse the strings a later build puts there.
    """
    for value in values:
        if value is not None:
            return SQL_TYPE.get(type(value), "VARCHAR")
    return "VARCHAR"


def tables_for(name: str, section: Any) -> list[tuple[str, list[str], list[list[Any]]]]:
    """Reduce one pack section to (table, columns, columns-of-values).

    Returns more than one table only for a ragged section, where columns of
    different lengths are counting different things and a single row would
    have to pretend otherwise.
    """
    if isinstance(section, dict) and section and all(isinstance(v, list) for v in section.values()):
        by_length: dict[int, list[str]] = {}
        for column, values in section.items():
            by_length.setdefault(len(values), []).append(column)
        if len(by_length) == 1:
            columns = list(section)
            return [(name, columns, [section[c] for c in columns])]
        # Ragged: the longest group keeps the section's name, and each other
        # group is named for the single column that makes it up.
        out = []
        for length, columns in sorted(by_length.items(), key=lambda kv: -kv[0]):
            table = name if length == max(by_length) else f"{name}_{columns[0]}"
            out.append((table, columns, [section[c] for c in columns]))
        return out
    if isinstance(section, dict) and all(
            not isinstance(v, (list, dict)) for v in section.values()):
        keys = list(section)
        return [(name, ["key", "value"], [keys, [section[k] for k in keys]])]
    if isinstance(section, dict):  # nested, e.g. meta -- values as JSON text
        keys = list(section)
        return [(name, ["key", "value"],
                 [keys, [json.dumps(section[k], separators=(",", ":")) for k in keys]])]
    if isinstance(section, list):
        return [(name, ["idx", "value"], [list(range(len(section))), section])]
    raise TypeError(f"section {name!r} has an unrecognised shape: {type(section).__name__}")


def load_pack(connection: Any, pack_id: str, path: Path) -> tuple[int, int]:
    """Write one pack into its own schema. Returns (tables, rows).

    A pack is already columns, so it is handed over as columns. Arrow arrays
    built from the parsed lists register into DuckDB without a per-row bind,
    which is the difference between seconds and minutes for a pack whose
    largest section is 1.3 million rows.

    The two routes that look plausible and are not: binding rows with
    `executemany` costs minutes because every value crosses the boundary
    individually, and reading the JSON with DuckDB's own reader leaves the
    whole pack in ONE nested row, so each of the ~62 sections re-scans the
    entire artifact to project itself.
    """
    schema = schema_name(pack_id)
    connection.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
    connection.execute(f'CREATE SCHEMA "{schema}"')

    with gzip.open(path, "rt", encoding="utf-8") as handle:
        pack = json.load(handle)

    tables = rows = 0
    for name, section in pack.items():
        for table, columns, data in tables_for(name, section):
            if data and data[0]:
                arrow = pyarrow.table(dict(zip(columns, data)))
                connection.register("section", arrow)
                connection.execute(
                    f'CREATE TABLE "{schema}"."{table}" AS SELECT * FROM section')
                connection.unregister("section")
            else:
                spec = ", ".join(f'"{c}" {column_type(v)}' for c, v in zip(columns, data))
                connection.execute(f'CREATE TABLE "{schema}"."{table}" ({spec})')
            tables += 1
            rows += len(data[0]) if data else 0
    return tables, rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", nargs="*", help="pack id or a prefix (default: all)")
    parser.add_argument("--list", action="store_true", help="print what would be built")
    parser.add_argument("--db", default=str(DB_PATH), help=f"output (default {DB_PATH})")
    args = parser.parse_args()

    chosen = [(p, DATA / p.id / "spelldata.json.gz")
              for p in (select(" ".join(args.version)) if args.version else select(None))]
    chosen = [(p, path) for p, path in chosen if path.exists()]
    if not chosen:
        log(f"{YELLOW}no packs on disk{RESET}")
        return 0

    if args.list:
        for pack, path in chosen:
            log(f"  {schema_name(pack.id):<10} {pack.id:<22} {path.stat().st_size / 1e6:>6.1f} MB  {pack.label}")
        return 0

    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(args.db)
    total_tables = total_rows = 0
    try:
        for index, (pack, path) in enumerate(chosen, 1):
            started = time.time()
            log(f"{DIM}[{index}/{len(chosen)}] {pack.id}  {pack.label}{RESET}")
            tables, rows = load_pack(connection, pack.id, path)
            total_tables += tables
            total_rows += rows
            log(f"  {schema_name(pack.id):<10} {tables:>3} tables  {rows:>10,} rows"
                f"  [{time.time() - started:.1f}s]")
    finally:
        connection.close()

    size = Path(args.db).stat().st_size
    log(f"\n{GREEN}{len(chosen)} pack(s){RESET}  {total_tables} tables, "
        f"{total_rows:,} rows  -> {args.db} ({size / 1e6:,.0f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
