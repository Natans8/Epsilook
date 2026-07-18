# Epsilook

Spell · model · sound search for [Epsilon WoW](https://epsilonwow.net/).

**Live at [natans8.github.io/Epsilook](https://natans8.github.io/Epsilook/).**

Search World of Warcraft spells by name, spell ID, model file, sound file, SoundKit,
AnimKit, animation or visual effect (beams searchable by texture and tint color,
morphs by creature model name or display ID) —
with spell icons, clickable cross-references, spell mechanic info, and one-click
copying of Epsilon commands (`.cast`, `.aura`, `.learn`, `.lookup spell id`,
`.lookup object <model>`, `.lookup emote <anim>`, `.modify animkit <id>`, and more).

The app is a fully static site: all data is baked into one compressed pack per game
version and every search runs in the browser. No server, no database, no dependencies.

## Using it

Open the page, type into the search bar. Full syntax is in the `?` dialog:

- Plain words search names, models, sounds, animations and visual effects at once and
  match **any part of a name, in any order** — `6dr statue` finds `6dr_draenei_statue_male01.m2`.
- Quotes make an **exact phrase**: `"fire bolt"` matches those words together, in that order.
- Field tags narrow a term to one field: `name:` `model:` `sound:` `soundkit:`
  `animkit:` `anim:` `fx:` `mech:` `id:` — type the prefix or click a field button.
  Tags combine with AND: `model:missile name:fire` finds fire-named spells that use
  a missile model.
- `fx:` searches the Effects column — beam/chain effects by category word
  (`fx:beam`), texture name (`fx:shadowlaser`) or tint color (`fx:beam red`;
  the dot on a beam tag shows the chain's RGB tint), and morphs (transform
  auras) by creature model name or display ID (`fx:"morph wolf"`). Morph tags
  copy the display ID and a ready `.morph <displayID>` command.
- `mech:` searches the Mechanics column — what a spell *does*: spell effect
  names (`mech:resurrect`, `mech:school_damage`) and aura names for
  aura-applying spells (`mech:mod_stun`, `mech:periodic_damage`).
- A `-` prefix excludes instead: `name:nova -mech:school_damage`.
- The whole bar selects like plain text — mouse, Ctrl+A, or Shift+arrows — and
  Ctrl+C copies the selection as query text (`model:book note anim:read`), ready
  to paste back into any Epsilook search bar.
- Click any tag in the results to search for it (Shift-click to exclude it). The
  current search always lives in the URL — the 🔗 Share button copies it.
- The ▶ on a sound file plays it in the browser (click again to stop).

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
spell → visual → model/sound/animkit/chain-effect chains, resolves effect and
aura enum names from [WoWDBDefs](https://github.com/wowdev/WoWDBDefs)
`meta/enums`, and writes
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
- Enum value names (spell effects, auras): [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) `meta/enums`
- Spell icon images: hotlinked from [Wowhead](https://www.wowhead.com)'s CDN
  (`wow.zamimg.com`), lazy-loaded per visible row; the icon *names* are baked into
  the data pack (SpellMisc table + listfile). `spellIconUrl` in `docs/js/config.js`
  sets the size or disables icons.
- Sound playback: the ▶ on a sound file streams it from the same CDN by
  FileDataID, fetched only when clicked — nothing is preloaded. The CDN serves
  the current retail build, so the rare file removed from the game since the
  pack's version won't play. `soundPlayUrl` / `soundVolume` in
  `docs/js/config.js` tune or disable it.
