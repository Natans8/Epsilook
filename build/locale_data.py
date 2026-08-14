#!/usr/bin/env python3
"""BUILD A LANGUAGE PACK: translated strings as a sparse overlay on one pack.

A language pack is an ADD-ON, not a second pack: it carries only the
user-facing strings of an existing version pack, re-read in another game
locale, and only where the translation actually differs from the English the
base pack ships. The app (once wired) loads it after the base pack and joins
by id; a spell, area or creature absent from the overlay simply keeps its
English string. Nothing else is duplicated — no ids the base does not have,
no visuals, no numbers.

WHAT IS COVERED — every string in the base pack that the game itself
localizes:

    spells.names / subtexts / altNames    wago `_lang` columns (`&locale=`)
    spellText descriptions/auras/notes    cooked from the locale's templates
    areas / items / mounts / shapeshifts  wago `_lang` columns
    morph + summon creature names         TDB `creature_template_locale`
    gameobject names                      TDB `gameobject_template_locale`

Deliberately NOT covered: asset file paths (never localized by the client),
sound-kit / missile-motion / boneset names (developer identifiers), enum-name
vocabularies (effect / aura / target words are the app's search language),
and the app's own labels — those are UI, not data.

Descriptions are cooked by build/spelltext.py exactly as the base pack's are,
from the locale's own templates, with a TextLocale supplying the wording the
cooker itself contributes (duration units, plural-form picking — Russian
declension markers carry three forms where English carries two).

Sources per locale per version: the same wago CSV route with `&locale=`
appended (all builds serve all locales — no per-version drift), and the TDB
world dump already cached for the base pack, from which the `*_locale`
tables are distilled on first use. Numeric tables are re-read from the base
pack's own cache; the base pack itself supplies the English strings the
overlay diffs against, so a rebuilt base wants its overlays rebuilt after it.

Usage:
    python build/locale_data.py --version 9.2.7.45745 --locale ruRU
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_data import (AURA_OVERRIDE_NAME, DATA_DIR, PACK_FORMAT,
                        read_description_templates, read_description_variables,
                        read_encounter_notes, read_spell_names, read_spell_values,
                        read_table, to_int)
from pack.drift import OPTIONAL_TABLES
from pack.progress import log
from pack.sources.cache import CACHE_DIR, download
from pack.sources.tdb import Distill, tdb_extraction, tdb_release
from pack.sources.wago import WAGO_CSV_URL
from spelltext import ENGLISH, RUSSIAN, DescriptionCooker, TextLocale

# The overlay's own format, independent of the base PACK_FORMAT: the two evolve
# for different reasons (a new base section is only an overlay change when it
# carries localizable text).
LOCALE_FORMAT = 1

# Locale code -> the prose wording the cooker needs for it. Adding a language
# the game ships is one entry here (plus a TextLocale in spelltext.py when its
# plural rules differ from an existing one).
#
# enUS is the locale the base pack itself is read in, so its overlay is empty
# by construction: every string equals the English it is diffed against. It is
# declared so the roster names every locale the app can be asked for rather
# than every locale except the default one, and an empty overlay is the
# machinery's own check — a non-zero count here means the base pack and the
# locale route disagree about the same strings.
LOCALES: dict[str, TextLocale] = {
    "enUS": ENGLISH,
    "ruRU": RUSSIAN,
}

# The wago tables whose `_lang` columns feed the overlay — re-fetched once per
# locale with `&locale=` appended, cached beside the base pack's tables.
# SpellXDescriptionVariables carries no text of its own but is read by the
# same reader as the variable bodies, so it is fetched into the same directory.
LOCALIZED_TABLES = [
    "SpellName",
    "Spell",
    "SpellOverrideName",
    "AreaTable",
    "ItemSearchName",
    "Mount",
    "SpellShapeshiftForm",
    "SpellDescriptionVariables",
    "SpellXDescriptionVariables",
    "JournalEncounterSection",
]

# TDB locale tables: one row per (entry, locale). Distilled from the world
# dump already cached for the base pack — the SQL is re-extracted from the
# kept archive on first use and deleted again.
TDB_LOCALE_TABLES = {
    "creature_template_locale": ["entry", "locale", "Name"],
    "gameobject_template_locale": ["entry", "locale", "name"],
}


def locale_table_dir(version: str, locale: str) -> Path:
    """The locale's table cache, nested in the build's own cache directory
    so the download-cache rotation treats them as one unit."""
    return CACHE_DIR / version / f"locale-{locale}"


def fetch_locale_tables(version: str, locale: str, refresh: bool) -> Path:
    """Ensure the localized wago CSVs are cached; return their directory."""
    loc_dir = locale_table_dir(version, locale)
    log(f"Localized tables (wago.tools, build {version}, locale {locale}):")
    for table in LOCALIZED_TABLES:
        url = WAGO_CSV_URL.format(table=table, version=version) + f"&locale={locale}"
        download(url, loc_dir / f"{table}.csv", refresh,
                 optional=table in OPTIONAL_TABLES)
    return loc_dir


def ensure_tdb_locale_tables(version: str) -> Path | None:
    """Ensure the TDB `*_locale` tables are distilled; return the TDB dir.

    The same source the base pack's own TrinityCore tables come from, asked for
    a different set of tables: they land in the release's one cache directory,
    and are recognised there by their headers — so a column added to
    TDB_LOCALE_TABLES re-distils the releases that were cached without it,
    rather than being silently absent from every overlay built over them.

    Not `required`: a world dump may legitimately predate a locale table, and
    those names then stay as the base pack ships them.

    Returns None when no TDB release maps to this version (the Classic
    re-release packs) — creature and gameobject names then stay untranslated,
    exactly as the base pack ships them as raw ids.
    """
    rel = tdb_release(version)
    if rel is None:
        log("TDB: no release mapped — creature/gameobject names stay English")
        return None
    log(f"TDB locale tables ({rel['tag']}):")
    return tdb_extraction(
        rel, f"TDB locale tables ({rel['tag']})",
        Distill(kinds=("world",), members={"world": rel["world"]},
                want={"world": TDB_LOCALE_TABLES},
                required=frozenset())).acquire(False)


def read_tdb_locale_names(tdb_dir: Path | None, table: str, locale: str) -> dict[int, str]:
    """entry -> translated name, from a distilled `*_locale` table."""
    if tdb_dir is None or not (tdb_dir / f"{table}.csv").exists():
        return {}
    name_col = TDB_LOCALE_TABLES[table][2]
    out: dict[int, str] = {}
    for entry, loc, name in read_table(tdb_dir, table, ["entry", "locale", name_col]):
        name = name.strip()  # a display name, trimmed; the dump itself is not
        if loc == locale and name and name != "NULL":
            out[to_int(entry)] = name
    return out


def read_spell_overrides(table_dir: Path) -> dict[int, list[int]]:
    """spell -> its SpellOverrideName ids (aura 370), from the client effects.

    The mapping is locale-independent — only the override TEXT localizes — so
    it is read from the base pack's own table cache.
    """
    out: dict[int, list[int]] = {}
    for sid, aura, m0 in read_table(
            table_dir, "SpellEffect", ["SpellID", "EffectAura", "EffectMiscValue_0"]):
        if to_int(aura) == AURA_OVERRIDE_NAME and to_int(m0) > 0:
            out.setdefault(to_int(sid), []).append(to_int(m0))
    return out


def load_base_pack(pack_id: str) -> dict:
    """The shipped base pack — the English strings the overlay diffs against."""
    path = DATA_DIR / pack_id / "spelldata.json.gz"
    if not path.exists():
        sys.exit(f"error: no base pack at {path} — build the version pack first")
    raw = path.read_bytes()
    if raw.startswith(b"version https://git-lfs"):
        sys.exit(f"error: {path} is an LFS pointer, not a pack — `git lfs pull` first")
    with gzip.open(io.BytesIO(raw), "rt", encoding="utf-8") as fh:
        return json.load(fh)


def sparse_names(ids: list[int], english: list[str],
                 translated: dict[int, str], full: bool = False) -> dict[str, list]:
    """{ids, names} for the entries whose translation exists and differs.

    Everything else is omitted on purpose: wago serves the English string for
    untranslated rows, so "same as English" and "not translated" are one case,
    and the app's fallback (keep the base string) is right for both.

    `full` drops the comparison and keeps every string the locale has, for an
    overlay that must stand alone rather than annotate the base pack.
    """
    out_ids, out_names = [], []
    for i, en in zip(ids, english):
        tr = translated.get(i, "")
        if tr and (full or tr != en):
            out_ids.append(i)
            out_names.append(tr)
    return {"ids": out_ids, "names": out_names}


def sparse_text_block(base_ids: list[int], english_text: list[str],
                      english_of: list[int], translated: dict[int, str],
                      full: bool = False) -> dict[str, list]:
    """{ids, text, of} for cooked prose that exists and differs from English.

    Same dedup as the base pack's spellText: redirect chains cook many spells
    to one identical string, so `text` pools the distinct strings and `of`
    indexes into it, parallel to `ids`.

    `full` keeps every cooked string, as in sparse_names.
    """
    en_of = dict(zip(base_ids, english_of))
    kept: dict[int, str] = {}
    for s, tr in translated.items():
        if tr and (full or tr != english_text[en_of.get(s, 0)]):
            kept[s] = tr
    out_ids = sorted(kept)
    pool: dict[str, int] = {}
    of = [pool.setdefault(kept[s], len(pool)) for s in out_ids]
    return {"ids": out_ids, "text": list(pool), "of": of}


def build_locale_pack(version: str, pack_id: str, locale: str,
                      text_locale: TextLocale, refresh: bool,
                      full: bool = False) -> dict:
    """Read the localized sources and assemble the overlay dict.

    `full` writes every string the locale has instead of only those differing
    from the base pack's English, for an overlay that is the sole source of
    its strings rather than an annotation on the base.
    """
    t0 = time.time()
    table_dir = CACHE_DIR / version
    if not (table_dir / "Spell.csv").exists():
        sys.exit(f"error: no table cache at {table_dir} — build the version pack first")
    base = load_base_pack(pack_id)
    loc_dir = fetch_locale_tables(version, locale, refresh)
    tdb_dir = ensure_tdb_locale_tables(version)

    base_ids: list[int] = base["spells"]["ids"]
    id_set = set(base_ids)

    # --- spell names / subtexts / alt names --------------------------------
    log("Reading localized spell names ...")
    loc_names, loc_subtexts = read_spell_names(loc_dir, None)
    spell_names = sparse_names(base_ids, base["spells"]["names"], loc_names, full)
    spell_subtexts = sparse_names(base_ids, base["spells"]["subtexts"], loc_subtexts, full)

    override_names = {to_int(oid): name for oid, name in read_table(
        loc_dir, "SpellOverrideName", ["ID", "OverrideName_lang"])}
    loc_altnames = {
        s: text for s, ids in read_spell_overrides(table_dir).items()
        if (text := " ".join(w for i in sorted(set(ids))
                             if (w := override_names.get(i, ""))))
    }
    spell_altnames = sparse_names(base_ids, base["spells"]["altNames"], loc_altnames, full)

    # --- cooked prose ------------------------------------------------------
    # The templates, the named-variable bodies and the spell names spliced in
    # by $@spellname are the locale's own; every numeric lookup reads the base
    # pack's cache (values do not localize).
    log("Cooking localized spell descriptions ...")
    raw_descriptions, raw_aura_descriptions = read_description_templates(loc_dir)
    cook_names = dict(zip(base_ids, base["spells"]["names"])) | loc_names
    cooker = DescriptionCooker(raw_descriptions, raw_aura_descriptions, cook_names,
                               read_spell_values(table_dir),
                               read_description_variables(loc_dir),
                               locale=text_locale)
    loc_descriptions = {
        s: cooked for s, template in raw_descriptions.items()
        if s in id_set and (cooked := cooker.cook(s, template))
    }
    loc_auras = {
        s: cooked for s, template in raw_aura_descriptions.items()
        if s in id_set and (cooked := cooker.cook(s, template))
    }
    loc_notes = {
        s: cooked for s, template in read_encounter_notes(loc_dir).items()
        if s in id_set and (cooked := cooker.cook(s, template))
    }
    bt = base["spellText"]
    spell_text = {
        "descriptions": sparse_text_block(
            base_ids, bt["descriptions"]["text"], bt["descriptions"]["of"],
            loc_descriptions, full),
        "auras": sparse_text_block(
            base_ids, bt["auras"]["text"], bt["auras"]["of"], loc_auras, full),
        "encounters": sparse_text_block(
            base_ids, bt["encounters"]["text"], bt["encounters"]["of"], loc_notes, full),
    }

    # --- the id-keyed name payloads ----------------------------------------
    log("Reading localized payload names ...")
    loc_areas = {to_int(a): name for a, name in read_table(
        loc_dir, "AreaTable", ["ID", "AreaName_lang"])}
    area_names = sparse_names(base["areas"]["ids"], base["areas"]["names"], loc_areas, full)

    loc_items = {to_int(i): name for i, name in read_table(
        loc_dir, "ItemSearchName", ["ID", "Display_lang"]) if name}
    item_names = sparse_names(base["items"]["ids"], base["items"]["names"], loc_items, full)

    # mount names key on the DISPLAY id, like the base section: the (locale-
    # independent) MountXDisplay hop is re-read from the base pack's cache,
    # first Mount row to name a display wins, as in read_mounts
    mount_displays: dict[int, list[int]] = {}
    for cdi, mid in read_table(
            table_dir, "MountXDisplay", ["CreatureDisplayInfoID", "MountID"]):
        mount_displays.setdefault(to_int(mid), []).append(to_int(cdi))
    loc_mounts: dict[int, str] = {}
    for mid, name, src in read_table(
            loc_dir, "Mount", ["ID", "Name_lang", "SourceSpellID"]):
        if to_int(src) in id_set and name:
            for did in mount_displays.get(to_int(mid), ()):
                loc_mounts.setdefault(did, name.strip())
    mounts = base["mounts"]
    mount_names = sparse_names(mounts["displayIds"], mounts["names"], loc_mounts, full)
    mount_names = {"displayIds": mount_names["ids"], "names": mount_names["names"]}

    loc_forms = {to_int(f): name for f, name in read_table(
        loc_dir, "SpellShapeshiftForm", ["ID", "Name_lang"])}
    shapeshift_names = sparse_names(
        base["shapeshifts"]["ids"], base["shapeshifts"]["names"], loc_forms, full)

    # --- TDB names: creatures (morphs + summons share them) and objects ----
    loc_creatures = read_tdb_locale_names(tdb_dir, "creature_template_locale", locale)
    base_creatures = dict(zip(base["morphs"]["creatureIds"], base["morphs"]["names"]))
    base_creatures.update(zip(base["summons"]["creatureIds"], base["summons"]["names"]))
    creature_ids = sorted(base_creatures)
    creature_names = sparse_names(
        creature_ids, [base_creatures[c] for c in creature_ids], loc_creatures, full)

    loc_objects = read_tdb_locale_names(tdb_dir, "gameobject_template_locale", locale)
    object_names = sparse_names(
        base["objects"]["ids"], base["objects"]["names"], loc_objects, full)

    counts = {
        "spellNames": len(spell_names["ids"]),
        "spellSubtexts": len(spell_subtexts["ids"]),
        "spellAltNames": len(spell_altnames["ids"]),
        "spellText.descriptions": len(spell_text["descriptions"]["ids"]),
        "spellText.auras": len(spell_text["auras"]["ids"]),
        "spellText.encounters": len(spell_text["encounters"]["ids"]),
        "areaNames": len(area_names["ids"]),
        "itemNames": len(item_names["ids"]),
        "mountNames": len(mount_names["displayIds"]),
        "shapeshiftNames": len(shapeshift_names["ids"]),
        "creatureNames": len(creature_names["ids"]),
        "objectNames": len(object_names["ids"]),
    }
    pack = {
        "meta": {
            "format": PACK_FORMAT,
            "localeFormat": LOCALE_FORMAT,
            "locale": locale,
            "sparse": not full,
            "base": pack_id,
            "built": date.today().isoformat(),
            "counts": counts,
        },
        "spellNames": spell_names,
        "spellSubtexts": spell_subtexts,
        "spellAltNames": spell_altnames,
        "spellText": spell_text,
        "areaNames": area_names,
        "itemNames": item_names,
        "mountNames": mount_names,
        "shapeshiftNames": shapeshift_names,
        "creatureNames": creature_names,
        "objectNames": object_names,
    }

    log("  " + "  ".join(f"{k}={v:,}" for k, v in counts.items())
        + f"  [{time.time() - t0:.1f}s]")
    return pack


def write_locale_pack(pack: dict, pack_id: str, locale: str) -> None:
    """Write the gzipped overlay beside the base pack it belongs to."""
    out_path = DATA_DIR / pack_id / f"spelldata.{locale}.json.gz"
    raw = json.dumps(pack, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    # mtime=0 keeps rebuilds byte-identical when the data hasn't changed
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(raw)
    out_path.write_bytes(buf.getvalue())
    pack_hash = hashlib.sha256(buf.getvalue()).hexdigest()[:10]
    log(f"Wrote {out_path}  ({len(raw):,} raw -> {out_path.stat().st_size:,} gzipped, "
        f"hash {pack_hash})")


def main() -> None:
    """Fetch the localized sources for one pack, build its overlay, write it."""
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", required=True, help="game build, e.g. 9.2.7.45745")
    ap.add_argument("--locale", required=True, choices=sorted(LOCALES),
                    help="game locale code")
    ap.add_argument("--id", help="pack identity the overlay attaches to "
                                 "(default: the version)")
    ap.add_argument("--refresh", action="store_true",
                    help="re-download localized sources even if cached")
    ap.add_argument("--full", action="store_true",
                    help="write every string the locale has, not only those "
                         "differing from the base pack's English")
    args = ap.parse_args()

    pack_id = args.id or args.version
    pack = build_locale_pack(args.version, pack_id, args.locale,
                             LOCALES[args.locale], args.refresh, args.full)
    write_locale_pack(pack, pack_id, args.locale)


if __name__ == "__main__":
    main()
