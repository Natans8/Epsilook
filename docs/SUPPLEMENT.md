# The asset-name supplement, and how to rebuild it

`build/sources/epsilon-listfile-supplement.csv.gz` is the only source in this repository that the build cannot fetch.
Everything else — the game tables, the community listfile, the TrinityCore dump — is downloaded and revalidated on every
run. This one is vendored, because deriving it needs a private client's own installation and, for the largest route, a
person logged into that client walking an API by hand.

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
| `objects`       | the gameobject walk through the client API         | real or derived | **an evening in game** |
| `customization` | the character-customization tables, joined by name | semantic        | a minute               |
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

> ⚠ Join by column *name*, never by position. The customization chain crosses five tables, and two of the positions
> recorded for them were wrong — a wrong position yields a confident name for the wrong thing rather than an error.
> `tools/epsilon_tables.py` pairs the reader with the published definitions so every join reads a named column.

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
`world/expansion05/doodads/thing.m2` is `world/expansion05/doodads/thing00.skin`, which is a *real* name, not a
placeholder. The child inherits its parent's standing: a child of a parent whose own path was derived lands under
`epsilon/` too, without needing a second rule.

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
coverage saturates from either direction, so a local-only run is a sound estimate of the whole at a fraction of the
requests. That is what makes iterating on a rule cheap: the whole pipeline runs in seconds.

**A run whose output is going to be vendored must pass `--network`.** A local-only walk does not merely find fewer
names, it finds *different* ones. A derived path names the parent that refers to the file, and where several parents
refer to one texture the walk picks the lowest-numbered parent it actually read — so which parents the machine happens
to have cached changes the name. Local-only output is therefore reproducible on one machine and not across two, which
is exactly the property a vendored artefact must not have.

```bash
uv run python tools/supplement.py --diff --network      # the run to vendor from
uv run python tools/supplement.py --diff                # the run to iterate with
```

Nothing here ever needs a full content download. The largest single thing any route fetches is the encoding file, once,
cached thereafter; the walks fetch small files and are bound by round trips rather than bandwidth.

**`--network` is a deliberate act, not a faster default.** It makes tens of thousands of requests to a service somebody
else runs for players, so the walk prints how many files it is about to ask for before it asks for any of them. Run it
when a result is going to be vendored; do not leave it running in the background out of habit. Everything it fetches is
cached under `.cache/casc/`, so a second run costs nothing.

## 4. The one cost that is not compute

**`objects` cannot be re-run from a machine.** It needs the `EpsilonDump` addon, a logged-in character, `/edump gob`,
and a clean logout — SavedVariables are flushed on exit, not at character select. It names roughly three quarters of
everything the supplement carries.

The addon clears its own section at the start of every walk, so **running any other dump destroys the previous
capture**. The pipeline therefore prefers a live capture and falls back to a saved copy of one at
`.claude/data/epsilon/dump_gob_names.json`.

> ⚠ That saved copy is currently the only one in existence, and it is not tracked by git. The installation's
> SavedVariables no longer holds the walk, and neither does its backup. Losing that file costs another evening in game.

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

A local-only run currently reaches **116,072 of the 128,476 custom files, 90.3%**, leaving 12,404. Of the 2,544 of
those the installation holds and can therefore be identified:

| kind            | count | which route would claim it        |
|-----------------|------:|-----------------------------------|
| `blp`           | 1,839 | none yet — see below              |
| `wmo group`     |   315 | `worldmodels`, with `--network`   |
| `m2`            |   169 | `models`, with `--network`        |
| `skin`          |   166 | `models`, with `--network`        |
| `wmo root`      |    23 | none: roots, not children         |
| everything else |    32 | sound, and a few unrecognised     |

No terrain appears in that list, which is the check that the terrain route is complete.

> ⚠ Classifying on the leading four bytes alone gives a wrong answer, and it is a wrong answer that looks right:
> terrain, world tables and world models all begin with the same version chunk, so magic-only classification calls
> thousands of map tiles world models. `classify()` separates them on the chunks they carry instead.

**The largest remaining move is `--network`.** Nine tenths of what is unnamed is simply not on this machine — 9,860 of
the 12,404 were never opened. The three walks reach further with the network on, and that is the run a vendored result
comes from anyway.

The remaining local textures have no route yet. They are not model textures — the parentage walks have taken those —
and they are not customization textures either. Identifying what uses them is the open question; there is no measured
answer, so do not assume one.

Two routes are closed and should not be re-opened. The world-model group route is exhausted — custom roots reference
stock group geometry, so no group target is unnamed. The terrain texture route is a dead end, because tileset textures
are shared across every tile that uses them, so a large sample yields almost no distinct unnamed files.

## 7. The step this does not take

**Nothing here writes `build/sources/epsilon-listfile-supplement.csv.gz`.** The pipeline writes to `.cache/` and prints
a diff; vendoring is a separate, deliberate act. That is the property worth keeping: the supplement is the one thing in
the build that a person put there on purpose, and the diff is what makes that a decision rather than a formality.

When it is taken, the result must be sorted and deduplicated — which `write_rows` guarantees — so that an unchanged
rebuild produces identical bytes and stages nothing.
