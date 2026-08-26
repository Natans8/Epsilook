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
JSON object of ~80 sections, and the shapes reduce to rows:

    parallel arrays   {ids: [...], names: [...]}  -> one column each
    ragged arrays     the same, where one column counts something else
                      -> split into a table per length, since a row must mean
                         one thing
    lookup            {"3": "Elite"}      -> (key, value)
    list              ["Stand", "Death"]  -> (idx, value), because position IS
                                             the id in every list a pack ships
    grouped           {missile: {...}, ground: {...}} -> a table per group,
                                             named for the path down to it
    nested            meta                -> (key, value), values as JSON

That list is closed and checked: an unrecognised shape stops the build rather
than being guessed at, because a silently skipped section is the failure this
tool would otherwise have.

THE SECTION REGISTRY IS WHAT SAYS WHICH SHAPE, rather than this file guessing.
A pack column ships in a declared layout -- dense, sparse or a deduped pool
plus one index per row -- and a reader that does not undo the layout sees the
pool and the index instead of the column. That is not hypothetical: before the
registry was read here, `spellText` and all five `*Rows` sections landed as one
(key, value) row apiece holding megabytes of JSON, so the entire row model and
every cooked description were in the mirror and unqueryable. `pack.encode`
decodes them, which is also why the decode lives beside the encoder rather than
here.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import packfile
from packs import schema_name, select
from repo import CACHE, DIM, GREEN, RESET, ROOT, YELLOW, log, survive_console_encoding

sys.path.insert(0, str(ROOT / "build"))

from pack.encode import EMPTY_SLOT, FEWEST_BYTES, decode_column, layout_for  # noqa: E402
from pack.model import SECTIONS  # noqa: E402
from pack.model.section import Encoding, Layout  # noqa: E402

survive_console_encoding()

try:
    import duckdb  # type: ignore[import-not-found]
    import pyarrow  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover - a development-tool dependency
    sys.exit(
        "tools/packdb.py needs DuckDB and PyArrow, which pyproject.toml declares:\n    uv run python tools/packdb.py"
    )

DATA = ROOT / "site" / "data"
DB_PATH = CACHE / "epsilook-packs.duckdb"

DECLARED = {section.name: section for section in SECTIONS}
"""Every section the build declares, by the key it ships under.

`meta` is the one thing in a pack that is not here: it describes the pack
rather than being one of its sections, and it is the manifest's, not a
producer's.
"""


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


def _length(shipped: Any, layout: Encoding) -> int:
    """How many rows a shipped column covers, where it says.

    Dense is its own length and a deduped index is one entry per row. Sparse is
    the one that cannot answer -- it ships the rows carrying a value and
    nothing about the gaps after the last of them -- so it reports nothing and
    lets a sibling column say.
    """
    if layout is Encoding.DENSE:
        return len(shipped) if isinstance(shipped, list) else 0
    if layout is Encoding.DEDUP:
        return len(shipped["of"])
    return 0


def decoded(name: str, section: Any) -> Any:
    """One section with every column's layout undone.

    What the section's `produce` returned, recovered from what shipped. A
    section the registry does not declare is handed back untouched, which is
    `meta` and nothing else.

    A sparse column ships only the rows that carry a value, so the row count
    has to come from somewhere: the section's other columns are the only place
    it exists, and the longest of them is the section's length.
    """
    declaration = DECLARED.get(name)
    if declaration is None:
        return section
    shipped = {declaration.columns[0]: section} if declaration.layout is Layout.BARE else section
    layouts = {column: layout_for(declaration, column, FEWEST_BYTES) for column in declaration.columns}
    rows = max(
        (_length(shipped[column], layouts[column]) for column in declaration.columns if column in shipped), default=0
    )
    columns = {
        column: decode_column(shipped[column], layouts[column], declaration.absent.get(column, EMPTY_SLOT), rows)
        for column in declaration.columns
        if column in shipped
    }
    return columns[declaration.columns[0]] if declaration.layout is Layout.BARE else columns


def tables_for(name: str, section: Any) -> list[tuple[str, list[str], list[list[Any]]]]:
    """Reduce one pack section to (table, columns, columns-of-values).

    Returns more than one table where the section holds things of different
    lengths -- columns counting different things, or a column that is itself a
    group of columns. A row has to mean one thing, and those cannot share one.
    """
    section = decoded(name, section)
    return _tables(name, section)


def _tables(name: str, section: Any) -> list[tuple[str, list[str], list[list[Any]]]]:
    """`tables_for` past the decode, so the recursion does not decode twice."""
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
    if isinstance(section, dict) and all(not isinstance(v, (list, dict)) for v in section.values()):
        keys = list(section)
        values = [section[k] for k in keys]
        # A column holds one type. Most lookups are uniform and land as what
        # they are; the ones that are not -- a vocabulary naming a word for one
        # property and a number for the next -- would otherwise fail the load
        # on whichever value the inference did not expect, so they land as the
        # text of what they were.
        if len({type(value) for value in values}) > 1:
            values = [json.dumps(value, separators=(",", ":")) for value in values]
        return [(name, ["key", "value"], [keys, values])]
    if isinstance(section, dict) and any(isinstance(v, dict) for v in section.values()):
        # Grouped: a column that is itself columns. The row model ships this way
        # -- one group of properties per row kind -- and flattening it into JSON
        # is what made the whole of it unqueryable. Each group becomes its own
        # table, named for the path down to it, because a name assembled from
        # the path is the one thing that cannot collide with a sibling's.
        out = []
        for key, value in section.items():
            if isinstance(value, (dict, list)):
                # An empty group is a real answer -- no kind carries a column
                # no property declares -- and it lands as an empty table rather
                # than as a row holding nothing.
                out.extend(_tables(f"{name}_{key}", value) if value else [(f"{name}_{key}", ["value"], [[]])])
            else:
                # A scalar beside the groups: nothing to recurse into, and
                # dropping it would lose it silently.
                out.append((f"{name}_{key}", ["value"], [[value]]))
        return out
    if isinstance(section, dict):  # nested, e.g. meta -- values as JSON text
        keys = list(section)
        return [(name, ["key", "value"], [keys, [json.dumps(section[k], separators=(",", ":")) for k in keys]])]
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

    pack = packfile.load(path)

    tables = rows = 0
    for name, section in pack.items():
        for table, columns, data in tables_for(name, section):
            if data and data[0]:
                arrow = pyarrow.table(dict(zip(columns, data)))
                connection.register("section", arrow)
                connection.execute(f'CREATE TABLE "{schema}"."{table}" AS SELECT * FROM section')
                connection.unregister("section")
            else:
                spec = ", ".join(f'"{c}" {column_type(v)}' for c, v in zip(columns, data))
                connection.execute(f'CREATE TABLE "{schema}"."{table}" ({spec})')
            tables += 1
            rows += len(data[0]) if data else 0
    return tables, rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("version", nargs="*", help="pack id or a prefix (default: all)")
    parser.add_argument("--list", action="store_true", help="print what would be built")
    parser.add_argument("--db", default=str(DB_PATH), help=f"output (default {DB_PATH})")
    args = parser.parse_args()

    chosen = [(p, DATA / p.id) for p in (select(" ".join(args.version)) if args.version else select(None))]
    chosen = [(p, path) for p, path in chosen if (path / "manifest.json").exists()]
    if not chosen:
        log(f"{YELLOW}no packs on disk{RESET}")
        return 0

    if args.list:
        for pack, path in chosen:
            megabytes = sum(packfile.sizes(path).values()) / 1e6
            log(f"  {schema_name(pack.id):<10} {pack.id:<22} {megabytes:>6.1f} MB  {pack.label}")
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
            log(f"  {schema_name(pack.id):<10} {tables:>3} tables  {rows:>10,} rows  [{time.time() - started:.1f}s]")
    finally:
        connection.close()

    size = Path(args.db).stat().st_size
    log(
        f"\n{GREEN}{len(chosen)} pack(s){RESET}  {total_tables} tables, "
        f"{total_rows:,} rows  -> {args.db} ({size / 1e6:,.0f} MB)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
