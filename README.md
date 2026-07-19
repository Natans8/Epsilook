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
**deterministic** — an unchanged rebuild is byte-identical, which makes
"rebuild and diff" the regression test for any change to the script. Pass
`--refresh` to re-download. Extracting the TDB archive (once per version)
needs [7-Zip](https://www.7-zip.org/) on the PATH.

**Adding a game version** is the same command with a different `--version`
(any build wago.tools lists), plus an entry in `TDB_RELEASES` at the top of
`build_data.py` so morph/summon names and hotfixes resolve. The version
dropdown appears by itself once a second pack exists.

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
