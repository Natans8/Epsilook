"""The TrinityCore world database: release mapping, extraction, distillation.

TrinityCore publishes a full server database per client era as a 7-Zip archive
of mysqldump SQL. The world dump is the only source of creature and gameobject
names; the hotfixes dump carries the rows Blizzard changed server-side after the
client shipped. Each release is scanned once, leaving the distilled CSVs and the
archive in the cache.
"""

from __future__ import annotations

import csv
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import NamedTuple, Protocol, TextIO

from ..drift import TDB_CANDIDATE_TABLES, TDB_OPTIONAL_COLUMNS, TDB_OPTIONAL_TABLES
from ..progress import log
from ..targets import VISUAL_REDIRECTS
from .archive import read_member
from .cache import CACHE_DIR, Pinned
from .dump import Column, iter_insert_rows, parse_create_table
from .source import Extract, Extracted, Fetched, Origin, Source

STAMP_COLUMN = "VerifiedBuild"
"""The client build a hotfix row was last verified against.

Every hotfix table declares it, and the overlay filters rows on it.
"""

# TrinityCore TDB release per game version. "hotfixes" is optional: the 3.3.5
# branch ships a world-only dump.
TDB_RELEASES: Mapping[str, Mapping[str, str]] = {
    "9.2.7.45745": {
        "tag": "TDB927.22111",
        "asset": "TDB_full_927.22111_2022_11_20.7z",
        "world": "TDB_full_world_927.22111_2022_11_20.sql",
        "hotfixes": "TDB_full_hotfixes_927.22111_2022_11_20.sql",
    },
    "10.2.7.55664": {
        "tag": "TDB1027.24051",
        "asset": "TDB_full_1027.24051_2024_05_11.7z",
        "world": "TDB_full_world_1027.24051_2024_05_11.sql",
        "hotfixes": "TDB_full_hotfixes_1027.24051_2024_05_11.sql",
    },
    "11.2.7.65299": {
        "tag": "TDB1127.26011",
        "asset": "TDB_full_1127.26011_2026_01_14.7z",
        "world": "TDB_full_world_1127.26011_2026_01_14.sql",
        "hotfixes": "TDB_full_hotfixes_1127.26011_2026_01_14.sql",
    },
    # Midnight: TrinityCore's master branch dump, cut against the 12.0 client
    # and keyed here to the 12.1.0 build the pack ships. Creature entries carry
    # across a minor patch.
    "12.1.0.69273": {
        "tag": "TDB1200.26021",
        "asset": "TDB_full_1200.26021_2026_02_06.7z",
        "world": "TDB_full_world_1200.26021_2026_02_06.sql",
        "hotfixes": "TDB_full_hotfixes_1200.26021_2026_02_06.sql",
    },
    # The second test slot, one minor patch further out than the first and
    # reaching the same dump for the same reason. Keyed exactly rather than by
    # patch, because no TDB is cut against 12.1 at all and a fallback would
    # find nothing and empty every morph name without saying so.
    "12.1.5.69594": {
        "tag": "TDB1200.26021",
        "asset": "TDB_full_1200.26021_2026_02_06.7z",
        "world": "TDB_full_world_1200.26021_2026_02_06.sql",
        "hotfixes": "TDB_full_hotfixes_1200.26021_2026_02_06.sql",
    },
    "8.3.7.35662": {
        "tag": "TDB837.20101",
        "asset": "TDB_full_837.20101_2020_10_20.7z",
        "world": "TDB_full_world_837.20101_2020_10_20.sql",
        "hotfixes": "TDB_full_hotfixes_837.20101_2020_10_20.sql",
    },
    # Legion: this archive nests both dumps in a folder and drops the "full_"
    # infix from the inner file names.
    "7.3.5.26972": {
        "tag": "TDB735.00",
        "asset": "TDB_full_735.00_2018_02_19.7z",
        "world": "TDB_full_735.00_2018_02_19/TDB_world_735.00_2018_02_19.sql",
        "hotfixes": "TDB_full_735.00_2018_02_19/TDB_hotfixes_735.00_2018_02_19.sql",
    },
    # WotLK Classic: the 3.3.5 branch ships a world-only dump, and it targets
    # original 3.3.5a rather than the 3.4.x Classic client.
    "3.4.3.58936": {
        "tag": "TDB335.25101",
        "asset": "TDB_full_world_335.25101_2025_10_21.7z",
        "world": "TDB_full_world_335.25101_2025_10_21.sql",
    },
}
TDB_ASSET_URL = "https://github.com/TrinityCore/TrinityCore/releases/download/{tag}/{asset}"

Wanted = Mapping[str, list[str]]
"""The tables one dump is scanned for, mapped to the columns kept from each.

A roster rather than the roster: the same dump is read for the pack's tables
and, by a language overlay, for the `*_locale` tables carrying the same rows in
another language.
"""

# Tables distilled out of the TDB SQL dumps into cached CSVs, with the columns
# kept. World tables are complete; hotfix rows are applied on top of the wago
# rows by row id.
TDB_TABLES = {
    "world": {
        "creature_template": ["entry", "name", "modelid1", "modelid2", "modelid3", "modelid4"],
        "creature_template_model": ["CreatureID", "Idx", "CreatureDisplayID", "Probability"],
        # A spawn effect's misc0 is a gameobject_template entry. The client's
        # GameObjects.db2 uses a different keying, so the name and displayId
        # live only here. `type` is the GAMEOBJECT_TYPE enum (3 CHEST, 5
        # GENERIC, 10 GOOBER, ...), read to gate the Wowhead object link.
        "gameobject_template": ["entry", "name", "displayId", "type"],
        # A totem spell's summon wears a different model per caster race, and
        # the client tables carry none of it: the creature's own display list
        # holds one entry, so the pack would otherwise show a single race's
        # totem for every shaman.
        "spell_totem_model": ["SpellID", "RaceID", "DisplayID"],
    },
    "hotfixes": {
        "spell_name": ["ID", "Name"],
        "spell_x_spell_visual": ["ID", "SpellID", "SpellVisualID"],
        # A hotfixed row replaces the wago row wholesale, so every column a
        # route reads has to be listed here or the overlay blanks it.
        "spell_visual": [
            "ID",
            "SpellVisualMissileSetID",
            "RaidSpellVisualMissileSetID",
            "MissileAttachment",
            "MissileDestinationAttachment",
            "AnimEventSoundID",
            *VISUAL_REDIRECTS,
        ],
        "spell_visual_missile": [
            "ID",
            "SpellVisualMissileSetID",
            "SpellVisualEffectNameID",
            "SoundEntriesID",
            "AnimKitID",
            "SpellMissileMotionID",
            "Attachment",
            "DestinationAttachment",
        ],
        "spell_visual_effect_name": ["ID", "ModelFileDataID"],
        # EffectBasePoints is the movement-speed percent, and every dump that
        # ships hotfixes spells it as an int even where the client exports only
        # the float.
        "spell_effect": [
            "ID",
            "SpellID",
            "Effect",
            "EffectAura",
            "EffectMiscValue1",
            "EffectMiscValue2",
            "ImplicitTarget1",
            "ImplicitTarget2",
            "EffectBasePoints",
            "EffectTriggerSpell",
        ],
        "spell_misc": ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"],
        "creature_display_info": ["ID", "ModelID"],
        "creature_model_data": ["ID", "FileDataID"],
    },
}

# The stamp rides every hotfix table, so it is appended once here rather than
# repeated above.
TDB_TABLES["hotfixes"] = {table: [*columns, STAMP_COLUMN] for table, columns in TDB_TABLES["hotfixes"].items()}

LOCALE_COLUMN = "locale"
"""The column a ``*_locale`` row names the language it is written in.

One row per entry per language, so reading one language means refusing the
rest -- which is what the overlay's own admission rule does.
"""

TDB_LOCALE_TABLES: Mapping[str, Wanted] = {
    "world": {
        # The same two names the pack's own world tables carry, in the
        # languages the server has them in. Spelled as each table spells them:
        # the creature side capitalises `Name` and the gameobject side does
        # not, and a join on the wrong spelling is a table that reads empty.
        "creature_template_locale": ["entry", LOCALE_COLUMN, "Name"],
        "gameobject_template_locale": ["entry", LOCALE_COLUMN, "name"],
    },
}
"""What a language reads out of the same world dump the pack's tables come from.

A roster of its own rather than more columns on ``TDB_TABLES``, so that a build
shipping one language never distils them: the archive is a hundred megabytes
and a re-scan is minutes, and completeness is compared per roster.
"""

TDB_LOSSY_COLUMNS = frozenset(
    {
        # A FLOAT in a modern dump, so its text is printed rounded against the
        # client's value. The oldest releases type the same column INT, where it is
        # exact -- it is refused there too, so one column means one thing whichever
        # release a build matched.
        ("spell_effect", "EffectBasePoints"),
    }
)
"""Overlay columns whose text may be lossier than the client's own.

Declared so the overlay can be composed without reading the dump, and checked
against the dump's own DDL on every distill. The column is still distilled;
refusing it is the overlay's job.

A CEILING, not an equality: the roster spans releases a decade apart and a
column's type moves between them, so a declaration says "lossy in at least one
release we distil" rather than "lossy in this one".
"""


class RowWriter(Protocol):
    """The one thing this module asks of a csv writer.

    Structural rather than nominal because `csv.writer` returns a type the
    standard library keeps private, and the alternative -- importing `_csv`
    for its name -- would tie the distiller to an implementation detail to
    say something this states outright.
    """

    def writerow(self, row: Iterable[object]) -> object:
        """Write one row of already-stringified values."""


class TableWriter(NamedTuple):
    """Where one distilled table's rows go, and how a dump row maps onto it."""

    writer: RowWriter
    """The open csv writer for this table's file."""
    columns: Sequence[int | None]
    """Position in the dump row per wanted column; None where the release
    lacks it and TDB_OPTIONAL_COLUMNS supplies the value instead."""
    width: int
    """How many values a dump row for this table must carry."""


def tdb_column_index(table: str, column: str, schema: list[str]) -> int | None:
    """Find a column's position in a TDB table.

    Returns:
        The index, or None when the column is declared in TDB_OPTIONAL_COLUMNS
        and this release does not carry it; the distiller then writes the
        declared default instead.
    """
    if column in schema:
        return schema.index(column)
    if (table, column) in TDB_OPTIONAL_COLUMNS:
        return None
    sys.exit(
        f"error: TDB table {table} has no column {column!r} and it is not "
        f"declared in TDB_OPTIONAL_COLUMNS; schema = {schema}"
    )


def check_lossy_declaration(table: str, schema: list[Column], keep: list[str]) -> None:
    """Fail on a dump column that prints lossily and is not declared.

    The overlay decides from the declaration rather than by opening the dump, so
    this is what keeps the two in step. Only one direction can do harm, and the
    check is asymmetric for that reason. An undeclared lossy column is applied
    over the client's own exact value, silently rounding it; a declared column
    a given release happens to type exactly is merely refused, which costs a
    revision nobody was relying on and keeps the column meaning one thing across
    every release.
    """
    kinds = {column.name: column for column in schema}
    for column in keep:
        if column not in kinds:
            # This release predates the column, declared in
            # TDB_OPTIONAL_COLUMNS, which is not a type disagreement.
            continue
        if kinds[column].lossy and (table, column) not in TDB_LOSSY_COLUMNS:
            sys.exit(
                f"error: {table}.{column} is typed {kinds[column].kind}, which "
                f"a dump prints lossily, and it is not declared in "
                f"TDB_LOSSY_COLUMNS"
            )


def distill_dump(
    lines: Iterable[str], name: str, want: Wanted, out_dir: Path, required: bool = True, overlay: bool = False
) -> None:
    """Write the wanted tables and columns of one SQL dump out as CSVs.

    A table with no ``INSERT`` still gets a header-only CSV. A row whose value
    count disagrees with its schema exits rather than writing a misaligned CSV.

    Args:
        lines: the dump's text, streamed.
        name: what to call the dump in an error.
        want: the columns to keep, per table.
        out_dir: where the CSVs are written.
        required: a table missing from the dump is fatal. True where this dump
            is the only source of what the table carries, as it is for the
            pack's own world tables and is not for their `*_locale`
            counterparts, which a release may predate.
        overlay: this dump revises data the client already has, so its column
            types are checked against TDB_LOSSY_COLUMNS.
    """
    schemas: dict[str, list[Column]] = {}
    writers: dict[str, TableWriter] = {}
    handles: list[TextIO] = []
    stream = iter(lines)
    for line in stream:
        if line.startswith("CREATE TABLE `"):
            table = line.split("`")[1]
            statement = [line]
            for more in stream:
                statement.append(more)
                if more.startswith(")"):
                    break
            if table in want:
                schemas[table] = parse_create_table("".join(statement))
                if overlay:
                    check_lossy_declaration(table, schemas[table], want[table])
        elif line.startswith("INSERT INTO `"):
            table = line.split("`")[1]
            if table not in want:
                continue
            if table not in writers:
                keep = want[table]
                names = [column.name for column in schemas[table]]
                idx = [tdb_column_index(table, c, names) for c in keep]
                handle = open(
                    out_dir / f"{table}.csv",
                    "w",  # pylint: disable=consider-using-with
                    newline="",
                    encoding="utf-8",
                )
                handles.append(handle)
                writer = csv.writer(handle)
                writer.writerow(keep)
                writers[table] = TableWriter(writer, idx, len(schemas[table]))
            into_table = writers[table]
            for row in iter_insert_rows(line):
                if len(row) != into_table.width:
                    sys.exit(f"error: {table} row has {len(row)} values, schema has {into_table.width}")
                into_table.writer.writerow(
                    [
                        row[i] if i is not None else TDB_OPTIONAL_COLUMNS[(table, column)]
                        for i, column in zip(into_table.columns, want[table])
                    ]
                )
    for open_file in handles:
        open_file.close()
    for table, keep in want.items():
        if table not in schemas:
            if required and table not in TDB_OPTIONAL_TABLES:
                sys.exit(f"error: table {table} not found in {name}")
            why = TDB_OPTIONAL_TABLES.get(table, "no overrides")
            log(f"    {table}: absent from this dump — {why}")
            if table in TDB_CANDIDATE_TABLES:
                # A reader picks between these by which one exists, so an empty
                # stand-in would win that race and silently blank every morph.
                continue
        if table not in writers:
            # No hotfixed rows, or no such table in this release: for an overlay
            # both mean "no overrides", and the header is what a cached release
            # is recognised by.
            with open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8") as handle:
                csv.writer(handle).writerow(keep)


def distilled(into: Path, want: Wanted) -> bool:
    """Check whether the cache holds exactly the tables and columns wanted.

    The header is compared, not the file's existence, which would leave a widened
    column list looking complete. Every table a distillation writes leaves a file
    behind even where the dump had none, so a missing one means the scan has not
    run -- except for the candidates, which are the tables deliberately left
    absent so that a reader picking between them picks the one with rows.
    """
    for table, columns in want.items():
        path = into / f"{table}.csv"
        if not path.exists():
            if table in TDB_CANDIDATE_TABLES:
                continue
            return False
        with path.open(newline="", encoding="utf-8") as handle:
            if next(csv.reader(handle), []) != columns:
                return False
    return True


def tdb_release(version: str) -> Mapping[str, str] | None:
    """Find the TDB release for a build, matched on the patch not the build id.

    TDB_RELEASES is keyed by full build id, but a TDB tracks a patch, so keying
    strictly would drop the mapping the moment a pack is bumped. Exact match
    still wins.
    """
    if version in TDB_RELEASES:
        return TDB_RELEASES[version]
    patch = version.split(".")[:3]
    for build, release in TDB_RELEASES.items():
        if build.split(".")[:3] == patch:
            return release
    return None


def tdb_dir_name(tag: str) -> str:
    """The directory one release is cached in: its archive, and what was
    distilled out of it.

    Keyed on the release tag rather than on a build, because several builds
    match one release and each of them would otherwise pay for the same
    hundreds of megabytes. The name alone, so a reader rooting the cache at its
    own declaration of where it is can still name the same directory.
    """
    return f"tdb-{tag}"


@dataclass(frozen=True)
class Distill:
    """Turning one release's dumps into the CSVs a provider serves.

    A release is scanned once and leaves a directory of CSVs holding only the
    declared tables and columns, with the archive beside them.
    """

    kinds: tuple[str, ...]
    """Which dumps this release ships, in the order they are read."""

    members: Mapping[str, str]
    """Dump kind, mapped to the member's path inside the archive."""

    want: Mapping[str, Wanted] = field(default_factory=lambda: TDB_TABLES)
    """Dump kind, mapped to the tables kept from it and the columns of each.

    A field rather than the one roster, because the same archive is scanned for
    more than one set of tables: the pack's, and the `*_locale` tables a
    language overlay reads out of the same world dump. Both then answer
    completeness the same way, by comparing headers -- so a column added to
    either roster re-distils the releases cached without it, rather than
    leaving them looking finished and quietly missing it.
    """

    required: frozenset[str] = frozenset({"world"})
    """The kinds a wanted table missing from the dump is fatal in.

    The pack's world tables are the only source of what they carry, so nothing
    can be built without them. Their `*_locale` counterparts are not: a release
    may predate one, and those strings stay in the language the base pack
    already ships.
    """

    overlay: frozenset[str] = frozenset({"hotfixes"})
    """The kinds revising data the client already has.

    An overlay's column types are checked against TDB_LOSSY_COLUMNS, so a
    column the dump prints rounded cannot be applied over the client's own
    exact value without being declared.
    """

    def wanted(self) -> dict[str, list[str]]:
        """Every table this extraction writes, with the columns kept.

        Only the kinds this release actually ships: a world-only release is
        complete without the hotfix tables, and asking for them would leave it
        permanently undistilled.
        """
        return {table: columns for kind in self.kinds for table, columns in self.want[kind].items()}

    def complete(self, into: Path) -> bool:
        """Whether the cache already holds exactly these tables and columns."""
        return distilled(into, self.wanted())

    def run(self, located: Path, into: Path) -> None:
        """Read each dump straight out of the archive, writing the CSVs out.

        The SQL never reaches the filesystem: a release is hundreds of
        megabytes of it, and only the declared columns of a dozen tables
        survive the scan.
        """
        for kind in sorted((self.overlay & set(self.want)) - set(self.kinds)):
            log(f"  no {kind} dump in this release: nothing revises what the client itself carries")
        for kind in self.kinds:
            member = self.members[kind]
            log(f"  distilling {member} ...")
            with read_member(located, member) as lines:
                distill_dump(
                    lines, member, self.want[kind], into, required=kind in self.required, overlay=kind in self.overlay
                )


def tdb_extraction(release: Mapping[str, str], name: str, extract: Extract) -> Extracted:
    """One release's archive, and what is distilled out of it, as one source.

    The archive is cached in the directory the CSVs land in, so a release is
    one directory whichever tables were asked of it -- and whichever of them
    asks first pays for the download.

    The archive is reached only where the distillation is not already complete,
    which is what keeps a refresh from spending hundreds of megabytes to arrive
    at the same rows. Where it is reached, a refresh is honoured: a truncated
    archive is exactly what somebody passes the flag to be rid of.
    """
    into = CACHE_DIR / tdb_dir_name(release["tag"])
    archive = Fetched(
        name=f"TDB archive ({release['tag']})",
        origin=Origin(TDB_ASSET_URL.format(**release)),
        dest=into / release["asset"],
        fetch=Pinned(),
    )
    return Extracted(name=name, inner=archive, extract=extract, into=into)


def tdb_source(version: str) -> Source | None:
    """The distilled TrinityCore tables for one build.

    Returns:
        The source, or None when no release maps to this version. Not an
        error: the routes that need one degrade as declared.
    """
    release = tdb_release(version)
    if release is None:
        return None
    kinds = tuple(kind for kind in ("world", "hotfixes") if kind in release)
    return tdb_extraction(
        release, f"TDB ({release['tag']})", Distill(kinds=kinds, members={kind: release[kind] for kind in kinds})
    )


def tdb_locale_source(version: str) -> Source | None:
    """The translated creature and object names, from the same world dump.

    Landing in the release's one directory beside the pack's own tables, so a
    provider reading either is pointed at the same place.

    Not required: a release may predate a ``*_locale`` table, and those names
    then stay in the language the world dump itself carries.

    Returns:
        The source, or None when no release maps to this version -- the Classic
        re-releases, whose creature names are raw ids in every language.
    """
    release = tdb_release(version)
    if release is None:
        return None
    return tdb_extraction(
        release,
        f"TDB translations ({release['tag']})",
        Distill(kinds=("world",), members={"world": release["world"]}, want=TDB_LOCALE_TABLES, required=frozenset()),
    )
