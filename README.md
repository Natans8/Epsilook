# Epsilook

Search World of Warcraft spells by **how they look and sound** — then copy the
[Epsilon WoW](https://epsilonwow.net/) command that casts one.

**→ [natans8.github.io/Epsilook](https://natans8.github.io/Epsilook/)**

Wowhead tells you what a spell *does*. Epsilook tells you which model files it attaches, which sounds it plays, which
animation it triggers and which visual effect it draws — and lets you search by any of those. Type `model:missile
arrow`, `sound:felreaver`, `anim:ArtLoop` or `fx:"chain red"` and get every spell that matches, with one-click `.cast` /
`.aura` / `.lookup` commands.

The whole thing is a static site: one compressed data pack per game version, every search running in the browser. No
server, no database, no framework. The app is written in strict TypeScript and bundled into a single file by
[esbuild](https://esbuild.github.io/) — the one build step, run by the deploy workflow, so the repo carries sources and
the site serves one bundle. Currently shipping WoW **9.2.7.45745**, ~276k spells.

## Using it

Full syntax lives behind the **?** button in the app. The short version:

- Plain words search names, models, sounds, animations and effects at once, matching **any part of a name in any
  order** — `6dr statue` finds
  `6dr_draenei_statue_male01.m2`. `"quoted words"` are an exact phrase.
- **Field tags** narrow a term to one column: `name:` `model:` `sound:`
  `anim:` `fx:` `mech:` `id:`. Tags AND together; a `-` prefix excludes.
- **Sound kits carry Blizzard's own name** where the game has one — `sound:frostbolt` finds kits named
  `SPELL_MA_Revamp_Frostbolt_Precast` as well as matching sound file names. About two thirds of kits are named; the rest
  are newer than the last game build that shipped the name list, and show their id and files as before.
- **Target-type icons** on models, sounds, animations, effects and mechanics say who the content plays on — caster,
  target, or the target location. A row that plays on several shows one icon each. Search them like category words:
  `model:"caster fire"`, `sound:target`, `anim:both`, `fx:"chain caster"`. `others` is the narrow one — content the
  caster never sees — and `target` finds it too.
- `mech:` covers what an effect does *and* what it is aimed at, matched on the same effect:
  `mech:"school_damage unit_target_enemy"` finds spells with one effect that is both, not spells that happen to have
  each somewhere.
- Some content has its own category word inside a column — `fx:object` for the GameObject a spell places
  (`fx:"object campfire"`, with `.gobject spawn` and `.lookup object` on the pill), `model:mount` for the mount it puts
  you on (`model:"mount stallion"`, with `.modify mount`), and `anim:replace` for animations it swaps out —
  `Stand → StealthStand`
  (`anim:"replace stealthstand"` finds spells that make you move like a stealthed rogue). `anim:kit` and `anim:loose`
  say where an animation came from: a numbered AnimKit bundle, or the spell's visual kit playing it directly.
- **How a spell is delivered is written under its name** — `1.8 sec cast · 30 sec channel · breaks on move`, or just
  `Instant`. Every spell has one, which is why it is a line rather than a pill.
- **And it is searchable**: `mech:instant` (no cast bar), `mech:casttime` (has one) and `mech:channeled` (held rather
  than cast once). **A spell can be both `casttime` and `channeled`** — 3,148 of them cast first and then channel, like
  Mind Control, so these are not three exclusive buckets. Two spellings to know: the word is `casttime`, not `cast`
  (`on cast` is a spell-link word, so `cast` alone would match most of the game), and `channeled` has one `l`, matching
  Wowhead and the game client.
- **Both of those take a number, in seconds** — the same number the line shows you. `mech:"casttime 2"` is a two-second
  cast, `mech:"casttime >3"` the slow ones, `mech:"channeled <=3"` the short channels, and `mech:"casttime 1.75"` works
  because fractions do. Write them together to ask about both halves at once: `mech:"casttime >8" mech:"channeled >8"`
  is the handful of spells with a long wind-up *and* a long hold. **The line highlights the part you asked about**, so
  on a spell that casts and then channels you can see which half your number matched.
- **A channel with no length has no number to compare** — it answers `mech:channeled` but no bound. For the ones whose
  line reads `unlimited channel`, ask for them by that word: `mech:"channeled unlimited"`, or just `mech:unlimited`. (A
  bare `channel` with no length at all is a smaller, murkier group and has no word of its own.)
- **Some spells are findable only by a flag.** A handful of `SpellMisc` attribute bits are their own chips:
  `anim:pose` holds the character's pose (the Permanent Feign Death and Cosmetic Dead poses — these have no model, sound
  or animation of their own, so before this they could not be found at all), and in Mechanics `mech:unbreakable` (a
  channel that persists while the caster moves and acts), `fx:tracking` (the caster stays facing the target),
  `mech:unhindered` (a channel you can act during) and `mech:debuff` (shows in the red debuff frame). **Only flags
  confirmed to work in Epsilon ship** — roughly half of those tested did not, so the wording describes what the server
  actually does rather than what retail documents.
- **Spells link to each other**, and the Mechanics column shows both directions: `mech:triggers` for what a spell casts,
  ticks, procs or removes, `mech:origin` for what reaches it. Each chip is the other spell — its id copies, its icon
  opens Wowhead, its name filters to that spell's own row, target icons say who the triggering effect is aimed at, and
  the note says how they are joined (`on cast`, `periodically`, `removes`). Search either end by name, by mechanism or
  by exact id: `mech:"triggers fireball"`, `mech:"origin periodically"`, `mech:"triggers 265714"`.
- **Some spells only work in one place**, and the Mechanics column says so under an `only in` head: `mech:location`
  finds every spell with an area gate, `mech:"location suramar"` the ones tied to a named place. This is a real
  restriction rather than a note — Epsilon enforces it on `.cast`, unlike most conditions — so a spell that refuses to
  fire may simply be somewhere else's. Each area links to its zone on Wowhead and copies `.lookup tele <area>` to get
  there, plus a command to open its map. Two areas can share a name and still be different places, so a spell may
  honestly list `Azsuna` twice.
- **A word may be followed by its value**, space-separated, and that is the only value form in the language:
  `model:"attach chest"` (where on the model it plays), `model:"motion parabola"` (the arc a projectile flies),
  `anim:(boneset "upper body")` (which body region moves),
  `mech:"seat >2"` (a numeric comparison), `fx:"scale 50"` (exactly +50%), `model:"count >4"` (`count` is the size of
  the column itself — Models, Sounds and Animations each have one — and a lone `model:>4` is its shorthand). Every one
  of these words autocompletes inside its column. **A value is always the one word that follows** — so a value with a
  space in it goes in quotes, and `boneset head kneel` is the head region *and* a kneel animation. On a number, a plain
  value is the `=` you did not have to type: `scale 50` is `scale =50`, and the sign is yours to keep (`fx:"scale -50"`
  shrinks). The search bar draws the word and its value joined, so you can see where the value ends.
- **`|` means either** — `model:fire|frost`, `fx:chain|dissolve`, with or without spaces around the bar;
  `id:133,116` does the same between numbers.
- The bar **colours what the grammar recognises** and explains it on hover. Nothing is ever marked wrong: anything it
  leaves plain is an ordinary text search, which is exactly what it does.
- **Click any tag in the results** to search for it — shift-click adds it to the search, ctrl-click excludes it.
- **The Columns row is a scale model of the table**: each chip wears its own column's colour and sits where that column
  does. Click one to show or hide the column (hidden ones also drop out of plain-word search and exports), drag it to
  move the column, or use `Alt` + `←` `→` from the keyboard. The layout is remembered per browser and stays out of
  shared links, so a link shows the recipient their own arrangement.
- The search — filters included — always lives in the URL, so any result set is a shareable link. Append `&export=json`
  or `&export=csv` to download it.
- Pasting an Epsilon command works: `.cast 12345` becomes an `id:` search.

## How it works

```
src/                     the app, strict TypeScript — bundled into site/js/app.js by esbuild
  main.ts                the entry point: the app's wiring, stated in one place
  config.ts              copy-command templates and UI tunables
  util.ts                leaf helpers shared by every module (DOM, templates)
  theme.ts               the theme registry -> <html data-theme> + the picker
  data.ts                pack loading + index building; the pack and index types
  pills.ts               the segment library results are built from + the pill-type registry
  pilltypes.ts           one record per kind of content shown and searched
  search.ts              query parser + the FIELDS registry (one per prefix)
  texture.ts             .blp loading + the texture/colour hover previews
  export.ts              the results as CSV, JSON or a Discord code block
  app/                   the UI, one module per subsystem
    state.ts             the mutable UI state every other module reads
    query.ts             chips <-> query text, and THE tokenizer
    bar.ts               the chip search bar: sync, selection, undo
    autocomplete.ts      the suggestion list (field prefixes + category words)
    highlight.ts         bar syntax highlighting (the #qhl backdrop, capsules)
    help.ts              the help dialog's generated half: specimen, legend, vocabulary
    run.ts               running a search: debounce, filters, sort
    render.ts            the results table: rows, cells, the height clamp
    tags.ts              every pill builder (model/sound/anim/fx/mechanic)
    hits.ts              hit-highlighting tests (shared with search selection)
    sound.ts             the ▶ playback
    clipboard.ts         copy + toast
    tooltip.ts           the app's own tooltip panel (every [title] on the page)
    url.ts               the URL as state: read, write, share
    events.ts            event wiring
    boot.ts              startup: load the manifest, activate a pack
  vendor/                vendored BLP decoder (Kruithne, MIT) + hand-written .d.ts
site/                    the site — published to GitHub Pages by .github/workflows/pages.yml
  index.html             markup + the in-app help dialog (its frame and prose; src/app/help.ts fills it)
  404.html               the not-found page Pages serves for any missing path
  .nojekyll              tells GitHub Pages to serve the folder without Jekyll
  css/app.css            every style, themed by the token block at the top
  js/                    BUILD OUTPUT, gitignored: app.js and its sourcemap
  dev/oracle.js          console measurement helpers — a dev tool, never bundled
  data/<version>/        one gzipped data pack per game version
build/                   the pack generator
  build_data.py          regenerates the packs (Python 3, stdlib only)
tools/                   every routine that would otherwise be a thing to remember
  build.mjs              the esbuild build: bundle, dev server, module-graph guard
  check.py               every check, plus the invariants that fail silently
  bump.py                move the ?v= cache-buster (both spots)
  rebuild.py             rebuild packs with their own labels; --verify the build
  verify_live.py         wait for Pages, then check what it actually serves
  verify_site.sh         is this assembled document root actually servable?
  docker_smoke.py        build the image, run it, prove it serves the site
  ide.py                 format + lint through the JetBrains IDEs, routed by owner
  builddb.py             build the exploration database (development tool)
  dossier.py             one spell, every route followed to the leaves
  dbd.py                 parser for WoWDBDefs .dbd schema definitions
  arcanum.py             build/read Arcanum ArcSpell import strings (development tool)
  arcanum_actions.json   the Arcanum action catalogue arcanum.py validates against
docker/                  the self-hosting path — see "Hosting it yourself"
  Dockerfile             the image: esbuild -> a verified document root -> nginx
  Dockerfile.dockerignore  an allowlist of what the image build may see
  nginx.conf             the server block: caching, compression, the 404 page
  compose.yaml           one service, ready to paste into a NAS
docs/                    how it works underneath, in prose
  DATA_ROUTES.md         every data route: sources, the spell->visual->kit graph, the pack layout
  PILLS.md               the pill design guide: anatomy, segment order, how to add one
  DB_SCHEMA.md           the exploration database — a SQL mirror of every table the build downloads
```

Note that `site/` is the published website and `docs/` is documentation, which is the opposite of the usual GitHub
convention. It is possible because Pages builds from `.github/workflows/pages.yml` rather than from a branch folder, so
no repo setting names either directory.

`build_data.py` walks the game's own tables — spell → visual → kit → model/sound/animkit/effect — and bakes the result
into one column-oriented JSON pack per version. The browser fetches that pack once, builds its search indexes in
`data.ts`, and every query after that is pure in-memory set intersection. Joins and search logic live in the app, not in
SQL.

Working on it takes one `npm install` — TypeScript and esbuild are the only dependencies — and then:

```
npm run dev
```

which serves `site/` on port 8378 and rebuilds the bundle on every request, so a reload is always the current source.
`npm run build` writes the bundle to `site/js/` instead, after which any static file server will do
(`cd docs && python -m http.server 8377`).

The packs are stored in [Git LFS](https://git-lfs.com), so a clone needs it installed — without it `site/data`
holds 132-byte pointer files instead of packs and no version will load. `git lfs install && git lfs pull` fixes an
existing clone; `python tools/check.py` says `via LFS pointer` when it is looking at stubs rather than packs.

Pushing to `main` deploys, through `.github/workflows/pages.yml`: it builds the bundle and uploads `site/` — which is
also why the packs can live in LFS at all, since GitHub Pages cannot resolve LFS pointers when it serves a branch
directly. A change to the CSS or to the bundle's sources needs the `?v=` cache-buster in `index.html` bumped (two spots
now: the stylesheet and the bundle); data packs bust themselves via a content hash in `versions.json`.

`python tools/bump.py` does the bumping: it compares against what `origin/main` is actually serving, rewrites both, and
does nothing at all when nothing served has changed or when the string already differs — so it is safe to run every time
rather than only when you remember. `python tools/verify_live.py` waits for Pages to publish and then checks that the
new string really is being served and that every asset and pack resolves.

### Hosting it yourself

GitHub Pages is where the site lives, but nothing about the app depends on it — every fetch is relative, so it runs
under any base path on any static host. The repo ships a container for that case:

```
docker compose -f docker/compose.yaml up -d --build
```

and the app is on `http://<host>:8378/`. Set `EPSILOOK_PORT` to move it. `.github/workflows/docker.yml` publishes the
same image to `ghcr.io/natans8/epsilook` on every push to `main`, for `linux/amd64` and `linux/arm64`, so a NAS can pull
it instead of building:

```
docker compose -f docker/compose.yaml pull
```

The image is a three-stage build: esbuild bundles `src/`, a second stage assembles the document root and runs
`tools/verify_site.sh` over it, and nginx serves the result with `docker/nginx.conf`. Building from a checkout needs the
LFS packs present — the build copies the working tree, so without `git lfs pull` the image would bake ten 130-byte
pointer files in; the verify stage refuses rather than shipping a site where no version loads. The build context is the
repo root even though the `Dockerfile` is not, so a plain `docker build` needs to say so:
`docker build -f docker/Dockerfile -t epsilook .`

`python tools/docker_smoke.py` builds the image, runs it, and checks what a static host that merely returns 200 would
still get wrong: that `index.html` and `versions.json` are never cached while everything they cache-bust is immutable,
that every pack arrives byte-for-byte against its manifest hash, that no pack is transport-gzipped (the app gunzips them
itself), and that the 404 page still finds its stylesheet. CI runs the same script, so a laptop and a runner agree on
what "the image works" means. It is deliberately not part of `tools/check.py`, which has to keep running on a machine
with no Docker installed.

### Rebuilding the data

```
python build/build_data.py --version 9.2.7.45745 --label "Shadowlands 9.2.7"
```

The label and the `--default` flag are arguments, not state, so a rebuild that omits them quietly renames the pack to
its build id and drops the default. `python tools/rebuild.py 9.2.7` reads both back out of `versions.json` and passes
them for you; with no argument it rebuilds every pack, and `--list` prints the commands without running them.

Downloads (and caches under `build/cache/`) the game tables from
[wago.tools](https://wago.tools), the community listfile, and the
[TrinityCore TDB](https://github.com/TrinityCore/TrinityCore/releases) for the same build; writes
`site/data/<version>/spelldata.json.gz` and updates
`versions.json`. Takes ~15 s once the sources are cached, and is **deterministic** — apart from the build date in
`meta.built`, an unchanged rebuild is byte-identical, which makes "rebuild and diff" the regression test for any change
to the script. `python tools/rebuild.py --verify` runs exactly that: rebuild, compare with the date normalised away,
then put the committed pack back, so a no-op rebuild cannot leave a date change staged for every user to re-download.
Pass `--refresh` to re-download. Extracting the TDB archive (once per version)
needs [7-Zip](https://www.7-zip.org/) on the PATH.

**Adding a game version** is the same command with a different `--version`
(any build wago.tools lists). Add an entry in `TDB_RELEASES` at the top of
`build_data.py` if TrinityCore publishes a matching world DB, so morph/summon names and hotfixes resolve — it is
optional (no TDB exists for the Classic re-release clients, and those sections simply fall back to raw ids). Shipped
packs: Vanilla Classic 1.15.8, TBC Classic 2.5.6, WotLK Classic 3.4.3, Cataclysm Classic 4.4.2, Mists of Pandaria
Classic 5.5.4, Legion 7.3.5, Battle for Azeroth 8.3.7, Shadowlands 9.2.7 (default), Dragonflight 10.2.7 and The War
Within 11.2.7.

Two flags control how a pack is presented:

- `--hidden` — reachable **only** through an explicit `?v=` in the URL: left out of the dropdown and never the default,
  so nobody downloads it unless they ask for it by name. Useful for staging a build before publishing it.
- `--default` — the pack served when the URL names no version (marking one entry clears the flag on the others). Without
  it the newest visible pack wins, which is not always what you want: Epsilook ships **Shadowlands 9.2.7**
  as the default even though newer packs exist.

Both live in `versions.json`, so changing them means rebuilding that version with the flag — e.g. `--version 9.2.7.45745 --label "Shadowlands 9.2.7"
--default`. The version dropdown appears once two or more visible packs exist, with the active expansion's logo beside
it (`expansionLogos` in `src/config.ts`, decoded from the game's own `.blp`).

**Older versions** work too, and mostly differ by what does not exist yet: db2 tables get introduced, split and renamed
as the game evolves. Rather than branch per version, the differences are declared in one block near the top of
`build_data.py`:

| declaration                                                                 | meaning                                                                                       |
|-----------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| `OPTIONAL_TABLES`                                                           | the table postdates the build — its pack section comes out empty and the feature switches off |
| `OPTIONAL_COLUMNS`                                                          | the column postdates the build — a declared default stands in                                 |
| `SPELL_NAME_SOURCES`                                                        | the data moved between tables (spell names live on `Spell` before BfA)                        |
| `TDB_OPTIONAL_TABLES` / `TDB_OPTIONAL_COLUMNS` / `CREATURE_DISPLAY_SOURCES` | the same three kinds of drift on the TrinityCore side                                         |
| `array_columns()`                                                           | an `X_0..X_n` array field exported as a bare `X` in a later build                             |

Anything *not* declared there is still a hard error — an unexpected schema change must fail the build rather than
silently lose data. So adding a version is: run it, read what it says is missing, and decide per item whether it belongs
in the table above or is a real bug. The build logs the absent tables and the feature each one costs, and bakes the list
into `meta.absentTables`.

### Extending it

- **A new search field**: emit the data in `build_data.py`, index it in
  `src/data.ts`, then add one entry to `FIELDS` in `src/search.ts` — it becomes a query prefix and a field button
  automatically.
- **A new kind of pill** (a new sort of thing a results column can show):
  one record in `src/pilltypes.ts` gives it a category word, that word's autocomplete description, its group head, its
  search-hit highlighting and the spells a query selects; the renderer is a list of segments. See
  **[docs/PILLS.md](docs/PILLS.md)** — it also carries the segment-order convention and the rules for choosing a
  keyword.
- **A new copy command**: `spellCommands` in `src/config.ts` for per-spell buttons (they render as one nowrap strip
  under the spell name — a new one becomes another segment of that strip and never wraps it to a second line); the
  `*CopyTemplate` entries for the ones on tags. A label starting with `.` gets that dot drawn in the accent colour
  automatically — it is the chat sigil; a label without one renders plain. The strip is drawn as ONE segmented control
  rather than as separate buttons, so a command costs a hairline divider and its own text, not a box. Give it a `short`
  (`.lookup` → `.lo`) and pills use that where width is scarce while the strip keeps the full label; list it in
  `linkCommands` to put it on spell-link chips too.
- **A new theme**: every colour in `app.css` comes from a token in the block at the top, so a theme is one
  `:root[data-theme="<id>"] { ... }` block re-declaring those tokens plus one `{id, label}` line in `themes` in
  `src/config.ts`. The header picker builds itself from that registry and appears once a second theme exists; the choice
  is remembered per browser, and the reserved id `auto` follows the OS's light/dark setting (`autoTheme` in
  `src/config.ts`
  says which palette it lands on). Three ship: **Dark**, **Light — Moonwell** (cool violet slate) and **Light — Vellum**
  (warm parchment). A palette also sets *how loudly* colour lands, not just which colour: the fill, edge and ink
  percentages at the bottom of each block are what let one set of family tokens work on black and on paper. The comment
  block at the top of `app.css` explains each of them.

### Checking your changes

Nothing here is required to run the app — it is all dev-time only.

```
python tools/check.py
```

is the one command: it type-checks, builds, lints, and then runs the handful of invariants that are specific to this
repo and fail *silently* if you get them wrong — the `?v=` string being one string in both places and having moved if
the CSS or the bundle's sources did, the committed blobs being LF, and `versions.json` agreeing with the packs on disk
down to their content hashes. (The old "every module is loaded by `index.html`" guard moved into the build itself:
`tools/build.mjs` fails on any source file its import graph never reaches, which is the same invariant expressed where
it cannot be forgotten.) It warns, without failing, when a change looks like it should have updated one of the sibling
docs. `--fast` skips the toolchain and runs the repo guards alone. The same script runs in CI
(`.github/workflows/ci.yml`), so there is one definition of "does this pass".

The underlying checks, if you want them individually:

```
npx tsc                                        # the app: strict TypeScript, no implicit any
npm run build                                  # the bundle, plus the module-graph guard
python -m mypy build/build_data.py tools       # Python: fully annotated
python -m pyflakes build/build_data.py tools
python tools/ide.py                            # the JetBrains inspections + formatting
```

Touching the `docker/Dockerfile`, `docker/nginx.conf` or anything they copy adds one more, which needs Docker running
and so stays out of `check.py`:

```
python tools/docker_smoke.py                   # build the image, run it, prove it serves
```

### Measuring what the app does

`site/dev/oracle.js` is a dev tool the app never loads. Paste this into the console of a running page — local or the
live site — and it gives you the measurements this project keeps having to take:

```js
s = document.createElement("script");
s.src = "dev/oracle.js";
document.head.append(s)
```

`Oracle.q([...])` runs a battery of queries in place and tabulates the result counts; `Oracle.same([...])` asserts that
a set of queries agree, which is the shape nearly every search-grammar check takes; `Oracle.contrast()` does the WCAG
walk, compositing each text node's ancestor backgrounds down to an opaque colour before measuring;
`Oracle.pills([...])` snapshots every pill-bearing cell as canonical text plus a hash, so a refactor that should not
change what renders can be proven not to. `Oracle.help()` lists them. It switches palettes by *reloading*
(`Oracle.theme("moonwell")`) rather than by setting `data-theme`, because Chrome serves stale computed colours for
elements already on screen and that has produced convincing false failures.

### Exploring the data

The app ships no SQL, but the *data* is much easier to reason about with some. `python tools/builddb.py` mirrors every
table the build downloads into one DuckDB file under `build/cache/` — ten game versions as ten schemas, plus a `ref`
schema holding the listfile, 169 decoded enums, and a catalog of every column's type, comment and foreign key (read
straight out of the WoWDBDefs definitions, so the schema is derived rather than hand-written).

```bash
python -m pip install duckdb
python tools/builddb.py
```

It is a development tool and nothing in `site/` reads it: the database is a cache, gitignored, and rebuilt in about
three minutes. `duckdb` is the only dependency outside the standard library anywhere in the project, and only this
script needs it. **[docs/DB_SCHEMA.md](docs/DB_SCHEMA.md)** is the reference — layout, conventions, worked queries, and
the three things to know before trusting a row.

`python tools/dossier.py <spell>` is the other half of the same idea: one spell, every route followed to its leaves, as
a readable summary or as JSON. It answers "what IS this spell" without writing the eight joins yourself — effects and
auras with their enums decoded, what each `EffectMiscValue` actually points at, the whole visual chain, the missile's
flight path, and every file the spell reaches. `--diff` puts two spells side by side, which is how you find out whether
they share a model or merely look like they should.

```bash
python tools/dossier.py fireball
python tools/dossier.py 3562 1953 --diff
python tools/dossier.py 133 --json | jq '.assets.models'
```

## Data sources

| What                                        | Where from                                                                                |
|---------------------------------------------|-------------------------------------------------------------------------------------------|
| Client db2 tables                           | [wago.tools](https://wago.tools) CSV export, pinned to the pack's build                   |
| Creature names/displays, post-ship hotfixes | [TrinityCore TDB](https://github.com/TrinityCore/TrinityCore/releases) for the same build |
| File names                                  | [community listfile](https://github.com/wowdev/wow-listfile)                              |
| Enum value names                            | [WoWDBDefs](https://github.com/wowdev/WoWDBDefs) `meta/enums`                             |
| Table semantics                             | [wowdev.wiki](https://wowdev.wiki)                                                        |

Three things are fetched live by the browser, always on explicit user action (a hover or a click) and never preloaded or
bulk-downloaded: spell **icons**
and **sound files** hotlink from Wowhead's CDN, and **texture previews** pull the raw `.blp` from wago.tools' CASC API
and decode it in-page with the vendored [js-blp](https://github.com/Kruithne/js-blp). Each can be tuned or disabled in
`src/config.ts`.

Epsilook is a fan tool, not affiliated with Blizzard, Wowhead or Epsilon. World of Warcraft and its data are property of
Blizzard Entertainment.
