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

    model:(caster fireball)   one row that is both — not a caster row and a fireball row
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

    desc:kneel              ≡  name:(desc kneel)
    attach:chest                any column, any row
    model:(attach chest)        that model row only  (L3 binds it)

The global door asks "does this spell have it anywhere". The in-column door additionally binds to the row. Nothing is
reachable through only one door.

> Broke as: `desc`, `icon`, `attach`, `boneset`, `motion`, `xpac`, `kit` are all in-column only, so a user who knows
> the concept cannot find the door.

### L6 — Arity is fixed, visible and equal to one

**A word takes the single token after it.** A quoted phrase is one token. This is the frozen rule from 1.0 and it
survives unchanged, including its rationale: an arity decided by the data cannot be seen or counted.

    model:(attach chest)      model:(attach "right hand")      id:(xpac >legion)

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
    fieldSep: ":",                     // model:fire        GitHub/Gmail convention
    negate: "-",                       // -model:beer       universal convention
    or: "|",                           // a|b               OR at EVERY level (§2.4)
    numListSep: ",",                   // id:133,134        numbers only — see altsOf
    compare: ["<=", ">=", "<", ">", "="],
    range: "..",                       // scale:10..50      GitHub convention (§4.5)
    phrase: '"',                       // "a b"  — ALWAYS a phrase, never grouping
    escape: "\\",                      // \" inside a phrase (§2.4.4)
    group: ["(", ")"],                 // grouping at EVERY level (§2.4)
    wildcard: "*",                     // §3.3
    countWord: "count",                // the universal cardinality axis (L1)
} as const;
```

### 2.4 NESTING — one recursive grammar, two scopes

**The user's instruction, 2026-08-10: *"I told you to reinvent the syntax, don't feel constrained… think a lot about
nesting and where it sits in our syntax."*** This section is the answer, and it is the single highest-leverage part of
the design: **one recursive grammar closes FIVE separate expressibility problems** (§9) that were each about to get
their own feature.

#### 2.4.1 The grammar

Lucene's own BNF is the convention and it already says this — a clause is optionally field-prefixed and may itself be a
parenthesised sub-query:

    Clause ::= ["+","-"] [<TERM> ":"] ( <TERM> | "(" Query ")" )

So:

```
query    := clause ( clause | "|" clause )*        juxtaposition = AND, "|" = OR
clause   := "-"? ( group | scoped | term )
group    := "(" query ")"                          BOOLEAN group  — combines SPELLS
scoped   := axis ":" "(" query ")"                 AXIS group     — combines within ONE ROW (L3)
term     := axis ":" value | value
value    := phrase | word | wildcard | comparison | range
phrase   := '"' ( char | "\\" char )* '"'          always a phrase; never grouping
```

**Precedence is the standard one: `-` > AND > `|`.** No invented precedence, no special cases.

#### 2.4.2 Where nesting SITS — the two scopes, and why they differ

This is the part that matters, and it falls straight out of L3:

| written                     | scope       | means                                                              |
|-----------------------------|-------------|--------------------------------------------------------------------|
| `(model:fire model:arcane)` | **spells**  | a fire model row AND an arcane model row — possibly different rows |
| `model:(fire arcane)`       | **one row** | a single model row matching both                                   |

**The same operators, at two scopes.** Learn the algebra once; the field prefix says which scope you are in. And because
negation now nests, the quantifier distinction becomes sayable for the first time:

    -model:fire        ¬∃row: fire        "has no fire model"
    model:(-fire)       ∃row: ¬fire       "has a model that isn't fire"
    model:* -model:(-caster)              "ALL model rows are caster"   ← full ∀
    -model:(-caster)   ¬∃row: ¬caster     ⚠ WRONG ALONE — vacuously true of every
                                            spell with no models at all

**That last line closes expressibility register #4** — universal quantification, which had no conventional spelling and
was going to need an invented word (`only`, `all:`). It needs neither: De Morgan and nesting already say it.

##### LOCAL NEGATION — THREE DEPTHS, and the fourth is BANNED

**The user challenged this as "problematic and confusing" (2026-08-10) and was half right: the VALUE is real and
measured, the CONFUSION was concentrated in one form, and that form is now illegal.**

**THE MEASUREMENT FIRST, because it is what justifies keeping any of it.** The flat, chip-level form silently
OVER-EXCLUDES — it drops every spell that has an excluded row anywhere, even when a perfectly good matching row exists:

| query | rows | |
|---|---|---|
| `model:fire` | 14,198 | |
| `model:fire -model:missile` | 9,575 | the flat form |
| `model:fire model:missile` | **4,623** | **33% of the result, silently dropped** |
| `sound:cast` | 51,117 | |
| `sound:cast -sound:impact` | 30,120 | |
| `sound:cast sound:impact` | **20,997** | **41%** |

So "fire models that aren't missiles" is answered WRONGLY by the flat form a third of the time. Local negation is not
a power-user luxury; it is the correct reading of the query people actually type.

**THE RULE, and it is a restriction rather than a generalisation: inside a scope, negation REFINES — it may not be the
whole predicate.** Every scope needs a positive anchor.

| written | depth | reads | |
|---|---|---|---|
| `-(model:arcane -model:fire)` | query | not this whole combination | ✅ |
| `-model:fire` | chip | no fire model row exists | ✅ |
| `model:(fire -missile)` | row, refining | a fire model row that is not a missile | ✅ |
| `model:(-fire)` | row, bare | — | ⛔ **illegal** |
| `model:(-attach:chest)` | row, scoped axis | — | ⛔ **illegal — use `-attach:chest`** |

**⭐ BANNING THE BARE FORM DELETES THE TRAP ENTIRELY.** The confusing case was never `model:(fire -missile)`; it was
that `-model:fire` and `model:(-fire)` disagree on spells with NO models — the first vacuously true, the second false.
With a positive anchor required, **every scope must find a row before it can exclude anything**, so the vacuity has
nowhere to appear and both readings become the obvious ones:

    -model:missile         "don't show me spells with missiles"        — no models? not excluded. obvious.
    model:(fire -missile)  "show me fire models that aren't missiles"  — no models? no match. obvious.

**And it deletes three more problems at a stroke** — all four were separate findings of the independent review (§8.9):

- the ∀ double-negative `-model:(-caster)` becomes unwritable, which is right: its showcase was WRONG (vacuously true
  of model-less spells), and the reviewer's judgement stands that no roleplayer would type it.
- `model:(attach -chest)`'s baffling reading (`attach:* AND NOT "chest"`) goes with it.
- **negated word-form axes disappear, so the parser stops needing the axis registry to place a `-`.** That was the
  review's finding #2/#3 and its worst structural consequence — registering an axis could change a bookmarked query.

**What is LOST is a genuine capability and it is named honestly: universal quantification.** "All model rows are
caster" is no longer sayable. It was sayable for one day, in a form that was measured wrong and that nobody would
type. **Expressibility register #4 reverts to OPEN** and, if it is ever wanted, gets a word of its own rather than a
double negative.

#### 2.4.3 The edge cases the grammar MUST answer

A recursive grammar creates combinations nobody typed on purpose. Each of these was found by walking the BNF against
the laws; leaving any of them undefined is how 1.0 got its exceptions.

**(a) `count` is a property of the SCOPE, not of a row.** It is the one axis that cannot be a row predicate — a row
has no cardinality. Inside a scope it counts **the rows that satisfy the rest of that scope's predicate**:

    model:(caster count >4)      more than four CASTER model rows       ← filtered count, §9 #3
    model:(count >4)             more than four model rows in all
    model:(count >4)             identical to the line above

So the register's filtered-count entry is not a special case; it is what `count` already means once a scope exists.

**(b) A group is ONE value, so arity (L6) survives nesting.** `attach` takes the single thing after it, and a
parenthesised group is a single thing:

    model:(attach chest)              one value
    model:(attach (chest|head))       still one value — the group IS the token

**(c) `-` prefixes a CLAUSE, and a word-form axis plus its argument is one clause.**

    -attach:chest             ¬(attached at chest)      ← chip level, the only form
    model:(attach chest -missile)   attached at the chest, not a missile  ← refining, legal
    model:(-attach:chest)     ⛔ illegal — a scope needs a positive anchor (§2.4.2)

The third line is legal and reads oddly, which is exactly why the highlighter must draw the capsule around what an
axis actually consumed. **Negation is never an axis's argument** — there is no "negated value", only a negated clause.

**(d) A scope may not name another column's axis.** `model:(sound:fire)` is a static error, not an empty result: the
scope is a set of MODEL rows and a sound axis cannot read one. Universal axes (`count`, `target`) are the exception —
they apply in every scope by definition (L1). Reject at parse time and say so in the bar; L2's "answer, never fall
through" is about DATA, not about nonsense.

**(e) An empty group `()` is a static error**, not an identity element. Nothing sensible reads it, and silently
treating it as "everything" or "nothing" is the class of failure §9.1 is about.

**(f) Two spellings of OR is one too many — `,` is retained ONLY for numbers.** `id:133,134` stays because a bare list
of ids is how people paste them, and the rule is syntactic (every part a number), not per-field. Everywhere else `|` is
the only OR. ⚠ This is a deliberate exception to L1 and the only one in the grammar; if it ever causes a question,
delete it rather than growing it.

#### 2.4.4 QUOTES MEAN ONE THING NOW, and that is a deletion

**1.0 has two kinds of quote and it is a documented trap.** Inside a value they are phrase quotes; *around* a value they
are grouping and get stripped. The app's own docs got it wrong once — `name:(fire "icon frost")` silently degrades,
because the inner quotes make `icon frost` a phrase, `splitKeyword` never sees the keyword, and the query returns 0 with
no complaint.

**2.0: `"` is ALWAYS a phrase. `()` is ALWAYS a group. `\"` is a literal quote inside a phrase.** One meaning per
delimiter, which is the whole of L1 applied to punctuation.

The consequence is a real and deliberate syntax change — grouping that used to be written with quotes is now written
with parens:

    1.0:  model:"attach chest"          2.0:  model:(attach chest)   or   attach:chest
    1.0:  name:"desc kneel"             2.0:  name:(desc kneel)      or   desc:kneel
    1.0:  model:"fire missile"          2.0:  model:(fire missile)

and a phrase with a quote in it is now expressible at all: `name:"the \"real\" one"`.

Note the global door (L5) is the SHORTEST form for the common case, so most of these get shorter, not longer.

#### 2.4.5 What one recursive grammar closes

| problem                               | was                                                          | now                                                       |
|---------------------------------------|--------------------------------------------------------------|-----------------------------------------------------------|
| cross-field OR (§9 #1)                | **silently wrong** — `model:fire\|sound:fire` = `model:fire` | `model:fire \| sound:fire`                                |
| row-level negation (§9 #2)            | `model:"fire -missile"` = 0, `-` a literal                   | `model:(fire -missile)`                                   |
| ∀ quantification (§9 #4)              | unexpressible; needed an invented word                       | `-model:(-caster)`                                        |
| arbitrary DNF                         | had to be hand-converted to CNF                              | `(model:fire model:arcane) \| (model:frost model:shadow)` |
| implication — "arcane only with fire" | unexpressible                                                | `-(model:arcane -model:fire)`                             |

**Five problems, one grammar, no new vocabulary.** That is the argument for nesting: it is not five features, it is the
absence of an arbitrary restriction.

⚠ **The costs, stated rather than discovered later.** The chip bar is a flat sequence today and must learn to render
NESTED groups — that is the real work, and it is a UI problem, not an engine one. The highlighter must show the parse,
because a mis-parenthesised query is the one failure mode this grammar adds. And `|` no longer has a bare shorthand:
`model:fire|frost` now parses as `model:fire OR frost`, so value alternation is written `model:(fire|frost)`.

### 2.2 `Axis` — the single structure

Everything that is a separate mechanism in 1.0 — a field's `run()`, a meta keyword, a target word, `count`, a pill
type's corpus — is **one record shape**:

```ts
export interface Axis {
    /** Stable identity. "model.file", "name.desc", "*.count", "*.target". */
    id: string;

    /** The two doors of L5. `word` omitted = the column's default axis. */
    prefix?: string;                    // desc:kneel
    word?: string;                      // model:(attach chest)

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

### 4.1 TWO LAYERS. The source owns one of them

**Read the SOURCE's types, not our current pills** (user, 2026-08-10: *"You need to look at the source and what types
they have there, and not only on our current data"*). Measured over every column of every table the build reads on 9.2.7
(`ref.column_info`):

| dbd type                                             | columns | notes                                        |
|------------------------------------------------------|---------|----------------------------------------------|
| `int` — widths 8 / 16 / 32 / 64, signed and unsigned | **909** | 25 are FK/relations, 7 carry a declared enum |
| **`float`**                                          | **320** | **the app has no float axis at all today**   |
| `locstring`                                          | 20      |                                              |
| `string`                                             | 7       |                                              |
| *(array columns)*                                    | **374** | a structural modifier over all of the above  |

**So the source declares FOUR base types**, and everything else is meaning we add. That gives the layering:

- **STORAGE — the source's, not ours to choose.** `int(width, signed)` · `float` · `string` · `locstring`, plus the
  structural modifiers *array*, *relation (FK)* and *declared enum*.
- **SEMANTIC — ours, declared, extensible.** What the number MEANS, how it is queried, how it is formatted, what the UI
  offers.

**The 320 float columns are the proof this matters**, and they are exactly the future pills the user named:
`CreatureModelData.CollisionHeight / CollisionWidth / HoverHeight / ModelScale / MountHeight`,
`BarrageEffect.ConeAngle / Range`, `BeamEffect.FixedLength / SourceMinDistance`, `AnimKitSegment.Speed`. Heights,
widths, radii, angles, lengths, rates — every one RP-relevant, none reachable.

### 4.2 The type REGISTRY — a framework, not a closed list

**User's requirement: *"we need many datatypes and a framework to define additional datatypes if needed."*** So types
are REGISTERED, exactly as pill types are — adding one is a call, never an edit to a union.

```ts
export interface AxisType {
    name: string;                                  // "percent", "seconds", "length"
    storage: "int" | "float" | "string" | "locstring" | null;  // §4.1; null = valueless (flag)
    parse(token: string): TypeQuery | null;        // token -> a test, or null = not mine
    test(q: TypeQuery, value: unknown): boolean;

    format(value: unknown): string;                // how a pill prints it
    ui: "text" | "number" | "range" | "picker" | "toggle" | "glyphs";
    unit?: string;                                 // "%", "s", "yd", "°", "x"
    step?: number;                                 // range / stepper granularity
    sentinels?: Record<number, string>;            // -1 -> "unlimited"
}

export const AXIS_TYPES = new Map<string, AxisType>();

export function defineAxisType(t: AxisType): void {
    if (AXIS_TYPES.has(t.name)) throw new Error(`axis type "${t.name}" already defined`);
    AXIS_TYPES.set(t.name, t);
}
```

**The types registered today** — grounded in the storage layer above, not invented:

| name      | storage   | examples                                         | matches                                     | UI                |
|-----------|-----------|--------------------------------------------------|---------------------------------------------|-------------------|
| `text`    | string    | spell name, description, kit name                | substring + glob                            | text              |
| `path`    | string    | model / sound files                              | substring + glob, **never anchored** (§3.2) | text              |
| `enum`    | int       | effect / aura / implicit-target names, expansion | exact → substring → glob                    | **value picker**  |
| `id`      | int       | spell id, SoundKit id, icon fid                  | **equality only, never substring**          | exact + copy      |
| `bitmask` | int       | target masks, attribute bits                     | bit test **and combinations**               | **glyph toggles** |
| `count`   | int       | `count`, vehicle seats                           | integer compare, ≥ 0                        | stepper           |
| `seconds` | int (ms)  | casttime, channeled                              | compare + `unlimited` sentinel              | number, `s`       |
| `percent` | int       | scale, speed, desaturate, transparency           | **signed** compare                          | range, `%`        |
| `length`  | **float** | collision/hover height, beam length, range       | compare                                     | range, `yd`       |
| `scale`   | **float** | model scale, attached-effect scale               | compare                                     | range, `×`        |
| `angle`   | **float** | cone angle                                       | compare                                     | range, `°`        |
| `rate`    | **float** | anim segment speed, ambient multiplier           | compare                                     | range, `×`        |
| `flag`    | —         | attribute bits, freeze, camo                     | membership; **no value at all**             | toggle            |
| `mixed`   | —         | the sound column (files ∪ kit names ∪ ids)       | union of its sub-axes                       | composite         |

### 4.3 `flag` is standalone, and tri-state is the GRAMMAR's job — not a type's

**The user's correction, and it deletes something invented: *"if you don't care about the flag just don't type it? and
if you don't want it put it in negative. If it's standalone then it's standalone completely."*** An earlier draft gave
`flag` a "tri-state toggle" as a type property. That duplicated the grammar. **EVERY axis is already tri-state**, by L8,
with no help from the type system:

    (absent)               don't care
    mech:unbreakable       require
    -mech:unbreakable      exclude

So `flag` is simply **an axis with no value** — nothing to parse, nothing to compare, nothing to format. The toggle in
the UI writes one of the three states above; it is not a fourth thing.

### 4.4 A word with no argument IS the existence test

**User: *"some keywords should double as flags if they don't have an input."*** That is the wildcard rule (§3.3)
arriving from the other side, so it costs no new machinery:

    model:attach   ≡   attach:*   ≡   "has any attachment point"
    name:desc      ≡   desc:*     ≡   "has a description"

**This deletes a 1.0 oddity**: today a trailing keyword with nothing after it "stays in text" and degrades into a
substring search *for its own name* — silently, and never as an error. ⚠ Measure per keyword when porting: some words
(`attach`) are ALSO category words in their column today, so the current behaviour is not uniform and the deltas will
not be either.

**⛔ IT DOES NOT APPLY TO EVERY AXIS, and the counter-example is the user's** (*"obviously not all keywords can be flags,
a count flag would be meaningless"*). **`count:*` is a TAUTOLOGY** — every column has a cardinality, possibly zero, so
"has any count" is true of every spell in the pack.

**The discriminator is NULLABLE vs TOTAL, and the axis declares it:**

|                                                       |                                                                                   | `axis:*` means                               |
|-------------------------------------------------------|-----------------------------------------------------------------------------------|----------------------------------------------|
| **nullable** — a spell or row may simply not have one | `attach`, `desc`, `icon`, `xpac`, `kit`, `motion`, `boneset`, `scale`, `casttime` | **has one at all.** The flag reading. Useful |
| **total** — always defined, possibly zero             | `count`, and any derived measure                                                  | **everything.** True, and worthless          |

For a total axis the wildcard is still **answered** rather than rejected — L2 forbids falling through, and "every spell"
is the literally correct answer — but it is **never offered in autocomplete and the bar marks it as a no-op**, so the
user sees why 276,332 rows came back instead of wondering. `total: true` on the axis is the whole declaration.

**Related weakness, stated rather than papered over: `count`'s GLOBAL door is weak.** L5 gives every axis a global
prefix, but `count` is a universal *parameterised by column*, so `count:>4` can only mean "some column has more than
four", which is a question nobody asks. Its real form is the in-column one, `model:(count >4)`. This is the one place
L5's two-doors rule produces a door not worth walking through, and that is a property of `count` being a meta-axis
rather than a flaw in the law.

### 4.5 VALUE RANGES — the syntax is GitHub's, the domain is MEASURED

Two halves that must agree: how you WRITE a range, and how the UI knows what range to DRAW.

**The syntax is GitHub's `n..n`** (L0 — it is the family Epsilook sits in), and `*` as an open bound composes exactly
with the wildcard rule already adopted in §3.3, so there is one meaning of `*` in the whole language:

    scale:10..50      between, inclusive
    scale:10..*       ≡  scale:>=10
    scale:*..50       ≡  scale:<=50
    scale:*           any value at all — the existence reading (§4.4)

Lucene's `[10 TO 50]` was the alternative and loses on both counts: it is the relevance family's spelling, and it costs
two brackets and a keyword where `..` costs two dots.

**The domain is DERIVED FROM THE LOADED PACK, never declared** — value sets differ per game version, so a hard-coded
min/max would be wrong on ten packs out of eleven. `Axis.domain(d)` is computed at index time, exactly as `when?(d)`
already gates a word by whether the pack has data for it.

**⚠ AND THE RAW MIN/MAX IS NOT THE DOMAIN. Measured on 9.2.7:**

| column                              | min             | max   | distinct | what a naive control would do          |
|-------------------------------------|-----------------|-------|----------|----------------------------------------|
| `CreatureModelData.CollisionHeight` | **−20,000,000** | 334.9 | 1,758    | a slider spanning 20 million, unusable |
| `CreatureModelData.ModelScale`      | 0.03            | 7.0   | 41       | fine                                   |
| `CreatureModelData.HoverHeight`     | 0               | 50    | 25       | fine                                   |
| `BarrageEffect.ConeAngle`           | 27              | 60    | **3**    | a slider over three values             |
| `BarrageEffect.Range`               | 10              | 60    | **4**    | a slider over four values              |

Two rules follow, and both were invisible until the numbers were on screen:

1. **Bounds must be ROBUST, not extremal.** Sentinels and garbage live in these columns (`−20000000` is not a height).
   Take a percentile band, or exclude declared sentinels, and say on the control that it is clipped.
2. **⭐ CARDINALITY DECIDES THE AFFORDANCE, NOT THE TYPE.** `ConeAngle` and `CollisionHeight` are both `float` and want
   completely different controls: 3 distinct values is a **picker**, 1,758 is a **slider**. So `AxisType.ui` is a
   DEFAULT that `domain()` may override — the type says what a value MEANS, the domain says how it is DRAWN.

This is also why `domain()` returns the distinct values when they are few:

```ts
export interface AxisDomain {
    lo: number;
    hi: number;                 // robust bounds, sentinels excluded
    step: number;
    values?: (number | string)[];  // present when cardinality is low -> picker
    clipped?: boolean;             // true when lo/hi hid outliers; the UI says so
}
```

### 4.6 `flag` vs `bitmask` — they look alike and are not

A `flag` is ONE bit on a SPELL, valueless, with no combinations: you have `unbreakable` or you do not. A `bitmask` is
SEVERAL bits on a ROW, and the combinations are the entire point — from `build_data.py`,
`caster 1 · target 2 · area 4 · not-caster 8 · missile-dest 16`, so `target` is the test `2|8`, `area` is `4|16`, and **
`both` is `1 AND 2`, a question no single bit spells**. Per-row, because the same chain plays on the caster for one
spell and the target for another.

**This is also the answer to *"why do we need 3 keywords exactly instead of just `target caster`"*** (user's brief).
Under L5 you get exactly that — `target:caster`, `target:area`, `target:both` — one keyword with named values, global.
The five words stop being independent vocabulary scattered across four columns and become **one `mask` axis**;
`model:caster` survives as its scoped form.

Two consequences worth stating, because both remove existing hand-written UI:

- **The filter row and the target icons stop being features** and become the rendered form of a `flag` and a `bitmask`
  axis. One declaration, two surfaces, no second list (L11).
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

### 8.8 Quotes as a grouping device

`model:"attach chest"` used quotes to group a keyword with its value; `"` now always means a phrase (§2.4.4). Grouping
is `model:(attach chest)`, or the global door `attach:chest`.

---

## 8.9 ⚠ THE INDEPENDENT REVIEW — §2.4 IS UNDER CHALLENGE, DO NOT BUILD IT YET

**2026-08-10. An agent with NO context on this app reviewed this document and its strongest objection lands.** It is
recorded here rather than quietly absorbed, because it argues against the single largest thing in the file.

**The objection: every measured defect in §7 is a LAW violation, and not one of them is an expressibility gap.** The
laws, the axis registry, the two doors and the row model fix all nine — with the chip list kept FLAT. §2.4's recursive
grammar is therefore paying structural costs (a chip bar that becomes a tree editor; a parser that depends on the axis
registry, so registering an axis can change what a bookmarked query means) for capability nobody has been measured
wanting. §9's own discipline is *measurement before feature*, and §9 contains no measurement of demand for DNF,
implication or ∀.

**Findings I accept outright, fixed above or listed as debt:**

- **The ∀ showcase was WRONG.** `-model:(-caster)` is vacuously true of every spell with no models — the exact trap
  §2.4.2 states and then violated. Corrected to `model:* -model:(-caster)`. The same vacuity applies to §9 #5.
- **L6's arity is NOT in the BNF.** There is no `word value` production, so `model:(-attach chest)` and
  `model:(attach -chest)` have the same parse tree; the distinction lives in the axis registry as a post-parse
  re-association. So negation binds by **two** rules, not one, and the parse is registry-dependent.
- **Arity breaks L8 inside a scope.** `model:(attach chest)` ≠ `model:(chest attach)`. Order-invariance is false.
- **Bare `count` returns everything** — L6 plus §4.4 make the lone word an existence test on a total axis.
- **`*` is two mechanisms** (glob, and existence) coinciding on string storage — the shape L4 forbids. And on `path`
  axes the glob is a literal no-op, since §3.2 proves matching is unanchored substring.
- **`Row.corpus` is one string**, so §8.1's promised category/corpus split and the `mixed` type are unrepresentable.
- **Arrays are unmodelled** — 374 columns, and an array column is exactly where the row model must decide one-row-vs-N,
  which determines every `count` on that column.
- **`Column.rows(d, spellId)` is a FORWARD index replacing inverted ones.** Not merely "unmeasured" as §5 of the
  process log says — architecturally inverted, on every keystroke, with `-model:(-caster)` answerable by no index at
  all.
- Missing entirely: an error model, incremental/prefix parse for a search-as-you-type box, unknown-prefix behaviour,
  case sensitivity, Unicode and curly quotes, escaping beyond `\"`, and a complexity budget.

**What survives untouched:** L1, L2, L4, L5, L7, L9, L11, the `Axis`/`Column` collapse, §4.1's storage measurement,
§4.5's cardinality-decides-affordance finding, and the row model's closure of filtered `count`.

**The pending call is in `docs/PROCESS-LOG-search2.md` §4.0** — it is a scope decision for the user, not a
documentation fix.

---

## 9. The expressibility register — KEEP HUNTING

**Standing instruction from the user, 2026-08-10: *"I want to be on constant lookout for similar scenarios that cannot
be satisfied by our current system."*** This section is where the real gaps are recorded, so the lookout produces a
list instead of a feeling.

**The discipline: when a query cannot be written, add a row here with a MEASUREMENT before deciding whether to build
anything.** It has already paid three ways — one entry turned out to be a silent BUG rather than a missing feature, one
turned out to be a free consequence of the row model, and four were closed at a stroke by the recursive grammar rather
than by four separate features.

| # | the query you could not write | 1.0 | 2.0 |
|---|---|---|---|
| 1 | **cross-field OR** — "a fire model OR a fire sound" | **silently wrong** (§9.1) | ✅ `model:fire \| sound:fire` — §2.4 |
| 2 | **row-level negation** — "a fire model that is not a missile" | `model:"fire -missile"` = 0, `-` a literal | ✅ `model:(fire -missile)` — §2.4 |
| 3 | **filtered count** — "more than 4 CASTER models" | `model:"caster count >4"` = 15,905 = has-a-caster-row ∧ >4 models *in all* | ✅ free from the row model (§9.2) |
| 4 | **∀ quantification** — "models that ALL play on the caster" | unexpressible | ⛔ **REOPENED** — the `-model:(-caster)` form was measured wrong and is now illegal (§2.4.2). Wants a word, not a double negative |
| 5 | **implication** — "arcane only if accompanied by fire" | unexpressible | ✅ `-(model:arcane -model:fire)` |
| 6 | **arbitrary DNF** — "(fire ∧ arcane) ∨ (frost ∧ shadow)" | hand-convert to CNF; grows exponentially | ✅ written directly — §2.4 |
| 7 | **cross-column row correlation** — "a model and a sound on the SAME target" | unexpressible | ⛔ still open — §9.3 |

**Note what 1–6 have in common: none needed a new word.** Five fell out of one recursive grammar and one out of the row
model. That is the test a proposed feature should face first — *is this a missing capability, or a missing
generalisation?*

### 9.1 Cross-field OR was a SILENT failure, not a missing feature

```
model:fire              14,198
sound:fire              13,578
model:fire|sound:fire   14,198     <- exactly model:fire
```

`parseQueryParts` leaves the pipe alone when a real field tag follows it, but the chip regex then swallows the lot:
field `model`, text `fire|sound:fire`. The tokenizer splits that into alternatives `fire` and `sound:fire`, the second
of which matches no file name — **so half the query is discarded with no error and no visual cue.** Worse than
unexpressible, because the result looks plausible.

### 9.2 The row model closes #3 for free — which is the argument for it

CLAUDE.md's open items say filtered `count` needs "the four column matchers restructured into per-spell ENTRY
ITERATORS". **`Column.rows()` IS that restructuring**, so it arrives as a side effect rather than its own pass: the
kernel evaluates the chip's row predicate first and counts what survives, so `model:(caster count >4)` becomes "more
than four caster models" — the meaning the docs always claimed.

⚠ **Measure it on landing**: it moves `model:"caster count >4"` off 15,905.

### 9.3 Still open, and honestly costed

**#7, cross-column row correlation.** "A model and a sound that play on the same target" needs rows from two different
columns joined on a shared attribute — the one thing the row model does NOT give, because `Column.rows()` is
per-column by construction. It would need a correlation key in `Row` and a join in the kernel. **Speculative: nobody
has asked for it.** Park unless someone does.
