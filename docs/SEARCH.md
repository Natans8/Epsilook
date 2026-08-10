# Search 2.0 — the rulebook

**Status: DESIGN, approved in principle 2026-08-10. Nothing here is built yet.** The implementation plan, the measured
baselines and the session-by-session state live in `docs/PROCESS-LOG-search2.md`. This file is the LAW — what the search
system is allowed to be. Read it before adding any searchable thing.

Search 1.0 was not designed; it accreted. Every feature was individually correct and the sum has no stated rules, so
each new axis had to invent its own mechanism and the exceptions outnumber the rules. This document exists so that the
next axis is a declaration rather than an invention.

---

## 1. The laws

Eleven. Each names the defect it prevents, and every one of those defects is real and measured on 9.2.7 — see §6.

### L1 — One grammar, above all columns

A syntactic form means the same thing in every column, or it does not exist. **Negation, alternation, comparison,
quoting, grouping and `count` are properties of the LANGUAGE, not of a field.** No field may implement one, redefine
one, or decline one.

> Broke as: `count` is documented universal and implemented in three columns of eight.

### L2 — A universal is ANSWERED, never fallen through

When a universal form is applied where the data cannot answer it, the result is **empty** — never a different question.
Silence is a correct answer; substitution never is.

> Broke as: `mech:>4` = 13,199. `count` never ran, so the lone comparison fell through to every numeric pill axis in
> the column at once — seats, invisibility detectors, cast seconds, channel seconds and speed percent, unioned.

### L3 — A column is a set of ROWS; a chip is a predicate on ONE row

Every token in one chip must be satisfied by the **same row**. Chips combine at the spell level, never inside a row.

    model:"caster fireball"   one row that is both — not a caster row and a fireball row
    model:caster model:fire   two rows, either may satisfy either chip

This is the single most load-bearing invariant in the app and today it is hand-maintained in five separate matchers.
Making it structural is the whole reason the kernel exists.

### L4 — One word, one meaning, one mechanism

A word naming a concept means it identically everywhere. **If two mechanisms answer to one word, one of them is
renamed** — not documented, not special-cased.

> Broke as: `caster` is a target-mask bit test in model/sound/anim/fx and a substring match on enum names in mech.
> Same word, two unrelated mechanisms, five wildly different populations.

### L5 — Every axis has exactly two doors

A **global prefix** and an **in-column word**, always both, always the same semantics:

    desc:kneel              ≡  name:"desc kneel"
    attach:chest                any column, any row
    model:"attach chest"        that model row only  (L3 binds it)

The global door asks "does this spell have it anywhere". The in-column door additionally binds to the row. Nothing is
reachable through only one door.

> Broke as: `desc`, `icon`, `attach`, `boneset`, `motion`, `xpac`, `kit` are all in-column only, so a user who knows
> the concept cannot find the door.

### L6 — Arity is fixed, visible and equal to one

**A word takes the single token after it.** A quoted phrase is one token. This is the frozen rule from 1.0 and it
survives unchanged, including its rationale: an arity decided by the data cannot be seen or counted.

    model:"attach chest"      model:(attach "right hand")      id:"xpac >legion"

### L7 — Plain search is a DECLARED union, ranked

Chipless search reads exactly the axes that declare `plain: true`, and the answer is readable in one place rather than
inferred from five `run()` bodies. Each contributing axis carries a **relevance tier**, so a name hit always outranks a
description hit.

> Broke as: today's `FIELDS.all` is a hand-written list of seven calls, and the ranking reads the NAME alone — so a
> description-only hit sits in the same bucket as an exact name match, with nothing to sink it.

### L8 — Order is meaningless unless you asked for it

Bare chips **commute** and narrow (AND). `−` and `+` are ordered and apply left to right over a working set:

    model:fire model:missile   AND, order-free — dragging a chip cannot change the result
    model:beer -model:bee      369 beers, then every "bee" cut          →  0
    -model:bee +model:beer     all spells, bees cut, beers re-admitted  →  369

The working set starts **∅** when the first rule is positive and **ALL** when it is negative. `+` is the only way to
re-admit, and it exists because *substring precision cannot do this job* — see §3.

### L9 — A number's meaning is declared per axis, never inferred from its shape

`50` is a percent to `scale`, a channel to `invis`, a seat count to `seat`, a spell id to `triggers` and a substring to
a file path. **The axis says which.** A bare number never acquires meaning by looking numeric.

### L10 — No display state may reach a result set

Hidden columns, theme, sort and the height clamp are display. A URL must yield the same spells for everyone. *(Held in
1.0. Kept verbatim — it is the one law that never broke.)*

### L11 — A declaration is COMPLETE

Registering an axis must yield, with no further edits: the search, the autocomplete entry, the help-dialog row, the bar
capsule, the hit-highlight and the export column. **If a surface needs a second list, the design is wrong.**

> Broke as: `desc` shipped fully searchable and absent from the help, the suggestions and the capsules, because
> `fieldCategories` gated them behind a literal field allowlist — with a second copy of that literal in `help.ts`.

---

## 2. The shape — one structure, callbacks for logic

Three objects. Change the first for a new **syntax**, the second for a new **capability**, and never the third.

```
grammar.ts   →  GRAMMAR   how a query STRING becomes a structured query
axes.ts      →  AXES[]    what can be ASKED
kernel.ts    →  the evaluator — knows GRAMMAR and AXES, and no field name anywhere
```

### 2.1 `GRAMMAR` — the syntax, swappable in one edit

Every sigil, operator and bracket the language uses, in one record. Rewriting the syntax tomorrow is editing this and
nothing else.

```ts
export const GRAMMAR = {
  fieldSep:   ":",                       // model:fire
  negate:     "-",                       // -model:bee        (ordered, L8)
  readmit:    "+",                       // +model:beer       (ordered, L8)
  alternate:  ["|", ","],                // fire|frost   133,134
  compare:    ["<=", ">=", "<", ">", "="],
  phrase:     '"',                       // one token, spaces kept (L6)
  group:      ["(", ")"],                // a value containing phrase quotes
  wildcard:   "*",                       // §3 — declared, deliberately limited
  countWord:  "count",                   // the universal cardinality axis (L1)
} as const;
```

### 2.2 `Axis` — the single structure

Everything that is a separate mechanism in 1.0 — a field's `run()`, a meta keyword, a target word, `count`, a pill
type's corpus — is **one record shape**:

```ts
export interface Axis {
  /** Stable identity. "model.file", "name.desc", "*.count", "*.target". */
  id: string;

  /** The two doors of L5. `word` omitted = the column's default axis. */
  prefix?: string;                    // desc:kneel
  word?: string;                      // model:"attach chest"

  /** Which column's rows it reads. "*" = universal: the kernel applies it to EVERY column. */
  column: string | "*";

  /** What a token means here (L9) — the kernel dispatches on this, nothing else does. */
  kind: "text" | "set" | "numeric" | "mask" | "id" | "cardinality";

  /** L6: tokens consumed after `word`. Always 0 or 1. */
  arity: 0 | 1;

  /** L7: does chipless search read it, and how hard does it rank? */
  plain: boolean;
  tier?: number;                      // 0 = exact name … 3 = description

  /** L11: everything every surface needs, stated once. */
  hint: string;
  when?(d: SpellData): boolean;       // absent data = absent word, everywhere

  /** THE ONLY CALLBACK. A predicate on ONE row (L3). The kernel owns
   *  the walk, the ∃ over rows, the set algebra and the ordering. */
  test(row: Row, q: AxisQuery, d: SpellData): boolean;
}
```

### 2.3 `Column` — rows, and nothing else

A column stops being a `run()` function and becomes a **row source**. This is what collapses `spellsByModel`,
`spellsBySound`, `spellsByAnim`, `spellsByFx`, `spellsByName` and the mech sweep into one evaluator.

```ts
export interface Column {
  key: string;                        // "model"
  label: string;                      // "Model"
  icon: string;                       // §5 — the column's glyph
  rows(d: SpellData, spellId: number): Row[];
  size?(d: SpellData, spellId: number): number;   // fast path for *.count
}

export interface Row {
  mask?: number;                      // target bits — makes *.target universal for free
  corpus?: string;                    // lowercase haystack
  num?: Record<string, number>;       // named numeric axes on this row
  ref?: number;                       // the id the row stands for
}
```

**What falls out for free, with no per-field code:**

| today                                                      | 2.0                                                                       |
|------------------------------------------------------------|---------------------------------------------------------------------------|
| `COUNT_SOURCES`, 3 of 8 columns                            | `*.count` reads `rows().length`. Universal by construction (L1).          |
| `TARGET_TESTS` + `splitTargetTokens`, 4 hand-wired columns | one `*.target` axis over `Row.mask`. Any column with masked rows gets it. |
| `splitKeyword` + `META_KEYWORDS`                           | axes with a `word`. No separate registry.                                 |
| 5 hand-written row-walk fast paths                         | the kernel's one walk.                                                    |
| `FIELDS.all`'s 7 hand-written calls                        | `AXES.filter(a => a.plain)`.                                              |

---

## 3. Wildcards, and why precision cannot replace ordering

**Measured 2026-08-10, and it is the finding that decided L8.** WoW asset paths carry no word segmentation:

```
beecreature.m2        beerfest_keg01.m2         hangingbeetle01.m2
beemount.m2           beerfest_beervendor.m2    8riv_beeflowers_b01.m2
```

Split on `_` and the words are `beecreature` and `beerfest` — **neither equals `bee` nor `beer`**. So an exact-word or
anchored operator does not separate bees from beers; it breaks both. Substring matching is not a sloppy default here, it
is **forced by the corpus**, and no amount of matching precision can express "bees out, beers in".

That is the whole justification for ordered `−`/`+` (L8). Do not re-propose anchoring as an alternative to it.

**Wildcards are therefore scoped deliberately narrow.** `*` is useful where a corpus DOES have structure — spell names,
enum names, icon names — and useless-to-harmful on paths:

    mech:unit_target_*        enum names are underscore-delimited and genuinely segmented
    name:"icon spell_fire_*"  icon names likewise
    model:bee*                allowed, but matches beerfest — say so in the hint, do not pretend otherwise

---

## 4. What a user types — the resolved surface

Not a wish list; the direct consequence of L1–L11.

```
fireball                         plain: every axis with plain:true, ranked by tier      (L7)
model:fire model:missile         two rows, AND, order-free                              (L8)
model:"fire missile"             ONE row that is both                                   (L3)
model:fire|frost                 alternation, distributed by the kernel                 (L1)
-model:bee +model:beer           ordered subtract then re-admit                         (L8)
count:>4                         universal — every column, every time                   (L1)
model:"count >4"                 the same axis, scoped to one column                    (L5)
target:caster                    universal — any column whose rows carry a mask         (L4)
model:caster                     the same axis, scoped                                  (L5)
desc:kneel  ≡  name:"desc kneel" two doors, one axis                                    (L5)
attach:chest                     global; model:"attach chest" binds the row             (L3/L5)
mech:unit_target_enemy           implicit targets by their own enum name                (L4)
```

**`caster` is fixed by L4**: it is the mask axis everywhere. The mech column's enum-name matching keeps its own axis and
its own word, so `mech:caster` stops meaning something no other column means.

---

## 5. What this must still host (designed for, not built)

The kernel is being built now so these cost a declaration later, not a redesign. Each is a queued item in the process
log.

- **Spell range**, including *unlimited* — a numeric axis with a sentinel, exactly like `channeled unlimited`.
- **The effect dictionary** — meaningful `SpellEffect`/`EffectAura` types promoted to real pills (`JUMP_DEST`,
  `FEATHER_FALL`, …), with the raw enum pill **consumed** by its implementation the way `APPLY_AURA` already is. A
  promoted effect is one dictionary row; an unpromoted one still renders and still searches. `Row.ref` is the hook.
- **fx / mech redistribution** — `Column.key` on the axis is the whole of "which column is this", so moving a pill is a
  one-word edit. The current line ("can you see it?") is kept until the dictionary lands and can be re-drawn.
- **Column iconography** — `Column.icon`: cube (models), note (sound), gear (mech), sparkle (fx), rig (animation).
- **Editor conveniences** — auto-closing `"` and `)`, keyword autocomplete that inserts the parent chip, the vocabulary
  presented before a key is pressed rather than after two.

---

## 6. The measured defects this replaces

All 9.2.7, all reproduced through `npm run query`, 2026-08-10. These are the regression targets: 2.0 must fix each one
and change nothing else.

| query                   | 1.0            | why                                                           | law |
|-------------------------|----------------|---------------------------------------------------------------|-----|
| `mech:"count >4"`       | **0**          | mech is not in `COUNT_SOURCES`                                | L1  |
| `fx:"count >2"`         | **0**          | nor is fx — and `search.ts:144` advertises this exact example | L1  |
| `name:"count >2"`       | **0**          | nor name                                                      | L1  |
| `mech:>4`               | **13,199**     | fell through to every numeric pill axis at once               | L2  |
| `mech:caster`           | **193,912**    | substring on enum names                                       | L4  |
| `model:caster`          | 101,307        | mask bit — the same word, another mechanism                   | L4  |
| `fx:caster`             | 14,641         | mask bit                                                      | L4  |
| `model:beer -model:bee` | **0**          | every beer contains "bee"; unexpressible in 1.0               | L8  |
| `desc:arcane`           | *no such door* | reachable only as `name:"desc arcane"`                        | L5  |

### The battery is a DIFF INSTRUMENT, not a pass gate

**We are reinventing, not repairing** (user, 2026-08-10: *"deconstruct the entire bitch if that's what it takes"*). So
the 40-query canonical battery in `CLAUDE.md` is **not** an acceptance test for 2.0 — freezing those numbers would
freeze 1.0's mistakes, several of which are listed in §7 as things to delete.

The rule instead: **run all 40 before and after, and every number that moves must be explained and intended.** A changed
count is a finding to write down, not a failure. An *unexplained* changed count is the failure. This is the same
discipline the format-35 and format-40 corpus additions used, where three `mech:` numbers moved and each delta was
decomposed and justified before it was believed.

---

## 7. What we are NOT keeping

The laws above kill several things 1.0 documents as deliberate. Each is listed here so the deletion is a decision on the
record rather than something a future session "fixes" back in.

### 7.1 Corpus bleed — "a category word also matches file names"

1.0's rule: `fx:glow` matches the `glow` category **and** `beam_webglowwhite`; `anim:loose` matches loose animations
**and** `Attack2HLoosePierce`. Documented as intended behaviour, and it is **the same defect as `mech:caster`**: one
word, two mechanisms, no way to say which you meant (L4).

It also silently pollutes counts — `mech:triggers` is 49,216 against 49,209 real link sources, the 7 extra being spells
reached from ones literally named "… Area Triggers".

**2.0: the category word and the corpus are separate axes with separate doors.** The union stays available because it is
genuinely useful, but it becomes something you *ask for* rather than something you cannot avoid.

### 7.2 `orGroups` — the exact-ID union special case

`id:133 id:134` unions today because ANDing two spell ids could never match. That is a special case in the evaluator to
paper over the lack of a general alternation at the time. **Alternation now exists** (`id:133,134`), so the special case
goes and `id:133 id:134` means what L8 says it means: AND, therefore empty.

### 7.3 `field` and `column` as the same concept

1.0 makes a searchable thing require a results column to live in — which is why `desc`, `icon` and `xpac` had to be
smuggled in as keywords inside a host column that renders something else entirely.

**2.0 separates them.** An **axis** is a question; a **column** is a rendering. Most axes read a column's rows, some
read none, and an axis may exist with nothing drawn for it. This is the change that makes the effect dictionary (§5)
cost a declaration: a promoted effect becomes searchable whether or not it has earned a pill yet.

### 7.4 `all` as a pseudo-field

`FIELDS.all` is a field that is not a field — no prefix, no column, a hand-written body calling seven others. Under L7
plain search is `AXES.filter(a => a.plain)` and there is nothing to declare.

### 7.5 Relevance ranked on the name alone

`sortByRelevance` scores exact/prefix/substring against the spell NAME, so a description hit and an exact-name hit land
in the same bucket. Under L7 the tier is the axis's own property and the sort reads it.

### 7.6 Legacy field aliases

`effect:` → `fx:`, `soundkit:` → `sound:`, `animkit:` → `anim:`. The user has retired backwards compatibility for this
work (*"the app is too young to worry about old links"*), and the app's own standing norm on renames is no legacy alias.
They go.
