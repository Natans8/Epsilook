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
    "SpellMisc",
    "SpellChainEffects",
    "SpellProceduralEffect",
    "BeamEffect",
    "CreatureDisplayInfo",
    "CreatureModelData",
]

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


def fetch_sources(version: str, refresh: bool) -> tuple[Path, Path]:
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
    # transform auras the misc value is the CreatureDisplayID to morph into.
    spell_effects: dict[int, set[int]] = defaultdict(set)
    spell_auras: dict[int, set[int]] = defaultdict(set)
    spell_morphs: dict[int, set[int]] = defaultdict(set)  # spell -> display ids
    for spell_id, effect, aura, misc0 in read_table(
        table_dir, "SpellEffect", ["SpellID", "Effect", "EffectAura", "EffectMiscValue_0"]
    ):
        s, e, a = to_int(spell_id), to_int(effect), to_int(aura)
        if s not in spell_names:
            continue
        if e:
            spell_effects[s].add(e)
        if a:
            spell_auras[s].add(a)
        if a == AURA_TRANSFORM:
            display_id = int(float(misc0)) if misc0 else 0
            if display_id > 0:
                spell_morphs[s].add(display_id)

    # display id -> model file id (CreatureDisplayInfo -> CreatureModelData);
    # old spells reference display ids long since removed from the client —
    # those keep fid 0 and show as a bare "#id" pill
    model_fid: dict[int, int] = {}
    for mid, fid in read_table(table_dir, "CreatureModelData", ["ID", "FileDataID"]):
        model_fid[to_int(mid)] = to_int(fid)
    morph_fid: dict[int, int] = {}
    used_morphs = {m for morphs in spell_morphs.values() for m in morphs}
    for did, mid in read_table(table_dir, "CreatureDisplayInfo", ["ID", "ModelID"]):
        d = to_int(did)
        if d in used_morphs:
            morph_fid[d] = model_fid.get(to_int(mid), 0)

    # spell -> icon file id (SpellMisc; prefer the base-difficulty row)
    spell_icon_fid: dict[int, int] = {}
    for spell_id, diff, icon_fid in read_table(
        table_dir, "SpellMisc", ["SpellID", "DifficultyID", "SpellIconFileDataID"]
    ):
        s, d, f = to_int(spell_id), to_int(diff), to_int(icon_fid)
        if s in spell_names and f and (s not in spell_icon_fid or d == 0):
            spell_icon_fid[s] = f

    # --- walk the chains per spell ------------------------------------------
    log("Walking spell -> model/sound/animkit/chain chains ...")
    spell_models: dict[int, set[int]] = defaultdict(set)          # spell -> model fids
    spell_sounds: dict[int, set[tuple[int, int]]] = defaultdict(set)  # spell -> (soundkit, fid)
    spell_animkits: dict[int, set[int]] = defaultdict(set)        # spell -> animkit ids
    spell_chains: dict[int, set[int]] = defaultdict(set)          # spell -> chain effect ids
    orphan_spells = 0  # SpellXSpellVisual rows whose SpellID has no SpellName entry

    for spell_id, visuals in spell_visuals.items():
        if spell_id not in spell_names:
            orphan_spells += 1
            continue
        for v in visuals:
            for k in visual_kits.get(v, ()):
                spell_models[spell_id].update(kit_models.get(k, ()))
                spell_animkits[spell_id].update(kit_animkits.get(k, ()))
                spell_chains[spell_id].update(kit_chains.get(k, ()))
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

    referenced_fids = set()
    for fids in spell_models.values():
        referenced_fids.update(fids)
    for pairs in spell_sounds.values():
        referenced_fids.update(f for _, f in pairs)
    for c in used_chains:
        referenced_fids.update(chain_rows[c][4])
    referenced_fids.update(f for f in morph_fid.values() if f)

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

    # only animkits that spells actually use
    used_animkits = {a for aks in spell_animkits.values() for a in aks}
    kit_anim_rows = sorted(
        (k, a) for k, anims in animkit_anims.items() if k in used_animkits for a in anims)
    effect_rows = sorted((s, e) for s, effs in spell_effects.items() for e in effs)
    aura_rows = sorted((s, a) for s, auras in spell_auras.items() for a in auras)
    morph_rows = sorted((s, m) for s, morphs in spell_morphs.items() for m in morphs)
    morph_display_ids = sorted(used_morphs)
    effect_names = read_enum_names("SpellEffect", version)
    aura_names = read_enum_names("SpellEffectAura", version)

    pack = {
        "meta": {
            "format": 5,
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
                "spellAuras": len(aura_rows),
                "spellFx": len(fx_rows),
                "spellMorphs": len(morph_rows),
                "morphs": len(morph_display_ids),
                "fxChains": len(fx_chain_ids),
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
        # morphs: transform auras' CreatureDisplayIDs; each resolves to a
        # creature model file (fid 0 = display removed from this build)
        "spellMorphs": {
            "spellIds": [r[0] for r in morph_rows],
            "displayIds": [r[1] for r in morph_rows],
        },
        "morphs": {
            "displayIds": morph_display_ids,
            "fids": [morph_fid.get(m, 0) for m in morph_display_ids],
        },
    }

    log(
        f"  spells={len(spell_ids):,}  files={len(file_ids):,} ({unnamed:,} unnamed)  "
        f"models={len(model_rows):,}  sounds={len(sound_rows):,}  animkits={len(anim_rows):,}  "
        f"kitAnims={len(kit_anim_rows):,}  effects={len(effect_rows):,}  auras={len(aura_rows):,}  fx={len(fx_rows):,}  "
        f"fxChains={len(fx_chain_ids):,}  morphs={len(morph_rows):,}  icons={len(icon_names):,}  "
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
