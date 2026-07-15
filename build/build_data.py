#!/usr/bin/env python3
"""Build the Epsilook data pack for one WoW game version.

Downloads raw game tables (CSV export from wago.tools) and the community
listfile (github.com/wowdev/wow-listfile), walks the spell -> visual ->
model/sound/animkit relationship chains in plain Python, and emits a compact
gzipped column-oriented JSON pack consumed by the web app.

Stdlib only. Downloads are cached under build/cache/ ; pass --refresh to
force re-download.

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
    "SpellVisualEvent",
    "SpellVisualKitEffect",
    "SpellVisualKitModelAttach",
    "SpellVisualEffectName",
    "SpellVisualAnim",
    "AnimKitSegment",
    "SoundKitEntry",
    "SpellEffect",
]

# Animation names indexed by AnimID (Stand=0, ...), maintained by wow.tools
ANIMS_JS_URL = "https://raw.githubusercontent.com/Marlamin/wow.tools.local/main/wwwroot/js/anims.js"

# Spell effect enum names (ID,Name CSV without the SPELL_EFFECT_ prefix),
# checked into the repo (extracted from TrinityCore SharedDefines.h /
# wowdev.wiki Spell.dbc/Effect)
EFFECT_NAMES_FILE = BUILD_DIR / "effect_names.csv"

# SpellVisualKitEffect.EffectType values (what the kit effect points at)
EFFECT_TYPE_SOUND = 5     # Effect = SoundKitID
EFFECT_TYPE_ANIM = 6      # Effect = SpellVisualAnim.ID

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


def fetch_sources(version: str, refresh: bool) -> tuple[Path, Path]:
    """Ensure all table CSVs and the listfile are cached; return their dirs."""
    table_dir = CACHE_DIR / version
    log(f"Tables (wago.tools, build {version}):")
    for table in TABLES:
        download(WAGO_CSV_URL.format(table=table, version=version), table_dir / f"{table}.csv", refresh)

    log("Animation names (wow.tools):")
    download(ANIMS_JS_URL, CACHE_DIR / "anims.js", refresh)

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
    return table_dir, listfile


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


# ----------------------------------------------------------------- pipeline

def build_pack(version: str, label: str, table_dir: Path, listfile_path: Path) -> dict:
    t0 = time.time()

    # --- spells -----------------------------------------------------------
    log("Reading SpellName / Spell ...")
    spell_names: dict[int, str] = {}
    for sid, name in read_table(table_dir, "SpellName", ["ID", "Name_lang"]):
        spell_names[to_int(sid)] = name

    subtexts: dict[int, str] = {}
    for sid, sub in read_table(table_dir, "Spell", ["ID", "NameSubtext_lang"]):
        i = to_int(sid)
        if i in spell_names and sub:
            subtexts[i] = sub

    # --- visual chain lookups ---------------------------------------------
    log("Reading spell visual chain tables ...")
    # spell -> visuals
    spell_visuals: dict[int, set[int]] = defaultdict(set)
    for spell_id, visual_id in read_table(table_dir, "SpellXSpellVisual", ["SpellID", "SpellVisualID"]):
        s, v = to_int(spell_id), to_int(visual_id)
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

    kit_models: dict[int, set[int]] = defaultdict(set)
    for kit_id, en_id in read_table(
        table_dir, "SpellVisualKitModelAttach", ["ParentSpellVisualKitID", "SpellVisualEffectNameID"]
    ):
        fid = effect_name_model.get(to_int(en_id), 0)
        k = to_int(kit_id)
        if k and fid:
            kit_models[k].add(fid)

    # kit -> soundkits / animkits (via SpellVisualKitEffect)
    anim_kit_of: dict[int, int] = {}  # SpellVisualAnim.ID -> AnimKitID
    for sva_id, animkit_id in read_table(table_dir, "SpellVisualAnim", ["ID", "AnimKitID"]):
        anim_kit_of[to_int(sva_id)] = to_int(animkit_id)

    kit_soundkits: dict[int, set[int]] = defaultdict(set)
    kit_animkits: dict[int, set[int]] = defaultdict(set)
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

    # spell -> effect enum ids
    spell_effects: dict[int, set[int]] = defaultdict(set)
    for spell_id, effect in read_table(table_dir, "SpellEffect", ["SpellID", "Effect"]):
        s, e = to_int(spell_id), to_int(effect)
        if s in spell_names and e:
            spell_effects[s].add(e)

    # --- walk the chains per spell ------------------------------------------
    log("Walking spell -> model/sound/animkit chains ...")
    spell_models: dict[int, set[int]] = defaultdict(set)          # spell -> model fids
    spell_sounds: dict[int, set[tuple[int, int]]] = defaultdict(set)  # spell -> (soundkit, fid)
    spell_animkits: dict[int, set[int]] = defaultdict(set)        # spell -> animkit ids
    orphan_spells = 0  # SpellXSpellVisual rows whose SpellID has no SpellName entry

    for spell_id, visuals in spell_visuals.items():
        if spell_id not in spell_names:
            orphan_spells += 1
            continue
        for v in visuals:
            for k in visual_kits.get(v, ()):
                spell_models[spell_id].update(kit_models.get(k, ()))
                spell_animkits[spell_id].update(kit_animkits.get(k, ()))
                for sk in kit_soundkits.get(k, ()):
                    for f in soundkit_files.get(sk, ()):
                        spell_sounds[spell_id].add((sk, f))

    # --- file names from the listfile ---------------------------------------
    referenced_fids = set()
    for fids in spell_models.values():
        referenced_fids.update(fids)
    for pairs in spell_sounds.values():
        referenced_fids.update(f for _, f in pairs)

    log(f"Resolving {len(referenced_fids):,} referenced file ids against the listfile ...")
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
            if fid in referenced_fids:
                fid_path[fid] = path.strip()
    unnamed = len(referenced_fids) - len(fid_path)

    # --- assemble the pack ---------------------------------------------------
    log("Assembling pack ...")
    spell_ids = sorted(spell_names)
    spells = {
        "ids": spell_ids,
        "names": [spell_names[s] for s in spell_ids],
        "subtexts": [subtexts.get(s, "") for s in spell_ids],
    }

    file_ids = sorted(referenced_fids)
    files = {
        "fids": file_ids,
        "paths": [fid_path.get(f, "") for f in file_ids],
    }

    model_rows = sorted((s, f) for s, fids in spell_models.items() for f in fids)
    sound_rows = sorted((s, sk, f) for s, pairs in spell_sounds.items() for sk, f in pairs)
    anim_rows = sorted((s, a) for s, aks in spell_animkits.items() for a in aks)

    # only animkits that spells actually use
    used_animkits = {a for aks in spell_animkits.values() for a in aks}
    kit_anim_rows = sorted(
        (k, a) for k, anims in animkit_anims.items() if k in used_animkits for a in anims)
    effect_rows = sorted((s, e) for s, effs in spell_effects.items() for e in effs)
    with open(EFFECT_NAMES_FILE, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        next(reader)  # header
        effect_names = {row[0]: row[1] for row in reader}

    pack = {
        "meta": {
            "format": 2,
            "version": version,
            "label": label,
            "built": time.strftime("%Y-%m-%d"),
            "listfileTag": (CACHE_DIR / "listfile" / "release-tag.txt").read_text().strip()
            if (CACHE_DIR / "listfile" / "release-tag.txt").exists() else "",
            "counts": {
                "spells": len(spell_ids),
                "files": len(file_ids),
                "spellModels": len(model_rows),
                "spellSounds": len(sound_rows),
                "spellAnimKits": len(anim_rows),
                "animKitAnims": len(kit_anim_rows),
                "spellEffects": len(effect_rows),
            },
        },
        "spells": spells,
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
    }

    log(
        f"  spells={len(spell_ids):,}  files={len(file_ids):,} ({unnamed:,} unnamed)  "
        f"models={len(model_rows):,}  sounds={len(sound_rows):,}  animkits={len(anim_rows):,}  "
        f"kitAnims={len(kit_anim_rows):,}  effects={len(effect_rows):,}  "
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

    # update the version manifest
    manifest_path = DATA_DIR / "versions.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else []
    entry = {
        "id": version,
        "label": label,
        "file": f"data/{version}/spelldata.json.gz",
        "built": pack["meta"]["built"],
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
    table_dir, listfile = fetch_sources(args.version, args.refresh)
    pack = build_pack(args.version, label, table_dir, listfile)
    write_pack(pack, args.version, label)


if __name__ == "__main__":
    main()
