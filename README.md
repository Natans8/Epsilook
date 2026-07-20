# Epsilook

Search World of Warcraft spells by **how they look and sound** — then copy the
[Epsilon WoW](https://epsilonwow.net/) command that casts one.

**→ [natans8.github.io/Epsilook](https://natans8.github.io/Epsilook/)**

Wowhead tells you what a spell *does*. Epsilook tells you which model files it
attaches, which sounds it plays, which animation it triggers and which visual
effect it draws — and lets you search by any of those. Type `model:missile
arrow`, `sound:felreaver`, `anim:ArtLoop` or `fx:"chain red"` and get every
spell that matches, with one-click `.cast` / `.aura` / `.lookup` commands.

The whole thing is a static site: one compressed data pack per game version,
every search running in the browser. No server, no database, no build step, no
runtime dependencies. Currently shipping WoW **9.2.7.45745**, ~276k spells.

## Using it

Full syntax lives behind the **?** button in the app. The short version:

- Plain words search names, models, sounds, animations and effects at once,
  matching **any part of a name in any order** — `6dr statue` finds
  `6dr_draenei_statue_male01.m2`. `"quoted words"` are an exact phrase.
- **Field tags** narrow a term to one column: `name:` `model:` `sound:`
  `anim:` `fx:` `mech:` `id:`. Tags AND together; a `-` prefix excludes.
- **Target-type icons** on models, sounds, animations and effects say who the
  content plays on — caster, target, or the target location. A row that plays
  on several shows one icon each. Search them like category words:
  `model:"caster fire"`, `sound:target`, `anim:both`.
- **Click any tag in the results** to search for it (shift-click to exclude).
- The search — filters included — always lives in the URL, so any result set
  is a shareable link. Append `&export=json` or `&export=csv` to download it.
- Pasting an Epsilon command works: `.cast 12345` becomes an `id:` search.

## How it works

```
docs/                    the site — GitHub Pages serves this folder as-is
  index.html             markup + the in-app help dialog
  js/config.js           copy-command templates and UI tunables
  js/data.js             pack loading + in-memory index building
  js/search.js           query parser + the FIELDS registry (one per prefix)
  js/app.js              all UI wiring
  js/types.d.ts          shared type declarations (dev-time only, never served)
  js/{bufo,js-blp}.js    vendored BLP texture decoder (Kruithne, MIT)
  data/<version>/        one gzipped data pack per game version
build/build_data.py      regenerates the packs (Python 3, stdlib only)
```

`build_data.py` walks the game's own tables — spell → visual → kit →
model/sound/animkit/effect — and bakes the result into one column-oriented
JSON pack per version. The browser fetches that pack once, builds its search
indexes in `data.js`, and every query after that is pure in-memory set
intersection. Joins and search logic live in the app, not in SQL.

Serve `docs/` with any static file server:

```
cd docs && python -m http.server 8377
```

Pushing to `main` deploys. Any CSS/JS change needs the `?v=` cache-buster in
`index.html` bumped (7 spots); data packs bust themselves via a content hash
in `versions.json`.

### Rebuilding the data

```
python build/build_data.py --version 9.2.7.45745 --label "Shadowlands 9.2.7"
```

Downloads (and caches under `build/cache/`) the game tables from
[wago.tools](https://wago.tools), the community listfile, and the
[TrinityCore TDB](https://github.com/TrinityCore/TrinityCore/releases) for the
same build; writes `docs/data/<version>/spelldata.json.gz` and updates
`versions.json`. Takes ~15 s once the sources are cached, and is
**deterministic** — apart from the build date in `meta.built`, an unchanged
rebuild is byte-identical, which makes "rebuild and diff" the regression test
for any change to the script. Pass `--refresh` to re-download. Extracting the
TDB archive (once per version) needs [7-Zip](https://www.7-zip.org/) on the
PATH.

**Adding a game version** is the same command with a different `--version`
(any build wago.tools lists). Add an entry in `TDB_RELEASES` at the top of
`build_data.py` if TrinityCore publishes a matching world DB, so morph/summon
names and hotfixes resolve — it is optional (no TDB exists for the Classic
re-release clients, and those sections simply fall back to raw ids). Shipped
packs: Vanilla Classic 1.15.8, TBC Classic 2.5.6, WotLK Classic 3.4.3, Legion
7.3.5, Battle for Azeroth 8.3.7, Shadowlands 9.2.7 (default), Dragonflight
10.2.7 and The War Within 11.2.7.

Two flags control how a pack is presented:

- `--hidden` — reachable **only** through an explicit `?v=` in the URL: left
  out of the dropdown and never the default, so nobody downloads it unless
  they ask for it by name. Useful for staging a build before publishing it.
- `--default` — the pack served when the URL names no version (marking one
  entry clears the flag on the others). Without it the newest visible pack
  wins, which is not always what you want: Epsilook ships **Shadowlands 9.2.7**
  as the default even though newer packs exist.

Both live in `versions.json`, so changing them means rebuilding that version
with the flag — e.g. `--version 9.2.7.45745 --label "Shadowlands 9.2.7"
--default`. The version dropdown appears once two or more visible packs exist,
with the active expansion's logo beside it (`expansionLogos` in `config.js`,
decoded from the game's own `.blp`).

**Older versions** work too, and mostly differ by what does not exist yet: db2
tables get introduced, split and renamed as the game evolves. Rather than
branch per version, the differences are declared in one block near the top of
`build_data.py`:

| declaration | meaning |
| --- | --- |
| `OPTIONAL_TABLES` | the table postdates the build — its pack section comes out empty and the feature switches off |
| `OPTIONAL_COLUMNS` | the column postdates the build — a declared default stands in |
| `SPELL_NAME_SOURCES` | the data moved between tables (spell names live on `Spell` before BfA) |
| `TDB_OPTIONAL_TABLES` / `TDB_OPTIONAL_COLUMNS` / `CREATURE_DISPLAY_SOURCES` | the same three kinds of drift on the TrinityCore side |
| `array_columns()` | an `X_0..X_n` array field exported as a bare `X` in a later build |

Anything *not* declared there is still a hard error — an unexpected schema
change must fail the build rather than silently lose data. So adding a version
is: run it, read what it says is missing, and decide per item whether it
belongs in the table above or is a real bug. The build logs the absent tables
and the feature each one costs, and bakes the list into `meta.absentTables`.

### Extending it

- **A new search field**: emit the data in `build_data.py`, index it in
  `data.js`, then add one entry to `FIELDS` in `search.js` — it becomes a
  query prefix and a field button automatically.
- **A new copy command**: `spellCommands` in `config.js` for per-spell
  buttons; the `*CopyTemplate` entries for the ones on tags.

### Checking your changes

Neither check is required to run the app — both are dev-time only:

```
npx -p typescript tsc -p docs/jsconfig.json    # JS: every file is // @ts-check'd
python -m mypy build/build_data.py             # Python: fully annotated
```

## Data sources

| What | Where from |
| --- | --- |
| Client db2 tables | [wago.tools](https://wago.tools) CSV export, pinned to the pack's build |
| Creature names/displays, post-ship hotfixes | [TrinityCore TDB](https://github.com/TrinityCore/TrinityCore/releases) for the same build |
| File names | [community listfile](https://github.com/wowdev/wow-listfile) |
| Enum value names | [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) `meta/enums` |
| Table semantics | [wowdev.wiki](https://wowdev.wiki) |

Three things are fetched live by the browser, always on explicit user action
(a hover or a click) and never preloaded or bulk-downloaded: spell **icons**
and **sound files** hotlink from Wowhead's CDN, and **texture previews** pull
the raw `.blp` from wago.tools' CASC API and decode it in-page with the
vendored [js-blp](https://github.com/Kruithne/js-blp). Each can be tuned or
disabled in `docs/js/config.js`.

Epsilook is a fan tool, not affiliated with Blizzard, Wowhead or Epsilon.
World of Warcraft and its data are property of Blizzard Entertainment.
