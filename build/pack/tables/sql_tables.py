"""Tables served from the same CSV files, read through DuckDB.

A peer of `CsvTables` in contract, a development instrument in role: the two
answer every question in the contract suite identically, which is what makes
this a second, independent reading of the same sources -- exploration and
validation, while `csv` is what ships. Nothing in the shipped path reads
through it, and that is the settled division of labour rather than a stage
still pending.

Two decisions are worth knowing before changing anything here.

Values come back as text, and that is deliberate. DuckDB honours the widths a
`.dbd` declares, so a float read as float32 prints different low-order digits
from the same field read as Python's float64: `-10454.0654296875` against
`-10454.065429688`. Either provider may serve a build, so a typed read here
would make which one ran decide what a pack says. `all_varchar` turns the
question off at the source, and the route parses the text exactly as it always
did. Typing belongs to whatever stage decides to re-baseline for it.

The attachment is SQL and every read is an expression. Naming a CSV takes one
DuckDB-specific statement, because `read_csv`'s options are named arguments no
SQL builder emits. Past that the table is an ordinary relation: the projection
is built with SQLAlchemy Core, so a table and a column arriving from a game
export are quoted as identifiers rather than pasted into a string.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator, Sequence
from pathlib import Path

import duckdb
import sqlalchemy as sa
from duckdb_sqlalchemy import Dialect

from ..drift import OPTIONAL_COLUMNS, OPTIONAL_TABLES
from .projection import absent, project

MAX_LINE = 20_000_000
"""How long a CSV line may be, in bytes.

DuckDB defaults to two megabytes and fails the scan past it; the plain reader
raises its own limit to ten megabytes per FIELD, so the generous number is the
one that keeps the two providers reading the same files.
"""

CHUNK = 50_000
"""Rows fetched per round trip.

The scan streams rather than materialising: `SpellEffect` is 420,713 rows on
9.2.7 and the routes consume it one row at a time.
"""

DIALECT = Dialect()
"""The dialect the projections compile against.

Held once because it is stateless and building one per read would be the only
per-read allocation in this file that buys nothing.
"""


class SqlTables:
    """One directory of `<table>.csv` files, presented row-wise as text.

    Each table is attached as a view over its file the first time it is asked
    for, in one in-memory database per instance. Nothing is copied: DuckDB scans
    the CSV where it lies, so attaching costs a header read.
    """

    def __init__(self, directory: Path, *,
                 absent_tables: dict[str, str] | None = None,
                 defaults: dict[tuple[str, str], str] | None = None) -> None:
        """Serve the CSVs in `directory`.

        `absent_tables` and `defaults` fall back to the build-wide drift
        declarations; a test or a second source passes its own.
        """
        self.directory = directory
        self.absent_tables = OPTIONAL_TABLES if absent_tables is None else absent_tables
        self.defaults = OPTIONAL_COLUMNS if defaults is None else defaults
        self._database: duckdb.DuckDBPyConnection | None = None
        self._attached: dict[str, sa.Table] = {}
        self._metadata = sa.MetaData()

    def path_of(self, table: str) -> Path:
        """Where a table's file would be, whether or not it exists."""
        return self.directory / f"{table}.csv"

    def available(self, table: str) -> bool:
        """Whether this source has the table at all."""
        return self.path_of(table).exists()

    def header(self, table: str) -> list[str]:
        """The table's column names, in source order; empty when it is absent.

        Empty rather than fatal for a file that exists and says nothing, too:
        this is the question asked before anybody knows whether there is a table
        to read, and `rows` is where an unreadable one has to be fatal.
        """
        attached = self._attach(table)
        return [column.name for column in attached.columns] if attached is not None else []

    def rows(self, table: str, columns: Sequence[str]) -> Iterator[tuple[str, ...]]:
        """Yield the named columns of every row, in file order.

        A declared-absent table yields nothing and a declared-optional column
        yields its stand-in; anything undeclared exits.
        """
        if not self.available(table):
            absent(table, self.absent_tables, self.directory)
            return
        attached = self._attach(table)
        if attached is None:
            sys.exit(f"error: {table}.csv in {self.directory} is empty; it has no "
                     f"header row, so the cached copy is incomplete")

        plan = project(table, [column.name for column in attached.columns], columns,
                       defaults=self.defaults)
        # A row of no columns is still a row, and the plain reader yields one
        # empty tuple for each. SQL has no zero-column select, so the count is
        # what gets asked for and the shape is restored on the way out.
        chosen = [sa.func.coalesce(attached.c[source], "")
                  if source is not None else sa.literal(stand_in)
                  for source, stand_in in zip(plan.sources, plan.stand_ins)]
        # Named rather than inferred from the columns, because a request made
        # entirely of stand-ins references none of them: the table would drop
        # out of the FROM clause and the whole read would collapse to the one
        # row a bare SELECT of literals returns.
        statement = sa.select(*chosen or [sa.literal(1)]).select_from(attached)
        sql = str(statement.compile(dialect=DIALECT,
                                    compile_kwargs={"literal_binds": True}))

        # Its own cursor, because two routes may hold two reads of this source
        # open at once and one connection streams one result at a time.
        cursor = self._connect().cursor()
        try:
            cursor.execute(sql)
            while chunk := cursor.fetchmany(CHUNK):
                if not chosen:
                    yield from (() for _ in chunk)
                else:
                    yield from chunk
        except duckdb.Error as error:
            # Every scan-time failure means the same thing here, and it is not a
            # question the build can answer: the file said something the header
            # promised it would not. Naming the table and the directory is what
            # an operator needs with sixty tables and twelve builds to choose
            # between, and the engine's own words say which row.
            sys.exit(f"error: {table}.csv in {self.directory} could not be read; "
                     f"the cached copy is incomplete\n  {error}")
        finally:
            cursor.close()

    def _connect(self) -> duckdb.DuckDBPyConnection:
        """This instance's database, opened on first use."""
        if self._database is None:
            self._database = duckdb.connect()
        return self._database

    def _attach(self, table: str) -> sa.Table | None:
        """The relation for one table, attaching it on first ask.

        Returns None when there is no file, or when there is one and it holds no
        header -- a truncated download rather than a build that predates the
        table, which the caller tells apart by whether the file exists.
        """
        if table in self._attached:
            return self._attached[table]
        path = self.path_of(table)
        if not path.exists():
            return None
        database = self._connect()
        # The one statement no builder writes: `read_csv`'s options are named
        # arguments rather than SQL, and a view definition cannot take a bound
        # parameter, so the path is quoted as the string literal it is.
        literal = str(path).replace("'", "''")
        try:
            database.execute(
                f'CREATE OR REPLACE VIEW "{table}" AS SELECT * FROM read_csv('
                f"'{literal}', all_varchar = true, header = true, "
                f"max_line_size = {MAX_LINE}, null_padding = false)")
            described = database.execute(f'SELECT * FROM "{table}" LIMIT 0')
        except duckdb.Error:
            return None
        relation = sa.Table(table, self._metadata,
                            *[sa.Column(name, sa.Text)
                              for name, *_ in described.description])
        self._attached[table] = relation
        return relation
