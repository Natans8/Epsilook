# Epsilook

Spell · model · sound search for [Epsilon WoW](https://epsilonwow.net/).

**Live at [natans8.github.io/Epsilook](https://natans8.github.io/Epsilook/).**

Search World of Warcraft spells by name, spell ID, model file, sound file, SoundKit,
AnimKit, animation or visual effect (chain/beam effects searchable by texture and
tint color, dissolves by texture, glows, ghost effects and model tints by color,
desaturation and transparency by percent, freezes and camouflage by word,
full-screen effects by name or color, morphs
by NPC name, model name, creature ID or display ID, summons by NPC name or
creature ID) —
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
- Field tags narrow a term to one field: `name:` `model:` `sound:` `anim:`
  `fx:` `mech:` `id:` — type the prefix or click a field button.
  `sound:` and `anim:` also take an exact SoundKit / AnimKit ID
  (`sound:86835`, `anim:13839`; the old `soundkit:`/`animkit:` prefixes
  still work as aliases). Tags combine with AND: `model:missile name:fire`
  finds fire-named spells that use a missile model. Exception: several
  `id:` tags combine with OR — two `id:` tags could never both match one
  spell (several kit IDs inside *one* `sound:`/`anim:` tag also OR).
- `fx:` searches the Effects column — chain/beam effects by category word
  (`fx:chain`), texture name (`fx:shadowlaser`) or tint color (`fx:chain red`,
  or by hex: `fx:#00b4ff`; the dot on a chain tag shows the chain's RGB
  tint), dissolve/materialize effects by texture (`fx:"dissolve arcane"`),
  glow and ghost effects and model tints by color word or hex
  (`fx:"glow red"`, `fx:"tint green"`, `fx:ghost` — color-only effects
  shown as a swatch + hex code), model desaturation and transparency by
  percent (`fx:"transparency 50%"`), freeze and camouflage effects by word
  (`fx:freeze`, `fx:camo`), full-screen effects (the screen tinting or
  overlaying while an aura holds) by internal name, color word or hex
  (`fx:"screen hex"`, `fx:"screen green"`), and morphs (transform
  auras) by NPC name, model name, creature ID or display ID
  (`fx:"morph sheep"`). Morph tags show the model name
  and copy the display ID, a ready `.morph <displayID>` command, and a
  `.lookup display creature <model file>` command; the Wowhead icon opens
  the morph in Wowhead's 3D model viewer. Summoned creatures search by NPC
  name, creature ID or control type (`fx:"summon argi"`, `fx:"summon 88807"`,
  `fx:"summon guardian"`); summon tags show the NPC name with how the summon
  is controlled (guardian/pet/vehicle/… — click the control word to find all
  summons of that type) and copy the creature ID, a ready
  `.lookup creature <name>` and a `.npc spawn <creatureID>` command; the
  Wowhead icon opens the NPC's Wowhead page.
- `mech:` searches the Mechanics column — what a spell *does*: spell effect
  names (`mech:resurrect`, `mech:school_damage`) and aura names for
  aura-applying spells (`mech:mod_stun`, `mech:periodic_damage`).
- The Models column groups each model by how the spell uses it — `attached`
  (to the caster/target), `missile` (projectile), `area` (ground
  model), `trail` (weapon trail), `barrage` (volley) — and `model:` matches
  those words too: `model:missile` finds every spell with a projectile model
  (category heads are clickable, like the Effects ones). Category words
  autocomplete while typing inside an `fx:`/`model:` tag, and a tag naming
  a category exactly floats that category's spells to the top of the results.
- A `-` prefix excludes instead: `name:nova -mech:school_damage`.
- The whole bar selects like plain text — mouse, Ctrl+A, or Shift+arrows — and
  Ctrl+C copies the selection as query text (`model:book note anim:read`), ready
  to paste back into any Epsilook search bar.
- Click any tag in the results to search for it (Shift-click to exclude it) —
  including an Effects category label ("chain", "glow", …), which finds every
  spell with that kind of effect. The current search — "Only spells with"
  filters included — always lives in the URL; the 🔗 Share button copies it.
- The multi-value columns (Models, Sounds, Animations, Effects, Mechanics)
  sort by how many entries a spell has — click the header; the first click
  puts the most extreme spells on top.
- Appending `&export=json` or `&export=csv` to a shared URL downloads the
  query's results directly on page load (same content as the Export buttons;
  hidden columns are excluded either way).
- The ▶ on a sound file plays it in the browser (click again to stop).
- The `3d` on a model tag opens the model in the community
  [WoW.tools model viewer](https://wowtools.work/mv/) in a new tab.
- Hovering a chain, dissolve or screen texture tag shows the texture itself
  in a floating preview (fetched on demand, nothing is preloaded). Chain
  previews are shown with the chain's tint applied — the color the beam
  actually has in game; screen overlays stay untinted (in game their colors
  grade the world, not the overlay image). Hovering any color swatch shows
  a large patch of the color with its hex and hue word.

## Development

```
docs/                  the site (GitHub Pages serves this folder)
  js/config.js         copy-command templates and UI tunables
  js/search.js         query parser + search field registry
  js/data.js           pack loading + in-memory index building
  js/app.js            UI wiring
  js/bufo.js           vendored: byte-buffer reader (Kruithne/node-bufo, MIT)
  js/js-blp.js         vendored: BLP texture decoder (Kruithne/js-blp, MIT)
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
export), the community listfile from
[wowdev/wow-listfile](https://github.com/wowdev/wow-listfile), and the
[TrinityCore TDB](https://github.com/TrinityCore/TrinityCore/releases) matching
the build (server-side creature data for morphs and summons, plus Blizzard's post-ship
hotfix rows, which override the wago rows). It walks the
spell → visual → model/sound/animkit/chain-effect chains, resolves effect and
aura enum names from [WoWDBDefs](https://github.com/wowdev/WoWDBDefs)
`meta/enums`, and writes
`docs/data/<version>/spelldata.json.gz` plus the `versions.json` manifest.
Downloads are cached under `build/cache/`; pass `--refresh` to re-download the
wago/listfile sources. Extracting the TDB archive (a one-time step per version)
needs [7-Zip](https://www.7-zip.org/) on the PATH or in Program Files.

**Adding another game version** is the same command with a different `--version`
(any build listed on wago.tools). For morph/summon names and hotfixes to resolve, also map
the version to its TDB release in `TDB_RELEASES` at the top of `build_data.py`
(without it the build still succeeds, minus that data). The version dropdown
appears automatically once more than one pack exists.

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
- Server-side data (creature names/displays for morphs and summons) and post-ship hotfix
  rows: [TrinityCore TDB](https://github.com/TrinityCore/TrinityCore/releases)
  for the same build
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
- Texture hover previews: hovering a beam/dissolve texture tag fetches the raw
  `.blp` from [wago.tools](https://wago.tools)' CASC API (pinned to the pack's
  build via `?version=`) and decodes it in the browser with the vendored
  [js-blp](https://github.com/Kruithne/js-blp) library — the same decoder
  wago.tools' own file viewer uses. Fetched only on hover, cached for the
  session. `texturePreviewUrl` / `texturePreviewMax` in `docs/js/config.js`
  tune or disable it.
