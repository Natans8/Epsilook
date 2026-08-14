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
| `neighbours`    | the id space itself: what a file arrived beside    | adjacent        | seconds                |

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

**An adjacent name is weaker still, and the `near/` bucket is what says so.** Every other route follows a pointer —
a model names its textures, a tile names what stands on it — so its claim can be checked by re-reading the parent. The
last route follows nothing: it names a file after the art it was *delivered* beside, on the evidence that file ids are
handed out as assets are added. That is a real signal and it is not a reference, so it is marked apart, and a route
that reads these names later can tell the two kinds apart without re-deriving either.

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

A `--network` run reaches **127,245 of the 128,476 custom files, 99.0%**, leaving 1,231:

| kind                    | count | what could reach it          |
|-------------------------|------:|-------------------------------|
| `blp`                   |   539 | nothing that refers to it     |
| `m2`                    |   269 | their own bytes name nothing  |
| `chunked, unrecognised` |   207 | nothing                       |
| `skin`                  |   171 | their models are unnamed      |
| `empty`                 |    30 | nothing — the files are zero length |
| `mp3`                   |    10 | sound                         |
| unknown                 |     5 | nothing recognises the bytes  |

**⭐ Every parent left is silent.** The two routes that read a file for what it says about itself have taken everything
they can: not one of the 269 models carries a name. No world model of either kind survives in that list, which is the
check that the routes reading them are complete.

**That was the ceiling for every route that follows a reference, and it is why the last route follows none.** What
remains is not unreachable, it is unreferenced — so `neighbours` names it by the art it was delivered beside instead.
It claims **2,239 rows** on a `--network` run, which is what carries the walk from 97.3% to 99.0%. ⚠ Measured
local-only it claims 631, and that figure describes the install rather than the route: a walk can only classify a file
it can read, and the install held 853 of the 3,470 unnamed at the time.

**⚠ Not one of the 1,231 that remain is on disk.** Everything this install holds is named, so the remainder can only be
classified over the network, and a route reaching it would have to do the same.

**⛔ A neighbour must identify something, or it says nothing.** The derived buckets come in two shapes: per-parent
(`epsilon/texture/<model>`) and flat (`epsilon/model`, `epsilon/buildingtile`, `unknown`). Only the first can carry the
claim — "delivered near `epsilon/model`" means the neighbour was *some* model, which is no claim at all. The rule is a
segment count rather than a list, so a route adding a bucket does not need a row. ⚠ Before it existed, 14.6% of the
adjacency rows came out `epsilon/near/model/<fid>`.

**⛔ And the route must not read its own output.** `--only` seeds from the last full run, so a second pass would treat
the first pass's `near/` names as buckets and spell the compounding literally as `near/near/`. Excluding what it
produced is what makes a re-run idempotent: measured, the second run adds zero rows.

**⚠ A local-only run reaches 91.8%, and the gap is not small.** Nine tenths of what an install lacks is exactly what
the file-reading routes want, so `--network` is not an optimisation here; it is most of the result.

**The pipeline converges in one pass.** Re-running the walks that consume other routes' output against a complete
result yields zero new rows, which follows from the ordering: routes run parents-before-children, and the children they
produce — groups, skins, textures — cannot themselves be parents. There is no fixed point to iterate towards.

No terrain appears in that list either, which is the same check for the terrain route.

> ⚠ Classifying on the leading four bytes alone gives a wrong answer, and it is a wrong answer that looks right:
> terrain, world tables and world models all begin with the same version chunk, so magic-only classification calls
> thousands of map tiles world models. `classify()` separates them on the chunks they carry instead.

The remaining textures have no *referrer*. They are not model textures — the parentage walks have taken those — nor
customization textures, nor the ground textures a map paints with, which is the one place left that could have
referenced them and does not. That is what `neighbours` is for, and what its weaker standing records.

**⭐ The id space is itself evidence, and a map's own run is the sharpest form of it.** Prophecy Lordaeron's art
occupies one unbroken stretch, `23,302,369`–`23,308,848`, across all three ways a map is named — its tiles, the models
its terrain places, the textures it paints with. **92 unnamed files fall inside it**, and they are named after the map
rather than after whichever parent folder happened to sit nearest, because a map says what a file is *for* while a
folder named after a file id says nothing. ⚠ Two maps delivered together share a stretch — `classicazeroth` and
`classickalimdor` do — so a file inside two runs is claimed by neither and falls through to the weaker rule.

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
| a world model's doodads      | `MODI`/`MODD` across every named world model reference nothing unnamed               |
| **a map's texture table**    | **`.tex` carries `TXVR`/`TXBT`/`TXMD` and no `TXFN`: 5.8 MB, zero unnamed ids**      |

⚠ **Read the last two as the correction they are.** The texture table was the most promising remaining lead — it is
the file that would name a map's ground textures, and the largest unnamed block is textures. It does not name them.
**And a head read shows only its version chunk**, so the question can only be settled by reading it whole; the cap
would have produced the same emptiness for a file that did name them.

⛔ **The question to ask before adding another route is not "what fraction is named".** No shipped pack references a
single custom file — every pack is built from wago's retail tables — so this supplement is preparation for an Epsilon
pack that does not exist yet. Coverage here is a readiness measure, and a route reaching files that pack will never
carry is worth nothing however elegant.

## 7. Vendoring

Writing `build/sources/epsilon-listfile-supplement.csv.gz` is a separate, deliberate act, and it has its own flag so
that it cannot happen as a side effect of a run somebody started for the diff:

```bash
uv run python tools/supplement.py --diff --network --vendor
```

**⛔ `--vendor` refuses a local-only or partial run**, because either one produces a file that is reproducible on this
machine and nowhere else. A local walk does not find fewer names, it finds *different* ones — a derived path names the
parent that refers to the file, and where several do, the walk takes the lowest-numbered one it managed to read, so
which parents a machine happens to hold decides the name. A `--only` run is refused from the other end: it would
vendor a merge of this run and whatever the cache was left holding.

Two properties make an unchanged re-vendoring stage nothing, and both are in `write_rows`:

- the rows are **sorted by id and unique**, so the same routes produce the same bytes;
- the gzip member is written with **`mtime=0`**. ⚠ Gzip stores a modification time and defaults it to the clock, which
  would make every re-vendoring a diff on its own and defeat the sorting entirely.

⚠ Gzip also stores the **file name**, so the bytes hold for the vendored path and are not a property of the rows alone.
Writing the same rows to a different name is a different file.

The supplement is the one thing in the build that a person put there on purpose, and the diff is what makes that a
decision rather than a formality.

### What the current file holds

The vendored file carries **127,277 rows**, reconstructed by a full `--network` run. Against the 95,410 it replaced:
**31,867 added, none lost, 796 renamed.** The renames come in four shapes worth recognising, because a later run will
produce more of the same:

- **569 followed their parent into a better bucket** — a world-model group is named beside its root, so a root that
  gains a truer name hands one to its groups. `epsilon/wmo/watertile_4_slime_000.wmo` became
  `epsilon/watertile/watertile_4_slime_000.wmo` without the derived name itself changing.
- **122 became file-id shaped**, which reads like a loss and is not. A group named `<root>_000.wmo` asserts that one
  root owns it; reading more parents over the network shows three roots sharing that geometry — the building and its
  alliance and horde variants — so the claim was withdrawn in favour of one that is true.
- **104 changed which parent named them**, for the same reason: where several parents refer to one file the walk takes
  the lowest-numbered it could read, so reading more of them changes the answer. This is the property `--vendor`
  demands a full network run for.
- **one fell from parentage to adjacency** — texture `19400081`, which no parent claimed this time and which
  `neighbours` then named. It is the one rename that trades a stronger claim for a weaker one, and the `near/` bucket
  is what makes that visible rather than silent.
