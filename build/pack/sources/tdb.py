"""The TrinityCore world database: release mapping, extraction, distillation.

TrinityCore publishes a full server database per client era as a 7-Zip archive
of mysqldump SQL. Two dumps matter: the world dump is the only source of
creature and gameobject names, and the hotfixes dump carries the rows Blizzard
changed server-side after the client shipped.

The archive is downloaded and the dumps scanned exactly once per release.
Afterwards only the small distilled CSVs stay in the cache, alongside the
archive itself.
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
from .dump import iter_insert_rows, parse_create_table

# TrinityCore TDB release per game version (server-side world DB + hotfixes).
# "hotfixes" is optional — the 3.3.5 branch ships a world-only dump, and
# hotfixes are a modern-client concept anyway.
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
    # Midnight: TrinityCore's master branch dump. Its 1200 names the 12.0 client
    # it was cut against, while the pack ships 12.1.0 — so unlike the entries
    # above this one is keyed to a patch it does not exactly match, and the
    # patch fallback in tdb_release() will not reach it on a 12.1 build. It is
    # named here on the 3.4.3 precedent: creature entries carry across a minor
    # patch, and the alternative is no morph display names at all for retail.
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
    # Legion: the 2018 archive nests both dumps in a folder and drops the
    # "full_" infix from the inner file names.
    "7.3.5.26972": {
        "tag": "TDB735.00",
        "asset": "TDB_full_735.00_2018_02_19.7z",
        "world": "TDB_full_735.00_2018_02_19/TDB_world_735.00_2018_02_19.sql",
        "hotfixes": "TDB_full_735.00_2018_02_19/TDB_hotfixes_735.00_2018_02_19.sql",
    },
    # WotLK Classic: TrinityCore's 3.3.5 branch ships a WORLD-ONLY dump (no
    # hotfixes key). It targets original 3.3.5a rather than the 3.4.x Classic
    # client, but it is the only source of creature name/display data for the
    # era and the creature entries are overwhelmingly shared.
    "3.4.3.58936": {
        "tag": "TDB335.25101",
        "asset": "TDB_full_world_335.25101_2025_10_21.7z",
        "world": "TDB_full_world_335.25101_2025_10_21.sql",
    },
}
TDB_ASSET_URL = "https://github.com/TrinityCore/TrinityCore/releases/download/{tag}/{asset}"

# Tables distilled out of the TDB SQL dumps into cached CSVs, with the
# columns we keep. world tables are complete (server-only data); hotfixes
# tables hold ONLY the rows Blizzard hotfixed post-ship — applied on top of
# the wago rows by row ID (TDB is preferred wherever it has data).
#
# NOTE widening a column list here does NOT invalidate the distilled CSV (the
# cache check is existence-only) — delete .cache/tdb-*/ to re-distill.
TDB_TABLES = {
    "world": {
        "creature_template": ["entry", "name",
                              "modelid1", "modelid2", "modelid3", "modelid4"],
        "creature_template_model": ["CreatureID", "Idx", "CreatureDisplayID", "Probability"],
        # gameobject spawners (§3, Effects column): a spawn effect's misc0 is a
        # gameobject_template ENTRY. The client GameObjects.db2 is world-placed
        # doodads keyed differently (0% overlap), so name + displayId only live
        # here — which is why gameobject names/models resolve on TDB packs and
        # degrade to id-only on the TDB-less Classic clients, like creatures.
        # `type` is the GAMEOBJECT_TYPE enum (3 CHEST, 5 GENERIC, 10 GOOBER, ...).
        # Read to gate the Wowhead object link: Wowhead indexes only some types.
        "gameobject_template": ["entry", "name", "displayId", "type"],
    },
    "hotfixes": {
        "spell_name": ["ID", "Name"],
        "spell_x_spell_visual": ["ID", "SpellID", "SpellVisualID"],
        # MissileAttachment/MissileDestinationAttachment must be overlaid too:
        # a hotfixed row replaces the wago row wholesale, so omitting them
        # would silently blank the launch/impact attachments on those visuals.
        # The redirect columns (VISUAL_REDIRECTS) and AnimEventSoundID are here
        # for exactly the same reason.
        "spell_visual": ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID",
                         "MissileAttachment", "MissileDestinationAttachment",
                         "AnimEventSoundID", *VISUAL_REDIRECTS],
        # SpellMissileMotionID and the two attachments are here for the
        # wholesale-replace reason above: a hotfixed missile row that omitted
        # them would blank the flight path and the launch/impact points.
        "spell_visual_missile": ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                                 "SoundEntriesID", "AnimKitID", "SpellMissileMotionID",
                                 "Attachment", "DestinationAttachment"],
        "spell_visual_effect_name": ["ID", "ModelFileDataID"],
        # EffectBasePoints joins the overlay for the wholesale-replace reason
        # above: it is the movement-speed percent. All four dumps that ship
        # hotfixes at all spell it the int way, even TDB1127 whose client
        # exports only the float. EffectTriggerSpell is here for the same
        # wholesale-replace reason — a hotfixed row omitting it would blank the
        # spell-link edge (§3r). Unlike the misc/target columns it is spelled
        # the SAME on both sides, verified against TDB927's hotfix schema.
        "spell_effect": ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1",
                         "EffectMiscValue2", "ImplicitTarget1", "ImplicitTarget2",
                         "EffectBasePoints", "EffectTriggerSpell"],
        "spell_misc": ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"],
        "creature_display_info": ["ID", "ModelID"],
        "creature_model_data": ["ID", "FileDataID"],
    },
}


def tdb_column_index(table: str, column: str, schema: list[str]) -> int | None:
    """Position of a column in a TDB table, or None if it is a legacy spelling.

    None means "declared in TDB_OPTIONAL_COLUMNS and not in this release" —
    the distiller writes the declared default instead.
    """
    if column in schema:
        return schema.index(column)
    if (table, column) in TDB_OPTIONAL_COLUMNS:
        return None
    sys.exit(f"error: TDB table {table} has no column {column!r} and it is not "
             f"declared in TDB_OPTIONAL_COLUMNS; schema = {schema}")


def distill_dump(lines: Iterable[str], name: str, want: dict[str, list[str]],
                 out_dir: Path, required: bool = True) -> None:
    """Write the wanted tables and columns of one SQL dump out as CSVs.

    `lines` is the dump's text, streamed; `name` identifies it in errors.

    A table may legitimately have no ``INSERT`` -- a hotfixes dump carries only
    the rows that were hotfixed -- and still gets a header-only CSV, so a
    reader can stream it without a special case. With `required` false a table
    missing from the dump altogether is tolerated too: older hotfix dumps
    predate some of the tables the build overlays.

    A row whose value count disagrees with its schema exits rather than
    writing a misaligned CSV.
    """
    schemas: dict[str, list[str]] = {}
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
        elif line.startswith("INSERT INTO `"):
            table = line.split("`")[1]
            if table not in want:
                continue
            if table not in writers:
                keep = want[table]
                idx = [tdb_column_index(table, c, schemas[table]) for c in keep]
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
            continue
        if table not in writers:  # zero hotfixed rows — emit header only
            with open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8") as handle:
                csv.writer(handle).writerow(keep)


def tdb_release(version: str) -> dict | None:
    """The TDB release for a build — matched on the PATCH, not the build id.

    TDB_RELEASES is written with a full build id because that is the client the
    release was cut against, but a TDB tracks a PATCH: TDB927 is the 9.2.7 world
    data whatever the hotfix suffix says. Keying strictly on the build id makes
    the mapping fall off the moment a pack is bumped — 3.4.3.58936 -> 3.4.3.x
    would silently lose TDB335 and every morph name with it, reported by nothing
    louder than one "no release mapped" line in a 200-line build log.

    Exact match still wins, so a release can be pinned to one build if a patch
    ever needs two.
    """
    if version in TDB_RELEASES:
        return TDB_RELEASES[version]
    patch = version.split(".")[:3]
    for build, release in TDB_RELEASES.items():
        if build.split(".")[:3] == patch:
            return release
    return None


def fetch_tdb(version: str) -> Path | None:
    """Ensure the TDB tables for this version are distilled; return their dir.

    The archive is downloaded once and its dumps are read straight out of it,
    so the hundreds of megabytes of SQL never reach the filesystem. Afterwards
    the cache holds the small distilled CSVs and the archive they came from.

    Returns None when no TDB release maps to this version, which is not an
    error: four Classic packs ship without one and the routes that need it
    degrade as declared.
    """
    rel = tdb_release(version)
    if rel is None:
        log(f"TDB: no release mapped for {version} — morphs will not resolve, "
            f"hotfixes will not apply")
        return None
    tdb_dir = CACHE_DIR / f"tdb-{rel['tag']}"
    # a release may ship world only (the 3.3.5 branch does), so only the kinds
    # this release actually has count towards "already distilled"
    kinds = [k for k in ("world", "hotfixes") if k in rel]
    wanted_csvs = [t for k in kinds for t in TDB_TABLES[k]]
    if all((tdb_dir / f"{t}.csv").exists() for t in wanted_csvs):
        log(f"TDB ({rel['tag']}): cached ({len(wanted_csvs)} distilled tables)")
        return tdb_dir
    if "hotfixes" not in rel:
        log(f"TDB ({rel['tag']}): world-only release — no hotfix overrides for this build")
    tdb_dir.mkdir(parents=True, exist_ok=True)
    archive = tdb_dir / rel["asset"]
    download(TDB_ASSET_URL.format(**rel), archive, refresh=False)
    for kind in kinds:
        member = rel[kind]
        log(f"  distilling {member} ...")
        # world tables are the only source of creature names/displays, so a
        # missing one is fatal; hotfixes are an overlay, and older dumps
        # legitimately predate some of the tables we look for
        with read_member(archive, member) as lines:
            distill_dump(lines, member, TDB_TABLES[kind], tdb_dir,
                         required=(kind == "world"))
    return tdb_dir

