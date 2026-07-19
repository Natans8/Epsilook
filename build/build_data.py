#!/usr/bin/env python3
"""Build the Epsilook data pack for one WoW game version.

Data sources (hybrid, in priority order):
  1. TrinityCore TDB (github.com/TrinityCore/TrinityCore releases) — the
     server-side world database for this exact game build. Two roles:
     a) world tables (creature_template, creature_template_model) are the
        ONLY source for creature -> display id mapping (server-side data
        the client never ships), used for morphs;
     b) hotfixes tables carry the rows Blizzard hotfixed over the wire
        after the client shipped — they override wago rows by row ID.
  2. wago.tools CSV exports — the client db2 tables (visual/sound/anim
     chains exist nowhere else).
  3. The community listfile (github.com/wowdev/wow-listfile) for file names.

Stdlib only, plus 7-Zip (7z on PATH or in Program Files) to extract the TDB
archive once. Downloads are cached under build/cache/ ; pass --refresh to
force re-download of the wago/listfile sources.

Usage:
    python build_data.py --version 9.2.7.45745 --label "Shadowlands 9.2.7"
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import sys
import time
import urllib.request
from collections import defaultdict
from pathlib import Path

BUILD_DIR = Path(__file__).resolve().parent
ROOT_DIR = BUILD_DIR.parent
CACHE_DIR = BUILD_DIR / "cache"
DATA_DIR = ROOT_DIR / "docs" / "data"

WAGO_CSV_URL = "https://wago.tools/db2/{table}/csv?build={version}"
LISTFILE_RELEASE_API = "https://api.github.com/repos/wowdev/wow-listfile/releases/latest"

TABLES = [
    "SpellName",
    "Spell",
    "SpellXSpellVisual",
    "SpellVisual",
    "SpellVisualMissile",
    "SpellVisualEvent",
    "SpellVisualKitEffect",
    "SpellVisualKitModelAttach",
    "SpellVisualEffectName",
    "SpellVisualAnim",
    "AnimKitSegment",
    "SoundKitEntry",
    "SpellEffect",
    "SummonProperties",
    "SpellMisc",
    "SpellChainEffects",
    "SpellProceduralEffect",
    "BeamEffect",
    "SpellEffectEmission",
    "SpellVisualKitAreaModel",
    "WeaponTrail",
    "BarrageEffect",
    "DissolveEffect",
    "TextureBlendSet",
    "EdgeGlowEffect",
    "ShadowyEffect",
    "SpellVisualScreenEffect",
    "ScreenEffect",
    "FullScreenEffect",
    "CreatureDisplayInfo",
    "CreatureModelData",
]

# TrinityCore TDB release per game version (server-side world DB + hotfixes).
TDB_RELEASES = {
    "9.2.7.45745": {
        "tag": "TDB927.22111",
        "asset": "TDB_full_927.22111_2022_11_20.7z",
        "world": "TDB_full_world_927.22111_2022_11_20.sql",
        "hotfixes": "TDB_full_hotfixes_927.22111_2022_11_20.sql",
    },
}
TDB_ASSET_URL = "https://github.com/TrinityCore/TrinityCore/releases/download/{tag}/{asset}"

# Tables distilled out of the TDB SQL dumps into cached CSVs, with the
# columns we keep. world tables are complete (server-only data); hotfixes
# tables hold ONLY the rows Blizzard hotfixed post-ship — applied on top of
# the wago rows by row ID (TDB is preferred wherever it has data).
TDB_TABLES = {
    "world": {
        "creature_template": ["entry", "name"],
        "creature_template_model": ["CreatureID", "Idx", "CreatureDisplayID", "Probability"],
    },
    "hotfixes": {
        "spell_name": ["ID", "Name"],
        "spell_x_spell_visual": ["ID", "SpellID", "SpellVisualID"],
        "spell_visual": ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID"],
        "spell_visual_missile": ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                                 "SoundEntriesID", "AnimKitID"],
        "spell_visual_effect_name": ["ID", "ModelFileDataID"],
        "spell_effect": ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1",
                         "EffectMiscValue2"],
        "spell_misc": ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"],
        "creature_display_info": ["ID", "ModelID"],
        "creature_model_data": ["ID", "FileDataID"],
    },
}

# Animation names indexed by AnimID (Stand=0, ...), maintained by wow.tools
ANIMS_JS_URL = "https://raw.githubusercontent.com/Marlamin/wow.tools.local/main/wwwroot/js/anims.js"

# Enum value names from WoWDBDefs meta/enums — the authority on what db2
# enum values mean ("ID NAME" lines; see read_enum_names for the format).
# SpellEffect = names for SpellEffect.Effect (SPELL_EFFECT_* without the
# prefix), SpellEffectAura = names for SpellEffect.EffectAura (SPELL_AURA_*).
WOWDBDEFS_ENUM_URL = "https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/meta/enums/{name}.dbde"
ENUM_FILES = ["SpellEffect", "SpellEffectAura"]

# SpellVisualKitEffect.EffectType values (what the kit effect points at) —
# the full enum is documented in WoWDBDefs definitions/SpellVisualKitEffect.dbd
EFFECT_TYPE_PROC = 1      # Effect = SpellProceduralEffect.ID
EFFECT_TYPE_SOUND = 5     # Effect = SoundKitID
EFFECT_TYPE_ANIM = 6      # Effect = SpellVisualAnim.ID
EFFECT_TYPE_SHADOWY = 7   # Effect = ShadowyEffect.ID
EFFECT_TYPE_EMISSION = 8  # Effect = SpellEffectEmission.ID (area-model emitter)
EFFECT_TYPE_DISSOLVE = 11 # Effect = DissolveEffect.ID
EFFECT_TYPE_EDGE_GLOW = 12 # Effect = EdgeGlowEffect.ID
EFFECT_TYPE_BEAM = 13     # Effect = BeamEffect.ID
EFFECT_TYPE_BARRAGE = 17  # Effect = BarrageEffect.ID (multi-model volley)
EFFECT_TYPE_SCREEN = 19   # Effect = SpellVisualScreenEffect.ID (verified:
                          # all 18 ET-19 rows in 9.2.7 resolve there)
# Of the remaining SpellVisualKitEffectType values (survey 2026-07-18):
# 2 (SpellVisualKitModelAttach) is 100% redundant with the
# ParentSpellVisualKitID walk; 10 (UnitSoundType) plays the TARGET unit's
# own sound — no concrete file; 15/20 are absent; the rest carry no
# model/sound columns.

# SpellEffect.EffectAura value whose EffectMiscValue_0 is a ScreenEffect ID —
# the main road to screen effects (~2.3k spells; the kit route via
# SpellVisualScreenEffect adds only 18 rows in 9.2.7)
AURA_SCREEN_EFFECT = 260

# SpellProceduralEffect.Type values. Type IS the client character-procedure
# index (m_characterProcedure) — see the "Proc type decode" section in
# CLAUDE.md. Which value column carries the payload differs per type.
PROC_TYPE_TINT = 1          # Value_0 = packed-RGB model tint (multiply)
PROC_TYPES_CHAIN = {0, 12, 26}  # Value_0 = SpellChainEffects ID (beams)
PROC_TYPE_STANDWALK = 7     # Value_0..3 = AnimationData IDs (stand/walk anim)
PROC_TYPE_AREAMODEL = 9     # Value_0 = SpellVisualKitAreaModel ID (model)
PROC_TYPE_FREEZE = 11       # valueless freeze/petrify state
PROC_TYPE_TRANSPARENCY = 14 # Value_0 = alpha 0..1 (SetAlphaMod)
PROC_TYPE_CAMO = 18         # valueless camouflage/cloak state
PROC_TYPE_DESATURATE = 21   # Value_2 = desaturation strength 0..1 (no color)
PROC_TYPE_GHOST_MAT = 22    # Value_3 = packed-RGB material recolor -> ghost
PROC_TYPE_TINT_MAT = 23     # Value_3 = packed-RGB material recolor -> tint
PROC_TYPE_WEAPONTRAIL = 27  # Value_0 = WeaponTrail.db2 ID (trail model)

# model categories: every (spell, model) row is tagged with how the model is
# used — the Models column groups by these short user-facing words
MODEL_CAT_ATTACH = 0   # SpellVisualKitModelAttach (model attached to the caster/target)
MODEL_CAT_MISSILE = 1  # SpellVisualMissile (projectile in flight)
MODEL_CAT_AREA = 2     # SpellVisualKitAreaModel (ground/area model: emission ET 8, proc Type 9)
MODEL_CAT_TRAIL = 3    # WeaponTrail (proc Type 27)
MODEL_CAT_BARRAGE = 4  # BarrageEffect (volley of models, ET 17)
MODEL_CAT_NAMES = {
    MODEL_CAT_ATTACH: "attached",  # renamed from "attach" 2026-07-19 ("attach" read like a button)
    MODEL_CAT_MISSILE: "missile",
    MODEL_CAT_AREA: "area",
    MODEL_CAT_TRAIL: "trail",
    MODEL_CAT_BARRAGE: "barrage",
}

# SpellEffectAura value whose EffectMiscValue_0 is a CreatureDisplayID
AURA_TRANSFORM = 56

# SpellEffect.Effect value that summons a creature: EffectMiscValue_0 is the
# creature id (server-side NPC entry, same space as morphs), EffectMiscValue_1
# the SummonProperties row governing how the summon behaves
EFFECT_SUMMON = 28

# SummonProperties.Control values (meta/enums/SummonPropertiesControl.dbde —
# too few and too free-form for read_enum_names). 0 = uncontrolled; shown as
# no word, like untinted beams.
SUMMON_CONTROL_NAMES = {
    0: "", 1: "guardian", 2: "pet", 3: "possessed",
    4: "possessed vehicle", 5: "vehicle",
}

csv.field_size_limit(10_000_000)


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- downloads

def download(url: str, dest: Path, refresh: bool, headers: dict | None = None) -> None:
    if dest.exists() and dest.stat().st_size > 0 and not refresh:
        log(f"  cached   {dest.name} ({dest.stat().st_size:,} bytes)")
        return
    log(f"  fetching {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "epsilook-build", **(headers or {})})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=600) as resp, open(tmp, "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)
    tmp.replace(dest)
    log(f"  saved    {dest.name} ({dest.stat().st_size:,} bytes)")


def find_7z() -> str:
    import shutil
    for cand in (shutil.which("7z"), r"C:\Program Files\7-Zip\7z.exe", "/usr/bin/7z"):
        if cand and Path(cand).exists():
            return cand
    sys.exit("error: 7-Zip (7z) is required to extract the TDB archive — install it "
             "or place the extracted .sql files in the cache tdb dir yourself")


def iter_insert_rows(line: str):
    """Yield value tuples (lists of raw strings) from one INSERT ... VALUES line."""
    i = line.find("VALUES")
    if i < 0:
        return
    i += len("VALUES")
    n = len(line)
    while i < n:
        while i < n and line[i] != "(":
            i += 1
        if i >= n:
            return
        i += 1
        row, val, in_str = [], [], False
        while i < n:
            c = line[i]
            if in_str:
                if c == "\\":
                    val.append(line[i + 1]); i += 2; continue
                if c == "'":
                    if i + 1 < n and line[i + 1] == "'":
                        val.append("'"); i += 2; continue
                    in_str = False; i += 1; continue
                val.append(c); i += 1; continue
            if c == "'":
                in_str = True; i += 1; continue
            if c == ",":
                row.append("".join(val).strip()); val = []; i += 1; continue
            if c == ")":
                row.append("".join(val).strip()); i += 1
                yield row
                break
            val.append(c); i += 1


def distill_tdb_dump(sql_path: Path, want: dict[str, list[str]], out_dir: Path) -> None:
    """Extract the wanted tables/columns from a TDB SQL dump into CSVs.

    A table may legitimately have no INSERT (hotfixes only carry hotfixed
    rows) — it still gets a header-only CSV so readers can stream it.
    """
    schemas: dict[str, list[str]] = {}
    writers: dict[str, tuple] = {}
    handles = []
    with open(sql_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith("CREATE TABLE `"):
                table = line.split("`")[1]
                if table not in want:
                    continue
                cols = []
                for defline in f:
                    defline = defline.strip()
                    if defline.startswith("`"):
                        cols.append(defline.split("`")[1])
                    else:
                        break
                schemas[table] = cols
            elif line.startswith("INSERT INTO `"):
                table = line.split("`")[1]
                if table not in want:
                    continue
                if table not in writers:
                    keep = want[table]
                    idx = [schemas[table].index(c) for c in keep]
                    fh = open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8")
                    handles.append(fh)
                    w = csv.writer(fh)
                    w.writerow(keep)
                    writers[table] = (w, idx, len(schemas[table]))
                w, idx, ncols = writers[table]
                for row in iter_insert_rows(line):
                    if len(row) != ncols:
                        sys.exit(f"error: {table} row has {len(row)} values, schema has {ncols}")
                    w.writerow([row[i] for i in idx])
    for fh in handles:
        fh.close()
    for table, keep in want.items():
        if table not in schemas:
            sys.exit(f"error: table {table} not found in {sql_path.name}")
        if table not in writers:  # zero hotfixed rows — emit header only
            with open(out_dir / f"{table}.csv", "w", newline="", encoding="utf-8") as fh:
                csv.writer(fh).writerow(keep)


def fetch_tdb(version: str) -> Path | None:
    """Ensure the TDB tables for this version are distilled; return their dir.

    The 117 MB archive is downloaded and the 700 MB SQL dumps parsed exactly
    once — afterwards only the small distilled CSVs (and the archive) stay
    in the cache. Returns None when no TDB release maps to this version.
    """
    rel = TDB_RELEASES.get(version)
    if rel is None:
        log(f"TDB: no release mapped for {version} — morphs will not resolve, "
            f"hotfixes will not apply")
        return None
    tdb_dir = CACHE_DIR / f"tdb-{rel['tag']}"
    wanted_csvs = [t for want in TDB_TABLES.values() for t in want]
    if all((tdb_dir / f"{t}.csv").exists() for t in wanted_csvs):
        log(f"TDB ({rel['tag']}): cached ({len(wanted_csvs)} distilled tables)")
        return tdb_dir
    tdb_dir.mkdir(parents=True, exist_ok=True)
    archive = tdb_dir / rel["asset"]
    download(TDB_ASSET_URL.format(**rel), archive, refresh=False)
    dumps = {kind: tdb_dir / rel[kind] for kind in ("world", "hotfixes")}
    if not all(p.exists() for p in dumps.values()):
        log(f"  extracting {archive.name} ...")
        import subprocess
        r = subprocess.run([find_7z(), "x", "-y", f"-o{tdb_dir}", str(archive)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"error: 7z extraction failed: {r.stderr[-500:]}")
    for kind, sql_path in dumps.items():
        log(f"  distilling {sql_path.name} ...")
        distill_tdb_dump(sql_path, TDB_TABLES[kind], tdb_dir)
        sql_path.unlink()  # the archive stays; the 460 MB text does not
    return tdb_dir


def fetch_sources(version: str, refresh: bool) -> tuple[Path, Path, Path | None]:
    """Ensure all table CSVs and the listfile are cached; return their dirs."""
    table_dir = CACHE_DIR / version
    log(f"Tables (wago.tools, build {version}):")
    for table in TABLES:
        download(WAGO_CSV_URL.format(table=table, version=version), table_dir / f"{table}.csv", refresh)

    log("Animation names (wow.tools):")
    download(ANIMS_JS_URL, CACHE_DIR / "anims.js", refresh)

    log("Enum names (wowdev/WoWDBDefs):")
    for name in ENUM_FILES:
        download(WOWDBDEFS_ENUM_URL.format(name=name), CACHE_DIR / "enums" / f"{name}.dbde", refresh)

    listfile_dir = CACHE_DIR / "listfile"
    listfile = listfile_dir / "community-listfile.csv"
    log("Listfile (wowdev/wow-listfile):")
    if listfile.exists() and not refresh:
        log(f"  cached   {listfile.name} ({listfile.stat().st_size:,} bytes)")
    else:
        with urllib.request.urlopen(
            urllib.request.Request(LISTFILE_RELEASE_API, headers={"User-Agent": "epsilook-build"}), timeout=60
        ) as resp:
            release = json.load(resp)
        asset = next(a for a in release["assets"] if a["name"] == "community-listfile.csv")
        download(asset["browser_download_url"], listfile, refresh=True)
        (listfile_dir / "release-tag.txt").write_text(release["tag_name"])

    tdb_dir = fetch_tdb(version)
    return table_dir, listfile, tdb_dir


# ------------------------------------------------------------------ parsing

def read_table(table_dir: Path, table: str, columns: list[str]):
    """Yield tuples of the requested columns for each row of a cached CSV."""
    path = table_dir / f"{table}.csv"
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        try:
            idx = [header.index(c) for c in columns]
        except ValueError as e:
            sys.exit(f"error: {table}.csv is missing an expected column ({e}); header = {header}")
        for row in reader:
            yield tuple(row[i] for i in idx)


def to_int(s: str) -> int:
    return int(s) if s else 0


def read_anim_names() -> list[str]:
    """Parse the animationNames JS array (index = AnimID)."""
    import re
    src = (CACHE_DIR / "anims.js").read_text(encoding="utf-8")
    names = re.findall(r'"([^"]*)"', src)
    if len(names) < 1000 or names[0] != "Stand":
        sys.exit("error: anims.js did not parse as expected")
    return names


def read_enum_names(name: str, version: str) -> dict[int, str]:
    """Parse a WoWDBDefs meta/enums .dbde file into {value: NAME}.

    Format: one "ID NAME" per line, optionally "// comment" suffixed. Some
    lines carry a "(BUILD a-b, c-d)" guard restricting which game builds the
    name applies to. Lines with no name (or junk like "==") are skipped —
    the app falls back to showing the raw id.
    """
    import re
    ver = tuple(int(p) for p in version.split("."))
    names: dict[int, str] = {}
    for line in (CACHE_DIR / "enums" / f"{name}.dbde").read_text(encoding="utf-8").splitlines():
        line = line.split("//", 1)[0].strip()
        if line.startswith("(BUILD "):
            guard, _, line = line[len("(BUILD "):].partition(")")
            line = line.strip()
            def in_range(rng: str) -> bool:
                lo, _, hi = rng.strip().partition("-")
                lo_t = tuple(int(p) for p in lo.split("."))
                hi_t = tuple(int(p) for p in hi.split(".")) if hi else lo_t
                return lo_t <= ver <= hi_t
            if not any(in_range(r) for r in guard.split(",")):
                continue
        m = re.fullmatch(r"(\d+) ([A-Z][A-Z0-9_]*)", line)
        if m:
            names[int(m.group(1))] = m.group(2)
    if len(names) < 100:
        sys.exit(f"error: enums/{name}.dbde did not parse as expected ({len(names)} names)")
    return names


# ----------------------------------------------------------------- pipeline

def hotfix_rows(tdb_dir: Path | None, table: str, columns: list[str]):
    """Yield TDB hotfix rows for a db2 table (nothing when TDB is absent).

    Hotfixes are the rows Blizzard changed server-side after the client
    shipped — each replaces the wago row with the same row ID.
    """
    if tdb_dir is None:
        return
    yield from read_table(tdb_dir, table, columns)


def build_pack(version: str, label: str, table_dir: Path, listfile_path: Path,
               tdb_dir: Path | None) -> dict:
    t0 = time.time()

    # --- spells -----------------------------------------------------------
    log("Reading SpellName / Spell ...")
    spell_names: dict[int, str] = {}
    for sid, name in read_table(table_dir, "SpellName", ["ID", "Name_lang"]):
        spell_names[to_int(sid)] = name
    for sid, name in hotfix_rows(tdb_dir, "spell_name", ["ID", "Name"]):
        spell_names[to_int(sid)] = name

    subtexts: dict[int, str] = {}
    for sid, sub in read_table(table_dir, "Spell", ["ID", "NameSubtext_lang"]):
        i = to_int(sid)
        if i in spell_names and sub:
            subtexts[i] = sub

    # --- visual chain lookups ---------------------------------------------
    log("Reading spell visual chain tables ...")
    # spell -> visuals (rows keyed by row ID so hotfixes can override)
    sxv_rows: dict[int, tuple[int, int]] = {}
    for rid, spell_id, visual_id in read_table(
        table_dir, "SpellXSpellVisual", ["ID", "SpellID", "SpellVisualID"]
    ):
        sxv_rows[to_int(rid)] = (to_int(spell_id), to_int(visual_id))
    for rid, spell_id, visual_id in hotfix_rows(
        tdb_dir, "spell_x_spell_visual", ["ID", "SpellID", "SpellVisualID"]
    ):
        sxv_rows[to_int(rid)] = (to_int(spell_id), to_int(visual_id))
    spell_visuals: dict[int, set[int]] = defaultdict(set)
    for s, v in sxv_rows.values():
        if s and v:
            spell_visuals[s].add(v)

    # visual -> kits
    visual_kits: dict[int, set[int]] = defaultdict(set)
    for visual_id, kit_id in read_table(table_dir, "SpellVisualEvent", ["SpellVisualID", "SpellVisualKitID"]):
        v, k = to_int(visual_id), to_int(kit_id)
        if v and k:
            visual_kits[v].add(k)

    # kit -> model file ids (via SpellVisualKitModelAttach -> SpellVisualEffectName)
    effect_name_model: dict[int, int] = {}
    for en_id, model_fid in read_table(table_dir, "SpellVisualEffectName", ["ID", "ModelFileDataID"]):
        effect_name_model[to_int(en_id)] = to_int(model_fid)
    for en_id, model_fid in hotfix_rows(tdb_dir, "spell_visual_effect_name", ["ID", "ModelFileDataID"]):
        effect_name_model[to_int(en_id)] = to_int(model_fid)

    # kit -> {(model fid, category)} — the category tags how the model is used
    kit_models: dict[int, set[tuple[int, int]]] = defaultdict(set)
    for kit_id, en_id in read_table(
        table_dir, "SpellVisualKitModelAttach", ["ParentSpellVisualKitID", "SpellVisualEffectNameID"]
    ):
        fid = effect_name_model.get(to_int(en_id), 0)
        k = to_int(kit_id)
        if k and fid:
            kit_models[k].add((fid, MODEL_CAT_ATTACH))

    # kit EffectType 8 -> SpellEffectEmission (particle-style emitter that
    # spawns copies of an area model) -> SpellVisualKitAreaModel, which
    # carries the model fid directly (no SpellVisualEffectName hop)
    area_model_fid: dict[int, int] = {}
    for am_id, model_fid_s in read_table(
        table_dir, "SpellVisualKitAreaModel", ["ID", "ModelFileDataID"]
    ):
        area_model_fid[to_int(am_id)] = to_int(model_fid_s)

    emission_fid: dict[int, int] = {}  # SpellEffectEmission.ID -> model fid
    for em_id, am_id in read_table(table_dir, "SpellEffectEmission", ["ID", "AreaModelID"]):
        emission_fid[to_int(em_id)] = area_model_fid.get(to_int(am_id), 0)

    # kit EffectType 17 -> BarrageEffect (volley of N models) -> model via
    # the usual SpellVisualEffectName hop (count/cone columns skipped)
    barrage_fid: dict[int, int] = {}  # BarrageEffect.ID -> model fid
    for b_id, en_id in read_table(
        table_dir, "BarrageEffect", ["ID", "SpellVisualEffectNameID"]
    ):
        barrage_fid[to_int(b_id)] = effect_name_model.get(to_int(en_id), 0)

    # WeaponTrail.db2 rows carry a trail model directly in FileDataID —
    # referenced by SpellProceduralEffect Type 27 (Value_0 = WeaponTrail.ID).
    weapontrail_fid: dict[int, int] = {}  # WeaponTrail.ID -> model fid
    for wt_id, fid in read_table(table_dir, "WeaponTrail", ["ID", "FileDataID"]):
        weapontrail_fid[to_int(wt_id)] = to_int(fid)

    # visual -> missile payload (SpellVisual.SpellVisualMissileSetID /
    # RaidSpellVisualMissileSetID -> SpellVisualMissile rows sharing that set).
    # Each missile carries a model (via SpellVisualEffectName), and sometimes
    # a SoundKit (flight/launch sound) and an AnimKit. Projectile models —
    # e.g. Arcane Missiles' cfx_mage_arcanemissiles_missile.m2 — are
    # reachable only through this path, never via SpellVisualKitModelAttach.
    sv_rows: dict[int, tuple[int, int]] = {}  # visual ID -> (set, raid set)
    for rid, ms, rms in read_table(
        table_dir, "SpellVisual", ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID"]
    ):
        sv_rows[to_int(rid)] = (to_int(ms), to_int(rms))
    for rid, ms, rms in hotfix_rows(
        tdb_dir, "spell_visual", ["ID", "SpellVisualMissileSetID", "RaidSpellVisualMissileSetID"]
    ):
        sv_rows[to_int(rid)] = (to_int(ms), to_int(rms))

    svm_cols = ["ID", "SpellVisualMissileSetID", "SpellVisualEffectNameID",
                "SoundEntriesID", "AnimKitID"]
    svm_rows: dict[int, tuple[int, int, int, int]] = {}  # missile ID -> (set, en, soundkit, animkit)
    for rid, *vals in read_table(table_dir, "SpellVisualMissile", svm_cols):
        svm_rows[to_int(rid)] = tuple(to_int(v) for v in vals)
    for rid, *vals in hotfix_rows(tdb_dir, "spell_visual_missile", svm_cols):
        svm_rows[to_int(rid)] = tuple(to_int(v) for v in vals)

    missile_set_models: dict[int, set[int]] = defaultdict(set)
    missile_set_soundkits: dict[int, set[int]] = defaultdict(set)
    missile_set_animkits: dict[int, set[int]] = defaultdict(set)
    for set_id, en_id, sk, ak in svm_rows.values():
        if not set_id:
            continue
        fid = effect_name_model.get(en_id, 0)
        if fid:
            missile_set_models[set_id].add(fid)
        if sk:
            missile_set_soundkits[set_id].add(sk)
        if ak:
            missile_set_animkits[set_id].add(ak)
    del svm_rows

    EMPTY: tuple = (frozenset(), frozenset(), frozenset())
    visual_missiles: dict[int, tuple] = {}  # visual ID -> (model fids, soundkits, animkits)
    for v, (ms, rms) in sv_rows.items():
        parts = tuple(
            d.get(ms, set()) | d.get(rms, set())
            for d in (missile_set_models, missile_set_soundkits, missile_set_animkits)
        )
        if any(parts):
            visual_missiles[v] = parts
    del sv_rows, missile_set_models, missile_set_soundkits, missile_set_animkits

    # kit -> soundkits / animkits (via SpellVisualKitEffect)
    anim_kit_of: dict[int, int] = {}  # SpellVisualAnim.ID -> AnimKitID
    for sva_id, animkit_id in read_table(table_dir, "SpellVisualAnim", ["ID", "AnimKitID"]):
        anim_kit_of[to_int(sva_id)] = to_int(animkit_id)

    # chain effects (beams): two paths lead from a kit to SpellChainEffects —
    # EffectType 1 -> SpellProceduralEffect (Type 26, Value_0 = chain ID) and
    # EffectType 13 -> BeamEffect (BeamID = chain ID). The same table's
    # Type 1 rows are model tints: Value_0 is the packed RGB, the color is
    # the whole payload (like edge glows / shadowy effects).
    # SpellProceduralEffect: one row per proc, keyed by ID; Type selects the
    # handler and thus which Value column is the payload. We bucket each proc
    # ID into the structure its type feeds (chain/tint/ghost material/desat/...)
    # so the kit walk below can dispatch a kit's proc references by ID.
    proc_chain: dict[int, int] = {}      # proc ID -> SpellChainEffects ID (beam)
    tint_rows: dict[int, int] = {}       # proc ID -> packed RGB (tint; Types 1 & 23)
    ghost_mat_rows: dict[int, int] = {}  # proc ID -> packed RGB (Type 22 -> ghost)
    desat_rows: dict[int, int] = {}      # proc ID -> desaturation percent (Type 21)
    transp_rows: dict[int, int] = {}     # proc ID -> transparency percent (Type 14)
    freeze_procs: set[int] = set()       # proc IDs of freeze (Type 11)
    camo_procs: set[int] = set()         # proc IDs of camo (Type 18)
    proc_model: dict[int, tuple[int, int]] = {}  # proc ID -> (model fid, category) (Types 9, 27)
    proc_anims: dict[int, tuple[int, ...]] = {}  # proc ID -> anim IDs (Type 7)

    def as_int(v: str) -> int:
        return int(float(v)) if v else 0

    proc_cols = ["ID", "Type", "Value_0", "Value_1", "Value_2", "Value_3"]
    for pid, ptype, v0, v1, v2, v3 in read_table(table_dir, "SpellProceduralEffect", proc_cols):
        p, pt = to_int(pid), to_int(ptype)
        if pt in PROC_TYPES_CHAIN:
            proc_chain[p] = as_int(v0)
        elif pt == PROC_TYPE_TINT:
            tint_rows[p] = as_int(v0) & 0xFFFFFF
        elif pt == PROC_TYPE_TINT_MAT:
            # material recolor -> tint; colorless (Value_3=0) folds in as black
            tint_rows[p] = as_int(v3) & 0xFFFFFF
        elif pt == PROC_TYPE_GHOST_MAT:
            c = as_int(v3) & 0xFFFFFF
            if as_int(v3):  # drop the colorless rows (nothing to show)
                ghost_mat_rows[p] = c
        elif pt == PROC_TYPE_DESATURATE:
            pct = round(float(v2 or 0) * 100)
            if pct > 0:  # 0% = no desaturation, nothing to show
                desat_rows[p] = pct
        elif pt == PROC_TYPE_TRANSPARENCY:
            pct = round(float(v0 or 0) * 100)
            if pct > 0:
                transp_rows[p] = pct
        elif pt == PROC_TYPE_FREEZE:
            freeze_procs.add(p)
        elif pt == PROC_TYPE_CAMO:
            camo_procs.add(p)
        elif pt == PROC_TYPE_AREAMODEL:
            fid = area_model_fid.get(as_int(v0), 0)
            if fid:
                proc_model[p] = (fid, MODEL_CAT_AREA)
        elif pt == PROC_TYPE_WEAPONTRAIL:
            fid = weapontrail_fid.get(as_int(v0), 0)
            if fid:
                proc_model[p] = (fid, MODEL_CAT_TRAIL)
        elif pt == PROC_TYPE_STANDWALK:
            # Value_0..3 are direct AnimationData IDs (stand/walk/run/...);
            # keep the meaningful ones (>0 skips the ubiquitous Stand=0 default)
            anims = tuple(dict.fromkeys(
                a for a in (as_int(v0), as_int(v1), as_int(v2), as_int(v3)) if a > 0))
            if anims:
                proc_anims[p] = anims

    beam_chain: dict[int, int] = {}  # BeamEffect.ID -> chain ID
    for bid, chain_id in read_table(table_dir, "BeamEffect", ["ID", "BeamID"]):
        beam_chain[to_int(bid)] = to_int(chain_id)

    # dissolves: EffectType 11 -> DissolveEffect, whose TextureBlendSet
    # carries up to 3 texture fids (mask + material; names via the listfile)
    blendset_tex: dict[int, tuple[int, ...]] = {}  # TextureBlendSet.ID -> tex fids
    for row in read_table(
        table_dir, "TextureBlendSet", ["ID"] + [f"TextureFileDataID_{i}" for i in range(3)]
    ):
        fids = tuple(dict.fromkeys(f for f in (to_int(v) for v in row[1:4]) if f))
        blendset_tex[to_int(row[0])] = fids

    dissolve_rows: dict[int, tuple[float, tuple[int, ...]]] = {}  # ID -> (duration, tex fids)
    for did, tbs_id, duration in read_table(
        table_dir, "DissolveEffect", ["ID", "TextureBlendSetID", "Duration"]
    ):
        dissolve_rows[to_int(did)] = (
            round(float(duration), 2) if duration else 0,
            blendset_tex.get(to_int(tbs_id), ()),
        )

    # screen effects: ScreenEffect rows tint/grade the whole screen while an
    # aura holds. Payload kept: the row's internal Name (readable, e.g.
    # "Shaman - Hex"), a fog tint color for Effect=3 (swirling fog — Param_0
    # low 24 bits are rrggbb; the top byte looks like opacity, NOT the
    # wiki's "rrggbbxx" claim — verified against jungle-green/twilight-purple
    # rows), and the FullScreenEffect payload where referenced (all Effect=8
    # rows): ColorMultiply/ColorAddition screen colors (floats 0..1) plus
    # overlay + TextureBlendSet textures. Gamma/saturation/blur/fades and
    # LightParams/SoundAmbience/ZoneMusic: skipped for now (revisit).
    SCREEN_EFFECT_FOG = 3
    fse_rows: dict[int, tuple[int, int, tuple[int, ...]]] = {}  # ID -> (mul, add, tex fids)
    for fid_, flds in (
        (to_int(r[0]), r[1:]) for r in read_table(
            table_dir, "FullScreenEffect",
            ["ID", "ColorMultiplyRed", "ColorMultiplyGreen", "ColorMultiplyBlue",
             "ColorAdditionRed", "ColorAdditionGreen", "ColorAdditionBlue",
             "OverlayTextureFileDataID", "TextureBlendSetID"])
    ):
        def fpack(r: str, g: str, b: str) -> int:
            f = lambda v: max(0, min(255, round(float(v or 0) * 255)))
            return (f(r) << 16) | (f(g) << 8) | f(b)
        overlay = to_int(flds[6])
        tex = tuple(dict.fromkeys(
            ([overlay] if overlay else []) + list(blendset_tex.get(to_int(flds[7]), ()))))
        fse_rows[fid_] = (fpack(*flds[0:3]), fpack(*flds[3:6]), tex)

    screen_rows: dict[int, tuple[str, int, int, int, tuple[int, ...]]] = {}
    # ScreenEffect.ID -> (name, fog color | -1, mul | -1, add | -1, tex fids)
    for sid, name, p0, eff, fse_id in read_table(
        table_dir, "ScreenEffect", ["ID", "Name", "Param_0", "Effect", "FullScreenEffectID"]
    ):
        fog = (to_int(p0) & 0xFFFFFF) if to_int(eff) == SCREEN_EFFECT_FOG else -1
        mul, add, tex = fse_rows.get(to_int(fse_id), (-1, -1, ()))
        screen_rows[to_int(sid)] = (name, fog, mul, add, tex)

    # kit route: EffectType 19 -> SpellVisualScreenEffect -> ScreenEffectID
    svse_screen: dict[int, int] = {}  # SpellVisualScreenEffect.ID -> ScreenEffect.ID
    for rid, se_id, _type_id in read_table(
        table_dir, "SpellVisualScreenEffect", ["ID", "ScreenEffectID", "ScreenEffectTypeID"]
    ):
        svse_screen[to_int(rid)] = to_int(se_id)

    # edge glows: EffectType 12 -> EdgeGlowEffect. The color is float RGB
    # 0..1 (alpha/multiplier/fade columns skipped — renderer tuning); the
    # color is the whole visible payload, packed like the chain tints.
    def float_channel(v: str) -> int:
        return max(0, min(255, round(float(v or 0) * 255)))

    glow_rows: dict[int, int] = {}  # EdgeGlowEffect.ID -> packed RGB
    for gid, r, g, b in read_table(
        table_dir, "EdgeGlowEffect", ["ID", "GlowRed", "GlowGreen", "GlowBlue"]
    ):
        glow_rows[to_int(gid)] = (
            (float_channel(r) << 16) | (float_channel(g) << 8) | float_channel(b)
        )

    # shadowy effects: EffectType 7 -> ShadowyEffect, two packed colors
    # stored as signed int32 ARGB — the alpha byte is masked off
    shadowy_rows: dict[int, tuple[int, int]] = {}  # ID -> (primary, secondary)
    for eid, primary, secondary in read_table(
        table_dir, "ShadowyEffect", ["ID", "PrimaryColor", "SecondaryColor"]
    ):
        shadowy_rows[to_int(eid)] = (to_int(primary) & 0xFFFFFF,
                                     to_int(secondary) & 0xFFFFFF)

    chain_cols = (
        ["ID", "Red", "Green", "Blue", "SoundKitID"]
        + [f"TextureFileDataID_{i}" for i in range(3)]
        + [f"SpellChainEffectID_{i}" for i in range(11)]
    )
    chain_rows: dict[int, tuple] = {}  # chain ID -> (r, g, b, soundkit, texfids, subchains)
    for row in read_table(table_dir, "SpellChainEffects", chain_cols):
        cid = to_int(row[0])
        r, g, b, sk = (to_int(v) for v in row[1:5])
        # dict.fromkeys: dedupe (a chain may repeat a fid) but keep slot order
        texfids = tuple(dict.fromkeys(f for f in (to_int(v) for v in row[5:8]) if f))
        subs = tuple(c for c in (to_int(v) for v in row[8:19]) if c)
        chain_rows[cid] = (r, g, b, sk, texfids, subs)

    def expand_chain(cid: int, out: set[int]) -> None:
        """Composite chains nest via SpellChainEffectID_0..10 — flatten."""
        if cid in out or cid not in chain_rows:
            return
        out.add(cid)
        for sub in chain_rows[cid][5]:
            expand_chain(sub, out)

    kit_soundkits: dict[int, set[int]] = defaultdict(set)
    kit_animkits: dict[int, set[int]] = defaultdict(set)
    kit_anims: dict[int, set[int]] = defaultdict(set)  # direct anim IDs (proc Type 7)
    kit_chains: dict[int, set[int]] = defaultdict(set)
    kit_dissolves: dict[int, set[int]] = defaultdict(set)
    kit_glows: dict[int, set[int]] = defaultdict(set)
    kit_shadowies: dict[int, set[int]] = defaultdict(set)
    kit_ghost_mats: dict[int, set[int]] = defaultdict(set)  # proc Type 22 material recolors
    kit_tints: dict[int, set[int]] = defaultdict(set)
    kit_desats: dict[int, set[int]] = defaultdict(set)   # proc IDs (Type 21)
    kit_transps: dict[int, set[int]] = defaultdict(set)  # proc IDs (Type 14)
    kit_freezes: set[int] = set()  # kit IDs with a freeze proc (Type 11)
    kit_camos: set[int] = set()    # kit IDs with a camo proc (Type 18)
    kit_screens: dict[int, set[int]] = defaultdict(set)  # kit -> ScreenEffect ids (ET 19)
    for kit_id, effect_type, effect in read_table(
        table_dir, "SpellVisualKitEffect", ["ParentSpellVisualKitID", "EffectType", "Effect"]
    ):
        k, et, e = to_int(kit_id), to_int(effect_type), to_int(effect)
        if not (k and e):
            continue
        if et == EFFECT_TYPE_SOUND:
            kit_soundkits[k].add(e)
        elif et == EFFECT_TYPE_ANIM:
            ak = anim_kit_of.get(e, 0)
            if ak:
                kit_animkits[k].add(ak)
        elif et == EFFECT_TYPE_PROC:
            # one proc reference — dispatch by which type-bucket it landed in
            expand_chain(proc_chain.get(e, 0), kit_chains[k])
            if e in tint_rows:
                kit_tints[k].add(e)
            if e in ghost_mat_rows:
                kit_ghost_mats[k].add(e)
            if e in desat_rows:
                kit_desats[k].add(e)
            if e in transp_rows:
                kit_transps[k].add(e)
            if e in freeze_procs:
                kit_freezes.add(k)
            if e in camo_procs:
                kit_camos.add(k)
            if e in proc_model:
                kit_models[k].add(proc_model[e])
            if e in proc_anims:
                kit_anims[k].update(proc_anims[e])
        elif et == EFFECT_TYPE_BEAM:
            expand_chain(beam_chain.get(e, 0), kit_chains[k])
        elif et == EFFECT_TYPE_DISSOLVE:
            if e in dissolve_rows:  # a missing row carries nothing to show
                kit_dissolves[k].add(e)
        elif et == EFFECT_TYPE_EDGE_GLOW:
            if e in glow_rows:
                kit_glows[k].add(e)
        elif et == EFFECT_TYPE_SHADOWY:
            if e in shadowy_rows:
                kit_shadowies[k].add(e)
        elif et == EFFECT_TYPE_EMISSION:
            fid = emission_fid.get(e, 0)
            if fid:
                kit_models[k].add((fid, MODEL_CAT_AREA))
        elif et == EFFECT_TYPE_BARRAGE:
            fid = barrage_fid.get(e, 0)
            if fid:
                kit_models[k].add((fid, MODEL_CAT_BARRAGE))
        elif et == EFFECT_TYPE_SCREEN:
            se_id = svse_screen.get(e, 0)
            if se_id in screen_rows:
                kit_screens[k].add(se_id)

    # soundkit -> sound file ids
    soundkit_files: dict[int, set[int]] = defaultdict(set)
    for soundkit_id, fid in read_table(table_dir, "SoundKitEntry", ["SoundKitID", "FileDataID"]):
        sk, f = to_int(soundkit_id), to_int(fid)
        if sk and f:
            soundkit_files[sk].add(f)

    # animkit -> animation ids (AnimKitSegment); names come from anims.js
    anim_names = read_anim_names()
    animkit_anims: dict[int, set[int]] = defaultdict(set)
    for parent_kit, anim_id in read_table(table_dir, "AnimKitSegment", ["ParentAnimKitID", "AnimID"]):
        k, a = to_int(parent_kit), to_int(anim_id)
        if k and 0 <= a < len(anim_names):
            animkit_anims[k].add(a)

    # spell -> effect enum ids, plus aura enum ids (EffectAura — meaningful
    # mostly on APPLY_AURA-family effects; any nonzero value is kept). For
    # transform auras (56) misc0 is a CREATURE id (server-side NPC entry,
    # per SpellAuraNames::SpecialMiscValue), NOT a display id; for summon
    # effects (28) misc0 is likewise a creature id and misc1 the
    # SummonProperties row.
    se_cols = ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue_0", "EffectMiscValue_1"]
    se_hotfix_cols = ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1", "EffectMiscValue2"]
    se_rows: dict[int, tuple[int, int, int, int, int]] = {}
    for rid, spell_id, effect, aura, misc0, misc1 in read_table(table_dir, "SpellEffect", se_cols):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                int(float(misc0)) if misc0 else 0,
                                int(float(misc1)) if misc1 else 0)
    for rid, spell_id, effect, aura, misc0, misc1 in hotfix_rows(tdb_dir, "spell_effect", se_hotfix_cols):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                int(float(misc0)) if misc0 else 0,
                                int(float(misc1)) if misc1 else 0)

    # SummonProperties: only Control matters (guardian/pet/possessed/...)
    summon_control: dict[int, int] = {}
    for pid, ctrl in read_table(table_dir, "SummonProperties", ["ID", "Control"]):
        summon_control[to_int(pid)] = to_int(ctrl)

    spell_effects: dict[int, set[int]] = defaultdict(set)
    spell_auras: dict[int, set[int]] = defaultdict(set)
    spell_morphs: dict[int, set[int]] = defaultdict(set)  # spell -> creature ids
    spell_summons: dict[int, set[tuple[int, int]]] = defaultdict(set)  # spell -> (creature, control)
    spell_screens: dict[int, set[int]] = defaultdict(set)  # spell -> ScreenEffect ids
    for s, e, a, misc0, misc1 in se_rows.values():
        if s not in spell_names:
            continue
        if e:
            spell_effects[s].add(e)
        if a:
            spell_auras[s].add(a)
        if a == AURA_TRANSFORM and misc0 > 0:
            spell_morphs[s].add(misc0)
        if e == EFFECT_SUMMON and misc0 > 0:
            spell_summons[s].add((misc0, summon_control.get(misc1, 0)))
        # SCREEN_EFFECT auras carry the ScreenEffect ID in misc0 — the main
        # route (the kit route below adds only a handful of rows)
        if a == AURA_SCREEN_EFFECT and misc0 > 0 and misc0 in screen_rows:
            spell_screens[s].add(misc0)
    del se_rows

    # creature -> name + display ids (TDB world tables — server-side data
    # the client never ships; without TDB morph creatures stay unresolved)
    creature_names: dict[int, str] = {}
    creature_displays: dict[int, list[tuple[int, int]]] = defaultdict(list)
    if tdb_dir is not None:
        for entry, name in read_table(tdb_dir, "creature_template", ["entry", "name"]):
            creature_names[to_int(entry)] = name
        for cid, idx, did, _prob in read_table(
            tdb_dir, "creature_template_model", ["CreatureID", "Idx", "CreatureDisplayID", "Probability"]
        ):
            creature_displays[to_int(cid)].append((to_int(idx), to_int(did)))
        for displays in creature_displays.values():
            displays.sort()

    # display id -> model file id (CreatureDisplayInfo -> CreatureModelData)
    display_model: dict[int, int] = {}
    for did, mid in read_table(table_dir, "CreatureDisplayInfo", ["ID", "ModelID"]):
        display_model[to_int(did)] = to_int(mid)
    for did, mid in hotfix_rows(tdb_dir, "creature_display_info", ["ID", "ModelID"]):
        display_model[to_int(did)] = to_int(mid)
    model_fid: dict[int, int] = {}
    for mid, fid in read_table(table_dir, "CreatureModelData", ["ID", "FileDataID"]):
        model_fid[to_int(mid)] = to_int(fid)
    for mid, fid in hotfix_rows(tdb_dir, "creature_model_data", ["ID", "FileDataID"]):
        model_fid[to_int(mid)] = to_int(fid)

    # flatten morph creatures to (creature, display, model fid) rows
    used_creatures = {c for cs in spell_morphs.values() for c in cs}
    morph_display_rows: list[tuple[int, int, int]] = []
    for c in sorted(used_creatures):
        for _idx, did in creature_displays.get(c, ()):
            fid = model_fid.get(display_model.get(did, 0), 0)
            morph_display_rows.append((c, did, fid))

    # spell -> icon file id (SpellMisc; prefer the base-difficulty row)
    sm_rows: dict[int, tuple[int, int, int]] = {}
    for rid, spell_id, diff, icon_fid in read_table(
        table_dir, "SpellMisc", ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"]
    ):
        sm_rows[to_int(rid)] = (to_int(spell_id), to_int(diff), to_int(icon_fid))
    for rid, spell_id, diff, icon_fid in hotfix_rows(
        tdb_dir, "spell_misc", ["ID", "SpellID", "DifficultyID", "SpellIconFileDataID"]
    ):
        sm_rows[to_int(rid)] = (to_int(spell_id), to_int(diff), to_int(icon_fid))
    spell_icon_fid: dict[int, int] = {}
    for s, d, f in sm_rows.values():
        if s in spell_names and f and (s not in spell_icon_fid or d == 0):
            spell_icon_fid[s] = f
    del sm_rows

    # --- walk the chains per spell ------------------------------------------
    log("Walking spell -> model/sound/animkit/chain chains ...")
    spell_models: dict[int, set[tuple[int, int]]] = defaultdict(set)  # spell -> (model fid, category)
    spell_sounds: dict[int, set[tuple[int, int]]] = defaultdict(set)  # spell -> (soundkit, fid)
    spell_animkits: dict[int, set[int]] = defaultdict(set)        # spell -> animkit ids
    spell_chains: dict[int, set[int]] = defaultdict(set)          # spell -> chain effect ids
    spell_dissolves: dict[int, set[int]] = defaultdict(set)       # spell -> dissolve effect ids
    spell_glows: dict[int, set[int]] = defaultdict(set)           # spell -> edge glow ids
    spell_shadowies: dict[int, set[int]] = defaultdict(set)       # spell -> shadowy effect ids
    spell_ghost_mats: dict[int, set[int]] = defaultdict(set)      # spell -> Type-22 proc ids
    spell_tints: dict[int, set[int]] = defaultdict(set)           # spell -> tint proc ids
    spell_desats: dict[int, set[int]] = defaultdict(set)          # spell -> Type-21 proc ids
    spell_transps: dict[int, set[int]] = defaultdict(set)         # spell -> Type-14 proc ids
    spell_anims: dict[int, set[int]] = defaultdict(set)           # spell -> direct anim ids (Type 7)
    spell_freezes: set[int] = set()                               # spells with a freeze proc
    spell_camos: set[int] = set()                                 # spells with a camo proc
    orphan_spells = 0  # SpellXSpellVisual rows whose SpellID has no SpellName entry

    for spell_id, visuals in spell_visuals.items():
        if spell_id not in spell_names:
            orphan_spells += 1
            continue
        for v in visuals:
            m_fids, m_sks, m_aks = visual_missiles.get(v, EMPTY)
            spell_models[spell_id].update((f, MODEL_CAT_MISSILE) for f in m_fids)
            spell_animkits[spell_id].update(m_aks)
            for sk in m_sks:
                for f in soundkit_files.get(sk, ()):
                    spell_sounds[spell_id].add((sk, f))
            for k in visual_kits.get(v, ()):
                spell_models[spell_id].update(kit_models.get(k, ()))
                spell_animkits[spell_id].update(kit_animkits.get(k, ()))
                spell_anims[spell_id].update(kit_anims.get(k, ()))
                spell_chains[spell_id].update(kit_chains.get(k, ()))
                spell_dissolves[spell_id].update(kit_dissolves.get(k, ()))
                spell_glows[spell_id].update(kit_glows.get(k, ()))
                spell_shadowies[spell_id].update(kit_shadowies.get(k, ()))
                spell_ghost_mats[spell_id].update(kit_ghost_mats.get(k, ()))
                spell_tints[spell_id].update(kit_tints.get(k, ()))
                spell_desats[spell_id].update(kit_desats.get(k, ()))
                spell_transps[spell_id].update(kit_transps.get(k, ()))
                if k in kit_freezes:
                    spell_freezes.add(spell_id)
                if k in kit_camos:
                    spell_camos.add(spell_id)
                spell_screens[spell_id].update(kit_screens.get(k, ()))
                for sk in kit_soundkits.get(k, ()):
                    for f in soundkit_files.get(sk, ()):
                        spell_sounds[spell_id].add((sk, f))

    # a chain effect's own SoundKit folds into the spell's Sounds column
    for spell_id, chains in spell_chains.items():
        for c in chains:
            sk = chain_rows[c][3]
            for f in soundkit_files.get(sk, ()):
                spell_sounds[spell_id].add((sk, f))

    # --- file names from the listfile ---------------------------------------
    used_chains = {c for chains in spell_chains.values() for c in chains}
    used_dissolves = {e for effs in spell_dissolves.values() for e in effs}
    used_screens = {sc for scs in spell_screens.values() for sc in scs}

    referenced_fids = set()
    for pairs in spell_models.values():
        referenced_fids.update(f for f, _ in pairs)
    for pairs in spell_sounds.values():
        referenced_fids.update(f for _, f in pairs)
    for c in used_chains:
        referenced_fids.update(chain_rows[c][4])
    for e in used_dissolves:
        referenced_fids.update(dissolve_rows[e][1])
    for sc in used_screens:
        referenced_fids.update(screen_rows[sc][4])
    referenced_fids.update(f for _, _, f in morph_display_rows if f)

    # icon fids resolve through the same listfile pass but stay out of the
    # pack's files table (they become iconNames instead)
    icon_fids = set(spell_icon_fid.values())
    lookup_fids = referenced_fids | icon_fids

    log(f"Resolving {len(lookup_fids):,} referenced file ids against the listfile ...")
    fid_path: dict[int, str] = {}
    with open(listfile_path, newline="", encoding="utf-8", errors="replace") as f:
        for line in f:
            fid_str, sep, path = line.partition(";")
            if not sep:
                continue
            try:
                fid = int(fid_str)
            except ValueError:
                continue
            if fid in lookup_fids:
                fid_path[fid] = path.strip()
    unnamed = sum(1 for f in referenced_fids if f not in fid_path)

    # --- assemble the pack ---------------------------------------------------
    log("Assembling pack ...")
    spell_ids = sorted(spell_names)

    # icon names: "interface/icons/xxx.blp" -> "xxx", the key Wowhead's CDN
    # (wow.zamimg.com/images/wow/icons/<size>/<xxx>.jpg) serves icons under.
    # spells.icons holds 1-based indexes into iconNames; 0 = no icon.
    def icon_name(fid: int) -> str:
        path = fid_path.get(fid, "")
        if not path.lower().startswith("interface/icons/"):
            return ""
        return path.rsplit("/", 1)[-1].rsplit(".", 1)[0].lower()

    icon_names: list[str] = []
    icon_index: dict[str, int] = {}
    spell_icons: list[int] = []
    for s in spell_ids:
        name = icon_name(spell_icon_fid.get(s, 0))
        if not name:
            spell_icons.append(0)
            continue
        i = icon_index.get(name)
        if i is None:
            i = icon_index[name] = len(icon_names)
            icon_names.append(name)
        spell_icons.append(i + 1)

    spells = {
        "ids": spell_ids,
        "names": [spell_names[s] for s in spell_ids],
        "subtexts": [subtexts.get(s, "") for s in spell_ids],
        "icons": spell_icons,
    }

    file_ids = sorted(referenced_fids)
    files = {
        "fids": file_ids,
        "paths": [fid_path.get(f, "") for f in file_ids],
    }

    model_rows = sorted((s, f, c) for s, pairs in spell_models.items() for f, c in pairs)
    sound_rows = sorted((s, sk, f) for s, pairs in spell_sounds.items() for sk, f in pairs)
    anim_rows = sorted((s, a) for s, aks in spell_animkits.items() for a in aks)
    fx_rows = sorted((s, c) for s, chains in spell_chains.items() for c in chains)

    # per used chain: packed RGB tint (0xFFFFFF = untinted — "the texture's
    # own color") and a coarse hue word for the search corpus, so a query
    # like "beam red" finds a red-tinted greyscale texture
    def hue_word(r: int, g: int, b: int) -> str:
        import colorsys
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s < 0.15 or v < 0.08:
            return ""  # white / grey / near-black tints carry no hue
        deg = h * 360
        for limit, name in ((15, "red"), (45, "orange"), (70, "yellow"), (160, "green"),
                            (200, "cyan"), (255, "blue"), (290, "purple"), (330, "pink"),
                            (361, "red")):
            if deg < limit:
                return name
        return ""

    fx_chain_ids = sorted(used_chains)
    fx_colors, fx_hues = [], []
    for c in fx_chain_ids:
        r, g, b = chain_rows[c][:3]
        fx_colors.append((r << 16) | (g << 8) | b)
        fx_hues.append(hue_word(r, g, b))
    fx_tex_rows = sorted((c, f) for c in used_chains for f in chain_rows[c][4])

    dissolve_row_pairs = sorted((s, e) for s, effs in spell_dissolves.items() for e in effs)
    dissolve_ids = sorted(used_dissolves)
    dissolve_tex_rows = sorted((e, f) for e in used_dissolves for f in dissolve_rows[e][1])

    # edge glows / shadowy effects: color-only rows — same packed RGB + hue
    # word treatment as the chain tints (hex search happens app-side)
    def unpack_rgb(c: int) -> tuple[int, int, int]:
        return (c >> 16) & 255, (c >> 8) & 255, c & 255

    glow_row_pairs = sorted((s, g) for s, gs in spell_glows.items() for g in gs)
    glow_ids = sorted({g for gs in spell_glows.values() for g in gs})
    glow_hues = [hue_word(*unpack_rgb(glow_rows[g])) for g in glow_ids]

    tint_row_pairs = sorted((s, t) for s, ts in spell_tints.items() for t in ts)
    tint_ids = sorted({t for ts in spell_tints.values() for t in ts})
    tint_hues = [hue_word(*unpack_rgb(tint_rows[t])) for t in tint_ids]

    shadowy_row_pairs = sorted((s, e) for s, es in spell_shadowies.items() for e in es)
    shadowy_ids = sorted({e for es in spell_shadowies.values() for e in es})
    shadowy_hues = []
    for e in shadowy_ids:
        p, sc = shadowy_rows[e]
        hues = dict.fromkeys(h for h in (hue_word(*unpack_rgb(p)), hue_word(*unpack_rgb(sc))) if h)
        shadowy_hues.append(" ".join(hues))

    # ghost materials (proc Type 22): single-color recolors that join the
    # ShadowyEffect rows under the "ghost" category — same color-only shape
    # as tints/glows
    ghost_mat_pairs = sorted((s, g) for s, gs in spell_ghost_mats.items() for g in gs)
    ghost_mat_ids = sorted({g for gs in spell_ghost_mats.values() for g in gs})
    ghost_mat_hues = [hue_word(*unpack_rgb(ghost_mat_rows[g])) for g in ghost_mat_ids]

    # screen effects: one row per used ScreenEffect — internal name, fog tint
    # (Effect=3 rows; -1 = none, 0 IS a legit black fog), FullScreenEffect
    # multiply/addition screen colors (-1 = no FSE) and texture fids
    screen_pairs = sorted((s, sc) for s, scs in spell_screens.items() for sc in scs)
    screen_ids = sorted(used_screens)
    screen_hues = []
    for sc in screen_ids:
        _, fog, mul, add, _tex = screen_rows[sc]
        hues = dict.fromkeys(
            h for c in (fog, mul, add) if c >= 0 for h in (hue_word(*unpack_rgb(c)),) if h)
        screen_hues.append(" ".join(hues))
    screen_tex_rows = sorted((sc, f) for sc in used_screens for f in screen_rows[sc][4])

    # desaturate (proc Type 21) / transparency (proc Type 14): percent-only
    # pills — the percent is the whole payload (no color, no id table). Dedupe
    # equal percents on the same spell.
    desat_pairs = sorted({(s, desat_rows[d]) for s, ds in spell_desats.items() for d in ds})
    transp_pairs = sorted({(s, transp_rows[t]) for s, ts in spell_transps.items() for t in ts})
    # freeze (11) / camo (18): valueless — just the spell id set
    freeze_ids = sorted(spell_freezes)
    camo_ids = sorted(spell_camos)

    # only animkits that spells actually use
    used_animkits = {a for aks in spell_animkits.values() for a in aks}
    kit_anim_rows = sorted(
        (k, a) for k, anims in animkit_anims.items() if k in used_animkits for a in anims)
    # direct stand/walk anim ids (proc Type 7) — index into animNames, like
    # animKitAnims; guard against ids past the anim-name table
    anim_direct_rows = sorted(
        {(s, a) for s, aset in spell_anims.items() for a in aset if a < len(anim_names)})
    effect_rows = sorted((s, e) for s, effs in spell_effects.items() for e in effs)
    aura_rows = sorted((s, a) for s, auras in spell_auras.items() for a in auras)
    morph_rows = sorted((s, c) for s, cs in spell_morphs.items() for c in cs)
    morph_creature_ids = sorted(used_creatures)
    summon_rows = sorted((s, c, ctrl) for s, cs in spell_summons.items() for c, ctrl in cs)
    summon_creature_ids = sorted({c for cs in spell_summons.values() for c, _ in cs})
    effect_names = read_enum_names("SpellEffect", version)
    aura_names = read_enum_names("SpellEffectAura", version)

    pack = {
        "meta": {
            "format": 16,
            "version": version,
            "label": label,
            "built": time.strftime("%Y-%m-%d"),
            "listfileTag": (CACHE_DIR / "listfile" / "release-tag.txt").read_text().strip()
            if (CACHE_DIR / "listfile" / "release-tag.txt").exists() else "",
            "tdbTag": TDB_RELEASES.get(version, {}).get("tag", "") if tdb_dir else "",
            "counts": {
                "spells": len(spell_ids),
                "files": len(file_ids),
                "spellModels": len(model_rows),
                "spellSounds": len(sound_rows),
                "spellAnimKits": len(anim_rows),
                "animKitAnims": len(kit_anim_rows),
                "spellEffects": len(effect_rows),
                "spellAuras": len(aura_rows),
                "spellFx": len(fx_rows),
                "spellMorphs": len(morph_rows),
                "morphs": len(morph_creature_ids),
                "morphDisplays": len(morph_display_rows),
                "spellSummons": len(summon_rows),
                "summons": len(summon_creature_ids),
                "fxChains": len(fx_chain_ids),
                "spellDissolves": len(dissolve_row_pairs),
                "dissolves": len(dissolve_ids),
                "spellGlows": len(glow_row_pairs),
                "glows": len(glow_ids),
                "spellShadowies": len(shadowy_row_pairs),
                "shadowies": len(shadowy_ids),
                "spellGhostMats": len(ghost_mat_pairs),
                "ghostMats": len(ghost_mat_ids),
                "spellTints": len(tint_row_pairs),
                "tints": len(tint_ids),
                "spellDesaturates": len(desat_pairs),
                "spellTransparencies": len(transp_pairs),
                "spellFreezes": len(freeze_ids),
                "spellCamos": len(camo_ids),
                "spellAnims": len(anim_direct_rows),
                "spellScreens": len(screen_pairs),
                "screens": len(screen_ids),
                "icons": len(icon_names),
            },
        },
        "spells": spells,
        "iconNames": icon_names,
        "files": files,
        # cats tag how each model is used (attach/missile/area/trail/barrage);
        # the same (spell, fid) can appear once per category it serves
        "spellModels": {
            "spellIds": [r[0] for r in model_rows],
            "fids": [r[1] for r in model_rows],
            "cats": [r[2] for r in model_rows],
        },
        "modelCatNames": MODEL_CAT_NAMES,
        "spellSounds": {
            "spellIds": [r[0] for r in sound_rows],
            "soundKitIds": [r[1] for r in sound_rows],
            "fids": [r[2] for r in sound_rows],
        },
        "spellAnimKits": {
            "spellIds": [r[0] for r in anim_rows],
            "animKitIds": [r[1] for r in anim_rows],
        },
        "animKitAnims": {
            "animKitIds": [r[0] for r in kit_anim_rows],
            "animIds": [r[1] for r in kit_anim_rows],
        },
        # direct stand/walk animation ids (SpellProceduralEffect Type 7) — a
        # second source for the Animations column; animIds index into animNames
        "spellAnims": {
            "spellIds": [r[0] for r in anim_direct_rows],
            "animIds": [r[1] for r in anim_direct_rows],
        },
        "animNames": anim_names,
        "spellEffects": {
            "spellIds": [r[0] for r in effect_rows],
            "effects": [r[1] for r in effect_rows],
        },
        "effectNames": effect_names,
        # aura mechanics: SpellEffect.EffectAura values (SPELL_AURA_* names)
        "spellAuras": {
            "spellIds": [r[0] for r in aura_rows],
            "auras": [r[1] for r in aura_rows],
        },
        "auraNames": aura_names,
        # visual FX: chain/beam effects (SpellChainEffects). spellFx links
        # spells to chains; fxChains carries each chain's tint + hue word;
        # fxTextures its texture fids (paths resolve via "files")
        "spellFx": {
            "spellIds": [r[0] for r in fx_rows],
            "chainIds": [r[1] for r in fx_rows],
        },
        "fxChains": {
            "ids": fx_chain_ids,
            "colors": fx_colors,
            "hues": fx_hues,
        },
        "fxTextures": {
            "chainIds": [r[0] for r in fx_tex_rows],
            "fids": [r[1] for r in fx_tex_rows],
        },
        # dissolves (DissolveEffect via kit EffectType 11): spellDissolves
        # links spells to dissolve rows; dissolves carries each row's
        # duration (seconds, 0 = unspecified); dissolveTextures its
        # TextureBlendSet texture fids (paths resolve via "files")
        "spellDissolves": {
            "spellIds": [r[0] for r in dissolve_row_pairs],
            "dissolveIds": [r[1] for r in dissolve_row_pairs],
        },
        "dissolves": {
            "ids": dissolve_ids,
            "durations": [dissolve_rows[e][0] for e in dissolve_ids],
        },
        "dissolveTextures": {
            "dissolveIds": [r[0] for r in dissolve_tex_rows],
            "fids": [r[1] for r in dissolve_tex_rows],
        },
        # edge glows (EdgeGlowEffect via kit EffectType 12): color-only —
        # no texture or model, the packed RGB is the whole payload
        "spellGlows": {
            "spellIds": [r[0] for r in glow_row_pairs],
            "glowIds": [r[1] for r in glow_row_pairs],
        },
        "glows": {
            "ids": glow_ids,
            "colors": [glow_rows[g] for g in glow_ids],
            "hues": glow_hues,
        },
        # shadowy effects (ShadowyEffect via kit EffectType 7): two packed
        # colors per row; hues joins both colors' hue words
        "spellShadowies": {
            "spellIds": [r[0] for r in shadowy_row_pairs],
            "shadowyIds": [r[1] for r in shadowy_row_pairs],
        },
        "shadowies": {
            "ids": shadowy_ids,
            "primaryColors": [shadowy_rows[e][0] for e in shadowy_ids],
            "secondaryColors": [shadowy_rows[e][1] for e in shadowy_ids],
            "hues": shadowy_hues,
        },
        # ghost materials (SpellProceduralEffect Type 22): single-color
        # material recolors that render under the same "ghost" category as the
        # ShadowyEffect rows — color-only, one packed RGB each
        "spellGhostMats": {
            "spellIds": [r[0] for r in ghost_mat_pairs],
            "ghostIds": [r[1] for r in ghost_mat_pairs],
        },
        "ghostMats": {
            "ids": ghost_mat_ids,
            "colors": [ghost_mat_rows[g] for g in ghost_mat_ids],
            "hues": ghost_mat_hues,
        },
        # model tints (SpellProceduralEffect Type 1 & 23 via kit EffectType 1):
        # color-only like glows — the packed RGB is the whole payload. Type 1
        # multiply-tints; Type 23 material-recolors (colorless folds in as black)
        "spellTints": {
            "spellIds": [r[0] for r in tint_row_pairs],
            "tintIds": [r[1] for r in tint_row_pairs],
        },
        "tints": {
            "ids": tint_ids,
            "colors": [tint_rows[t] for t in tint_ids],
            "hues": tint_hues,
        },
        # desaturate (Type 21) / transparency (Type 14): percent-only pills —
        # spellIds parallel to percents (0..100), no color, no id table
        "spellDesaturates": {
            "spellIds": [r[0] for r in desat_pairs],
            "percents": [r[1] for r in desat_pairs],
        },
        "spellTransparencies": {
            "spellIds": [r[0] for r in transp_pairs],
            "percents": [r[1] for r in transp_pairs],
        },
        # freeze (Type 11) / camo (Type 18): valueless standalone pills
        "spellFreezes": {"spellIds": freeze_ids},
        "spellCamos": {"spellIds": camo_ids},
        # screen effects (ScreenEffect via SCREEN_EFFECT auras + kit ET 19):
        # per row an internal name, a fog tint (-1 = none), FullScreenEffect
        # multiply/addition screen colors (-1 = none) and texture fids
        # (overlay + TextureBlendSet; paths resolve via "files")
        "spellScreens": {
            "spellIds": [r[0] for r in screen_pairs],
            "screenIds": [r[1] for r in screen_pairs],
        },
        "screens": {
            "ids": screen_ids,
            "names": [screen_rows[sc][0] for sc in screen_ids],
            "fogColors": [screen_rows[sc][1] for sc in screen_ids],
            "mulColors": [screen_rows[sc][2] for sc in screen_ids],
            "addColors": [screen_rows[sc][3] for sc in screen_ids],
            "hues": screen_hues,
        },
        "screenTextures": {
            "screenIds": [r[0] for r in screen_tex_rows],
            "fids": [r[1] for r in screen_tex_rows],
        },
        # morphs: transform auras reference a CREATURE (NPC entry); its
        # display ids come from TDB's creature_template_model, each display
        # resolving to a creature model file (fid 0 = unknown model)
        "spellMorphs": {
            "spellIds": [r[0] for r in morph_rows],
            "creatureIds": [r[1] for r in morph_rows],
        },
        "morphs": {
            "creatureIds": morph_creature_ids,
            "names": [creature_names.get(c, "") for c in morph_creature_ids],
        },
        "morphDisplays": {
            "creatureIds": [r[0] for r in morph_display_rows],
            "displayIds": [r[1] for r in morph_display_rows],
            "fids": [r[2] for r in morph_display_rows],
        },
        # summons (SpellEffect SUMMON): the spell summons a CREATURE (NPC
        # entry, names via TDB creature_template like morphs); control is
        # per spell-effect row, from its SummonProperties
        "spellSummons": {
            "spellIds": [r[0] for r in summon_rows],
            "creatureIds": [r[1] for r in summon_rows],
            "controls": [r[2] for r in summon_rows],
        },
        "summons": {
            "creatureIds": summon_creature_ids,
            "names": [creature_names.get(c, "") for c in summon_creature_ids],
        },
        "summonControlNames": SUMMON_CONTROL_NAMES,
    }

    log(
        f"  spells={len(spell_ids):,}  files={len(file_ids):,} ({unnamed:,} unnamed)  "
        f"models={len(model_rows):,}  sounds={len(sound_rows):,}  animkits={len(anim_rows):,}  "
        f"kitAnims={len(kit_anim_rows):,}  effects={len(effect_rows):,}  auras={len(aura_rows):,}  fx={len(fx_rows):,}  "
        f"fxChains={len(fx_chain_ids):,}  dissolves={len(dissolve_row_pairs):,} "
        f"({len(dissolve_ids):,} rows)  glows={len(glow_row_pairs):,} "
        f"({len(glow_ids):,} rows)  shadowies={len(shadowy_row_pairs):,} "
        f"({len(shadowy_ids):,} rows)  tints={len(tint_row_pairs):,} "
        f"({len(tint_ids):,} rows)  screens={len(screen_pairs):,} "
        f"({len(screen_ids):,} rows)  morphs={len(morph_rows):,} "
        f"({len(morph_display_rows):,} displays)  summons={len(summon_rows):,} "
        f"({len(summon_creature_ids):,} creatures)  icons={len(icon_names):,}  "
        f"orphan visual spells={orphan_spells:,}  [{time.time() - t0:.1f}s]"
    )
    return pack


def write_pack(pack: dict, version: str, label: str) -> None:
    out_dir = DATA_DIR / version
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "spelldata.json.gz"

    raw = json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    # mtime=0 keeps rebuilds byte-identical when the data hasn't changed
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(raw)
    out_path.write_bytes(buf.getvalue())
    log(f"Wrote {out_path}  ({len(raw):,} raw -> {out_path.stat().st_size:,} gzipped)")

    # content hash for cache busting: the app appends it to the pack URL
    # (?v=<hash>), so browsers refetch exactly when the data changed
    import hashlib
    pack_hash = hashlib.sha256(buf.getvalue()).hexdigest()[:10]

    # update the version manifest
    manifest_path = DATA_DIR / "versions.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else []
    entry = {
        "id": version,
        "label": label,
        "file": f"data/{version}/spelldata.json.gz",
        "built": pack["meta"]["built"],
        "hash": pack_hash,
    }
    manifest = [e for e in manifest if e["id"] != version] + [entry]
    manifest.sort(key=lambda e: e["id"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"Updated {manifest_path}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", required=True, help="game build, e.g. 9.2.7.45745")
    ap.add_argument("--label", help='display label, e.g. "Shadowlands 9.2.7" (default: the version)')
    ap.add_argument("--refresh", action="store_true", help="re-download sources even if cached")
    args = ap.parse_args()

    label = args.label or args.version
    table_dir, listfile, tdb_dir = fetch_sources(args.version, args.refresh)
    pack = build_pack(args.version, label, table_dir, listfile, tdb_dir)
    write_pack(pack, args.version, label)


if __name__ == "__main__":
    main()
