# Epsilook

Spell · model · sound search for [Epsilon WoW](https://epsilonwow.net/).

**Live at [natans8.github.io/Epsilook](https://natans8.github.io/Epsilook/).**

Search World of Warcraft spells by name, spell ID, model file, sound file, SoundKit,
AnimKit or animation — with spell icons, clickable cross-references, spell effect info,
and one-click copying of Epsilon commands (`.cast`, `.aura`, `.learn`, `.lookup spell id`,
`.lookup object <model>`, `.lookup emote <anim>`, `.modify animkit <id>`, and more).

The app is a fully static site: all data is baked into one compressed pack per game
version and every search runs in the browser. No server, no database, no dependencies.

## Using it

Open the page, type into the search bar. Full syntax is in the `?` dialog:

- Plain words search names, models, sounds and animations at once and match **any part of a name,
  in any order** — `6dr statue` finds `6dr_draenei_statue_male01.m2`.
- Field tags narrow a term to one field: `name:` `model:` `sound:` `soundkit:`
  `animkit:` `anim:` `effect:` `id:` — type the prefix or click a field button.
  Tags combine with AND: `model:missile name:fire` finds fire-named spells that use
  a missile model.
- A `-` prefix excludes instead: `name:nova -effect:school_damage`.
- Click any tag in the results to search for it (Shift-click to exclude it). The
  current search always lives in the URL — the 🔗 Share button copies it.

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
- Spell icon images: hotlinked from [Wowhead](https://www.wowhead.com)'s CDN
  (`wow.zamimg.com`), lazy-loaded per visible row; the icon *names* are baked into
  the data pack (SpellMisc table + listfile). `spellIconUrl` in `docs/js/config.js`
  sets the size or disables icons.
