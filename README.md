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

**The syntax is documented in the app, behind the **?** button** — it is generated from the field and keyword
registries, so it is always current. It is deliberately not restated here: a second copy drifts, and this file is the
repo's map rather than the app's manual.

## How it works

```
src/                     the app, strict TypeScript — bundled into site/js/app.js by esbuild
  main.ts                the entry point: the app's wiring, stated in one place
  config.ts              copy-command templates and UI tunables
  util.ts                pure leaf helpers (templates, colours) — no DOM
  dom.ts                 typed DOM shorthands ($, $$, el)
  theme.ts               the theme registry -> <html data-theme> + the picker
  data.ts                pack loading + index building; the pack and index types
  pills.ts               the segment library results are built from + the pill-type registry
  query.ts               the query language: text <-> chips <-> tokens
  pilltypes.ts           one record per kind of content shown and searched
  search.ts              query parser + the FIELDS registry (one per prefix)
  texture.ts             .blp loading + the texture/colour hover previews
  export.ts              the results as CSV, JSON or a Discord code block
tools/query.ts           the same engine as a command-line UI (npm run query)
tools/parse.ts           the search 2.0 parser as JSON (npm run parse -- '<query>')
tools/equal.ts           search 2.0 query equivalence (npm run equal -- '<a>' '<b>')
  app/                   the UI, one module per subsystem
    state.ts             the mutable UI state every other module reads
    query.ts             the bar's half of the query language (the rest is src/query.ts)
    pillrender.ts        segments -> DOM: the only place a pill becomes an element
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
build/                   the pack generator (Python 3) — source and its tracked inputs, nothing generated
  build_data.py          regenerates the packs
  enums/                 checked-in enum tables, each with its attribution
  expansion_ids.json.gz  which expansion introduced each spell (tools/expansions.py writes it)
  sources/               a vendored era client table no public archive serves
  pack/                  the build as layers, each one replaceable on its own
    sources/             acquire: URLs, the cache, archives, the TrinityCore dumps
    tables/              the provider seam every reader reads through
    routes/              the readers: tables in, typed bundles out
    derive/              the graph walk and every cross-route derivation
      spelltext.py       the description template language, cooked to prose
    model/               the section registry
    encode/              how a column is laid out
    emit/                module files, the manifest, hashes
tools/                   every routine that would otherwise be a thing to remember
  build.mjs              the esbuild build: bundle, dev server, module-graph guard
  check.py               every check, plus the invariants that fail silently
  bump.py                move the ?v= cache-buster (both spots)
  rebuild.py             rebuild packs with their own labels; --verify the build
  listfile.py            would a newer community listfile change any shipped pack?
  verify_live.py         wait for Pages, then check what it actually serves
  verify_site.sh         is this assembled document root actually servable?
  docker_smoke.py        build the image, run it, prove it serves the site
  ide.py                 format + lint through the JetBrains IDEs, routed by owner
  builddb.py             build the exploration database of the SOURCES (development tool)
  packdb.py              build the exploration database of the SHIPPED PACKS (development tool)
  dossier.py             one spell, every route followed to the leaves
  dbd.py                 parser for WoWDBDefs .dbd schema definitions
  arcanum.py             build/read Arcanum ArcSpell import strings (development tool)
  arcanum_actions.json   the Arcanum action catalogue arcanum.py validates against
docker/                  the self-hosting path — see "Hosting it yourself"
  Dockerfile             the image: esbuild -> a verified document root -> nginx
  Dockerfile.dockerignore  an allowlist of what the image build may see
  nginx.conf             the server block: caching, compression, the 404 page
  compose.yaml           one service, ready to paste into a NAS
.cache/                  GENERATED, gitignored: downloaded tables, distilled dumps, the exploration database
docs/                    how it works underneath, in prose
  DATA_ROUTES.md         every data route: sources, the spell->visual->kit graph, the pack layout
  icons/                 the SVG masters behind the pill glyphs, and a preview page
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
existing clone; `uv run python tools/check.py` says `via LFS pointer` when it is looking at stubs rather than packs.

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
python tools/rebuild.py shadowlands
```

Every shipped game version is declared in `tools/packs.py` — build id, label, which one is the default. That file is the
input; `versions.json` is generated from it. Name a pack by its key (`vanilla`, `mop`, `midnight` …) or by a build
prefix; with no argument it rebuilds all eleven, and `--list` prints the underlying commands without running them.

**Updating a pack to a newer game build is one edit**: change that pack's `build=` string in `tools/packs.py` and rerun
the command above. The label follows the build, and the pack being replaced is retired for you. To find out when that is
due, `python tools/packs.py --check` asks Blizzard's own version service which build each line is currently on (a weekly
GitHub Action does the same and opens an issue).

The underlying script still takes its identity as arguments, if you want to drive it directly:

```
python build/build_data.py --version 9.2.7.45745 --label "Shadowlands 9.2.7"
```

Downloads (and caches under `.cache/`) the game tables from
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
uv run python tools/check.py
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
npm test                                       # the TypeScript suite, node --test
uv run mypy build tools                        # Python: fully annotated
uv run pyflakes build tools
uv run pylint --errors-only build tools
uv run pytest                                  # the Python suite, beside build/pack
```

The Python toolchain is pinned by `pyproject.toml` and `uv.lock`, so a checker's version is a fact of the repository
rather than of whoever's machine ran it. `uv run` installs what it needs on first use.

Touching the `docker/Dockerfile`, `docker/nginx.conf` or anything they copy adds one more, which needs Docker running
and so stays out of `check.py`:

```
python tools/docker_smoke.py                   # build the image, run it, prove it serves
```

### Running queries without a browser

The search engine is a layer of its own — `data.ts` + `query.ts` + `search.ts` know how to answer a query and nothing
about how it is shown — so the same engine drives a shell:

```bash
npm run query -- 'fx:chain mech:channeled'
```

The query language is the app's own, because it *is* the app's own code: field prefixes, quoted phrases, `|`
alternation, `-` exclusion and numeric comparisons all behave exactly as they do in the search bar. A result that
differs between the two is a bug, not two implementations drifting apart — there is only one.

```bash
npm run query -- 'model:"attach chest"' --limit=5
npm run query -- 'model:missile' --count
npm run query -- 'anim:replace' --json | jq '.spellIds | length'
npm run query -- --version=3.4.3 'fx:tint'
```

`--count` prints the number alone and `--json` the full result, both on stdout with every diagnostic on stderr, so
either pipes cleanly. `--version=` picks a pack by id prefix or label (default: the pack marked `default`). Loading a
pack costs about a second and the query itself a few tens of milliseconds, so it is one command per question rather than
a session.

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
table the build downloads into one DuckDB file under `.cache/` — ten game versions as ten schemas, plus a `ref`
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

## Licence

The code is **AGPL-3.0-or-later** — see [LICENSE](LICENSE).

It does not cover everything in the tree. The data packs under `site/data/` are derived from Blizzard's client tables
and are redistributed for non-commercial fan use under no claim of ours; the expansion marks under `site/img/` come from
[Warcraft Wiki](https://warcraft.wiki.gg) and stay under CC BY-SA 4.0; and `src/vendor/` holds third-party MIT code.
[NOTICE](NOTICE) is the map of which is which, and `tools/check.py` fails if a directory reaches `site/` without being
recorded there.
