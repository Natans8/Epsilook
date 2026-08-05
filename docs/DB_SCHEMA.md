# The exploration database

A cached **development tool**: every table the build downloads, in one queryable DuckDB file. It is not part of the
product — nothing in `site/` reads it, it is never committed (`build/cache/` is gitignored), and deleting it costs only
the two minutes it takes to rebuild.

It exists because `build/build_data.py` is a *pipeline*, not a place to ask questions. Answering "how many spells reach
a screen effect through a kit rather than through an aura" used to mean writing a throwaway script that re-parsed 180 MB
of CSV. Now it is a `SELECT`.

```bash
python -m pip install duckdb
python tools/builddb.py
```

- **[1. Getting connected](#1-getting-connected)**
- **[2. Layout](#2-layout)** — schemas, naming, what lives where
- **[3. The `ref` schema](#3-the-ref-schema)** — universal data + the metadata catalog
- **[4. Views](#4-views)** — the spine, pre-joined
- **[5. Worked queries](#5-worked-queries)**
- **[6. Three things to know before you trust it](#6-three-things-to-know-before-you-trust-it)**
- **[7. Extending it](#7-extending-it)**

---

## 1. Getting connected

The file is `build/cache/epsilook.duckdb`.

**DataGrip / PyCharm Professional** — `+ → Data Source → DuckDB`, point it at the file, let it download the driver. The
bundled driver is JDBC 1.3.1, so the builder pins the file to the **v1.0.0 storage format**; do not remove that pin
(`STORAGE_VERSION` in `tools/builddb.py`) or a newer DuckDB will write a file your IDE cannot open.

> DuckDB allows **one writer at a time**, and a writer blocks readers. Close the IDE connection before rebuilding, or
> the build fails with a lock error.

**Python**

```python
import duckdb

con = duckdb.connect("build/cache/epsilook.duckdb", read_only=True)  # read_only lets others attach too
con.execute("SELECT count(*) FROM v9_2_7.spells").fetchone()
```

**CLI** — `duckdb build/cache/epsilook.duckdb`, then `.schema` / `.tables`.

**The SQL is PostgreSQL-flavoured.** CTEs, window functions, `information_schema` and `GROUP BY`/`HAVING` all behave the
way they do in Postgres. Nothing here needs DuckDB-specific syntax, though `SELECT * EXCLUDE (col)` and `GROUP BY ALL`
are available and save typing on tables this wide.

### Building

```bash
python tools/builddb.py                # everything (~2 min, warm cache)
python tools/builddb.py 9.2.7          # one version, prefix match; leaves the others alone
python tools/builddb.py --list         # what would be built, and from where
python tools/builddb.py --refresh-dbd  # re-fetch the WoWDBDefs schema definitions and enums
```

It reads `build/cache/` **in place** — the same CSVs `build/build_data.py` already downloaded. It never re-downloads
game tables. The only things it fetches are the `.dbd` schema definitions, the enum tables, and the handful of
`EXTRA_TABLES` (§7) the pack does not need.

If a version has no cache directory yet, build it the normal way first: `python tools/rebuild.py 9.2.7`.

---

## 2. Layout

| Schema                | Holds                                              |
|-----------------------|----------------------------------------------------|
| `ref`                 | universal data — one copy, shared by every version |
| `v1_15_8` … `v11_2_7` | one schema per game build, fully isolated          |

A version schema is named for major.minor.patch (`9.2.7.45745` → `v9_2_7`); the build number lives in
`ref.game_build`. Ten schemas, one per pack in the dropdown.

**Naming, and it is load-bearing:**

| Kind                     | Convention                     | Example                         |
|--------------------------|--------------------------------|---------------------------------|
| client db2 table         | PascalCase, singular, verbatim | `v9_2_7."SpellVisualKitEffect"` |
| TrinityCore server table | `tdb_` + the dump's own name   | `v9_2_7.tdb_creature_template`  |
| convenience view         | snake_case, **plural**         | `v9_2_7.spells`                 |

DuckDB compares identifiers **case-insensitively**, so a view named `spell` and the table `Spell` are the same object —
which is exactly why views are plural. `tools/builddb.py` refuses to create a view that would collide with a table
rather than crashing, so adding one later is safe.

Column names are the CSV's **verbatim**, including the array spelling: `EffectMiscValue_0`, `ImplicitTarget_1`,
`Offset_2`. Anything you read in `build_data.py` is spelled the same here, deliberately — a renaming layer would mean
translating every time you cross between the two.

Quote the PascalCase names (`v9_2_7."SpellEffect"`); unquoted identifiers get folded and the table will not be found.

---

## 3. The `ref` schema

### Universal data

| Table                        | Rows      | What it is                                                        |
|------------------------------|-----------|-------------------------------------------------------------------|
| `listfile`                   | 2,204,763 | `fid → path`. The only route from a FileDataID to a filename.     |
| `anim_name`                  | 1,778     | `AnimID → "Stand"`, from `anims.js`.                              |
| `m2_attachment`              | 58        | raw M2 attachment id → name, imported from `build_data.py`.       |
| `vehicle_geo_component_link` | 26        | the client's hardcoded seat-index → attachment table (§3i).       |
| `enum_value`                 | 5,206     | **169 enums** from WoWDBDefs `meta/enums/`, one long table.       |
| `game_build`                 | 10        | the manifest: schema name, build id, label, default flag, TDB tag |

`enum_value` is keyed `(enum_name, value) → name`:

```sql
SELECT name
FROM ref.enum_value
WHERE enum_name = 'SpellEffectAura'
  AND value = 296;
-- SET_VEHICLE_ID
```

All 169 enums are shipped, not just the five the build currently decodes — they are a few hundred KB in total, and the
point of the database is to have the answer before the question.

### Project decodes

Knowledge that lived only as prose, shipped as joinable tables so raw ids are legible without a second window open. Each
cites where it came from:

| Table             | Source                              | What it decodes                                                  |
|-------------------|-------------------------------------|------------------------------------------------------------------|
| `kit_effect_type` | DATA_ROUTES §3a                     | `SpellVisualKitEffect.EffectType` → the table `Effect` points at |
| `proc_type`       | CLAUDE.md *Proc type decode*        | `SpellProceduralEffect.Type` → which `Value_n` is the payload    |
| `target_type`     | DATA_ROUTES §2                      | `SpellVisualEvent.TargetType` → bit, search word, meaning        |
| `spell_attribute` | `build/enums/spell_attributes.json` | all 449 `SpellMisc.Attributes` bits → name, column, mask         |

`spell_attribute` is the one that makes `SpellMisc`'s widest columns readable at all. The flags are packed 32 to a
column across `Attributes_0..N`, so a raw value is unreadable without knowing which column and which bit — `attr_column`
and `mask` are exactly the two things a query needs:

```sql
-- which of the shipped flags does this spell carry?
SELECT a.name, a.label, a.handler
FROM ref.spell_attribute a, v9_2_7."SpellMisc" m
WHERE m."SpellID" = 131041 AND a.handler IS NOT NULL
  AND CASE a.attr_column WHEN 'Attributes_0' THEN m."Attributes_0"
                         WHEN 'Attributes_1' THEN m."Attributes_1"
                         WHEN 'Attributes_5' THEN m."Attributes_5"
                         WHEN 'Attributes_11' THEN m."Attributes_11" END & a.mask <> 0
```

`handler` is non-null on the bits the **pack ships as pills**, and `requires` carries the one intersection rule (bit 160
`AllowActionsDuringChannel` only means anything AND-ed with bit 34 `IsChannelled`). **Builds ship between 14 and 17
`Attributes_N` columns**, so a high bit is simply absent on an older build rather than renumbered — verified by counting
each flag across all ten schemas and getting a clean monotonic rise.

### The metadata catalog

`ref.column_info` — one row per physical column per version, and the answer to "what type is this, what does it point
at, and what does the comment say":

| Column                                                 | Meaning                                                             |
|--------------------------------------------------------|---------------------------------------------------------------------|
| `schema_name`, `build_id`, `table_name`, `column_name` | where the column lives                                              |
| `dbd_column`, `array_index`                            | the WoWDBDefs declaration it matched, and which array element       |
| `dbd_type`, `sql_type`, `width`, `unsigned`            | declared type and the DuckDB type applied                           |
| `is_id`, `is_relation`, `unverified`                   | `$id$` / `$relation$` markers; `?` = guessed, not confirmed         |
| `comment`                                              | the `//` comment — often a column's only documentation anywhere     |
| `fk_table`, `fk_column`                                | the relationship, from `int<Table::Column>`                         |
| `enum_name`                                            | which `ref.enum_value` enum applies (`ENUM_COLUMNS` in the builder) |

`ref.relation` is the FK graph on its own, with a `resolvable` flag saying whether the target is a table we actually
hold — a `.dbd` names plenty we never download, and a relation you cannot join is noise.

`ref.table_info` lists what landed, so `--list` and this document cannot quietly disagree.

---

## 4. Views

Per version. The altitude is deliberate: they cover the **spine** — the joins every question repeats — and stop short of
the payload routes. Reimplementing the six model routes in SQL would be a second copy of the hardest logic in the
project, guaranteed to drift from the one the app ships. **Getting from a spell to its kits is a view; deciding what a
kit means stays in `build_data.py`.**

| View            | Gives you                                                                                             |
|-----------------|-------------------------------------------------------------------------------------------------------|
| `spells`        | `spell_id, name` — resolves the BfA `SpellName`/`Spell` split, so you never check which build         |
| `spell_kits`    | spell → visual → kit, carrying the event's `target_type`/`target_word` and start phase                |
| `kit_effects`   | a kit's effect rows with `EffectType` decoded into the table it points at                             |
| `spell_effects` | an effect row with `Effect`, `EffectAura` and both `ImplicitTarget`s spelled out, plus the spell name |

A view is skipped when its sources are absent, so the older Classic schemas simply have fewer.

---

## 5. Worked queries

**What does this spell do, in words?**

```sql
-- Divine Shield
SELECT effect_index, effect_name, aura_name, misc0, target0_name
FROM v9_2_7.spell_effects
WHERE spell_id = 642;
-- 0  APPLY_AURA  SCHOOL_IMMUNITY  1  TARGET_UNIT_CASTER
```

**Which auras are most common, by name?**

```sql
SELECT aura_name, count(*) n
FROM v9_2_7.spell_effects
WHERE aura_name IS NOT NULL
GROUP BY 1
ORDER BY n DESC LIMIT 10;
```

**What is this file id?**

```sql
SELECT path
FROM ref.listfile
WHERE fid = 3597252;
```

**Compare a table across every version at once** — the thing a single-schema database made painful:

```sql
SELECT 'v9_2_7' AS build, count(*)
FROM v9_2_7."SpellEffect"
UNION ALL
SELECT 'v10_2_7', count(*)
FROM v10_2_7."SpellEffect"
UNION ALL
SELECT 'v11_2_7', count(*)
FROM v11_2_7."SpellEffect";
```

**What points at `SpellVisualEffectName`?** (the catalog earning its keep)

```sql
SELECT from_table, from_column
FROM ref.relation
WHERE schema_name = 'v9_2_7'
  AND to_table = 'SpellVisualEffectName'
  AND resolvable;
```

**What does this undocumented column say about itself?**

```sql
SELECT table_name, column_name, sql_type, comment
FROM ref.column_info
WHERE schema_name = 'v9_2_7'
  AND comment IS NOT NULL
  AND table_name = 'SpellVisualKitEffect';
```

**Which columns are guesses, not confirmed?**

```sql
SELECT table_name, column_name
FROM ref.column_info
WHERE schema_name = 'v9_2_7'
  AND unverified
ORDER BY 1, 2;
```

---

## 6. Three things to know before you trust it

**Relationships are declared, not enforced — and that is not laziness.** Real client data has dangling references:
1,139 of 163,834 `SpellXSpellVisual` rows on 9.2.7 point at a `SpellVisual` the build does not ship. DuckDB's
`FOREIGN KEY` rejects such rows outright, so enforcing the graph would fail the load on data that is simply how the game
is. The relationships live in `ref.relation` instead, where they can be queried and counted. **Adding real FK
constraints will break the build.**

**A declared relationship can still be wrong.** `WoWDBDefs` is community reverse-engineering, and `ref.relation` repeats
whatever it says. Verify before you rely on one — which is cheap now, and cuts both ways: DATA_ROUTES §3h used to call
`LowDefModelAttachID` a FileDataID, and one query showed 36/36 of its values resolve as `SpellVisualKitModelAttach.ID`
against 8/36 as file ids. The `.dbd` was right and the note was wrong. Equally, `ref.column_info.unverified` marks the
columns WoWDBDefs itself is only guessing at.

**Types come from WoWDBDefs, not from inference.** A `.dbd` says `Flags<u32>`, `Gender<u8>`; DuckDB's own inference
makes every integer a `BIGINT`. The builder applies the declaration — on 9.2.7 that is 40 `UTINYINT`, 78 `USMALLINT`, 78
`UINTEGER` and only 42 `BIGINT` columns. Where a declared type does not fit the data, that table falls back to inference
and **says so in the build log**; a silently widened column is schema drift nobody would notice.

---

## 7. Extending it

Everything below is a one-line change. The builder is dynamic on purpose: it sweeps **every CSV present** in a version's
cache directory, so anything `build_data.py` starts downloading appears here with no edit at all.

| To add…                        | Do this                                                                              |
|--------------------------------|--------------------------------------------------------------------------------------|
| a table the pack does not need | add it to `EXTRA_TABLES` in `tools/builddb.py`; it is fetched per version            |
| a table the pack *does* need   | nothing — add it to `build_data.py`'s `TABLES` and the sweep finds it                |
| an enum → column link          | one line in `ENUM_COLUMNS` (the `.dbd` names the enum but never the column using it) |
| a new game version             | nothing — it follows `site/data/versions.json`                                       |
| a convenience view             | one `make_view(...)` call in `build_views`; collisions are refused, not fatal        |
| a project decode as a table    | follow `KIT_EFFECT_TYPES` / `PROC_TYPES` — a literal list plus one `CREATE TABLE`    |

`EXTRA_TABLES` currently adds five tables the pack build never reads: **`SpellVisualKit`** (the kit rows themselves —
`build_data.py` reaches kits through `SpellVisualEvent` and never reads the table, so 6.65% of `SpellVisualKitEffect`
rows point at a kit no event reaches and were invisible), `AnimKit`, `AnimKitConfig`, `SpellVisualKitPicker`, and **
`SpellInterrupts`** (what breaks a cast, an aura or a channel — `InterruptFlags`, `AuraInterruptFlags[2]`,
`ChannelInterruptFlags[2]`, with bit 0 = `Movement`). It is **present on all ten builds** (79,587 spells on 9.2.7;
51,643 break casting on movement) and is the standing candidate for a future route.

**This list is the answer to "our tooling can't answer that".** A question the database cannot reach is one line here,
not a reason to go around the database — see CLAUDE.md, *"a gap in a tool we maintain is a task, not a constraint"*.

**`tools/dbd.py`** is the WoWDBDefs parser, standalone and reusable. It never raises on malformed input: a missing
definition, an unmatched build or an unknown column all degrade to "no metadata", and the column still loads. Losing a
type annotation must never cost you the data.
