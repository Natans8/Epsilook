"""A private client's own tables, read from its content store and written as CSV.

Every other table source is an export somebody published. A private server's
client is the case where nobody did: its build carries rows no public export
has, and the only copy is the binary tables inside the client's own storage.

So this reads them where they live and writes the CSVs the ordinary provider
already serves. Extracting rather than serving the db2s directly is the whole
design, for three reasons. The decode is expensive and the result never changes
under a fixed build, so writing it once means every later build of that pack
costs a directory read. The drift declarations -- which tables a client
predates, which columns stand in -- are honoured by the CSV provider and would
have to be reimplemented behind a second one. And nothing above this layer
learns that a pack came from a client at all: `Providers` wires the same
`CsvTables` over the same shape of directory whichever source filled it.

Columns are addressed by NAME, so this needs the published definitions as well
as the reader. A join written against column positions is correct only until
somebody looks at it, and two positions recorded from sample rows have already
turned out wrong.
"""

from __future__ import annotations

import csv
import struct
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from ..progress import log
from . import dbd
from .cache import CACHE_DIR
from .casc import EPSILON, Service, Storage
from .listfile import listfile_source
from .source import Origin, Source
from .wago import TABLES
from .wdc3 import Db2

DEFINITIONS = CACHE_DIR / "dbd"
"""Where parsed table definitions are cached, shared with the tools."""

TABLE_PREFIX = "dbfilesclient/"
"""Where the listfile keeps the client's database tables."""

TABLE_SUFFIX = ".db2"

STAMP = "extracted.txt"
"""Names the build and the tables this directory was written for.

The completeness test the source contract asks for, and it has to be more than
"is anything there": a table added to the roster, or a client that has moved to
a new build, both leave a directory that exists and is wrong.
"""


def table_ids(listfile: Path) -> dict[str, int]:
    """Every database table's file id, by lowercase table name.

    Read from the community listfile, because a table is a file like any other
    and mapping a name to a file id is what the listfile is for. A private
    client adds rows to these tables; it does not rename them, so the community
    list addresses them exactly as it addresses the stock ones.
    """
    found: dict[str, int] = {}
    with listfile.open(encoding="utf-8", errors="replace", newline="") as handle:
        for line in handle:
            fid, separator, path = line.partition(";")
            name = path.strip().lower()
            if separator and name.startswith(TABLE_PREFIX) and name.endswith(TABLE_SUFFIX):
                found[name[len(TABLE_PREFIX) : -len(TABLE_SUFFIX)]] = int(fid)
    return found


@dataclass(frozen=True)
class ClientTables:
    """The tables one client carries, extracted to a directory of CSVs.

    A `Source` in its own right rather than an `Extracted` over a `Fetched`:
    the bytes under it are not a file to be located but a content store to be
    addressed, and the store resolves what it holds in one pass over its own
    encoding table. Splitting that into a fetch and an extraction would mean
    fetching sixty-four blobs to nowhere in particular and then finding them
    again.
    """

    name: str
    service: Service
    """Which TACT service the client publishes on."""

    version: str
    """The build this pack is declared to be. The live service is checked
    against it rather than trusted: a private client updates whenever its
    operator says so, and a pack built from a build other than the one it
    claims would be wrong in a way nothing downstream could detect."""

    tables: Sequence[str]
    """The roster of tables to extract, which is the build's own."""

    into: Path
    """The directory the CSVs land in, read afterwards by `CsvTables`."""

    listfile: Source
    """How a table name becomes a file id."""

    definitions: Path
    """Where parsed table definitions are cached."""

    def origins(self) -> list[Origin]:
        """The service, named without asking it anything."""
        return [Origin(self.service.versions_url, detail=f"{len(self.tables)} tables of build {self.version}")]

    def _stamp(self) -> str:
        """What a complete extraction of this roster would record."""
        return "\n".join([self.version, *sorted(self.tables)]) + "\n"

    def complete(self) -> bool:
        """Whether the directory already holds exactly what this would write."""
        path = self.into / STAMP
        return path.exists() and path.read_text(encoding="utf-8") == self._stamp()

    def acquire(self, refresh: bool) -> Path | None:
        """Extract every roster table, unless the cache already holds them.

        Args:
            refresh: extract again even where the stamp says the cache is
                current. What that re-reads is the decode; the blobs under it
                have their own policy and it already knows whether they moved.

        Returns:
            The directory, or None when the listfile it needs is absent.
        """
        if not refresh and self.complete():
            log(f"  cached   {self.into.name} ({len(self.tables)} tables)")
            return self.into
        listfile = self.listfile.acquire(False)
        if listfile is None:
            return None

        storage = Storage(self.service)
        if storage.build != self.version:
            log(
                f"  the service is on {storage.build}, and this pack is declared "
                f"{self.version}; bump the roster row before building it"
            )
            return None

        ids = table_ids(listfile)
        wanted = {table: ids[table.lower()] for table in self.tables if table.lower() in ids}
        absent = [table for table in self.tables if table.lower() not in ids]
        if absent:
            log(f"  {len(absent)} table(s) the listfile does not name: {', '.join(sorted(absent))}")

        blobs = storage.open_many(sorted(set(wanted.values())))
        build = dbd.parse_build(self.version)
        self.into.mkdir(parents=True, exist_ok=True)
        written = self._write(wanted, blobs, build)
        (self.into / STAMP).write_text(self._stamp(), encoding="utf-8")
        log(f"  {written} of {len(self.tables)} tables extracted to {self.into.name}")
        return self.into

    def _write(self, wanted: dict[str, int], blobs: dict[int, bytes], build: dbd.Build | None) -> int:
        """Decode each table and write it, returning how many landed.

        A table that cannot be decoded is left absent rather than written
        empty, which is the same answer a build predating it gives: the drift
        declarations decide whether that switches a section off or fails the
        build, and they are read by the provider rather than here.
        """
        written = 0
        for table, fid in sorted(wanted.items()):
            raw = blobs.get(fid)
            if not raw:
                log(f"  {table}: the client does not carry it")
                continue
            schema = dbd.schema_for(dbd.load(table, self.definitions), build)
            if schema is None:
                log(f"  {table}: no definition block for this build")
                continue
            try:
                parsed = Db2(raw, schema)
                rows = list(parsed.rows())
                columns = list(parsed.columns)
            except (ValueError, IndexError, KeyError, struct.error) as exc:
                log(f"  {table}: does not decode ({type(exc).__name__})")
                continue
            self._write_table(table, columns, rows)
            written += 1
        return written

    def _write_table(self, table: str, columns: Sequence[str], rows: Sequence[Sequence[object]]) -> None:
        """One table's CSV, in the shape the exports use.

        Written through a temporary and renamed, so an interrupted run leaves
        no half-written file for the stamp of a later one to vouch for.
        """
        temporary = self.into / f"{table}.csv.part"
        with temporary.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(columns)
            writer.writerows(["" if value is None else str(value) for value in row] for row in rows)
        temporary.replace(self.into / f"{table}.csv")


CLIENTS: dict[str, Service] = {"epsilon": EPSILON}
"""The private clients a pack may be built from, by roster key.

A declaration, so a second one is a row here and a roster row naming it. What
separates these from every other pack is only where the tables come from: the
routes, the sections and the artifact are the build's own either way.
"""


def client_tables_dir(client: str, version: str) -> Path:
    """Where one private client's decoded tables land.

    Named here because this is the layer that decides it, and read by the
    exploration database as well: a client build's tables are not in the cache
    directory a published build of the same number uses, and a tool guessing
    the shape would be a second copy of it.
    """
    return CACHE_DIR / f"{version}-{client}"


def client_tables_source(client: str, version: str) -> Source:
    """One private client's tables, as the directory a provider reads.

    The same shape `tables_source` returns for a published build, and
    deliberately so: what differs is that these are decoded out of the client's
    own storage rather than downloaded as somebody's export.

    Raises:
        KeyError: no client is declared under that key, which is a roster row
            naming one that does not exist.
    """
    return ClientTables(
        name=f"tables ({client} client, build {version})",
        service=CLIENTS[client],
        version=version,
        tables=TABLES,
        into=client_tables_dir(client, version),
        listfile=listfile_source(),
        definitions=DEFINITIONS,
    )
