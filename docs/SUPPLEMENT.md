# The asset-name supplement, and how to rebuild it

`build/sources/epsilon-listfile-supplement.csv.gz` is the only source in this repository that the build cannot fetch.
Everything else — the game tables, the community listfile, the TrinityCore dump — is downloaded and revalidated on every
run. This one is vendored, because deriving it needs a private client's own installation, which no build machine has.

That makes it the one file where "how was this produced" has to be written down. This is that procedure. It is a script
rather than a note, because the routes disagree about cost by four orders of magnitude and choosing which to run is a
decision that needs the numbers in front of it.

**The deliverable is `fid;path`**, one row per file, confined to the id space the client allocates its own assets from.
It is merged over the community listfile by `pack/tables/listfile_tables.py`, under the admission rule in
`pack/supplements.py` — so a row it may not contribute is refused rather than silently overwriting a real name.

## 1. What it is for

The community listfile names every file Blizzard ships. A private client adds its own, and nothing public knows what
those are called. Without the supplement, every asset the client added shows up as a bare number: unsearchable, and
meaningless on screen.

| bound                                     | value      |
|-------------------------------------------|------------|
| files the client adds, above the id floor | 128,476    |
| the floor a supplement may not name below | 18,000,000 |
| named by the current routes               | §6         |

## 2. The routes

Each route is one way of learning what a file is called, and they are not equally good. They are declared in
`tools/supplement.py` in priority order, and the order means two things at once: **earlier wins a conflict, and earlier
feeds what comes later.**

| route           | reads                                              | name            | cost                   |
|-----------------|----------------------------------------------------|-----------------|------------------------|
| `terrain`       | the map table, then each map's tile grid           | real            | a minute               |
| `icons`         | the icon database an addon ships                   | real            | a second               |
| `objects`       | the gameobject name list the client ships          | real or derived | seconds                |
| `customization` | the character-customization tables, joined by name | semantic        | a minute               |
| `modelnames`    | the name a model carries about itself              | real            | minutes                |
| `reskins`       | the retail world model a file was copied from      | semantic        | minutes                |
| `worldmodels`   | group geometry and textures, from their models     | derived         | minutes                |
| `models`        | skins, textures and anims, from their models       | derived         | minutes                |

**A real name is one the game itself would look the file up by.** Terrain qualifies because a map's directory plus a
tile's position in the map's fixed grid determines the filename by convention — nothing is invented. Icons and the
object walk qualify because the client reports the name itself.

**A semantic name describes the thing rather than its neighbours.** It is not the name the game looks the file up by,
but it is joined out of the tables that actually use the file, so it says what the file is *for* —
`chrcustomization/eye_color/trollmaleeyecolorzandalari04` rather than the id of some model that happens to reference it.
That is why it outranks parentage.

**A derived name is a placeholder and says so.** It states which model refers to the file, which is all anyone knows,
and it sits under an `epsilon/` prefix so it can never be mistaken for a path the game uses. The object route derives
one too, for the names the client reports as a bare filename with no directory.

**Two routes read the file itself rather than anything that references it**, which is what lets them reach files no
table mentions at all:

- **`modelnames`** takes the name a model stores in its own header. That is a real name — the one whoever built the
  model gave it — so it ranks with the routes the client reports. ⚠ **Some models hold a texture path in that field
  instead**, and taking it would name a model after its own texture, so a value ending `.blp` is refused.
- **`reskins`** reads `MOHD.wmoID`, the retail id a world model declares, and matches it against the stock roots that
  declare the same one. A reskin inherits its original's id, so the file says which retail model it began as. That is
  a description rather than a filename, so it sits with `customization` — and **below `objects`, deliberately**:
  Epsilon's own name for these files (`EPS_RockArch2_…`) is better than "a copy of `6ng_rockarchwmo_02l`", so if the
  object walk ever reaches one, it wins.

**Both name PARENTS, and that is why they are worth more than their own row counts.** A named model lets the `models`
walk name its skins, textures and animations; a named world-model root lets `worldmodels` name its groups. Measured on
the local-only run that introduced them: **179 parents named, 472 children following, 651 rows for two routes that
directly produce 179.**

> ⚠ Read every column by *name*, never by position — and this is not only about joins. The customization chain crosses
> five tables and two of the positions recorded for them were wrong; the terrain route read `Map.db2` positionally and
> got the number `53330` where the row holds `Azeroth`, because a positional read cannot tell a string from the offset
> that locates it. Either way the result is a confident name for the wrong thing rather than an error.
> `tools/epsilon_tables.py` pairs the reader with the published definitions so every read names its column.

### Naming follows the game's own conventions, where there is one

A derived name is only worth having if it looks like a name the game would use, so each convention was measured
against the community listfile rather than assumed. Three hold and are applied; three do not and are not.

| child                       | convention                         | measured                 |
|-----------------------------|------------------------------------|--------------------------|
| a model's skin              | `<model>00.skin`, beside the model | 3,976 / 4,000 models     |
| a world model's group       | `<root>_000.wmo`, beside the root  | 3,999 / 4,000 groups     |
| a model's animation         | `<model><anim>-<variation>.anim`   | 3,318 / 4,000 animations |
| `.phys` / `.skel` / `.bone` | no predictable spelling            | under 1% each            |

**Where a convention holds, the child is placed beside its parent and named the way the game names it** — so a skin of
`world/expansion05/doodads/thing.m2` would be `world/expansion05/doodads/thing00.skin`. The child inherits its parent's
standing: a child of a parent whose own path was derived lands under `epsilon/` too, without needing a second rule.

> ⚠ In practice this currently yields no real names, and the reason is worth knowing before anyone counts it as a win.
> Every custom child of a real-pathed model is already named by an earlier route — measured at 1,333 of 1,333 across a
> four-thousand-model sample. The walks only ever reach what nothing better named, and that is models whose own names
> were derived. The rule is right and costs nothing; it simply has nothing left to claim.

**Where no convention holds, the file id keeps the path unique** and it sits in a bucket under `epsilon/`, because a
plausible-looking invented name is worse than an obviously derived one.

> ⚠ An animation is named by the animation it holds, not by its position in the list. The two fields ahead of the file
> id in the chunk are the animation id and its variation — they are the name, not padding to skip past.

### Why the order matters twice

A walk can only name a child of a parent that *already has a name*. So the same walk yields different results depending
on what ran before it — one pass over the world models found 3,577 names against one set of parents and 404 against a
larger one. That is not a defect; it is what makes re-running a walk after another route lands worthwhile, and why
`--only` seeds itself from the last full run rather than starting empty.

## 3. Running it

```bash
uv run python tools/supplement.py --list
```

Prints what each route needs and costs, and runs nothing. Then:

```bash
uv run python tools/supplement.py --diff
```

Runs every route that can run, merges them in priority order, writes `.cache/supplement/supplement.csv`, and reports
how the result differs from what is currently vendored. Each route also writes its own file under `.cache/supplement/`,
so any one can be re-run alone:

```bash
uv run python tools/supplement.py --only models
```

### The network policy, and the one case where the default is wrong

**The walks read the installation first and refuse the network by default.** The install holds under half the files a
walk wants — a client's own additions are the least-cached part of any install, because they download on demand — but
coverage saturates: local-only reaches 116,072 names against the full run's 118,294, for a fraction of the requests and
in seconds rather than minutes. That is what makes iterating on a rule cheap.

**A run whose output is going to be vendored must pass `--network`.** A local-only walk does not merely find fewer
names, it finds *different* ones. A derived path names the parent that refers to the file, and where several parents
refer to one texture the walk picks the lowest-numbered parent it actually read — so which parents the machine happens
to have cached changes the name. Local-only output is therefore reproducible on one machine and not across two, which
is exactly the property a vendored artefact must not have.

```bash
uv run python tools/supplement.py --diff --network      # the run to vendor from
uv run python tools/supplement.py --diff                # the run to iterate with
```

Nothing here ever needs a full content download, and in particular it never downloads an archive index: **the client
keeps its own copy of every one of them**, and a full run located 48,605 of 48,605 wanted files from those without
asking the service anything. What remains is one small ranged request per file, which is what the walk's own progress
counts.

**`--network` is a deliberate act, not a faster default.** It makes tens of thousands of requests to a service somebody
else runs for players, so the walk prints how many files it is about to ask for before it asks for any of them. Run it
when a result is going to be vendored; do not leave it running in the background out of habit. Everything it fetches is
cached under `.cache/casc/`, so a second run costs nothing.

## 4. The catalogue the client ships

**`objects` names roughly three quarters of everything the supplement carries, and it used to cost an evening in
game.** It no longer does. The client ships its own `id;name` list as an ordinary file in its storage, and that file is
where the client API reads from:

| file id      | rows    | what it names                                    |
|--------------|--------:|--------------------------------------------------|
| `23200000`   | 166,671 | models and world models — what `objects` reads   |
| `23200001`   | 194,720 | sounds; names one id the listfile lacks, below the floor |

**It is the same catalogue, not a second opinion.** Measured against a captured `/edump gob` walk: the identical
166,671 ids, agreeing on **166,670** of them. The single row that differs is the shipped file being *right* — the walk
returns `Катапульта` through the addon's chat layer as mojibake, and reading the bytes skips the round trip that
mangles it.

So the route reads the file, and falls back to a live capture and then a saved copy only if it cannot. **Nothing in
this procedure now requires anybody to log in.**

> ⚠ `.claude/data/epsilon/dump_gob_names.json` is kept as a fallback and is no longer irreplaceable. It was, for as
> long as the walk was the only source — that is why the warning about the addon clearing its section between dumps
> mattered, and why it no longer does.

**A capture will not name more than the shipped file does, and neither reaches everything.** Both hold 166,671 entries
while `GameObjectDisplayInfo` carries 167,376 distinct file ids: **705 are in the table and absent from the
catalogue**, 692 of them otherwise unnamed. **That is a data limit, not an API one** — the ceiling is baked into the
file the client ships, so no way of reading it will produce those names.

## 5. Verifying

Three layers, and they answer different questions.

**Does each route still produce what it produced before?**

```bash
uv run python tools/supplement.py --verify
```

Each route is checked against a known-good copy of its output. These copies are what made the rewrite possible: two of
the routes had no surviving code at all, only their outputs, and reproducing those exactly is what proved the recovered
rules were right — and what caught four the written description had wrong or left out.

**Is the vendored file structurally sound?** `tools/check.py` runs on every commit and fails when the supplement is
unsorted, carries a duplicate id, or names anything at or below the floor. It also reconciles the floor's two
declarations — the drift there would not break a build, it would quietly admit a row that overwrites a real community
name.

**Do the derived names describe real files?** This part is manual and short, because nothing automatic can judge it:

- Take a handful of rows from each derived bucket and confirm the file's magic bytes match the extension the path
  claims. The extension given to a name with none was established this way rather than assumed.
- Confirm a new bucket has not fallen through to a catch-all: the route reports its split by bucket, and a bucket that
  suddenly holds most of the rows means a prefix rule stopped matching.
- Spot-check that a derived path's parent still exists under the name the walk used, after any route above it changed.

## 6. What is still unnamed

Total coverage is the goal, so what remains is the output that matters — a count says how far there is to go, and the
classification says which route would go there.

```bash
uv run python tools/supplement.py --coverage
```

A local-only run reaches **117,975 of the 128,476 custom files, 91.8%**, leaving 10,501. Of the **1,096** of those the
installation holds and can therefore be identified:

| kind                    | count | which route would claim it            |
|-------------------------|------:|---------------------------------------|
| `blp`                   |   923 | none yet — see below                  |
| `skin`                  |   121 | none: their models are not held here  |
| `chunked, unrecognised` |    14 | none                                  |
| `m2`                    |    13 | none: they carry no name of their own |
| `mp3`                   |    11 | sound                                 |
| `unknown`               |     7 | none                                  |
| `wmo group`             |     7 | none: their roots are not held here    |

The other **9,405 are not held locally and were not opened**, so what they are is unmeasured. Classifying them would
cost a request each and the report says so rather than guessing.

**⭐ Read that table against its predecessor: the locally-readable PARENTS are now exhausted.** Before `modelnames` and
`reskins` it read 169 `m2` and 23 `wmo root` blocking 311 `wmo group` and 126 `skin`. It now reads **13 models, zero
world-model roots and seven groups** — so on this machine there is no parent left whose name would free a child. What
remains locally is 923 textures and a handful of odds.

No terrain appears in that list, which is the check that the terrain route is complete.

> ⚠ Classifying on the leading four bytes alone gives a wrong answer, and it is a wrong answer that looks right:
> terrain, world tables and world models all begin with the same version chunk, so magic-only classification calls
> thousands of map tiles world models. `classify()` separates them on the chunks they carry instead.

**The largest remaining move is `--network`, and the two file-reading routes are why it is worth more than it was.**
Nine tenths of what is unnamed is simply not on this machine. `modelnames` and `reskins` both read the file itself, so
every parent the network reaches is a parent they can name — and each named parent frees its children. Measured
locally, 179 parents brought 472 children with them.

The remaining local textures have no route yet. They are not model textures — the parentage walks have taken those —
and they are not customization textures either. Identifying what uses them is the open question; there is no measured
answer, so do not assume one.

### Routes that are closed, with what closed them

Do not re-open these without new evidence; each cost a measurement.

| route                        | why it is closed                                                                     |
|------------------------------|--------------------------------------------------------------------------------------|
| world-model groups           | custom roots reference stock group geometry, so no group target is unnamed           |
| terrain textures             | tileset textures are shared across every tile, so a large sample yields almost none  |
| `.lookup tiletexture`        | 201 terms, 144 returning a full page, **zero** results above the custom floor        |
| every other client table     | `--referrers` over 836 tables: 10,152 of 11,152 unnamed are mentioned by none of them |
| `.gob spawn`                 | fails for the display-carrying orphans, models and world-model roots alike           |
| `GODI_Search`                | returns exactly the same 166,671 rows as the index walk; the ceiling is the catalogue |
| embedded paths in WMO or ADT | a chunk census finds no `MODN` and no `MOTX`: modern formats carry file ids only     |
| `.lookup object`             | 22,051 custom filenames, and **no file id on any of them** — see below               |

> ⚠ **`.lookup object` was swept and knows nothing this does not, so nobody need spend an evening on it.** Over 201
> terms it returns 34,838 gameobject entries naming a model file, 20,262 of them filenames the listfile has never heard
> of — Epsilon's own, lowercase: `eps_rockarch_lavarock.wmo`, `eps_emptywmo_gilneas_outpost_stable_v2`. Set-differenced
> against this supplement, **49 remain unaccounted for**, and none carries a file id. The server's object names and the
> `objects` walk's names are the same body.
>
> **That is also what closes the 692 display-carrying orphans**: had they names on the server, the leftover would be
> about 692 rather than 49. It is not. Those files have no name in the client catalogue, the server's gameobject
> table, any db2, or their own bytes.
>
> ⚠ The leftover read **2,429** until leading markers were stripped — entries are prefixed `[bfa 8.0] name.m2` as well
> as suffixed `name.m2 [elevator]`, and stripping only the suffix leaves thousands of ordinary listfile names looking
> novel.

⛔ **And the question to ask before adding another route is not "what fraction is named".** No shipped pack references
a single custom file — every pack is built from wago's retail tables — so this supplement is preparation for an
Epsilon pack that does not exist yet. Coverage here is a readiness measure, and a route reaching files that pack will
never carry is worth nothing however elegant.

## 7. The step this does not take

**Nothing here writes `build/sources/epsilon-listfile-supplement.csv.gz`.** The pipeline writes to `.cache/` and prints
a diff; vendoring is a separate, deliberate act. That is the property worth keeping: the supplement is the one thing in
the build that a person put there on purpose, and the diff is what makes that a decision rather than a formality.

When it is taken, the result must be sorted and deduplicated — which `write_rows` guarantees — so that an unchanged
rebuild produces identical bytes and stages nothing.
