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
    "SpellMisc",
    "SpellChainEffects",
    "SpellProceduralEffect",
    "BeamEffect",
    "DissolveEffect",
    "TextureBlendSet",
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
        "spell_effect": ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1"],
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
EFFECT_TYPE_DISSOLVE = 11 # Effect = DissolveEffect.ID
EFFECT_TYPE_BEAM = 13     # Effect = BeamEffect.ID

# SpellProceduralEffect.Type whose Value_0 is a SpellChainEffects ID
PROC_TYPE_CHAIN = 26

# SpellEffectAura value whose EffectMiscValue_0 is a CreatureDisplayID
AURA_TRANSFORM = 56

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

    kit_models: dict[int, set[int]] = defaultdict(set)
    for kit_id, en_id in read_table(
        table_dir, "SpellVisualKitModelAttach", ["ParentSpellVisualKitID", "SpellVisualEffectNameID"]
    ):
        fid = effect_name_model.get(to_int(en_id), 0)
        k = to_int(kit_id)
        if k and fid:
            kit_models[k].add(fid)

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
    # EffectType 13 -> BeamEffect (BeamID = chain ID)
    proc_chain: dict[int, int] = {}  # SpellProceduralEffect.ID -> chain ID
    for pid, ptype, v0 in read_table(
        table_dir, "SpellProceduralEffect", ["ID", "Type", "Value_0"]
    ):
        if to_int(ptype) == PROC_TYPE_CHAIN:
            proc_chain[to_int(pid)] = int(float(v0)) if v0 else 0

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
    kit_chains: dict[int, set[int]] = defaultdict(set)
    kit_dissolves: dict[int, set[int]] = defaultdict(set)
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
            expand_chain(proc_chain.get(e, 0), kit_chains[k])
        elif et == EFFECT_TYPE_BEAM:
            expand_chain(beam_chain.get(e, 0), kit_chains[k])
        elif et == EFFECT_TYPE_DISSOLVE:
            if e in dissolve_rows:  # a missing row carries nothing to show
                kit_dissolves[k].add(e)

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
    # transform auras (56) the misc value is a CREATURE id (server-side NPC
    # entry, per SpellAuraNames::SpecialMiscValue), NOT a display id.
    se_rows: dict[int, tuple[int, int, int, int]] = {}
    for rid, spell_id, effect, aura, misc0 in read_table(
        table_dir, "SpellEffect", ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue_0"]
    ):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                int(float(misc0)) if misc0 else 0)
    for rid, spell_id, effect, aura, misc0 in hotfix_rows(
        tdb_dir, "spell_effect", ["ID", "SpellID", "Effect", "EffectAura", "EffectMiscValue1"]
    ):
        se_rows[to_int(rid)] = (to_int(spell_id), to_int(effect), to_int(aura),
                                int(float(misc0)) if misc0 else 0)

    spell_effects: dict[int, set[int]] = defaultdict(set)
    spell_auras: dict[int, set[int]] = defaultdict(set)
    spell_morphs: dict[int, set[int]] = defaultdict(set)  # spell -> creature ids
    for s, e, a, misc0 in se_rows.values():
        if s not in spell_names:
            continue
        if e:
            spell_effects[s].add(e)
        if a:
            spell_auras[s].add(a)
        if a == AURA_TRANSFORM and misc0 > 0:
            spell_morphs[s].add(misc0)
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
    spell_models: dict[int, set[int]] = defaultdict(set)          # spell -> model fids
    spell_sounds: dict[int, set[tuple[int, int]]] = defaultdict(set)  # spell -> (soundkit, fid)
    spell_animkits: dict[int, set[int]] = defaultdict(set)        # spell -> animkit ids
    spell_chains: dict[int, set[int]] = defaultdict(set)          # spell -> chain effect ids
    spell_dissolves: dict[int, set[int]] = defaultdict(set)       # spell -> dissolve effect ids
    orphan_spells = 0  # SpellXSpellVisual rows whose SpellID has no SpellName entry

    for spell_id, visuals in spell_visuals.items():
        if spell_id not in spell_names:
            orphan_spells += 1
            continue
        for v in visuals:
            m_fids, m_sks, m_aks = visual_missiles.get(v, EMPTY)
            spell_models[spell_id].update(m_fids)
            spell_animkits[spell_id].update(m_aks)
            for sk in m_sks:
                for f in soundkit_files.get(sk, ()):
                    spell_sounds[spell_id].add((sk, f))
            for k in visual_kits.get(v, ()):
                spell_models[spell_id].update(kit_models.get(k, ()))
                spell_animkits[spell_id].update(kit_animkits.get(k, ()))
                spell_chains[spell_id].update(kit_chains.get(k, ()))
                spell_dissolves[spell_id].update(kit_dissolves.get(k, ()))
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

    referenced_fids = set()
    for fids in spell_models.values():
        referenced_fids.update(fids)
    for pairs in spell_sounds.values():
        referenced_fids.update(f for _, f in pairs)
    for c in used_chains:
        referenced_fids.update(chain_rows[c][4])
    for e in used_dissolves:
        referenced_fids.update(dissolve_rows[e][1])
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

    model_rows = sorted((s, f) for s, fids in spell_models.items() for f in fids)
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

    # only animkits that spells actually use
    used_animkits = {a for aks in spell_animkits.values() for a in aks}
    kit_anim_rows = sorted(
        (k, a) for k, anims in animkit_anims.items() if k in used_animkits for a in anims)
    effect_rows = sorted((s, e) for s, effs in spell_effects.items() for e in effs)
    aura_rows = sorted((s, a) for s, auras in spell_auras.items() for a in auras)
    morph_rows = sorted((s, c) for s, cs in spell_morphs.items() for c in cs)
    morph_creature_ids = sorted(used_creatures)
    effect_names = read_enum_names("SpellEffect", version)
    aura_names = read_enum_names("SpellEffectAura", version)

    pack = {
        "meta": {
            "format": 9,
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
                "fxChains": len(fx_chain_ids),
                "spellDissolves": len(dissolve_row_pairs),
                "dissolves": len(dissolve_ids),
                "icons": len(icon_names),
            },
        },
        "spells": spells,
        "iconNames": icon_names,
        "files": files,
        "spellModels": {
            "spellIds": [r[0] for r in model_rows],
            "fids": [r[1] for r in model_rows],
        },
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
    }

    log(
        f"  spells={len(spell_ids):,}  files={len(file_ids):,} ({unnamed:,} unnamed)  "
        f"models={len(model_rows):,}  sounds={len(sound_rows):,}  animkits={len(anim_rows):,}  "
        f"kitAnims={len(kit_anim_rows):,}  effects={len(effect_rows):,}  auras={len(aura_rows):,}  fx={len(fx_rows):,}  "
        f"fxChains={len(fx_chain_ids):,}  dissolves={len(dissolve_row_pairs):,} "
        f"({len(dissolve_ids):,} rows)  morphs={len(morph_rows):,} "
        f"({len(morph_display_rows):,} displays)  icons={len(icon_names):,}  "
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
