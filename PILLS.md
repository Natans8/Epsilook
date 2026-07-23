# Pills — the design guide

Everything in a results column is a **pill**: a model file, a sound, a summoned creature, an invisibility channel. This
is how to add another one, and the conventions to follow while doing it.

Three files:

| file                   | holds                                                          |
|------------------------|----------------------------------------------------------------|
| `docs/js/pills.js`     | the segment library and the pill-type registry — the machinery |
| `docs/js/pilltypes.js` | one record per content type — the declarations                 |
| `docs/js/app.js`       | one renderer per pill type, and the cells that arrange them    |

`pills.js` depends only on `config.js` and never reaches into `app.js`. That is deliberate: it lets `search.js` read the
type registry too, so matching a query is written once instead of once per file.

---

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

**a. Declare the type** in `pilltypes.js`:

```js
T({
  key: "fx:sparkle",           // unique
  field: "fx",                 // which column / search field
  word: "sparkle",             // the category keyword (omit for none)
  hint: "Sparkle overlay (SpellSparkleEffect)",   // autocomplete description
  corpus: (d) => d.sparkleSearchL,   // id -> lowercase haystack
  spells: (d) => d.sparkleSpells,    // id -> spell ids
  when: (d) => d.sparkleSpells.size > 0,   // optional availability gate
});
```

From that one record you get: the autocomplete word and its description, the group head and its tooltip, `.hit`
highlighting, and the spells the query selects. The fx column and the fx search both iterate the registry, so neither
needs editing.

**b. Write the renderer** in `app.js`, as a segment list (§1).

**c. Give it a tone** in `app.css`, if it isn't reusing one:

```css
.tag.sparkle {
  --tone: #e0c0f0;
}
```

**d. Add it to the cell** — for fx, one `cats.push(...)` block saying how the spell's ids collapse into pills. Use
`targetSplit(masks)` for the icons:
`.head` for the category head, `.pill(mask)` for a row.

### Choosing the keyword

The registry decides **what a user can type**, so the choices there are product choices:

- **Check the word for collisions first.** Category words match *in addition*
  to file names, so a word that appears in the model corpus drags unrelated results in. `creature` was rejected for this
  (~21% of model paths contain it) in favour of `display`; the model category `area` was renamed `ground`
  because `area` is also a target word.
- **Words name kinds of content; values are typed, not suggested.**
  Autocomplete offers `attach`, never `Chest`; `equipped`, never
  `equipped off hand`. The suggestion list is a menu of what can be *asked*, not of the answers.
- **A description is not optional.** A word with no `hint` autocompletes with a blank line beside it. (The one
  deliberate exception is a second type sharing an existing word — `fx:ghostmat` rides `fx:shadowy`'s "ghost".)
- Keep hints free of parentheses: `updateCategorySuggest` truncates at the first `" ("`.

### Numbers

Two axes, and the difference matters:

| axis                    | means                            | example                |
|-------------------------|----------------------------------|------------------------|
| `numeric.kind: "count"` | how many things the id has       | a vehicle's seats      |
| `numeric.kind: "value"` | a measurement the id carries     | a desaturation percent |
| `bare`                  | a bare number that **is** the id | an invisibility type   |

`operatorOnly: true` reserves bare numbers for the text or `bare` axis, so only `<`, `>`, `<=`, `>=`, `=` reach the
number. That is what lets
`fx:"invis 13"` mean type 13 while `fx:"invis =0"` means the invisibility nothing detects — and why `model:2` still
matches `cfx_fire_02.m2`.

**A bound may be negative or fractional, because values are.** A movement-speed change is signed, so `fx:"speed <-50"`
asks for snares worse than half; `numericPredicate` (search.js) and `tokenMatches` (pills.js) parse the same shape and
must stay in step. A `count` axis is never negative and simply matches nothing against a bound it cannot reach — no
guard needed.

Where a value could be printed two ways, **ship the one the game stores**. Movement speed is the worked example: the
pill shows the change (`+70%`) and not the resulting speed (`170%`), because the change is what `EffectBasePoints`
holds, what the game's own tooltip prints, and the only form that survives the data's full range — 10 rows on 9.2.7 are
below −100%, which as a resulting speed would be negative. The friendlier reading rides the **tooltip**, where it is
free to be absent when it says nothing.

A whole-column count (`model:>4`) is a different feature: `COUNT_SOURCES` in
`search.js`, one entry per countable column.

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

**The head reads at full strength in both shapes.** A collapsed group's head is the same head as a full one — same
word, same job — so it was wrong to dim it to 0.8 (as the compact style once did, on the theory that a category word
prefixing a value is a qualifier). Dimming made one word two brightnesses depending only on how many siblings it
happened to have. The capsule below already separates category from value; it needs no brightness gradient's help.
(Removed 2026-07-23.)

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
(models, sounds, animations, fx) builds a `{hit, el}[]` and hands it to **`renderBlocks(td, blocks)`**, which floats the
blocks holding a search hit to the top (stable partition, so with no active query nothing moves and the deliberate order
— e.g. loose model pills before their category groups — survives).

Two reasons this is one shared helper and not per-cell:

- **The thing you searched for should be visible.** `clampCell` hides overflow from the **bottom** behind a "+N more",
  so a hit stranded below a pile of non-matching pills (or below other groups) could be clamped away entirely. Floating
  it up is what keeps it on screen.
- **Consistency.** Before this, the fx cell did not float hit groups at all, and the models/animations cells floated
  hit *groups* but always drew their loose pills first — so a matched category sat below non-matching attach splits.
  Treating a loose pill and a group as the same kind of block (each just `{hit, el}`) makes "hits first" one rule for
  every column instead of three near-misses.

Sorting *within* a group (hit items before the rest) is the same idea one level down, via `hitsFirst(items, …)` when
the group's items are built.

## 5. Adding a segment kind

Rare — the ten cover a lot — but it is one declaration plus one CSS rule:

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

## 6. Tooltips

Never hand-write one. Every text segment composes the same three parts:

```
<what it is>          opts.title
<details>             opts.detail — falsy lines dropped
Click: find <finds> · Shift-click: exclude     from opts.finds
```

Use `opts.click` instead of `finds` when the click navigates rather than filters ("show the 3 counterparts"). A segment
with no `search` gets no action line and renders inert — that is how the priceless invisibility pill is built.

## 7. Verifying a change

The DOM is the oracle. For a refactor that should not change what renders:
snapshot every pill-bearing cell across a query battery, canonicalize (attribute order is an artifact — sort it),
refactor, diff. The battery used for the segment-library refactor covered 54 queries × 4 rows × 5 columns = 900 cells
and reached all 23 renderers.

For anything that touches matching, also compare **search counts** for a set of queries covering each axis — text, bare
number, and both numeric kinds.

Local: `.claude/launch.json` serves `docs/`. In-page,
`history.pushState(null,"","/?v=9.2.7&q=…")` followed by a `popstate` event re-runs a search without a reload — keep
`v=` in the URL or you will measure the default pack while thinking you measured another.
