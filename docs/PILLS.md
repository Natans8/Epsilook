# Pills — the design guide

Everything in a results column is a **pill**: a model file, a sound, a summoned creature, an invisibility channel. This
is how to add another one, and the conventions to follow while doing it.

Three files:

| file                | holds                                                          |
|---------------------|----------------------------------------------------------------|
| `src/pills.ts`      | the segment library and the pill-type registry — the machinery |
| `src/pilltypes.ts`  | one record per content type — the declarations                 |
| `src/app/tags.ts`   | one renderer per pill type                                     |
| `src/app/render.ts` | the cells that arrange them                                    |

`pills.ts` depends only on `config.ts` and never reaches into the app modules. That is deliberate: it lets `search.ts`
read the type registry too, so matching a query is written once instead of once per file.

---

## 0. What is NOT a pill — the delivery line

**Some things about a spell are not payload, and those do not get pills.** The delivery line under the spell name
(`1.8 sec cast · 30 sec channel · breaks on move`) is the worked example, and the user's framing is the rule to reuse:

> *"Those are inherent properties of spells. Pills are meant for stuff that doesn't always appear, this is in the same
> weight category as the spell name or ID."*

So the test before adding a pill type is **does every spell have one?** A model, a sound, a tint — these are payload:
present on some rows, absent on others, and a pill's whole job is to show you which. Delivery is identity: every spell
has an answer, even if the answer is `Instant`. Rendering 276,332 pills that say the same thing would be noise, and
276,332 pills of *any* kind in the Mechanics column would bury the ones that mean something.

**Three consequences worth copying if this ever comes up again:**

- **It lives in the Name cell** (`render.ts deliveryLine`), between the subtext and the command strip — beside the
  identity it belongs to, not in a column of its own.
- **It carries NO content colour.** Colour in this app names a content family; delivery is not a family. Weight is the
  only typography: the number and its load-bearing word at `--text`, the rest at `--text-dim`.
- **It is still fully searchable.** `mech:instant` / `mech:casttime` / `mech:channeled` are registered pill types like
  any other — they simply carry `draw: false` in `ATTR_FLAGS`, which both render sites honour. **Searchable and undrawn
  is a supported state; searchable and *accidentally* undrawn is the fx-column bug.** The difference is that one list
  drives both halves.

**The slot order is `<value> <label>` and it never flips** (the user's rule) — `unlimited channel`, never
`channel, no limit`. Wowhead's own tooltip writes `Channeled (5 sec cast)`, label first; the vocabulary is borrowed from
it, the ordering is not. See docs/DATA_ROUTES.md §3s-bis for the data behind the line.

## 1. Anatomy

A pill is an **ordered list of segments**, written left to right exactly as it renders:

```js
P.pill({
    cls: "model",                    // classes after "tag" — drives the tone
    hit: modelFileIsHit(file, cat),  // matched by the current query
    title: file.path,                // tooltip on the pill body
    segments: [
        P.view(url, "Preview … in the model viewer"),   // 3D cube
        P.targets(mask),                                 // who it plays on
        P.label(name, {title, detail, search, finds}), // the clickable name
        attachSegment(src, dst, "model", false),         // where it attaches
        P.cmd(".lo", CFG.modelCopyTemplate, vars),       // copy button
    ],
})
```

Falsy segments are dropped and nested arrays flatten, so conditional and variable-length sections need no control flow:

```js
segments: [
    named && P.link(href, title),        // only when the item has a name
    swatches,                            // an array of 0–3 colour dots
    displayId && [                       // two segments, or neither
        P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
        P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
    ],
]
```

Each segment has:

- a **kind** — its class, its role, which side carries a divider;
- a **content** form — `text`, `svg`, `img` or `nodes`. Any kind takes any of them, so an icon-only variant of a text
  segment needs no new kind;
- at most one **action** — `search`, `copy`, `href` or `play`. The action decides the element (button / anchor / inert
  span), composes the tooltip's closing line, and supplies the accessible name.

That is the whole vocabulary: ten kinds × four content forms × four actions covers every pill in the app.

## 2. Segment order — a convention, not a rule

The builder renders the array **as written**. Nothing reorders it, and no new segment kind should ever be given an
implicit position. Follow this order unless the pill has a reason not to, and say what the reason is:

```
[actions] · targets · swatch/icon · LABEL · notes · [copies]
   link       who it     what it     its     what      what it
   view       plays on   looks like  name    qualifies puts on
   play                                      it        the clipboard
```

The reasoning, so a future pill can depart from it deliberately:

- **Leading actions open out of the app** (Wowhead, the model viewer, sound playback). They sit at the edge because they
  leave; the rest of the pill acts on the search.
- **Target icons come before the thing they describe**, not at the pill's leading edge — an icon stranded left of the
  action buttons reads as another button.
- **The swatch or icon is part of the name.** A colour pill's dot and its hex are one unit; an item's inventory icon
  sits flush against its name with nothing between them.
- **The label is the pill.** It is what the user reads, clicks, and searches by. Every pill has exactly one.
- **Notes qualify the label** and read dimmer and smaller than it: an attachment point, a counterpart count, a summon's
  control word.
- **Copy buttons close the pill.** They are the only segments whose click does not change the search.

## 3. Adding a pill type

Four steps. Nothing else in the app needs to know.

**a. Declare the type** in `pilltypes.ts`:

```js
T({
    key: "fx:sparkle",           // unique
    field: "fx",                 // which column / search field
    word: "sparkle",             // the category keyword (omit for none)
    hint: "Sparkle overlay (SpellSparkleEffect)",   // autocomplete description
    corpus: (d) => d.sparkleSearchL,   // id -> lowercase haystack
    spells: (d) => d.sparkleSpells,    // id -> spell ids
    targets: (d) => d.sparkleTargets,  // spell -> id -> target mask (see below)
    when: (d) => d.sparkleSpells.size > 0,   // optional availability gate
});
```

From that one record you get: the autocomplete word and its description, the group head and its tooltip, `.hit`
highlighting, and the spells the query selects. The fx column and the fx search both iterate the registry, so neither
needs editing.

**Declare `targets` if the pill draws target icons.** It is the one axis keyed by **(spell, id)** rather than by id
alone, because "who does this play on" is a fact about the ROW — the same chain is caster-side on one spell and
target-side on another. `data.ts` already builds these maps with `maskIndex`, so this is a one-line reference, not new
data.

Omitting it is a real decision and not a default: a type with no mask **answers nothing** to `fx:caster`, which is right
for a tint or a desaturation (they carry no targeting information) and wrong for anything that draws the icons. Getting
it wrong the other way is what the fx column did for a year — it drew the icons and offered the words in autocomplete
while `fx:caster` quietly fell through to corpus text, selecting the 32 spells with "caster" in an asset path while 27
of their cells lit their icons anyway. **The icons ask the mask; if the search cannot, the two are already lying to each
other.**

**b. Write the renderer** in `src/app/tags.ts`, as a segment list (§1).

**c. Give it a tone** in `app.css`, if it isn't reusing one:

```css
.tag.sparkle {
    --tone: var(--sparkle); /* a palette token, never a literal */
}
```

`--tone` is the whole colour contract: the generic `.tag` rule derives the pill's fill, its border and its label ink
from it, and each palette decides how loudly through `--tone-fill` / `--tone-edge` / `--ink-mix`. So a pill type never
writes a `color` or a `background` of its own — one line here colours the shape *and* the text, in every theme.

Two consequences worth knowing:

- **A shape with no pill of its own still needs a tone.** `--tone` also inherits from the column (`.c-models`,
  `.c-sounds`, …), which is what colours a kit box, its head, and a compact group's capsule. Give a new column a
  `--tone` there or its groups come out grey — on dark that is invisible (a 3% fill is a 3% fill), on a light palette it
  is the first thing you see.
- **Fills stack.** A compact group's field lies under its item's pill, so the two percentages add. Labels are solved
  against the loudest floor they ever land on; push a fill past that floor and text on it drops below AA. Re-run the
  contrast oracle (walk every text node, composite the ancestors' alphas, measure) after touching any of them.

**d. Add it to the cell** — for fx, one `pushCat({...})` call in `fxCell` saying how the spell's rows become pills. The
helper owns the shape every category shares (the head-vs-pill icon split, hit-floating, the group envelope), so a plain
category is four lines:

```js
pushCat({
    name: "sparkle",
    rows: sparkleIds,
    mask: (id) => maskOf(d.sparkleTargets, spellId, [id]),
    isHit: (id) => sparkleIsHit(id),
    render: (id, m) => sparkleTag(id, m),
});
```

It pushes nothing when `rows` is empty, so no `if` is needed around it.

**Rows are not always pills.** `pushCat` keeps two levels apart, and getting them right is the whole job:

|                          | what it is                                  | decides                                                                                       |
|--------------------------|---------------------------------------------|-----------------------------------------------------------------------------------------------|
| **source rows** (`rows`) | what the spell actually has in the category | the category's hit state, and — via `targetSplit` — whether the target icon can ride the head |
| **entries**              | what becomes a pill                         | the pills, through `render`                                                                   |

`entries(rows)` maps between them and is the only place a category's collapsing rule lives. Most categories **dedupe**
(chain, dissolve, glow, ghost, tint, keybind — rows sharing a texture or color become one pill and union their masks);
morph and shapeshift **expand** (one creature with three displays becomes three pills). Omit `entries` when the rows
already are the pills (summon, speed, scale, the invis/detect channels). When entries differ from rows, give
`entryIsHit` and `entryMask` too — their defaults (`isHit`, `mask`) are only correct when the two are the same thing.

Two escape hatches, both used exactly once:

- **`headMasks`** — which masks decide whether the icon can ride the head. Defaults to the source rows'. `keybind`
  overrides it to the *deduped* pills' masks, because a merged pill genuinely shows its members' union.
- **omitting `render`** — valueless categories (`freeze`, `camo`) whose clickable head IS the whole pill. They carry one
  nominal row so the category exists, and `entries: () => []`.

Don't reach for `targetSplit` directly; `pushCat` calls it. It stays exported only because the helper needs it.

### A FAMILY of types: declare the list once and let every surface read it

The four steps above are right for one type. **When you are adding a FAMILY that will grow — the spell attribute flags
are the first — do not write the family out four times.** Declare the members once and let the registry, both render
sites and the export all read that one list:

```js
export const ATTR_FLAGS = [];                  // filled by the helper below
const attrFlag = (key, field, word, handler, hint) => {
    T({key, field, word, hint, spells: (d) => d.spellAttrs.get(handler) || new Set(), ...});
    ATTR_FLAGS.push({handler, field, word, key});
};
attrFlag("mech:unbreakable", "mech", "unbreakable", "unbreakablechannel", "...");
```

`render.ts` then filters `ATTR_FLAGS` by `field` in each cell and `export.ts` maps over it, so **a member cannot be
searchable and undrawn, or drawn and unexportable.** That is the same failure the fx column shipped for a year, and the
fix is structural rather than remembered. The pack matches: one open-ended `spellAttrs` section keyed by handler, not a
key per flag — so adding a member is a `handler` tag in `build/enums/spell_attributes.json` plus one line here.

**The gate is `when`, not a version test.** `when: (d) => (d.spellAttrs.get(handler)?.size ?? 0) > 0` switches the word
off for a pack too old to carry it *and* for a game build whose data simply has none, without either case being named.

### Choosing the keyword

The registry decides **what a user can type**, so the choices there are product choices:

- **Check the word for collisions first, BY MEASURING IT.** Category words match *in addition* to file names, so a word
  that appears in the column's corpus drags unrelated results in. `creature` was rejected for this (~21% of model paths
  contain it) in favour of `display`; the model category `area` was renamed `ground` because `area` is also a target
  word. **An unregistered word is its own collision test** — search `mech:<candidate>` before you register it and the
  hit count IS the noise it will carry. Four candidates measured 0 that way in one call.
- **Not all overlap is equal: reject a word that matches something meaning the OPPOSITE.** `mech:actions` for
  `AllowActionsDuringChannel` measured +497 because `actions` is a substring of the aura name `MOD_NO_ACTIONS` — 342
  spells that specifically *cannot* act. It shipped as `unhindered` (0 collisions) instead. Compare `fx:tracking`, which
  carries +175 from spells literally named "Beast Tracking" / "Dragon Tracking": **that** overlap is the documented,
  defensible behaviour, because those spells really are about tracking. The test is not "does it overlap"
  but "does the overlap mean the same kind of thing".
- **Words name kinds of content; values are typed, not suggested.**
  Autocomplete offers `attach`, never `Chest`; `equipped`, never
  `equipped off hand`. The suggestion list is a menu of what can be *asked*, not of the answers.
- **A description is not optional.** A word with no `hint` autocompletes with a blank line beside it. (The one
  deliberate exception is a second type sharing an existing word — `fx:ghostmat` rides `fx:shadowy`'s "ghost".)
- Keep hints free of parentheses: `updateCategorySuggest` truncates at the first `" ("`.

### Numbers

Two axes, and the difference matters:

| axis                    | means                            | example                       |
|-------------------------|----------------------------------|-------------------------------|
| `numeric.kind: "count"` | how many things the id has       | a vehicle's seats             |
| `numeric.kind: "value"` | a measurement the id carries     | a desaturation percent        |
| `bare`                  | a bare number that **is** the id | an invisibility type, a spell |

**`bare` is also how an ID becomes searchable without poisoning a corpus**, and that is worth stating plainly because
the alternative was measured and rejected. `mech:"triggers 133"` matches by **equality** against the id the chip stands
for; putting the same id in the corpus instead makes every numeric token in the field match by substring, which broke a
bound number outright (`mech:"speed 70"` 76 → 85) and put 77% noise into `mech:"invis 13"` (11 → 47). **The corpus is
for words.** Anything with an id that a user might type exactly wants `bare`.

**A number is written as the category word, then its value** — `mech:"seat >2"`, `fx:"scale >100"`,
`mech:"speed <-50"`, `fx:"scale 50"` — which is the same shape as every other value in the language (`attach chest`,
`boneset upper body`, `count >4`). A type therefore never needs a second name for its number: the word it already has IS
the name. An earlier pass invented `seats`, `detectors` and `reveals` as separate axis names glued to their operators;
that gave the language a third way to attach a value and two words for one concept, and it was reverted.

**A plain number is the `=` you did not have to type.** `fx:"scale 50"` is `fx:"scale =50"` — a synonym, not a form of
its own, so there is one comparison grammar and omitting the operator picks its default. It is emphatically NOT an
absolute value: the sign is meaningful on every axis that has one (`fx:"scale -50"` shrinks), and folding it away would
leave no way to ask for one direction while `scale >0` and `scale <0` already say it.

`bindNumeric` (pills.ts) is what makes that precise. It takes the ONE token after the word — the same arity a meta
keyword has — out of the chip and asks the numeric axis instead, so the number never reaches the corpus.
`tokenMatches` tries the corpus first, so before this a bare `50` matched `+150%` as a substring long before it could be
tested as a number (349 rows became 483 on 9.2.7).

`operatorOnly: true` governs a number standing **loose** in the chip — one not written against its word — reserving it
for the text or `bare` axis. So `mech:"speed run 70"` still reads the corpus the pill prints, and `model:2` still
matches `cfx_fire_02.m2`. A type declaring `bare` is left alone by `bindNumeric` entirely: there the number after the
word is the id itself, which is what lets `mech:"invis 13"` mean channel 13 while `mech:"invis =0"` means the
invisibility nothing detects.

The search bar draws exactly this: `Pills.isValue` is the one predicate, and the bar's capsule asks it, so what is drawn
as a word-and-value and what binds as one cannot drift apart.

**A bound may be negative or fractional, because values are.** A movement-speed change is signed, so `fx:"speed <-50"`
asks for snares worse than half. A `count` axis is never negative and simply matches nothing against a bound it cannot
reach — no guard needed.

**THE WHOLE NUMERIC GRAMMAR LIVES IN `pills.ts` AND NOWHERE ELSE** — `CMP_OPS` / `NUM_SRC` (the alphabet, exported as
regex source so the tokenizer composes its own patterns from them), `VALUE_RE`, `isValue`, `hasOperator`, `numericTest`
and `matchNumeric`. It used to be spelled five times: search.ts carried a byte-identical copy of `numericTest` under the
name `numericPredicate`, "a comparison with its operator written" appeared twice more (search.ts and app/highlight.ts),
and app/query.ts's `GLUED_CMP` embedded the operator alternation a fifth time. Both files claimed in a comment to be its
single home and neither was. If you need "a comparison that wrote its operator", that is
`isValue(t) && hasOperator(t)` — do not respell the regex.

Where a value could be printed two ways, **ship the one the game stores**. Movement speed is the worked example: the
pill shows the change (`+70%`) and not the resulting speed (`170%`), because the change is what `EffectBasePoints`
holds, what the game's own tooltip prints, and the only form that survives the data's full range — 10 rows on 9.2.7 are
below −100%, which as a resulting speed would be negative. The friendlier reading rides the **tooltip**, where it is
free to be absent when it says nothing.

`count` is the reserved word for the column's own size, spelled the same way in every field —
`model:"count >4"`, `sound:"count =0"`, `model:"count 4"` — with a lone comparison (`model:>4`) as its shorthand. The
shorthand still needs its operator, and only the shorthand does: written against the word a bare number is that word's
argument like any other, but standing alone `model:4` is a substring search for "4" and always has been. Its source is
`COUNT_SOURCES` in `search.ts`, one entry per countable column. It counts the WHOLE column, not the rows matching the
chip's other tokens; narrowing that needs the column matchers rebuilt as per-spell entry iterators, which is its own
pass.

## 4. Groups

A group is a pill-shaped container of pills — a SoundKit and its files, an AnimKit and its animations, an fx category
and its effects:

```js
P.group({head: fxHeadTag(word, hit, mask), items: pills})
```

**The item count decides the shape, always.** A group holding **one item or none** renders as a single inline pill: the
head leading, the lone item fused into it. With more, it becomes a full-width strip. That is the whole reason groups are
an abstraction rather than markup — a group that is usually one-of-a-kind and occasionally many needs one renderer, not
two, and no caller has to predict which it will be.

**The head reads at full strength in both shapes.** A collapsed group's head is the same head as a full one — same word,
same job — so it was wrong to dim it to 0.8 (as the compact style once did, on the theory that a category word prefixing
a value is a qualifier). Dimming made one word two brightnesses depending only on how many siblings it happened to have.
The capsule below already separates category from value; it needs no brightness gradient's help. (Removed 2026-07-23.)

**In a collapsed group the head is separated from the item by a rounded capsule, never a flat divider** —
`( speed ( run | +70% ) )`, not `( speed | run | +70% )`. The capsule is what says "these are two different things, a
category and a value in it"; a flat divider says "these are parts of one label", which is what the dividers *inside* a
pill mean. Both marks are load-bearing, so they must not be traded for each other. This is a property of every group,
drawn by one CSS rule on `.kit-group.compact .kit-files` — there is deliberately no way for a renderer to opt out.
(There was once: a `flat` class three fx renderers set on themselves. It made percent, channel and speed pills the only
collapsed groups in the app whose head ran flat into their value, for no reason a user could infer. Removed 2026-07-23 —
same lesson as the `compact` flag before it.)

This is unconditional on purpose. It was once opt-in, and only the two columns whose author added the flag passed it, so
a SoundKit with one file and an AnimKit with one animation (56–98% of them, depending on the query) stretched across a
full strip while an identically-sized fx category sat inline. A rule that describes the shape of a group cannot be
something each caller remembers separately — if a future group needs a different shape rule, it belongs in `P.group`
keyed on something the group itself knows, not in a flag at the call site.

## 4-bis. Search hits float to the top of a cell

A results cell is an ordered list of **blocks** — a block is one loose pill *or* one group. Every pill-bearing cell
(models, sounds, animations, fx, mechanics) builds a `{el}[]` and hands it to **`renderBlocks(td, blocks)`**, which
floats the blocks holding a search hit to the top (stable partition, so with no active query nothing moves and the
deliberate order — e.g. loose model pills before their category groups — survives).

Two reasons this is one shared helper and not per-cell:

- **The thing you searched for should be visible.** `clampCell` hides overflow from the **bottom** behind a "+N more",
  so a hit stranded below a pile of non-matching pills (or below other groups) could be clamped away entirely. Floating
  it up is what keeps it on screen.
- **Consistency.** Before this, the fx cell did not float hit groups at all, and the models/animations cells floated hit
  *groups* but always drew their loose pills first — so a matched category sat below non-matching attach splits.
  Treating a loose pill and a group as the same kind of block makes "hits first" one rule for every column instead of
  three near-misses.

### The rank is READ OFF THE PILL — never re-derived beside the cell

**`P.holdsHit(el)` is the only answer to "does this hold a hit": the pill's own `.hit`, one segment's, or an item's
inside a group.** A block therefore has no `hit` field to disagree with what is on screen, and `groupBlock({items,
head, hit?, named?})` builds a group's items *first* so both of its answers come from them — items ordered by which hold
a hit, head told whether any of them does.

**This is the fix for a bug that shipped twice, and the second time is why the mechanism changed.** The block's rank
used to be a predicate written next to the cell (`modelFileIsHit`, the file corpus plus the category word). Segments
grew their own hit tests — `attach` first, then `motion` — which lit them gold while that predicate knew nothing about
them, so the row that was asked for sank to the **bottom** of its cell and the clamp hid it behind "+N more". Measured
on 9.2.7 the day it was fixed: `model:"motion parabola"` put the matched block last in **37 of 40** cells,
`model:"attach chest"` in **9 of 40**. Deriving the rank from the rendered pill fixed both at once and cannot be
re-broken by a new segment kind — which reading a predicate beside the cell can, and did.

The same rewrite removed three latent copies of the same mistake: a display pill and an item pill were both ranked by
`modelFileIsHit` although each computes a different hit of its own (`morphIsHit`, `itemIsHit`), and the mechanics cell
spelled `p.rows.some(mechanicIsHit)` twice — once for the pill, once for the block.

`hit` survives on `groupBlock` for one case only: a **valueless** fx category whose clickable head IS the whole pill and
which has no items to derive from (`freeze`, `camo`). It ORs in, never overrides.

**The target icons light too, and they are the one segment where a hit must NOT recolour.** `targetSeg(field, mask)`
gives `P.targets` its hit — the query named a target type this row's mask carries, tested through the engine's own
`Search.maskIsNamed` so what lights up and what was selected cannot drift. Before it, a target query lit *nothing*:
`model:caster` selected 101,307 spells and every cell kept its resting order, because there was no hit for `holdsHit` to
find. But these glyphs already carry meaning **in their colour** — caster dim, target mech-tone, area fx-tone,
never-caster danger — so `.ticons.hit` puts the gold *behind* the group as a capsule and the glyphs keep their hues,
exactly as `.tag.hit` washes a pill without touching its label. Tinting them gold would trade a type distinction for a
state one. Measured on real page loads, all three palettes: the capsule's 1px ring carries the state at **3.74:1**
(moonwell) and **3.68:1** (vellum) against the row — over the 3:1 non-text bar — and the glyphs stay **6.0:1** and
**12.5:1** on top of the wash. Text contrast is untouched in every palette (dark keeps only its known `.qchip-x`
failure). The field is per renderer, because a target word only ever means its own column.

Verified as a stable partition, not a re-sort: over 30 queries × 5 columns, **147 of 150 cell orderings came back
byte-identical**, all 30 result counts unchanged, and the three that moved were exactly the Models column under the two
attach queries and the motion query. Re-run that way after touching any of this — and note the trap it exposes:
**a cell snapshot that includes the clamp's "+N more" is not comparable across page states**, because a change in one
column's width re-clamps every other column. Exclude `.more` (or reveal the cell) before diffing.

## 5. Adding a segment kind

Rare — the eleven cover a lot — but it is one declaration plus one CSS rule:

```js
defineSegment("badge", {cls: "tag-badge", role: "meta", sep: "left"});
```

- `role` is `action`, `content` or `meta`. It sets the divider's weight (quiet between a label and its qualifier, firmer
  around action buttons) and documents intent.
- `sep` is `"left"`, `"right"` or `"none"` — rendered as `data-sep`, drawn by two generic rules. Do not add a border to
  the segment's own class.
- `inert: true` for something that must never become a button (target icons, colour swatches carry a title and nothing
  else).
- `wrapCls` for an image kind that needs an anchor around it when clickable.

Then a shorthand constructor beside the others, so pills read as named parts rather than `{kind: "badge", …}` literals.

**A width budget is a legitimate reason for a new kind.** `motion` (a missile's flight path) is a `note` in every
respect — same dim weight, same `role: "meta"`, same left divider — and exists only because it clamps at 9rem where a
note clamps at 14. The per-spell flight-path names run past 40 characters (`5.2 Legendary Scenario - Throw Axes`), and a
missile pill already spends its width on the model name plus a two-point attachment, so at a note's budget the `.lo`
copy button gets pushed out of the Models column. Measured: 0 overflowing blocks of 861 at 9rem. The full name rides the
tooltip, so the ellipsis costs nothing. Adding a `maxWidth` option to `note` was the alternative and was rejected — it
would put a layout number at every call site instead of in the stylesheet.

**A width budget for ONE pill is a class, not a kind.** `motion` earned a kind because any pill could want a
harder-clamped note. The spell-link chip's two clamps did not: `.link-name` (7rem) and `.link-kind` (5rem) are passed as
`opts.cls` and sized under `.tag.link` in app.css, because they describe how much room *this* pill can spare, not a
reusable budget. Same rule, opposite answer — ask whether the number belongs to the segment or to the pill.

**The spell-link chip is where the width rules got their hardest test, and it is worth reading as a worked example.** It
carries more than any other pill in its column — icon, spell name, spell id, target icons, joining words, three
commands — and the Mechanics column's width is whatever its widest chip needs. Three moves paid for the content:

- **The id IS the copy button.** A chip has to show the spell id (it is what `.cast` takes) and has to offer copying it;
  those are one control, exactly as the Name column's own id already is. A `⧉` beside a printed id spends width saying
  the same thing twice.
- **Commands wear Epsilon's own abbreviations.** `.c` / `.au` / `.lo` are real accepted spellings of `.cast` / `.aura` /
  `.lookup`, so the short label is honest rather than a private code. `SpellCommand.short` holds it beside the template,
  so what is shown and what is copied cannot drift; the row strip still shows the full label, where there is room.
- **The variable-length parts clamp, the fixed ones do not.** A name and a joining word are unbounded; an id and a
  command are not.

Measured on 9.2.7 (`mech:triggers`, 75 chips): widest chip **349 → 321 px** and the Mechanics column **437 → 434 px**,
while gaining the id, the target icons and a third command. The column is still ~70 px wider than the 364 px it wants
with no links at all — that residue is the content itself, and cutting it further means clipping spell names to about 12
characters, which is the wrong trade.

## 6. Tooltips

Never hand-write one. Every text segment composes the same three parts:

```
<what it is>                                                              opts.title
<details>                                                                 opts.detail — falsy lines dropped
Click: find <finds>                                                       from opts.finds
Shift-click: add to search · Ctrl-click: exclude · Middle-click: new tab
```

Use `opts.click` instead of `finds` when the click navigates rather than filters ("show the 3 counterparts"). A segment
with no `search` gets no action line and renders inert — that is how the priceless invisibility pill is built.

**A navigating segment keeps only the middle-click line.** The modifiers narrow what is on screen, and "the counterpart
of what is on screen" is a query for no spell — but a new tab has nothing on screen to narrow, so opening the segment's
own question in one is meaningful for every clickable segment. That asymmetry is the whole of `clickHint`.

**Every modifier is written into the tooltip, always.** It is what made them acceptable when a hidden keybinding was
not: a gesture nobody can discover is a gesture nobody has.

### The app draws it, not the browser (`src/app/tooltip.ts`)

**The composed string above is still the source of truth and nothing about writing one changes.** What changed is who
renders it: `title` handed the whole thing to the OS, which drew an unstyled box after a one-second wait and flattened
the structure the composer had just built. A panel in the app's own tones draws it instead — one delegated listener on
the document, so every `[title]` in the app inherits it and no renderer opts in.

Two things carry the panel, and both are read off content that already existed:

- **The left edge is the hovered pill's own `--tone`**, read from the element's computed value. A model tooltip is blue,
  a mechanic tooltip orange, so the panel says which column it came from before a word of it is read. It is deliberately
  **not** a copy of the game tooltip: Wowhead's real one is a few pixels away on the same row, and a near-miss beside
  the genuine article reads as a bad imitation.
- **The gesture lines become a two-column key map**, because that is what they always were — `title` is what flattened a
  key→action mapping into prose. Each gesture then renders as a **keycap**, the same one the help dialog's
  "Clicks and keys" band draws, so the actionable half of a panel is findable without reading it.

**The gestures are an explicit list (`GESTURES` in `pills.ts`), not "any line with a colon".** The counter-example is
already in the app: `cmd` writes "Copy:  .lookup object x.m2", which describes what lands on the clipboard rather than
instructing, and a colon rule would put it in a keycap. So the format is `Gesture: action` everywhere, and **a tooltip
written anywhere in the app — including index.html's static ones — gets the key map by matching it.** That is why the
column headers and the toolbar were rewritten to say "Click: sort by how many" rather than "Click to sort by count":
one shape, one renderer.

Adding a gesture is one entry in `GESTURES`. **Escape it** — the list is prose and `Alt + ← →` carries a `+`; as a raw
quantifier that alternative matches nothing, and since the scan walks BACK from the last line, one unmatchable gesture
at the bottom silently demotes every key line above it to prose.

**Two surfaces are excluded, on ownership rather than taste.** A `wowhead.com` link already shows Wowhead's tooltip —
the real in-game one — so ours must never stack on it; and `#q`'s title is rewritten on every mousemove by
`highlight.ts` §`barHover`, which hit-tests the bar's backdrop spans. That attribute is the bar's mechanism.

**The panel is a `popover`, and that is what lets it show over the help dialog.** A modal `<dialog>` renders in the
**top layer**, which no `z-index` can reach over — so the help was covering its own tooltips, which is where the detail
went when its prose came out (see the vocabulary in `app/help.ts`). A popover is promoted to that same layer, and the
top layer stacks in promotion order, so a tooltip opened while the dialog is up paints above it. It is
`popover="manual"`
because this is driven entirely by hover and focus: the light dismiss of `auto` would close it on the very click the app
is explaining, and auto popovers close each other. Feature-detected — where `showPopover` is missing the panel keeps its
`z-index` and behaves exactly as before, which is right everywhere except over a modal. The UA's popover defaults have
to be undone in CSS (`inset: 0` + `margin: auto` would centre it in the viewport).

**A title that was an element's only accessible name is replaced by an `aria-label` when it is hoisted.** A target icon
and a colour swatch have no text of their own, so taking `title` away without putting a name back would make them
unreadable to a screen reader. The hoist is what makes the panel possible at all — an attribute cannot be drawn by us
and suppressed in the browser at the same time — and a fresh `title` always wins, so an element that rewrites its own
keeps working.

## 7. Verifying a change

The DOM is the oracle. For a refactor that should not change what renders:
snapshot every pill-bearing cell across a query battery, canonicalize (attribute order is an artifact — sort it),
refactor, diff. The battery used for the segment-library refactor covered 54 queries × 4 rows × 5 columns = 900 cells
and reached all 23 renderers.

For anything that touches matching, also compare **search counts** for a set of queries covering each axis — text, bare
number, and both numeric kinds.

Local: `.claude/launch.json` serves `site/`. In-page,
`history.pushState(null,"","/?v=9.2.7&q=…")` followed by a `popstate` event re-runs a search without a reload — keep
`v=` in the URL or you will measure the default pack while thinking you measured another.
