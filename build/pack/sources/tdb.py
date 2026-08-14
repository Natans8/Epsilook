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
from collections.abc import Iterable
from pathlib import Path

from ..drift import TDB_OPTIONAL_COLUMNS, TDB_OPTIONAL_TABLES
from ..progress import log
from ..targets import VISUAL_REDIRECTS
from .archive import read_member
from .cache import CACHE_DIR, download
from .dump import Column, iter_insert_rows, parse_create_table

STAMP_COLUMN = "VerifiedBuild"
"""The client build a hotfix row was last verified against.

Every hotfix table declares it, and the overlay filters rows on it.
"""

# TrinityCore TDB release per game version. "hotfixes" is optional: the 3.3.5
# branch ships a world-only dump.
TDB_RELEASES = {
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

# Tables distilled out of the TDB SQL dumps into cached CSVs, with the columns
# kept. World tables are complete; hotfix rows are applied on top of the wago
# rows by row id.
TDB_TABLES = {
    "world": {
        "creature_template": ["entry", "name",
                              "modelid1", "modelid2", "modelid3", "modelid4"],
        "creature_template_model": ["CreatureID", "Idx", "CreatureDisplayID", "Probability"],
        # A spawn effect's misc0 is a gameobject_template entry. The client's
        # GameObjects.db2 uses a different keying, so the name and displayId
        # live only here. `type` is the GAMEOBJECT_TYPE enum (3 CHEST, 5
        # GENERIC, 10 GOOBER, ...), read to gate the Wowhead object link.
        "gameobject_template": ["entry", "name", "displayId", "type"],
    },
    "hotfixes": {
        "spell_name": ["ID", "Name"],
        "spell_x_spell_visual": ["ID", "SpellID", "SpellVisualID"],
        # A hotfixed row replaces the wago row wholesale, so every column a
        # route reads has to be listed here or the overlay blanks it.
        "spell_visual": ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID",
                         "MissileAttachment", "MissileDestinationAttachment",
                         "AnimEventSoundID", *VISUAL_REDIRECTS],
        "spell_visual_missile": ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                                 "SoundEntriesID", "AnimKitID", "SpellMissileMotionID",
                                 "Attachment", "DestinationAttachment"],
        "spell_visual_effect_name": ["ID", "ModelFileDataID"],
        # EffectBasePoints is the movement-speed percent, and every dump that
        # ships hotfixes spells it as an int even where the client exports only
        # the float.
        "spell_effect": ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1",
                         "EffectMiscValue2", "ImplicitTarget1", "ImplicitTarget2",
                         "EffectBasePoints", "EffectTriggerSpell"],
        "spell_misc": ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"],
        "creature_display_info": ["ID", "ModelID"],
        "creature_model_data": ["ID", "FileDataID"],
    },
}

# The stamp rides every hotfix table, so it is appended once here rather than
# repeated above.
TDB_TABLES["hotfixes"] = {table: [*columns, STAMP_COLUMN]
                          for table, columns in TDB_TABLES["hotfixes"].items()}

TDB_LOSSY_COLUMNS = frozenset({
    # A FLOAT in a modern dump, so its text is printed rounded against the
    # client's value. The oldest releases type the same column INT, where it is
    # exact -- it is refused there too, so one column means one thing whichever
    # release a build matched.
    ("spell_effect", "EffectBasePoints"),
})
"""Overlay columns whose text may be lossier than the client's own.

Declared so the overlay can be composed without reading the dump, and checked
against the dump's own DDL on every distill. The column is still distilled;
refusing it is the overlay's job.

A CEILING, not an equality: the roster spans releases a decade apart and a
column's type moves between them, so a declaration says "lossy in at least one
release we distil" rather than "lossy in this one".
"""


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
    sys.exit(f"error: TDB table {table} has no column {column!r} and it is not "
             f"declared in TDB_OPTIONAL_COLUMNS; schema = {schema}")


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
                f"TDB_LOSSY_COLUMNS")


def distill_dump(lines: Iterable[str], name: str, want: dict[str, list[str]],
                 out_dir: Path, required: bool = True,
                 overlay: bool = False) -> None:
    """Write the wanted tables and columns of one SQL dump out as CSVs.

    A table with no ``INSERT`` still gets a header-only CSV. A row whose value
    count disagrees with its schema exits rather than writing a misaligned CSV.

    Args:
        lines: the dump's text, streamed.
        name: what to call the dump in an error.
        want: the columns to keep, per table.
        out_dir: where the CSVs are written.
        required: a table missing from the dump is fatal. True for the world
            tables, the only source of what they carry.
        overlay: this dump revises data the client already has. Only an overlay
            has its column types checked against TDB_LOSSY_COLUMNS, and only for
            an overlay does an absent table get a header-only stand-in.
    """
    schemas: dict[str, list[Column]] = {}
    writers: dict[str, tuple] = {}
    handles = []
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
                handle = open(out_dir / f"{table}.csv", "w",  # pylint: disable=consider-using-with
                              newline="", encoding="utf-8")
                handles.append(handle)
                writer = csv.writer(handle)
                writer.writerow(keep)
                writers[table] = (writer, idx, len(schemas[table]))
            writer, idx, width = writers[table]
            for row in iter_insert_rows(line):
                if len(row) != width:
                    sys.exit(f"error: {table} row has {len(row)} values, schema has {width}")
                writer.writerow([row[i] if i is not None
                                 else TDB_OPTIONAL_COLUMNS[(table, column)]
                                 for i, column in zip(idx, want[table])])
    for handle in handles:
        handle.close()
    for table, keep in want.items():
        if table not in schemas:
            if required and table not in TDB_OPTIONAL_TABLES:
                sys.exit(f"error: table {table} not found in {name}")
            why = TDB_OPTIONAL_TABLES.get(table, "no overrides")
            log(f"    {table}: absent from this dump — {why}")
            if not overlay:
                # The creature-display route picks the first candidate table
                # that exists, so an empty stand-in would win that race and
                # silently blank every morph.
                continue
        if table not in writers:
            # No hotfixed rows, or no such table in this release: for an overlay
            # both mean "no overrides", and the header is what a cached release
            # is recognised by.
            with open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8") as handle:
                csv.writer(handle).writerow(keep)


def distilled(tdb_dir: Path, want: dict[str, list[str]]) -> bool:
    """Check whether the cache holds exactly the tables and columns wanted.

    The header is compared, not the file's existence, which would leave a widened
    column list looking complete. A table absent from an older release is
    excluded by the declaration that let it be absent.
    """
    for table, columns in want.items():
        path = tdb_dir / f"{table}.csv"
        if not path.exists():
            if table in TDB_OPTIONAL_TABLES:
                continue
            return False
        with path.open(newline="", encoding="utf-8") as handle:
            if next(csv.reader(handle), []) != columns:
                return False
    return True


def tdb_release(version: str) -> dict | None:
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


def fetch_tdb(version: str) -> Path | None:
    """Distil the TDB tables for this version if needed, and say where they are.

    The dumps are read straight out of the downloaded archive, so the SQL never
    reaches the filesystem.

    Returns:
        The directory holding the distilled CSVs, or None when no TDB release
        maps to this version, which is not an error: the routes that need one
        degrade as declared.
    """
    rel = tdb_release(version)
    if rel is None:
        log(f"TDB: no release mapped for {version} — morphs will not resolve, "
            f"hotfixes will not apply")
        return None
    tdb_dir = CACHE_DIR / f"tdb-{rel['tag']}"
    # Only the kinds this release actually has count towards "already
    # distilled".
    kinds = [k for k in ("world", "hotfixes") if k in rel]
    wanted = {t: c for k in kinds for t, c in TDB_TABLES[k].items()}
    if distilled(tdb_dir, wanted):
        log(f"TDB ({rel['tag']}): cached ({len(wanted)} distilled tables)")
        return tdb_dir
    if "hotfixes" not in rel:
        log(f"TDB ({rel['tag']}): world-only release — no hotfix overrides for this build")
    tdb_dir.mkdir(parents=True, exist_ok=True)
    archive = tdb_dir / rel["asset"]
    download(TDB_ASSET_URL.format(**rel), archive, refresh=False)
    for kind in kinds:
        member = rel[kind]
        log(f"  distilling {member} ...")
        with read_member(archive, member) as lines:
            distill_dump(lines, member, TDB_TABLES[kind], tdb_dir,
                         required=(kind == "world"),
                         overlay=(kind == "hotfixes"))
    return tdb_dir

