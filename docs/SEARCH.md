# Search 2.0 — the rulebook

**Status: DESIGN, approved in principle 2026-08-10. Nothing here is built yet.** The implementation plan, the measured
baselines and the session-by-session state live in `docs/PROCESS-LOG-search2.md`. This file is the LAW — what the search
system is allowed to be. Read it before adding any searchable thing.

Search 1.0 was not designed; it accreted. Every feature was individually correct and the sum has no stated rules, so
each new axis had to invent its own mechanism and the exceptions outnumber the rules. This document exists so that the
next axis is a declaration rather than an invention.

---

## L0 — FOLLOW CONVENTION. This law governs the other eleven

**User's standing rule, 2026-08-10: *"follow convention and design patterns wherever possible."*** Before inventing a
syntax, a semantic or a UI affordance, find out what the established systems do and adopt it. A user arriving at
Epsilook already knows Google, GitHub and Wowhead; every place this app differs from them is a thing they must be
taught, and teaching is a cost paid by every visitor forever.

**This law has already earned its keep once, by killing a design I had argued for and the user had approved.** The
ordered `−`/`+` pipeline in the first draft of this file was bespoke, and one round of reading — Lucene, Solr,
Elasticsearch, Google, GitHub, gitignore, rsync — showed both that no search engine works that way and *why*. See §3.

**The families, so the next question starts from the map rather than from scratch:**

| family                          | who                                          | bare term                   | negation          | order        |
|---------------------------------|----------------------------------------------|-----------------------------|-------------------|--------------|
| **relevance**                   | Lucene, Solr, Elasticsearch, Azure AI Search | `SHOULD` — optional, scores | `-` prohibited    | irrelevant   |
| **filter** ← *Epsilook is here* | Google, GitHub, Gmail, Jira, Kibana          | `MUST` — implicit AND       | `-` prohibited    | irrelevant   |
| **pattern list**                | gitignore, rsync, iptables, CSS              | a rule in a sequence        | `!` / `--exclude` | **decisive** |

Epsilook returns **sets**, not ranked documents, so it belongs to the filter family and should look like GitHub's search
box. Reach for the pattern-list family only for something that genuinely is an ordered rule list — and note that nothing
in a search query is.

---

## 1. The laws

Eleven, under L0. Each names the defect it prevents, and every one of those defects is real and measured on 9.2.7 — see
§7.

### L1 — One grammar, above all columns

A syntactic form means the same thing in every column, or it does not exist. **Negation, alternation, comparison,
quoting, grouping, wildcards and `count` are properties of the LANGUAGE, not of a field.** No field may implement one,
redefine one, or decline one.

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

**Negation is the negation of the existential**, which is the conventional reading (Lucene nested queries, SQL `NOT
EXISTS`) and the one every user expects: `-model:caster` is *"has no caster model row"*, never *"has a row that is not
caster"*.

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

**Negation in plain is the complement of the positive**: `-arcane` removes every spell that `arcane` selects, across
every `plain` axis. One rule, no special case. It is deliberately broad — the narrow form is a chip (`-name:arcane`),
which is L5's two doors doing their job.

> Broke as: today's `FIELDS.all` is a hand-written list of seven calls, and the ranking reads the NAME alone — so a
> description-only hit sits in the same bucket as an exact name match, with nothing to sink it.

### L8 — ORDER NEVER MATTERS

Chips commute. Bare chips are **required** (implicit AND); `-` chips are **prohibited**. This is the filter family's
convention (L0) and it is what Epsilook already does — the value of writing it down is that it is now a law rather than
an accident, and that the bespoke alternative is closed.

    model:fire model:missile   ≡  model:missile model:fire
    model:bee -model:beer      ≡  -model:beer model:bee        →  19

**⛔ THERE IS NO `+` AND NO ORDERED OVERRIDE.** Both were designed, approved and then deleted the same session — see §3,
which is the whole argument. Do not reintroduce them.

### L9 — A number's meaning is declared per axis, never inferred from its shape

`50` is a percent to `scale`, a channel to `invis`, a seat count to `seat`, a spell id to `triggers` and a substring to
a file path. **The axis says which** — through its declared type (§4). A bare number never acquires meaning by looking
numeric.

### L10 — No display state may reach a result set

Hidden columns, theme, sort and the height clamp are display. A URL must yield the same spells for everyone. *(Held in
1.0. Kept verbatim — it is the one law that never broke.)*

### L11 — A declaration is COMPLETE

Registering an axis must yield, with no further edits: the search, the autocomplete entry, the help-dialog row, the bar
capsule, the hit-highlight, the filter affordance (§4) and the export column. **If a surface needs a second list, the
design is wrong.**

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

```ts
export const GRAMMAR = {
    fieldSep: ":",                       // model:fire          GitHub/Gmail convention
    negate: "-",                       // -model:beer         universal convention
    alternate: ["|", ","],                // fire|frost   133,134
    compare: ["<=", ">=", "<", ">", "="],
    phrase: '"',                       // one token, spaces kept (L6)
    group: ["(", ")"],                // a value containing phrase quotes
    wildcard: "*",                       // §3
    countWord: "count",                   // the universal cardinality axis (L1)
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

    /** §4 — drives BOTH how a token matches and what the UI offers. */
    type: AxisType;

    /** L6: tokens consumed after `word`. Always 0 or 1. */
    arity: 0 | 1;

    /** L7: does chipless search read it, and how hard does it rank? */
    plain: boolean;
    tier?: number;                      // 0 = exact name … 3 = description

    /** L11: everything every surface needs, stated once. */
    hint: string;

    when?(d: SpellData): boolean;       // absent data = absent word, everywhere

    /** THE ONLY CALLBACK. A predicate on ONE row (L3). The kernel owns
     *  the walk, the ∃ over rows, the set algebra and the negation. */
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
    icon: string;                       // §6 — the column's glyph
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
| `HAS_CATEGORY` tri-state filter row                        | a rendered affordance of a typed axis (§4).                               |

---

## 3. Why there is no `+`, and what wildcards are for

**Measured 2026-08-10. This section exists because the opposite was designed, approved, and deleted the same day — it is
the most expensive finding in the file and must not be re-derived.**

### 3.1 The bee/beer problem does not exist, and the operator was solving nothing

**The whole ordered-`+` design was built to satisfy "find beer without bee junk". Measured, that need is already met by
the shortest possible query, with no operator:**

```
model:beer             369        ← ALREADY beer with no bee junk
model:bee              388        ← beer ⊂ bee, as substring-match sets
model:bee -model:beer   19        ← the actual bees. Works today, order-free.
model:beer -model:bee    0        ← unsatisfiable BY DEFINITION
```

**Zero files in the entire listfile are both a bee and contain the string `beer`** (checked in SQL over every `.m2`). A
bee is `beecreature.m2` / `beemount.m2` / `hangingbeetle01.m2`; none of them contains `beer`, so none of them can appear
in a `beer` search. **Searching the longer string IS the more specific search** — that is what substring matching gives
you for free, and it only runs one way.

So `-model:bee` was never removing junk from a beer search; it removes *everything*, because every beer contains "bee".
"Matches beer AND NOT matches bee" is **provably empty**, and 0 is the correct answer. An ordered `+` returning 369
would not express something AND/NOT cannot — it would **override a constraint to produce a set contradicting its own
query**. That is what a firewall does, and it is why no search engine in the L0 table works that way.

**The general rule, which is the useful thing to carry forward: subtract the MORE SPECIFIC pattern from the LESS
specific one.** `model:bee -model:beer` = 19. `model:fire -model:firefly`. The direction that fails is the one that was
already empty before you typed the operator.

### 3.2 Anchoring cannot substitute either

Asset paths carry no word segmentation:

```
beecreature.m2      beerfest_keg01.m2        hangingbeetle01.m2
beemount.m2         beerfest_beervendor.m2   8riv_beeflowers_b01.m2
```

Split on `_` and the words are `beecreature` and `beerfest` — **neither equals `bee` nor `beer`**. An exact-word or
anchored operator separates nothing and breaks both halves. **Substring matching is forced by the corpus.** Do not
propose word-boundary anchoring; do not propose ordered override. Both are closed.

### 3.3 `*` — one rule, and the filter buttons fall out of it

**`*` matches any value of the axis.** That single rule gives three readings that all coincide, so there is no special
case to remember:

    *                every spell            — replaces the `-id:0` hack
    model:*          has any model row      ≡ the filter button, ON
    -model:*         has no model row       ≡ the filter button, OFF
    mech:unit_target_*   prefix glob, on a corpus that IS segmented
    model:bee*       prefix glob — still matches beerfest, and the hint says so

**Negation composes without a rule of its own**, which is the test that the single rule is right: `-model:*` is L3's
negated existential ("no model row"), and it is exactly the tri-state filter row's third state. `-*` is the empty set —
degenerate, consistent, harmless.

Text globbing is honest but weak on paths (§3.2) and genuinely useful on segmented corpora — enum names, icon names,
spell names. The hint tells the truth rather than implying precision the corpus cannot deliver.

---

## 4. Axis TYPES — the same declaration drives matching and UI

**The user's call, 2026-08-10: *"keywords can have datatypes… a % keyword, an enum selection keyword, a string keyword
an ID keyword, a mixed keyword, could behave differently in the UI."*** This is L9 and L11 meeting: the type says what a
token means AND what the user is offered instead of having to type it.

| type       | examples                                         | matches                                | UI affordance                             |
|------------|--------------------------------------------------|----------------------------------------|-------------------------------------------|
| `text`     | model/sound file, spell name, description        | substring + glob                       | text input, autocomplete on the axis word |
| `enum`     | effect / aura / implicit target names, expansion | exact, then substring, then glob       | **picker listing the enum's real values** |
| `percent`  | scale, speed, desaturate, transparency           | signed numeric compare                 | **range control, `%` suffix, sign-aware** |
| `duration` | casttime, channeled                              | numeric compare + `unlimited` sentinel | numeric input, `s` suffix                 |
| `count`    | `count`, seat                                    | integer compare, ≥ 0                   | stepper                                   |
| `id`       | spell id, SoundKit id, icon fid                  | **equality only, never substring**     | exact input + copy button                 |
| `flag`     | attribute bits, freeze, camo                     | membership; valueless                  | **tri-state toggle**                      |
| `mask`     | the target words                                 | bit test                               | **the target glyphs, as toggles**         |
| `mixed`    | the sound column (files ∪ kit names ∪ ids)       | union of its sub-axes                  | composite of the above                    |

**`flag` vs `mask` — they look alike and are not.** A `flag` is ONE bit on a SPELL, valueless, with no combinations:
you have `unbreakable` or you do not. A `mask` is SEVERAL bits on a ROW, and the combinations are the entire point —
from `build_data.py`, `caster 1 · target 2 · area 4 · not-caster 8 · missile-dest 16`, so `target` is the test
`2|8`, `area` is `4|16`, and **`both` is `1 AND 2`, a question no single bit spells**. Per-row because the same chain
plays on the caster for one spell and the target for another. Different arity, different affordance, two types.

**This is also the answer to *"why do we need 3 keywords exactly instead of just `target caster`"*** (user's brief).
Under L5 you get exactly that — `target:caster`, `target:area`, `target:both` — one keyword with named values, global.
The five words stop being independent vocabulary scattered across four columns and become **one `mask` axis**;
`model:caster` survives as its scoped form.

Two consequences worth stating, because both remove existing hand-written UI:

- **The tri-state filter row and the target icons stop being features** and become the rendered form of a `flag` and a
  `mask` axis. One declaration, two surfaces, no second list (L11).
- **`enum` axes become browsable**, which is the direct answer to *"I find myself way too often opening wago.tools when
  Epsilook doesn't provide"* — the values exist in the pack already; nothing offers them. **`mech:unit_target_enemy`
  already works today** (21,109 on 9.2.7); what is missing is anything that tells you the value exists.

---

## 5. The empty state

**Decided 2026-08-10: an empty query shows EVERY spell, with a vocabulary strip above the results.** The examples panel
goes — the user's assessment is that it is outdated, and a hand-written example list is exactly the kind of thing L11
forbids.

This settles three complaints at once: `-id:0` stops being the way to see everything (§3.3), the tool reads as something
you *narrow* rather than something you must know how to address, and the searchable vocabulary is on screen before a key
is pressed. The strip is generated from `AXES`, so it cannot go stale.

Exclusion-only queries already return ~all spells today and render fine — only `scrollBatch` rows are built and icons
are per-row lazy — so this is not a new performance case.

---

## 6. What this must still host (designed for, not built)

- **Spell range**, including *unlimited* — a `duration`-shaped numeric axis with a sentinel, exactly like `channeled`.
- **The effect dictionary** — meaningful `SpellEffect`/`EffectAura` types promoted to real pills (`JUMP_DEST`,
  `FEATHER_FALL`, …), with the raw enum pill **consumed** by its implementation the way `APPLY_AURA` already is. A
  promoted effect is one dictionary row; an unpromoted one still renders and still searches. `Row.ref` is the hook.
- **fx / mech redistribution** — `Column.key` on the axis is the whole of "which column is this", so moving a pill is a
  one-word edit.
- **Column iconography** — `Column.icon`: cube (models), note (sound), gear (mech), sparkle (fx), rig (animation).
- **Editor conveniences** — auto-closing `"` and `)`, keyword autocomplete that inserts the parent chip.

---

## 7. The measured defects this replaces

All 9.2.7, reproduced through `npm run query`, 2026-08-10.

| query             | 1.0                     | why                                                           | law |
|-------------------|-------------------------|---------------------------------------------------------------|-----|
| `mech:"count >4"` | **0**                   | mech is not in `COUNT_SOURCES`                                | L1  |
| `fx:"count >2"`   | **0**                   | nor is fx — and `search.ts:144` advertises this exact example | L1  |
| `name:"count >2"` | **0**                   | nor name                                                      | L1  |
| `mech:>4`         | **13,199**              | fell through to every numeric pill axis at once               | L2  |
| `mech:caster`     | **193,912**             | substring on enum names                                       | L4  |
| `model:caster`    | 101,307                 | mask bit — the same word, another mechanism                   | L4  |
| `fx:caster`       | 14,641                  | mask bit                                                      | L4  |
| `desc:arcane`     | *no such door*          | reachable only as `name:"desc arcane"`                        | L5  |
| `-id:0`           | *the "everything" hack* | no `*`, so the empty set's complement is the idiom            | L1  |

### The battery is a DIFF INSTRUMENT, not a pass gate

**We are reinventing, not repairing** (user: *"deconstruct the entire bitch if that's what it takes"*). The 40-query
canonical battery in `CLAUDE.md` is **not** an acceptance test — freezing those numbers would freeze the mistakes §8
deletes on purpose.

The rule instead: **run all 40 before and after, and every number that moves must be explained and intended.** A changed
count is a finding to write down; an *unexplained* changed count is the failure.

---

## 8. What we are NOT keeping

### 8.1 Corpus bleed — "a category word also matches file names"

1.0's rule: `fx:glow` matches the `glow` category **and** `beam_webglowwhite`. Documented as intended, and it is **the
same defect as `mech:caster`**: one word, two mechanisms, no way to say which you meant (L4). It silently pollutes
counts — `mech:triggers` is 49,216 against 49,209 real link sources.

**2.0: the category word and the corpus are separate axes with separate doors.** The union stays available because it is
useful, but it becomes something you *ask for*.

### 8.2 `orGroups` — the exact-ID union special case

`id:133 id:134` unions today because ANDing two spell ids could never match — a special case papering over the lack of
alternation at the time. **Alternation now exists** (`id:133,134`), so it goes and `id:133 id:134` means what L8 says.

### 8.3 `field` and `column` as the same concept

1.0 makes a searchable thing require a results column, which is why `desc`, `icon` and `xpac` were smuggled in as
keywords inside a host column that renders something else. **2.0 separates them**: an axis is a question, a column is a
rendering, and an axis may exist with nothing drawn for it. This is what makes the effect dictionary (§6) cost a
declaration.

### 8.4 `all` as a pseudo-field

A field that is not a field — no prefix, no column, a hand-written body calling seven others. Under L7 plain search is
`AXES.filter(a => a.plain)`.

### 8.5 Relevance ranked on the name alone

`sortByRelevance` scores against the spell NAME, so a description hit and an exact-name hit land in the same bucket.
Under L7 the tier is the axis's own property.

### 8.6 Legacy field aliases

`effect:` → `fx:`, `soundkit:` → `sound:`, `animkit:` → `anim:`. Backwards compatibility is waived for this work (*"the
app is too young to worry about old links"*), and the app's standing norm on renames is no legacy alias.

### 8.7 The examples panel

Replaced by §5's vocabulary strip, which is generated and therefore cannot rot.
