#!/usr/bin/env python3
"""Build the Epsilook exploration database — a cached DEVELOPMENT tool.

    python tools/builddb.py                 # build everything (~2 min from a warm cache)
    python tools/builddb.py 9.2.7           # one version (prefix match), keep the rest
    python tools/builddb.py --refresh-dbd   # re-fetch the WoWDBDefs schema definitions
    python tools/builddb.py --list          # what would be built, and from where

The result is ONE DuckDB file at `.cache/epsilook.duckdb`, gitignored like
everything else under `.cache/`. It is not part of the product, nothing in
`site/` reads it, and deleting it costs only the time to rebuild.

WHY IT EXISTS
    `build/build_data.py` walks the game tables and bakes exactly the ~44 pack
    sections the app needs. That walk is the product; it is not a place to ask
    questions. Answering "how many spells reach a screen effect through a kit
    rather than an aura" meant writing a throwaway script that re-parsed 180 MB
    of CSV. This is that question in SQL instead.

SHAPE
    ref                 universal data — one copy, shared by every version
    v1_15_8 .. v11_2_7  one schema per game build, isolated

    Version schemas hold the client db2 tables under their real names
    (`v9_2_7."SpellEffect"`) plus the TrinityCore server tables under a `tdb_`
    prefix (`v9_2_7.tdb_creature_template`). Column names are the CSV's
    verbatim, so anything you read in build_data.py is spelled the same here.

THREE DECISIONS WORTH KNOWING BEFORE YOU CHANGE ANYTHING

    1. TYPES COME FROM WoWDBDefs, NOT FROM INFERENCE. A `.dbd` says
       `Flags<u32>` / `Gender<u8>`; DuckDB's own inference makes every integer a
       BIGINT. tools/dbd.py parses the definition and this builder applies it.
       Where a definition is missing or a value does not fit, the table falls
       back to inference and the fallback is LOGGED, never silent.

    2. RELATIONSHIPS ARE DECLARED, NOT ENFORCED — and this is not laziness.
       Real client data has dangling references: 1,139 of 163,834
       `SpellXSpellVisual` rows on 9.2.7 point at a `SpellVisual` the build does
       not ship. DuckDB's FOREIGN KEY rejects those rows outright, so enforcing
       the graph would fail the load on data that is simply how the game is.
       Instead every relationship the `.dbd` files declare (~224 per build) is
       recorded in `ref.column_info` / `ref.relation`, where it can be queried,
       joined and counted. Adding real FK constraints WILL break the build.

    3. NOTHING IS DOWNLOADED THAT build_data.py ALREADY CACHES. This reads
       `.cache/` in place. The only things it fetches are the `.dbd`
       schema definitions, the enum tables, and the few EXTRA_TABLES below that
       the pack does not need but exploration does.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))

from pack.sources import dbd  # noqa: E402  (path set above)
from pack.sources.tdb import tdb_dir_name  # noqa: E402  (path set above)
from packs import PACKS, builds, schema_name  # noqa: E402  (path set above)

from repo import CACHE, LISTFILE_ASSET

try:
    # The `type: ignore` is REQUIRED, not cosmetic: tools/check.py type-checks
    # all of tools/, and CI runs it on a machine that has never installed
    # duckdb. Without this, mypy fails with import-not-found and the whole
    # check goes red over an optional dependency of a development tool.
    import duckdb  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - the one dependency, and it is optional
    sys.exit(
        "tools/builddb.py needs DuckDB, which pyproject.toml declares:\n"
        "    uv run python tools/builddb.py"
    )

# Progress bars: a ~2.5 minute build with no output for minutes at a time reads
# as a hang, and that is all this fixes. Declared in pyproject.toml, so unlike
# the era when it was installed by hand there is no absence to degrade to.
from tqdm import tqdm

ROOT = Path(__file__).resolve().parent.parent
DBD_CACHE = CACHE / "dbd"
ENUM_CACHE = CACHE / "enums"
DB_PATH = CACHE / "epsilook.duckdb"

WAGO_CSV_URL = "https://wago.tools/db2/{table}/csv?build={version}"
DBDE_URL = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/meta/enums/{name}.dbde"
DBDE_LIST_URL = "https://api.github.com/repos/wowdev/WoWDBDefs/contents/meta/enums"
USER_AGENT = "Epsilook-devdb (github.com/Natans8/Epsilook)"

# DuckDB's storage format is not forward compatible: a file written by a newer
# engine cannot be opened by an older reader. DataGrip 2026.2 bundles JDBC
# driver 1.3.1, so the file is pinned to the v1.0.0 format to guarantee the IDE
# can open it. 1.5.5 already defaults to this; pinning stops a future DuckDB
# upgrade silently locking the user out of their own database.
STORAGE_VERSION = "v1.0.0"

# Tables worth having in the database that the PACK does not need, so
# build_data.py never downloads them. Fetched into the same per-version cache
# directory, after which the ordinary CSV sweep picks them up for free.
#
# This list is the answer to "if we don't have all the data, rethink how we
# fetch it": adding a name here is the whole change.
EXTRA_TABLES = {
    # The kit table itself. build_data.py reaches kits through
    # SpellVisualEvent -> SpellVisualKitEffect and never reads SpellVisualKit,
    # so its own columns (flags, anim ids, the kit's own name) are invisible to
    # every question asked so far. 6.65% of SpellVisualKitEffect rows point at a
    # kit no event reaches, and without this table there is no way to see them.
    "SpellVisualKit": "the kit rows themselves — reached but never read by the pack build",
    "AnimKitConfig": "AnimKitSegment.AnimKitConfigID resolves here (bonesets go through it)",
    "AnimKit": "the animkit rows themselves; segments carry ParentAnimKitID",
    "SpellVisualKitPicker": "kits chosen at random — SpellVisualKitPickerEntry's parent",
    # ------------------------------------------------------------ conditionals
    #
    # THE GATES ON A SPELL — everything that decides whether it casts at all,
    # and which of several visuals plays when it does. None of it was reachable
    # here before 2026-08-05, which made "why does this spell do nothing"
    # unanswerable in SQL.
    #
    # Two independent families, and they are evaluated in different places:
    #   CAST gates  — SpellCastingRequirements (zone/focus/faction),
    #                 SpellAuraRestrictions, SpellTargetRestrictions,
    #                 SpellLevels, SpellEquippedItems, SpellReagents,
    #                 SpellTotems.
    #
    #                 DO NOT ASSUME THESE ARE ENFORCED. Tested in game
    #                 2026-08-05: Epsilon enforces the AREA gate and does NOT
    #                 enforce OnlyOutdoors or CasterAuraSpell, though retail
    #                 TrinityCore checks all three. `.aura` bypasses every
    #                 restriction outright (it never enters CheckCast). See
    #                 docs/DECISIONS.md, "Epsilon enforces the AREA gate and
    #                 almost nothing else" — the data being present here says
    #                 nothing about whether the audience's server honours it.
    #   VISUAL gates — SpellXSpellVisual's four condition columns resolve into
    #                 PlayerCondition / UnitCondition.
    "SpellCastingRequirements": "RequiredAreasID / RequiresSpellFocus / MinFactionID — the zone gate",
    "AreaGroupMember": "SpellCastingRequirements.RequiredAreasID expands to area ids here",
    "AreaTable": "names the areas AreaGroupMember lists (and every other AreaID in the data)",
    "SpellAuraRestrictions": "caster/target aura and aura-state gates, incl. the Exclude* pair",
    "SpellTargetRestrictions": "who may be targeted — creature type, max targets, cone",
    "SpellLevels": "BaseLevel / MaxLevel / SpellLevel gates",
    "SpellEquippedItems": "weapon/armour class gates (EquippedItemClass/-Subclass/-InvTypes)",
    "SpellReagents": "material components a cast consumes",
    "SpellTotems": "required totem items",
    # The area pill needs a MAP to link to, and AreaTable.ID is not one:
    # `OpenWorldMap()` in Lua takes a UiMapID. UiMapAssignment is the only
    # bridge between the two.
    "UiMap": "the map ids Lua's OpenWorldMap() takes — NOT AreaTable.ID",
    "UiMapAssignment": "AreaID -> UiMapID, the only bridge from an area to a map",
    "SpellFocusObject": "names SpellCastingRequirements.RequiresSpellFocus (the second binding gate)",
    "PlayerCondition": "SpellXSpellVisual.{Caster,Viewer}PlayerConditionID resolves here",
    "UnitCondition": "SpellXSpellVisual.{Caster,Viewer}UnitConditionID resolves here",
    # ---------------------------------------------------------------- stacking
    #
    # CumulativeAura is the stack CEILING and it lives nowhere else — not on
    # Spell, not on SpellMisc, not in any attribute bit. Without this table the
    # question "how far can I stack this" has no answer in SQL at all.
    # ProcCharges is the other, unrelated counter on the same row: charges are
    # spent by procs, stacks are not, and the two are independent.
    "SpellAuraOptions": "CumulativeAura — the stack limit; plus ProcCharges and the proc mask",
    # ---------------------------------------------------------------- enchants
    #
    # `.enchant mainhand <id>` takes a SpellItemEnchantment ID, and nothing else
    # in the cache names one — an enchant id in a macro or an ArcSpell was an
    # opaque number until this was added (2026-08-06, resolving 5877/5385 out of
    # a real ArcSpell). Weapon-glow enchants are the RP-relevant ones: the
    # Effect_* / EffectArg_* columns carry the enchant TYPE and its payload.
    "SpellItemEnchantment": "names enchant ids — what `.enchant mainhand <id>` takes",
    # ------------------------------------------------------- the raw-id arsenal
    #
    # ARCANUM ADDRESSES ASSETS BY RAW ID, AND EPSILOOK ONLY INDEXES THE ONES A
    # SPELL REACHES. `.mod anim`, `.mod animkit` and Arcanum's own sound actions
    # take any id in these tables whether or not a spell ever used it, so
    # composing against "the full arsenal" needs the tables themselves.
    #
    # Measured 2026-08-06: 9.2.7 — the build Epsilon RUNS — cached SoundKitEntry
    # but neither SoundKit nor AnimationData, while 10.2.7 and 11.2.7 had both.
    # So the product version was the ONE version that could not answer
    # "what sound kits exist" or "what is animation 403 called".
    "SoundKit": "the kit rows behind SoundKitEntry — SoundType, volume, flags",
    "AnimationData": "names animation ids; AnimKitSegment and the anim routes point here",
    "Emotes": "`.mod anim <id>` takes an EMOTE id, and this is the only table that names one",
    "EmotesTextSound": "emote -> voice line, per race/sex — why one emote is audible and another is not",
    # SoundKitName was tried here on 2026-08-06 and REMOVED the same hour. It
    # writes a 0-BYTE file on every 9.x/10.x/11.x build (the table stopped
    # shipping after 8.3.0, exactly as DATA_ROUTES §3u records), and because
    # fetch_extra_tables skips a destination that already exists, that empty
    # file is permanent — a cache poisoned against a table that will never
    # arrive. The Classic builds that DO ship it already get it through the
    # normal CSV sweep, and 9.2.7's names come from the pinned 8.3.0 download
    # the pack build makes. Nothing was missing; do not add it back.
    # SpellCastTimes, SpellDuration and SpellInterrupts USED to be listed here.
    # They are build_data.py TABLES now (the delivery line reads all three), so
    # the normal CSV sweep already caches them and repeating them here would
    # only be a second place to keep in step.
}

# ---------------------------------------------------------------- enum linkage
#
# WoWDBDefs ships ~169 enum tables but nothing says WHICH COLUMN uses WHICH
# enum — that mapping exists only in readers like build_data.py. Declared here
# so `ref.enum_column` can join a raw value to its name.
#
# EXTENSION POINT: one line per (table, column) -> enum name.
ENUM_COLUMNS = {
    ("SpellEffect", "Effect"): "SpellEffect",
    ("SpellEffect", "EffectAura"): "SpellEffectAura",
    ("SpellEffect", "ImplicitTarget_0"): "Target",
    ("SpellEffect", "ImplicitTarget_1"): "Target",
    ("SpellVisualEvent", "StartEvent"): "SpellVisualEventEvent",
    ("SpellVisualEvent", "EndEvent"): "SpellVisualEventEvent",
    ("SpellVisualEffectName", "Type"): "SpellVisualEffectNameType",
}

# Enums always fetched even if the sweep of meta/enums/ fails.
CORE_ENUMS = [
    "SpellEffect", "SpellEffectAura", "Target",
    "SpellVisualEventEvent", "SpellVisualEffectNameType",
]

# ------------------------------------------------- project knowledge as tables
#
# Decodes that live in docs/DATA_ROUTES.md / CLAUDE.md prose and nowhere machine
# readable. Shipping them as lookup tables is what makes the raw ids in
# SpellVisualKitEffect / SpellProceduralEffect legible without a second window
# open. Sources are cited so they can be re-verified, not just trusted.

# docs/DATA_ROUTES.md 3a — which table SpellVisualKitEffect.Effect points at.
KIT_EFFECT_TYPES = [
    (1, "SpellProceduralEffect", "dispatched again by Type; see ref.proc_type"),
    (2, "SpellVisualKitModelAttach", "dropped by the pack: redundant with the kit walk"),
    (3, "CameraEffect", "not surfaced"),
    (4, "CameraEffect", "camera related; not surfaced"),
    (5, "SoundKit", "-> SoundKitEntry -> sound FileDataIDs"),
    (6, "SpellVisualAnim", "-> AnimKit segments and loose AnimationData ids"),
    (7, "ShadowyEffect", "ghost — two packed colours"),
    (8, "SpellEffectEmission", "-> SpellVisualKitAreaModel -> model fid"),
    (9, "OutlineEffect", "not surfaced"),
    (10, "UnitSoundType", "dropped: plays the target's own sound, names no file"),
    (11, "DissolveEffect", "-> TextureBlendSet -> texture fids"),
    (12, "EdgeGlowEffect", "glow — packed RGB + alpha"),
    (13, "BeamEffect", "-> SpellChainEffects"),
    (14, "ClientSceneEffect", "not surfaced"),
    (15, "CloneEffect", "absent from the data"),
    (16, "GradientEffect", "not surfaced"),
    (17, "BarrageEffect", "-> SpellVisualEffectName -> model fid"),
    (18, "RopeEffect", "not surfaced"),
    (19, "SpellVisualScreenEffect", "-> ScreenEffect"),
    (20, "SpellVisualKitPicker", "absent from the data"),
]

# DATA_ROUTES.md section 3b — SpellProceduralEffect.Type is the client's
# character-procedure index, and it selects WHICH Value_n column is the payload.
PROC_TYPES = [
    (0, "Value_0", "chain", "-> SpellChainEffects (variant of 26)"),
    (1, "Value_0", "tint", "packed RGB, multiply"),
    (2, None, "scale", "not surfaced"),
    (3, None, "colour payload", "not surfaced"),
    (4, None, "emissive colour", "not surfaced"),
    (5, None, "colour payload", "not surfaced"),
    (6, None, "eclipse overlay", "not surfaced"),
    (7, "Value_0/1/2", "replace", "AnimationData ids: Stand/Walk/RUN swaps"),
    (8, None, "weapon trail (old)", "not surfaced"),
    (9, "Value_0", "model", "-> SpellVisualKitAreaModel (ground)"),
    (10, None, "fishing line", "not surfaced"),
    (11, None, "freeze", "valueless"),
    (12, "Value_0", "chain", "-> SpellChainEffects (variant of 26)"),
    (13, None, "gore/blood", "undocumented"),
    (14, "Value_0", "transparency", "alpha 0..1"),
    (15, None, "do fade", "not surfaced"),
    (16, None, "mount transition", "not surfaced"),
    (17, "Value_1", "item visual", "Item::ID"),
    (18, None, "camo", "valueless"),
    (19, None, "head look", "not surfaced"),
    (20, None, "time rate", "not surfaced"),
    (21, "Value_2", "desaturate", "strength 0..1, ~94% colourless"),
    (22, "Value_3", "ghost", "packed RGB; translucent shadow materials"),
    (23, "Value_3", "tint", "packed RGB material recolor"),
    (24, None, "play all attached mirrored", "not surfaced"),
    (25, None, "mirror image / item visual", "not surfaced"),
    (26, "Value_0", "chain", "-> SpellChainEffects (main beams)"),
    (27, "Value_0", "model", "-> WeaponTrail (trail)"),
    (29, None, "LOD enforce", "undocumented"),
    (30, None, "cast/strike anim override", "undocumented"),
    (31, None, "Legion artifact hidden proc", "all-zero"),
    (33, None, "desaturate aura", "2 dead spells"),
]

# docs/DATA_ROUTES.md 2 — SpellVisualEvent.TargetType and the search word it becomes.
TARGET_TYPES = [
    (0, 0, None, "effectively unused (1 row in 207,241 on 9.2.7)"),
    (1, 1, "caster", "on the caster"),
    (2, 2, "target", "on the target"),
    (3, 4, "area", "on the ground at the target"),
    (4, 8, "target", "on the target only, never the caster"),
    (5, 16, "area", "on the ground where the missile lands"),
]


def log(message: str) -> None:
    # Routed through tqdm.write because a bar may be on screen: an ordinary
    # print lands ON TOP of the bar and shreds it.
    tqdm.write(message)


def progress(items: "Iterable[Any]", desc: str, unit: str,
             total: int | None = None, nested: bool = False) -> "Iterable[Any]":
    """Wrap an iterable in a tqdm bar, or return it untouched.

    It declines when stderr is not a TTY, which matters because this script is
    routinely run redirected to a log file (`python tools/builddb.py > out.log`)
    and a bar rendered into a file is thousands of lines of carriage-return
    noise that buries the real output.
    """
    if not sys.stderr.isatty():
        return items
    return tqdm(items, desc=desc, unit=unit, total=total,
                leave=not nested, dynamic_ncols=True)


def scalar(con: "duckdb.DuckDBPyConnection", sql: str,
           params: list | None = None) -> int:
    """One-cell query. `fetchone()` is Optional, and every caller here is a
    COUNT that cannot legitimately come back empty — so a None is a bug worth
    hearing about rather than a zero worth papering over."""
    row = con.execute(sql, params) if params else con.execute(sql)
    result = row.fetchone()
    if result is None:
        raise RuntimeError(f"query returned no row: {sql}")
    return int(result[0])


def fetch(url: str, dest: Path, refresh: bool = False, timeout: int = 120) -> bool:
    """Download to `dest` unless cached. False means "not available" (404)."""
    if dest.exists() and not refresh:
        return dest.stat().st_size > 0
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            dest.write_bytes(response.read())
        return dest.stat().st_size > 0
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            dest.write_bytes(b"")  # remember the absence
            return False
        raise


# --------------------------------------------------------------- schema naming

def sql_type(column: dbd.Column | None, width: dbd.BuildColumn | None) -> str | None:
    """Map a WoWDBDefs declaration to a DuckDB type. None = let DuckDB infer."""
    if column is None:
        return None
    if column.type in ("string", "locstring"):
        return "VARCHAR"
    if column.type == "float":
        return "FLOAT"
    if column.type == "int":
        bits = width.width if width and width.width else 32
        unsigned = bool(width and width.unsigned)
        table = {
            8: ("UTINYINT", "TINYINT"),
            16: ("USMALLINT", "SMALLINT"),
            32: ("UINTEGER", "INTEGER"),
            64: ("UBIGINT", "BIGINT"),
        }
        return table.get(bits, ("UINTEGER", "INTEGER"))[0 if unsigned else 1]
    return None


def resolve_column(name: str, definition: dbd.Definition,
                   widths: dict[str, dbd.BuildColumn]
                   ) -> tuple[dbd.Column | None, dbd.BuildColumn | None, int | None]:
    """Match a CSV column back to its `.dbd` declaration.

    Three spellings have to be reconciled, and the order matters:
      exact            `Flags`          -> Flags
      localised        `Name_lang`      -> Name_lang, else Name
      array element    `Offset_0`       -> Offset[3], element 0

    The array rule is checked LAST and only against a DECLARED array, because
    plenty of real columns simply end in a number — `Field_9_1_0_38549_014` is
    one column, not element 14 of `Field_9_1_0_38549`.
    """
    if name in definition.columns:
        return definition.columns[name], widths.get(name), None

    if name.endswith("_lang"):
        base = name[: -len("_lang")]
        if base in definition.columns:
            return definition.columns[base], widths.get(base), None

    base, _, index = name.rpartition("_")
    if index.isdigit() and base in definition.columns:
        width = widths.get(base)
        if width is None or width.array is None or int(index) < width.array:
            return definition.columns[base], width, int(index)

    return None, None, None


# ------------------------------------------------------------------ ingestion

def csv_header(path: Path) -> list[str]:
    with open(path, encoding="utf-8", errors="replace", newline="") as handle:
        try:
            return next(csv.reader(handle))
        except StopIteration:
            return []


def load_csv_table(con: "duckdb.DuckDBPyConnection", schema: str, table: str,
                   path: Path, types: dict[str, str]) -> tuple[int, bool]:
    """Create `schema.table` from a CSV. Returns (rows, fell_back_to_inference).

    A type that does not fit the data drops the WHOLE table to inference rather
    than losing rows — and says so. That has to stay loud: a silently widened
    column is a schema drift nobody will notice.
    """
    qualified = f'"{schema}"."{table}"'
    literal = str(path).replace("'", "''")
    if types:
        struct = ", ".join(f"'{c}': '{t}'" for c, t in types.items())
        typed = (f"CREATE OR REPLACE TABLE {qualified} AS SELECT * FROM "
                 f"read_csv('{literal}', header=true, types={{{struct}}}, sample_size=-1)")
        try:
            con.execute(typed)
            return scalar(con, f"SELECT count(*) FROM {qualified}"), False
        except duckdb.Error:
            pass
    con.execute(f"CREATE OR REPLACE TABLE {qualified} AS SELECT * FROM "
                f"read_csv('{literal}', header=true, sample_size=-1)")
    return scalar(con, f"SELECT count(*) FROM {qualified}"), bool(types)


def build_version(con: "duckdb.DuckDBPyConnection", build_id: str,
                  catalog: list[tuple], refresh_dbd: bool) -> tuple[int, int, int]:
    """Load every CSV in one version's cache directory into its own schema."""
    schema = schema_name(build_id)
    build = dbd.parse_build(build_id)
    source = CACHE / build_id
    if build is None or not source.is_dir():
        log(f"  ! {build_id}: no cache directory — run build/build_data.py first")
        return 0, 0, 0

    con.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
    tables = rows = fallbacks = 0

    csvs = sorted(source.glob("*.csv"))
    for path in progress(csvs, f"  {schema} db2", "table", len(csvs), nested=True):
        table = path.stem
        header = csv_header(path)
        if not header:
            continue

        definition = dbd.load(table, DBD_CACHE, refresh=refresh_dbd)
        widths = definition.widths_for(build) if definition else {}
        types: dict[str, str] = {}

        for name in header:
            column = width = None
            index = None
            if definition:
                column, width, index = resolve_column(name, definition, widths)
            duck_type = sql_type(column, width)
            if duck_type:
                types[name] = duck_type
            catalog.append((
                schema, build_id, table, name,
                column.name if column else None, index,
                column.type if column else None, duck_type,
                width.width if width else None,
                bool(width.unsigned) if width else None,
                bool(width.is_id) if width else False,
                bool(width.is_relation) if width else False,
                bool(column.unverified) if column else None,
                column.comment if column else None,
                column.fk_table if column else None,
                column.fk_column if column else None,
                ENUM_COLUMNS.get((table, name)),
            ))

        count, fell_back = load_csv_table(con, schema, table, path, types)
        tables += 1
        rows += count
        if fell_back:
            fallbacks += 1
            log(f"    ~ {table}: declared types rejected, inferred instead")

    return tables, rows, fallbacks


def load_tdb(con: "duckdb.DuckDBPyConnection", build_id: str, tdb_tag: str | None) -> int:
    """Load the TrinityCore distilled CSVs under a `tdb_` prefix.

    Four Classic re-release packs have no TDB release at all — they simply get
    no tdb_ tables, exactly as the pack build degrades for them.

    The directory is named by the build rather than spelled again here: it is
    keyed on the release TAG, so two builds matching one release read one
    directory, and a tool guessing at that name reads nothing at all.
    """
    if not tdb_tag:
        return 0
    directory = CACHE / tdb_dir_name(tdb_tag)
    if not directory.is_dir():
        return 0
    schema = schema_name(build_id)
    loaded = 0
    tdb_csvs = sorted(directory.glob("*.csv"))
    for path in progress(tdb_csvs, f"  {schema} tdb", "table", len(tdb_csvs), nested=True):
        if not csv_header(path):
            continue
        literal = str(path).replace("'", "''")
        con.execute(f'CREATE OR REPLACE TABLE "{schema}"."tdb_{path.stem}" AS '
                    f"SELECT * FROM read_csv('{literal}', header=true, sample_size=-1)")
        loaded += 1
    return loaded


def fetch_extra_tables(build_id: str) -> None:
    """Download the EXTRA_TABLES this build has, into its normal cache dir.

    They then look exactly like anything build_data.py cached, so the CSV sweep
    picks them up with no special case. A table that postdates the build 404s
    and is remembered as absent.
    """
    directory = CACHE / build_id
    if not directory.is_dir():
        return
    for table in EXTRA_TABLES:
        destination = directory / f"{table}.csv"
        if destination.exists():
            continue
        try:
            if fetch(WAGO_CSV_URL.format(table=table, version=build_id), destination):
                log(f"    + {table}.csv")
        except OSError as exc:
            log(f"    ! {table}: {exc}")


def fetch_enums(refresh: bool) -> list[str]:
    """Cache every WoWDBDefs enum table. ~169 files, a few hundred KB in total.

    All of them, not just the five we currently decode: they are tiny, they are
    the only place an enum value's NAME is written down, and the point of this
    database is to have the answer before the question is asked.
    """
    ENUM_CACHE.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    try:
        request = urllib.request.Request(DBDE_LIST_URL, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response:
            names = [entry["name"][: -len(".dbde")]
                     for entry in json.load(response)
                     if entry["name"].endswith(".dbde")]
    except (OSError, ValueError, KeyError):
        log("  ! could not list meta/enums — falling back to the core set")

    for name in sorted(set(names) | set(CORE_ENUMS)):
        try:
            fetch(DBDE_URL.format(name=name), ENUM_CACHE / f"{name}.dbde", refresh=refresh)
        except OSError:
            continue
    return sorted(set(names) | set(CORE_ENUMS))


def build_reference(con: "duckdb.DuckDBPyConnection", manifest: list[dict],
                    refresh: bool) -> None:
    """The `ref` schema — everything that is the same for every game version."""
    con.execute("CREATE SCHEMA IF NOT EXISTS ref")

    # -- listfile: the only route from a FileDataID to a path ------------------
    listfile = CACHE / "listfile" / LISTFILE_ASSET
    if listfile.exists():
        literal = str(listfile).replace("'", "''")
        con.execute(f"""
            CREATE OR REPLACE TABLE ref.listfile AS
            SELECT CAST(column0 AS UINTEGER) AS fid, column1 AS path
            FROM read_csv('{literal}', header=false, delim=';',
                          columns={{'column0':'VARCHAR','column1':'VARCHAR'}})""")
        count = scalar(con, "SELECT count(*) FROM ref.listfile")
        log(f"  ref.listfile                    {count:>9,}")

    # -- sound-kit names (SoundKitID -> "Invisibility Impact") ----------------
    # Build-independent on purpose, hence `ref` and not a per-version table:
    # `SoundKitName` was last shipped at 8.3.0.32218 and exists in NO 9.x+
    # build, so one pinned copy names kits for every schema here. Kit ids are
    # stable across builds (99.65% identical file sets), which is what makes the
    # join sound. See build_data.SOUNDKITNAME_BUILD.
    skn = CACHE / "8.3.0.32218" / "SoundKitName.csv"
    if skn.exists():
        literal = str(skn).replace("'", "''")
        con.execute(f"""
            CREATE OR REPLACE TABLE ref.sound_kit_name AS
            SELECT CAST("ID" AS UINTEGER) AS sound_kit_id, "Name" AS name
            FROM read_csv('{literal}', header=true)
            WHERE "Name" IS NOT NULL AND "Name" <> ''""")
        count = scalar(con, "SELECT count(*) FROM ref.sound_kit_name")
        log(f"  ref.sound_kit_name              {count:>9,}")

    # -- animation names (AnimID -> "Stand") ----------------------------------
    anims = CACHE / "anims.js"
    if anims.exists():
        text = anims.read_text(encoding="utf-8", errors="replace")
        names = re.findall(r'"((?:[^"\\]|\\.)*)"', text)
        con.execute("CREATE OR REPLACE TABLE ref.anim_name "
                    "(anim_id INTEGER PRIMARY KEY, name VARCHAR)")
        con.executemany("INSERT INTO ref.anim_name VALUES (?, ?)",
                        list(enumerate(names)))
        log(f"  ref.anim_name                   {len(names):>9,}")

    # -- hardcoded client tables, imported from build_data.py -----------------
    # Imported rather than re-typed: a second copy of a table is a copy waiting
    # to drift, and build_data.py is already where both are maintained.
    try:
        import build_data

        con.execute("CREATE OR REPLACE TABLE ref.m2_attachment "
                    "(attachment_id INTEGER PRIMARY KEY, name VARCHAR)")
        con.executemany("INSERT INTO ref.m2_attachment VALUES (?, ?)",
                        sorted(build_data.M2_ATTACHMENT_NAMES.items()))
        log(f"  ref.m2_attachment               "
            f"{len(build_data.M2_ATTACHMENT_NAMES):>9,}")

        # VehicleSeat.AttachmentID is an INDEX into a table hardcoded in the
        # client binary, not an M2 attachment id (DATA_ROUTES 3i). Shipping the
        # decode makes that join possible in SQL instead of in prose.
        links = build_data.VEHICLE_GEO_COMPONENT_LINKS
        pairs = (sorted(links.items()) if isinstance(links, dict)
                 else list(enumerate(links)))
        con.execute("CREATE OR REPLACE TABLE ref.vehicle_geo_component_link "
                    "(idx INTEGER PRIMARY KEY, attachment_id INTEGER)")
        con.executemany("INSERT INTO ref.vehicle_geo_component_link VALUES (?, ?)",
                        pairs)
        log(f"  ref.vehicle_geo_component_link  {len(pairs):>9,}")

        # The 449 spell attribute bits. They are packed across
        # SpellMisc.Attributes_0..N (32 bits per column), so the raw columns are
        # unreadable without this: attr_column + mask are the two things a query
        # needs. `handler` marks the bits the pack ships as pills, `requires` the
        # one intersection rule (160 only means anything AND 34).
        attrs = build_data.load_local_enum("spell_attributes")
        con.execute("CREATE OR REPLACE TABLE ref.spell_attribute ("
                    " bit INTEGER PRIMARY KEY, name VARCHAR, label VARCHAR,"
                    " attr_column VARCHAR, mask BIGINT,"
                    " handler VARCHAR, requires INTEGER)")
        con.executemany(
            "INSERT INTO ref.spell_attribute VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(bit, meta["name"], meta["label"],
              f"Attributes_{bit // 32}", 1 << (bit % 32),
              meta.get("handler"), meta.get("requires"))
             for bit, meta in sorted(attrs.items())])
        log(f"  ref.spell_attribute             {len(attrs):>9,}")

        # The two interrupt-flag enums, in ONE table with the column each
        # applies to — because SpellInterrupts' three flag columns do NOT share
        # an enum and reading them with one decode has already reported the
        # breaks-on-movement channel population 4.4x too low. Query with the
        # `flag_column` you are actually decoding:
        #   InterruptFlags          -> SpellInterrupts::InterruptFlags, move = 0
        #   AuraInterruptFlags_N    -> SpellInterruptFlags,             move = 3
        #   ChannelInterruptFlags_N -> SpellInterruptFlags,             move = 3
        con.execute("CREATE OR REPLACE TABLE ref.spell_interrupt_flag ("
                    " enum VARCHAR, applies_to VARCHAR, bit INTEGER,"
                    " name VARCHAR, label VARCHAR, mask BIGINT, handler VARCHAR)")
        interrupt_rows = []
        for enum_file, applies in (("spell_interrupts_interrupt_flags", "InterruptFlags"),
                                   ("spell_interrupt_flags", "AuraInterruptFlags / ChannelInterruptFlags")):
            enum = build_data.load_local_enum(enum_file)
            interrupt_rows += [
                (enum_file, applies, bit, meta["name"], meta["label"],
                 1 << (bit % 32), meta.get("handler"))
                for bit, meta in sorted(enum.items())]
        con.executemany("INSERT INTO ref.spell_interrupt_flag VALUES (?, ?, ?, ?, ?, ?, ?)",
                        interrupt_rows)
        log(f"  ref.spell_interrupt_flag        {len(interrupt_rows):>9,}")
    except (ImportError, AttributeError) as exc:
        log(f"  ! build_data.py tables unavailable ({exc})")

    # -- enums ----------------------------------------------------------------
    enum_names = fetch_enums(refresh)
    con.execute("CREATE OR REPLACE TABLE ref.enum_value "
                "(enum_name VARCHAR, value INTEGER, name VARCHAR)")
    rows: list[tuple[str, int, str]] = []
    for name in enum_names:
        path = ENUM_CACHE / f"{name}.dbde"
        if not path.exists() or not path.stat().st_size:
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            value, _, label = line.strip().partition(" ")
            label = label.strip()
            if value.lstrip("-").isdigit() and label:
                rows.append((name, int(value), label))
    if rows:
        con.executemany("INSERT INTO ref.enum_value VALUES (?, ?, ?)", rows)
    con.execute("CREATE INDEX IF NOT EXISTS enum_value_idx "
                "ON ref.enum_value(enum_name, value)")
    log(f"  ref.enum_value                  {len(rows):>9,}  "
        f"({len({r[0] for r in rows})} enums)")

    # -- decodes that exist only as prose in docs/DATA_ROUTES.md / CLAUDE.md -------
    con.execute("CREATE OR REPLACE TABLE ref.kit_effect_type "
                "(effect_type INTEGER PRIMARY KEY, target_table VARCHAR, note VARCHAR)")
    con.executemany("INSERT INTO ref.kit_effect_type VALUES (?, ?, ?)", KIT_EFFECT_TYPES)

    con.execute("CREATE OR REPLACE TABLE ref.proc_type "
                "(type INTEGER PRIMARY KEY, payload_column VARCHAR, "
                " becomes VARCHAR, note VARCHAR)")
    con.executemany("INSERT INTO ref.proc_type VALUES (?, ?, ?, ?)", PROC_TYPES)

    con.execute("CREATE OR REPLACE TABLE ref.target_type "
                "(target_type INTEGER PRIMARY KEY, bit INTEGER, "
                " word VARCHAR, meaning VARCHAR)")
    con.executemany("INSERT INTO ref.target_type VALUES (?, ?, ?, ?)", TARGET_TYPES)
    log("  ref.kit_effect_type / proc_type / target_type   (project decodes)")

    # -- the version manifest -------------------------------------------------
    con.execute("CREATE OR REPLACE TABLE ref.game_build ("
                " schema_name VARCHAR PRIMARY KEY, build_id VARCHAR, label VARCHAR,"
                " major INTEGER, minor INTEGER, patch INTEGER, build_number INTEGER,"
                " is_default BOOLEAN, tdb_tag VARCHAR)")
    for entry in manifest:
        parsed = dbd.parse_build(entry["id"]) or (0, 0, 0, 0)
        con.execute("INSERT INTO ref.game_build VALUES (?,?,?,?,?,?,?,?,?)",
                    [schema_name(entry["id"]), entry["id"], entry.get("label"),
                     *parsed, bool(entry.get("default")), entry.get("tdb_tag")])


def build_catalog(con: "duckdb.DuckDBPyConnection", catalog: list[tuple]) -> None:
    """`ref.column_info` — every physical column, typed, with its FK and comment.

    This is where "relationships are configured" actually lives. It is a table
    rather than FK constraints for the reason in the module docstring: the real
    data has dangling references and constraints would reject them.
    """
    con.execute("""
                CREATE
                OR REPLACE TABLE ref.column_info (
            schema_name   VARCHAR,  build_id      VARCHAR,
            table_name    VARCHAR,  column_name   VARCHAR,
            dbd_column    VARCHAR,  array_index   INTEGER,
            dbd_type      VARCHAR,  sql_type      VARCHAR,
            width         INTEGER,  unsigned      BOOLEAN,
            is_id         BOOLEAN,  is_relation   BOOLEAN,
            unverified    BOOLEAN,  comment       VARCHAR,
            fk_table      VARCHAR,  fk_column     VARCHAR,
            enum_name     VARCHAR)""")
    if catalog:
        con.executemany(
            "INSERT INTO ref.column_info VALUES (" + ",".join("?" * 17) + ")",
            catalog)
    con.execute("CREATE INDEX IF NOT EXISTS column_info_idx "
                "ON ref.column_info(schema_name, table_name)")

    # The FK graph on its own, flagged by whether the target is a table we hold:
    # a `.dbd` names tables we never download, and a relation you cannot join is
    # noise. `resolvable` is which side of that line a row falls on.
    con.execute("""
                CREATE
                OR REPLACE VIEW ref.relation AS
                SELECT c.schema_name,
                       c.build_id,
                       c.table_name                                           AS from_table,
                       c.column_name                                          AS from_column,
                       c.fk_table                                             AS to_table,
                       c.fk_column                                            AS to_column,
                       c.comment,
                       EXISTS (SELECT 1
                               FROM ref.column_info t
                               WHERE t.schema_name = c.schema_name
                                 AND lower(t.table_name) = lower(c.fk_table)) AS resolvable
                FROM ref.column_info c
                WHERE c.fk_table IS NOT NULL""")

    total = scalar(con, "SELECT count(*) FROM ref.relation")
    usable = scalar(con, "SELECT count(*) FROM ref.relation WHERE resolvable")
    log(f"  ref.column_info                 {len(catalog):>9,}  columns")
    log(f"  ref.relation                    {total:>9,}  "
        f"({usable:,} join to a table we hold)")


# ---------------------------------------------------------------------- views
#
# The altitude here is deliberate: these views cover the SPINE — the joins every
# question repeats — and stop short of the payload routes. Reimplementing
# build_data.py's six model routes in SQL would be a second copy of the hardest
# logic in the project, guaranteed to drift from the one the app actually ships.
# So: getting from a spell to its kits is a view; deciding what a kit MEANS
# stays in build_data.py.

def has_tables(con: "duckdb.DuckDBPyConnection", schema: str, *tables: str) -> bool:
    placeholders = ",".join("?" * len(tables))
    found = scalar(
        con,
        "SELECT count(DISTINCT lower(table_name)) FROM information_schema.tables "
        f"WHERE table_schema = ? AND lower(table_name) IN ({placeholders})",
        [schema, *(t.lower() for t in tables)])
    return found == len(tables)


def make_view(con: "duckdb.DuckDBPyConnection", schema: str, name: str,
              body: str) -> int:
    """Create one convenience view, refusing to collide with a real table.

    NAMING CONVENTION, and it is load-bearing: db2 tables keep their PascalCase
    singular names (`Spell`, `SpellVisualKit`), convenience views are snake_case
    and plural (`spells`, `spell_kits`). DuckDB compares identifiers
    case-insensitively, so a view called `spell` and the table `Spell` are the
    same name — that collision crashed the first build of this script. The guard
    below turns a future one into a warning instead of a stack trace.
    """
    exists = con.execute(
        "SELECT table_type FROM information_schema.tables "
        "WHERE table_schema = ? AND lower(table_name) = ?",
        [schema, name.lower()]).fetchone()
    if exists and exists[0] == "BASE TABLE":
        log(f"    ! view {name} skipped: a table of that name already exists")
        return 0
    con.execute(f'CREATE OR REPLACE VIEW "{schema}"."{name}" AS {body}')
    return 1


def build_views(con: "duckdb.DuckDBPyConnection", schema: str) -> int:
    """Convenience views for one version. Each is skipped if its sources are absent."""
    made = 0
    q = f'"{schema}"'

    # spells — id + name, resolving the BfA table split so downstream views do
    # not have to care which side of it this build sits on.
    if has_tables(con, schema, "SpellName"):
        made += make_view(con, schema, "spells",
                          f'SELECT ID AS spell_id, Name_lang AS name FROM {q}."SpellName"')
    elif has_tables(con, schema, "Spell"):
        made += make_view(con, schema, "spells",
                          f'SELECT ID AS spell_id, Name_lang AS name FROM {q}."Spell"')

    # spell_kit — the spine, flattened. Spell -> visual -> event -> kit, with
    # the event's target mask and phase carried along, because every visual
    # question starts by repeating exactly this join.
    if has_tables(con, schema, "SpellXSpellVisual", "SpellVisualEvent"):
        made += make_view(con, schema, "spell_kits", f"""
            SELECT x.SpellID          AS spell_id,
                   x.SpellVisualID    AS visual_id,
                   e.SpellVisualKitID AS kit_id,
                   e.TargetType       AS target_type,
                   t.word             AS target_word,
                   e.StartEvent       AS start_event,
                   se.name            AS start_event_name,
                   e.EndEvent         AS end_event
            FROM {q}."SpellXSpellVisual" x
            JOIN {q}."SpellVisualEvent"  e ON e.SpellVisualID = x.SpellVisualID
            LEFT JOIN ref.target_type    t ON t.target_type   = e.TargetType
            LEFT JOIN ref.enum_value    se ON se.enum_name = 'SpellVisualEventEvent'
                                          AND se.value     = e.StartEvent""")

    # kit_effects — a kit's effect rows with EffectType decoded into the table
    # its Effect column actually points at (DATA_ROUTES 3a).
    if has_tables(con, schema, "SpellVisualKitEffect"):
        made += make_view(con, schema, "kit_effects", f"""
            SELECT k.ParentSpellVisualKitID AS kit_id,
                   k.EffectType             AS effect_type,
                   r.target_table           AS effect_table,
                   k.Effect                 AS effect_id,
                   r.note
            FROM {q}."SpellVisualKitEffect" k
            LEFT JOIN ref.kit_effect_type r ON r.effect_type = k.EffectType""")

    # spell_effects — the single highest-traffic exploration query: an effect
    # row with its enums spelled out and the spell named, instead of four
    # integers you have to look up by hand.
    if has_tables(con, schema, "SpellEffect"):
        made += make_view(con, schema, "spell_effects", f"""
            SELECT e.SpellID            AS spell_id,
                   s.name               AS spell_name,
                   e.EffectIndex        AS effect_index,
                   e.Effect             AS effect,
                   ef.name              AS effect_name,
                   e.EffectAura         AS aura,
                   au.name              AS aura_name,
                   e.EffectMiscValue_0  AS misc0,
                   e.EffectMiscValue_1  AS misc1,
                   e.ImplicitTarget_0   AS target0,
                   t0.name              AS target0_name,
                   e.ImplicitTarget_1   AS target1,
                   t1.name              AS target1_name
            FROM {q}."SpellEffect" e
            LEFT JOIN {q}.spells     s ON s.spell_id  = e.SpellID
            LEFT JOIN ref.enum_value ef ON ef.enum_name = 'SpellEffect'
                                       AND ef.value     = e.Effect
            LEFT JOIN ref.enum_value au ON au.enum_name = 'SpellEffectAura'
                                       AND au.value     = e.EffectAura
            LEFT JOIN ref.enum_value t0 ON t0.enum_name = 'Target'
                                       AND t0.value     = e.ImplicitTarget_0
            LEFT JOIN ref.enum_value t1 ON t1.enum_name = 'Target'
                                       AND t1.value     = e.ImplicitTarget_1""")

    return made


def build_summary(con: "duckdb.DuckDBPyConnection") -> None:
    """`ref.table_info` — what actually landed, so `--list` and the docs agree."""
    con.execute("""
                CREATE
                OR REPLACE TABLE ref.table_info AS
                SELECT t.table_schema                      AS schema_name,
                       t.table_name,
                       (SELECT count(*)
                        FROM ref.column_info c
                        WHERE c.schema_name = t.table_schema
                          AND c.table_name = t.table_name) AS column_count
                FROM information_schema.tables t
                WHERE t.table_type = 'BASE TABLE'""")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build the Epsilook exploration database (development tool).")
    parser.add_argument("version", nargs="*",
                        help="build id prefix, e.g. 9.2.7 (default: all)")
    parser.add_argument("--refresh-dbd", action="store_true",
                        help="re-fetch WoWDBDefs schema definitions and enums")
    parser.add_argument("--list", action="store_true",
                        help="show what would be built, and exit")
    parser.add_argument("--db", default=str(DB_PATH), help=f"output (default {DB_PATH})")
    args = parser.parse_args()

    # ONE SCHEMA PER BUILD, NOT PER PACK. The roster is the input (it is what
    # build_data.py is driven from), and two packs can ship one build — a test
    # line is level with live until it moves ahead, and versions.json would
    # therefore ask for the same tables twice under a schema name that is not a
    # game version. What this database is FOR is the game data, so the
    # distinction the app makes between those packs does not exist here.
    manifest: list[dict[str, Any]] = [
        {"id": build,
         "label": next(p.label for p in PACKS if p.build == build),
         "default": any(p.default for p in PACKS if p.build == build)}
        for build in builds()]

    # TDB tags come from build_data.py so the mapping is not written down twice.
    try:
        import build_data
        for entry in manifest:
            release = build_data.tdb_release(entry["id"])
            entry["tdb_tag"] = release.get("tag") if release else None
    except (ImportError, AttributeError):
        for entry in manifest:
            entry["tdb_tag"] = None

    selected = manifest
    if args.version:
        selected = [e for e in manifest
                    if any(e["id"].startswith(v) for v in args.version)]
        if not selected:
            log(f"no version matches {args.version}; have: "
                + ", ".join(e["id"] for e in manifest))
            return 1

    if args.list:
        for entry in manifest:
            directory = CACHE / entry["id"]
            csvs = len(list(directory.glob("*.csv"))) if directory.is_dir() else 0
            mark = "*" if entry in selected else " "
            log(f" {mark} {schema_name(entry['id']):<9} {entry['id']:<14} "
                f"{csvs:>3} csv  tdb={entry['tdb_tag'] or '-'}  {entry.get('label', '')}")
        return 0

    started = time.time()
    database = Path(args.db)
    database.parent.mkdir(parents=True, exist_ok=True)

    # STORAGE_VERSION pins the on-disk format so DataGrip's bundled JDBC driver
    # can open the file. See the constant's comment.
    con = duckdb.connect()
    literal = str(database).replace("'", "''")
    con.execute(f"ATTACH '{literal}' AS db (STORAGE_VERSION '{STORAGE_VERSION}')")
    con.execute("USE db")

    log(f"Epsilook development database -> {database}")
    log("\nreference data (shared by every version)")
    build_reference(con, manifest, args.refresh_dbd)

    catalog: list[tuple] = []
    total_tables = total_rows = total_views = 0
    for entry in progress(selected, "versions", "pack", len(selected)):
        build_id = entry["id"]
        log(f"\n{schema_name(build_id)}  ({entry.get('label', build_id)})")
        fetch_extra_tables(build_id)
        tables, rows, fallbacks = build_version(
            con, build_id, catalog, args.refresh_dbd)
        tdb = load_tdb(con, build_id, entry.get("tdb_tag"))
        views = build_views(con, schema_name(build_id))
        total_tables += tables + tdb
        total_rows += rows
        total_views += views
        note = f", {fallbacks} inferred" if fallbacks else ""
        log(f"  {tables} db2 + {tdb} tdb tables, {rows:,} rows, {views} views{note}")

    log("\ncatalog")
    build_catalog(con, catalog)
    build_summary(con)

    con.execute("CHECKPOINT")
    con.close()

    size = database.stat().st_size / 1e6
    log(f"\n{total_tables} tables, {total_rows:,} rows, {total_views} views "
        f"-> {size:,.0f} MB in {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
