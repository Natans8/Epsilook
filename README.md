# Epsilook

Spell · model · sound search for [Epsilon WoW](https://epsilonwow.net/).

Search World of Warcraft spells by name, spell ID, model file, sound file, SoundKit,
AnimKit or animation — with clickable cross-references, spell effect info, and one-click
copying of Epsilon commands (`.cast`, `.aura`, `.learn`, `.lookup spell id`,
`.lookup object <model>`, `.lookup emote <anim>`, `.modify animkit <id>`, and more).

The app is a fully static site: all data is baked into one compressed pack per game
version and every search runs in the browser. No server, no database, no dependencies.

## Using it

Open the hosted page, type into the search bar. Details are in the `?` popover:

- Words match **any part of a name, in any order** — `6dr statue` finds
  `6dr_draenei_statue_male01.m2`.
- The tabs (All / Name / Model / Sound / SoundKit / AnimKit / Spell ID) choose what your
  words match against.
- Field prefixes combine filters: `model:missile name:fire` finds fire-named spells that
  use a missile model.
- Click any tag in the results to search for it; the current search always lives in the
  URL, so copying the address shares the exact result page.

## Development

```
docs/                  the site (GitHub Pages serves this folder)
  js/config.js         copy-command templates and UI tunables
  js/search.js         query parser + search field registry
  js/data.js           pack loading + in-memory index building
  js/app.js            UI wiring
  data/<version>/      one data pack per game version + versions.json manifest
build/build_data.py    regenerates the data packs (Python 3, stdlib only)
```

Serve `docs/` with any static file server, e.g.:

```
cd docs && python -m http.server 8377
```

### Rebuilding the data

```
python build/build_data.py --version 9.2.7.45745 --label "Shadowlands 9.2.7"
```

The script downloads the raw game tables from [wago.tools](https://wago.tools) (CSV
export) and the community listfile from
[wowdev/wow-listfile](https://github.com/wowdev/wow-listfile), walks the
spell → visual → model/sound/animkit chains, and writes
`docs/data/<version>/spelldata.json.gz` plus the `versions.json` manifest.
Downloads are cached under `build/cache/`; pass `--refresh` to re-download.

**Adding another game version** is the same command with a different `--version`
(any build listed on wago.tools). The version dropdown appears automatically once
more than one pack exists.

### Adding a search field

1. If the field needs new data, extend `build_data.py` to emit it and `data.js` to
   index it.
2. Add one entry to `FIELDS` in `docs/js/search.js` (`label`, `placeholder`,
   `run(tokens, data) → Set<spellId>`). It becomes a tab and a query prefix
   automatically.

### Adding a copy command

Edit `docs/js/config.js` — `spellCommands` for per-spell buttons,
`modelCopyTemplate` for the command copied from model tags.

## Data sources

- Game tables: [wago.tools](https://wago.tools) CSV export, build 9.2.7.45745
- File names: [community listfile](https://github.com/wowdev/wow-listfile)
