# Search 2.0 — the rulebook

**Status: DESIGN, approved in principle 2026-08-10. Nothing here is built yet.** The implementation plan, the measured
baselines and the session-by-session state live in `docs/PROCESS-LOG-search2.md`. This file is the LAW — what the search
system is allowed to be. Read it before adding any searchable thing.

Search 1.0 was not designed; it accreted. Every feature was individually correct and the sum has no stated rules, so
each new axis had to invent its own mechanism and the exceptions outnumber the rules. This document exists so that the
next axis is a declaration rather than an invention.

**HOW TO READ IT: this file states what IS.** A rejected alternative appears as a single ⛔ line and nothing more — the
argument that killed it is in the process log, and re-reading it is how a closed question gets re-opened. Measurements
stay, because they are the evidence; the deliberation around them does not.

---

## L0 — FOLLOW CONVENTION. This law governs the other twelve

**User's standing rule, 2026-08-10: *"follow convention and design patterns wherever possible."*** Before inventing a
syntax, a semantic or a UI affordance, find out what the established systems do and adopt it. A user arriving at
Epsilook already knows Google, GitHub and Wowhead; every place this app differs from them is a thing they must be
taught, and teaching is a cost paid by every visitor forever.

It has already killed one approved design: the ordered `−`/`+` pipeline was bespoke, and one round of reading closed it
(§3).

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

Twelve, under L0. Each names the defect it prevents, and every one of those defects is real and measured on 9.2.7 — see
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

    model:{target:caster fireball}   ONE row that is both — not a caster row and a fireball row
    model:target:caster model:fire   two rows, either may satisfy either clause

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

### L5 — The global prefix is a VIRTUAL SCOPED TAG, desugared at parse time

**The user, 2026-08-10: *"plain keywords are shortcuts to scoped keywords, as if `scale:50` is treated like
`fx:scale 50`, a virtual fx tag… not just an equivalent but as a virtual behaviour."***

**THE RULE. A global prefix is REWRITTEN, before evaluation, into the union of its scoped forms over every column that
carries the axis:**

    axis:value   ⟶   ⋁  column:(axis value)   for every column carrying `axis`

    scale:50     ⟶   fx:{scale:50}                                        one column — the degenerate case
    desc:kneel   ⟶   name:{desc:kneel}
    attach:chest ⟶   model:{attach:chest} | fx:{attach:chest} | mech:{attach:chest}
    count:>4     ⟶   model:{count:>4} | sound:{count:>4} | …

**IT IS A REWRITE, NOT AN EQUIVALENCE, AND THAT IS THE WHOLE POINT.** The kernel has no notion of a "global axis" and
never evaluates one — it sees scoped clauses only. So the two doors *cannot* disagree, in the strong sense that there is
nothing for them to disagree with. One evaluator, one code path (L11).

**What follows for free:**

- **`when?(d)` filters the expansion**, so an axis absent from this pack simply contributes no term, and a global form
  over columns that all lack it correctly yields nothing (L2 — answered, not fallen through).
- **Negation needs no rule.** `-attach:chest` is the negated union, i.e. `-model:{attach:chest} -fx:{attach:chest} …`
  by De Morgan. Intuitive, and derived rather than stated.
- **`count` needs no carve-out.** `count:>4` is the union like everything else, and it reads oddly for the same reason
  any wide union does — not because `count` is special.
- **The bar can SHOW the expansion** — a global chip is a virtual scoped chip, so hovering or expanding it teaches the
  scoped form. That is the answer to "the user has to hunt for the keywords": the shortcut is also the lesson.

**⚠ THE TWO DOORS ARE NOT PEERS — the scoped form is strictly more expressive**, and this is the one thing the sugar
cannot reach: only a scope can conjoin the axis with other predicates **on the same row** (L3).

    scale:50               some fx row scales by 50
    fx:{scale:50 chain}    ONE row that scales by 50 AND is a chain   ← unsayable globally

So: `axis:value` is sugar; `column:(axis …)` is the general form. Every axis has the shortcut, and the shortcut is never
the whole language.

> Broke as: `desc`, `icon`, `attach`, `boneset`, `motion`, `xpac`, `kit` are all in-column only, so a user who knows
> the concept cannot find the door.

#### L5.1 — WHAT EARNS A GLOBAL DOOR. Four gates, and two of them are mechanical

**User's requirement, 2026-08-10: *"set concrete requirements and rules what earns a keyword a right to plain scope
presence, not just semantics but also logic."*** So the test is not taste. **An axis earns a global prefix only if it
passes ALL FOUR**; failing any one leaves it reachable through its column, which is correct — for those, the column IS
the meaning.

| gate                    | question                                                                                  | kind                                       |
|-------------------------|-------------------------------------------------------------------------------------------|--------------------------------------------|
| **G1 UNIQUE**           | Does any other axis declare this word or prefix?                                          | **mechanical — `check.py` can enforce it** |
| **G2 SELF-NAMING**      | Does the word name its subject with the column removed?                                   | semantic (L12)                             |
| **G3 ONE VALUE SPACE**  | Across every column it spans, do its values mean the same thing and come from one domain? | **logical**                                |
| **G4 MEANINGFUL UNION** | Is the desugared union over columns (L5) a question anyone asks?                          | **logical**                                |

**G3 and G4 are the logical half and they exist because L5 makes a global prefix a UNION.** A union is only coherent if
the things unioned are the same KIND of thing (G3) and if asking about all of them at once is a question (G4). A
single-column axis passes both trivially — which is why most axes qualify and the multi-column ones need checking.

**Applied to today's vocabulary:**

| axis                                                                   | G1                                                    | G2                                          | G3                                                     | G4                                        | verdict                 |
|------------------------------------------------------------------------|-------------------------------------------------------|---------------------------------------------|--------------------------------------------------------|-------------------------------------------|-------------------------|
| `desc`, `icon`, `xpac`, `scale`, `motion`, `speed`, `seat`, `location` | ✅                                                    | ✅                                          | ✅ single column                                       | ✅                                        | **global**              |
| `target`                                                               | ✅                                                    | ✅                                          | ✅ one mask vocabulary in every column                 | ✅                                        | **global**              |
| `attach`                                                               | ⛔ **collides with the `attach` model CATEGORY word** | ✅                                          | ✅ M2 attachment ids throughout                        | ✅                                        | **blocked on a rename** |
| `count`                                                                | ✅                                                    | ✅                                          | ✅                                                     | ⛔ "some column has >4" is not a question | **scoped only**         |
| `kit`                                                                  | ⛔ two axes claim it                                  | ✅                                          | ⛔ **AnimKit ID vs SoundKit NAME — different domains** | ⛔                                        | **scoped only**         |
| `replace`, `loose`                                                     | ✅                                                    | ⛔ replace *what*?                          | —                                                      | —                                         | **scoped only**         |
| `attached`, `missile`, `ground`, `trail`, `barrage`, `display`, `item` | ✅                                                    | ⛔ model categories; the column is the noun | —                                                      | —                                         | **scoped only**         |

**⚠ ONE CONCRETE ACTION FALLS OUT, and it is a live 1.0 defect rather than a 2.0 design choice.** `attach` is registered
BOTH as a model category word (`pilltypes.ts`, `modelCat("attach", …)`) and as the attachment keyword
(`META_KEYWORDS.attach`) — so inside one column it already means two things: `model:attach` = 16 (substring) against
`model:{attach:chest}` = 51,581 (keyword). **G1 fails today.** The category word must lose the name — `attached`
already exists as its twin and is the better noun — before `attach:` can be a global door.

**G1 IS A GUARD, NOT A NOTE.** Per this project's own rule that prose cannot fire: `check.py` must fail when two axes
declare the same word or prefix. That is the only one of the four a script can decide, and it is also the one that
already broke.

### L6 — An axis binds EXACTLY ONE value, and the colon says so

**Every axis binds with `:`, at every level, to exactly one value** — where a phrase, a value group and a comparison are
each one value. There is no rule to remember and nothing to count:

    attach:chest              model:{attach:"right hand"}      id:{xpac:>legion}
    model:{attach:(chest|head) fire}                           name:="Blood Pool"

**The reader's rule, and nothing is looked up to apply it: a bare token is ALWAYS content; `axis:value` is ALWAYS an
axis.** Both are visible in the text, which is L12.

**Variable arity stays forbidden**, because an arity decided by the data can be neither seen nor counted — and the colon
makes it unrepresentable rather than merely against the rules. §2.4.1 has what that deletes.

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

**GENERALISED (§4.2b): a type REALISES an operator for its domain; it never REDEFINES one.** `=` is "exactly this"
everywhere — numeric equality on a number, the whole string on text. `<` is "earlier in this type's order", which is a
number for `percent` and a rung of the expansion ladder for `ordinal`. **And a type may DECLINE an operator, which is a
static error rather than a silent fallback** — `name:>m` must say "the name axis has no ordering", not substring-search
for the characters `>m` as 1.0 does.

### L10 — No display state may reach a result set

Hidden columns, theme, sort and the height clamp are display. A URL must yield the same spells for everyone. *(Held in
1.0. Kept verbatim — it is the one law that never broke.)*

### L11 — A declaration is COMPLETE

Registering an axis must yield, with no further edits: the search, the autocomplete entry, the help-dialog row, the bar
capsule, the hit-highlight, the filter affordance (§4) and the export column. **If a surface needs a second list, the
design is wrong.**

> Broke as: `desc` shipped fully searchable and absent from the help, the suggestions and the capsules, because
> `fieldCategories` gated them behind a literal field allowlist — with a second copy of that literal in `help.ts`.

### L12 — A QUERY READS AS ITS OWN EXPLANATION

**The user's rule, 2026-08-10: *"when a user reads the search bar, the logic should become immediately obvious. Seeing a
bar should birth assumption about what it does."* And, when I first read it too narrowly: *"I'm not just talking about
naming keywords. I'm exposing a larger issue: query readability."***

**The test, and it applies to the WHOLE query, not to its vocabulary:** a reader who has never seen a form should still
guess right about what it does. Concretely, four failures — any one of them is disqualifying:

1. **A token whose ROLE is invisible.** You cannot tell field from value from operator without knowing the registry.
2. **A scope you cannot see.** You cannot tell what binds to what.
3. **A form that means two things depending on hidden state.**
4. **A form that READS correctly and BEHAVES otherwise.** The worst kind, because nothing prompts you to check.

**Applied to this document's own forms — a law that condemns nothing is decoration:**

| form                                                     | verdict                                                                                         |
|----------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| `desc:kneel`, `attach:chest`, `scale:50`                 | ✅ reads as it means                                                                            |
| `model:{fire -missile}`                                  | ✅ "a fire model that isn't a missile"                                                          |
| **`(model:fire model:arcane)` vs `model:{fire arcane}`** | ⛔ **FAILS (2).** One paren's POSITION changes the meaning and both read identically aloud      |
| `model:attach` (16) vs `model:{attach:chest}` (51,581)   | ⛔ **FAILS (3).** `attach` is a category word AND the keyword, in one column                    |
| `anim:kit` (31,291) vs `sound:kit` (2,516)               | ⛔ **FAILS (3)** globally — so `kit:` gets no global door                                       |
| `replace:`, `loose:`                                     | ⛔ **FAILS (1).** Replace *what*? Meaningless outside their column                              |
| `model:fire -model:missile`                              | 🟡 **withdrawn** — correct for "no missile anywhere"; the ambiguity is in the ENGLISH (§8.9.3b) |
| `-model:{-caster}`                                       | ⛔ **FAILS (4).** Already deleted for being measured wrong                                      |

**Three earlier decisions are its special cases**, each taken for a narrower reason: banning bare scope negation,
deleting the ∀ double negative, and making `-` bind by one rule (L6). **The fourth is spell-level grouping, which this
law is what killed** (§8.9.1) — `(model:fire model:arcane)` and `model:{fire arcane}` read identically aloud, so `(`
now appears only after a prefix and means exactly one thing.

**It is also why a global door is EARNED rather than automatic** — the four gates of L5.1, of which G2 (self-naming) is
this law applied to a single word.

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
    compare: ["<=", ">=", "<", ">", "="],   // `=` also anchors TEXT: name:=Fireball
    range: "-",                        // scale:10-90       between values; §4.5
    phrase: '"',                       // "a b"  — ALWAYS a phrase, never grouping
    escape: "\\",                      // \" inside a phrase (§2.4.4)
    scope: ["{", "}"],                 // model:{…} — ONE row satisfies it (§2.4.0)
    vgroup: ["(", ")"],                // (a|b) — alternatives as one value
    wildcard: "*",                     // §3.3
    countWord: "count",                // the universal cardinality axis (L1)
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
    word?: string;                      // model:{attach:chest}

    /** Which columns' rows it reads. A LIST, because L5's own worked example
     *  (`attach` over model|fx|mech) is unrepresentable with one string, and
     *  "*" would wrongly claim sound — which §9.0 measured as having no
     *  attachment column at all. "*" = universal: EVERY column. */
    columns: string[] | "*";

    /** §4 — drives BOTH how a token matches and what the UI offers.
     *  ⚠ ONE AXIS, ONE VALUE (§4.2b): if this axis's value cannot be written
     *  down with a single unit, it is two axes. `>` orders THIS value and
     *  nothing else; cardinality is always the separate `count` axis.
     *  ORDERED: the first type whose shape accepts the operand wins, so
     *  `kit` declares [id, text]. Most axes declare exactly one. An operator
     *  is offered only if EVERY listed type implements it. */
    types: AxisType[];

    /** §4.4 — is the axis ALWAYS defined (possibly zero) or may it be absent?
     *  ⚠ ON THE AXIS, NOT THE TYPE: `count` and `seat` share the `count` TYPE
     *  and disagree — every column has a cardinality, but only 358 spells on
     *  9.2.7 have a seat. `total: true` means `axis:*` is every spell, so the
     *  wildcard is answered (L2) but never offered and marked a no-op. */
    total?: boolean;

    /** L7: does chipless search read it, and how hard does it rank? */
    plain: boolean;
    tier?: number;                      // 0 = exact name … 3 = description

    /** L11: everything every surface needs, stated once. */
    hint: string;
    short: string;                      // the placeholder on an incomplete chip (§4.9.7)

    when?(d: SpellData): boolean;       // absent data = absent word, everywhere
    domain?(d: SpellData): AxisDomain;  // §4.5 — robust bounds, computed at index time

    /** THE ROW PREDICATE (L3). The kernel owns the walk, the ∃ over rows,
     *  the set algebra and the negation. */
    test(row: Row, q: AxisQuery, d: SpellData): boolean;

    /** ⚠ THE SECOND CALLBACK, and it exists because `count` cannot be a row
     *  predicate — a row has no cardinality (§2.4.3a). Declaring it here is
     *  what keeps `count` an AXIS instead of a kernel special case, which
     *  §2.5's forbidden-thing #2 would otherwise make it. An axis declares
     *  `test` OR `testRows`, never both. */
    testRows?(rows: Row[], q: AxisQuery, d: SpellData): boolean;
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

### 2.4 NESTING — one recursive grammar, one scope

**The user's instruction, 2026-08-10: *"I told you to reinvent the syntax, don't feel constrained… think a lot about
nesting and where it sits in our syntax."*** One recursive grammar closes five separate expressibility problems (§9)
that were each about to get their own feature.

**There is exactly ONE scope: the row scope `axis:{…}`.** Spell-level grouping was designed and dropped (§8.9.1) — it
cost no expressive power (§8.9.4) and it failed L12. So a query is a FLAT list of clauses, and the only nesting is
inside a clause.

#### 2.4.0 DELIMITERS, CHOSEN ON COLLISION DATA — and how they nest

**The user, 2026-08-10: *"we're remaking the system from scratch, you can change the established roles of delimiters.
And you haven't addressed the question of nested quotes/parentheses."*** Both fair. Delimiters are re-derived here from
measurement rather than habit, and nesting is answered rather than assumed.

**How often each character appears in the data it would have to coexist with** (9.2.7, 276,332 spell names, 133,699
`.m2` paths):

| char    | in spell names | in paths | role            | why                                                               |
|---------|----------------|----------|-----------------|-------------------------------------------------------------------|
| `*`     | **0**          | 0        | **wildcard**    | zero collisions anywhere — a free choice                          |
| `{` `}` | **5**          | 0        | *(unused)*      | cleanest bracket by far, but see below                            |
| `\|`    | 68             | 0        | **OR**          | low collision, and the Lucene/regex convention                    |
| `"`     | 315            | 0        | **phrase**      | low collision + universal convention                              |
| `(` `)` | 5,894          | 0        | **grouping**    | see the trade below                                               |
| `[` `]` | 9,246          | 0        | *(unused)*      | **worse than parens** — kills the obvious alternative             |
| `:`     | 12,477         | 0        | **axis prefix** | unavoidable; it is THE convention (Google, GitHub, Gmail, Lucene) |
| `'`     | **14,819**     | 0        | *(unused)*      | the worst character in the set — never use it as a delimiter      |

**⚠ THE ONE REAL TRADE: `(` collides with 5,894 spell names and `{` with 5.** On pure data, braces win by three orders
of magnitude. Parens are kept anyway, for two reasons that outweigh it:

1. **L0.** Every query language in the L0 table groups with parens. Braces read as "set" or "code block" and would have
   to be taught.
2. **⭐ DROPPING SPELL-LEVEL GROUPING (§8.9.1) ALREADY DEFUSED THE COLLISION.** `(` is only ever meaningful where a VALUE
   or CLAUSE is expected — after `axis:`, after a keyword word, or after `|` inside a scope. **In top-level free text it
   is an ordinary character**, so `fireball (rank 2)` searches literally and the 5,894 names are untouched.

That is a second dividend of a decision taken for readability, and it is why the collision count does not decide this.

##### ⭐ SETTLED: `{ }` IS THE ROW SCOPE, `( )` IS A VALUE GROUP — one meaning each

**The user disliked parens for scoping, then opened the door: *"I don't mind { } though, but it should be VERY clear
what it does."* That requirement is what picks the assignment, and it reverses the earlier recommendation.**

| delimiter | job                                                 | collisions in 276,332 spell names |
|-----------|-----------------------------------------------------|-----------------------------------|
| `{ }`     | **ROW SCOPE** — these conditions hold of ONE row    | **5**                             |
| `( )`     | **VALUE GROUP** — several alternatives as one value | 5,894, but see below              |
| `" "`     | **PHRASE** — a leaf; no delimiter is active inside  | 315                               |

    model:{fire missile}                 one model row matching both
    model:{attach:(chest|head) fire}     attached at chest OR head, and matching fire
    model:{attach:"right hand"}          a phrase as the keyword's value
    name:"Elixir (Greater)"              every delimiter is data inside a phrase

**THREE REASONS BRACES BEAT PARENS FOR THE SCOPE, and the third is the one that actually decides it:**

1. **Collisions: 5 against 5,894.** Three orders of magnitude, measured.
2. **Braces are semantically HONEST here.** In maths `{ }` is a SET and `( )` is precedence grouping. A row scope is a
   set of conditions on one row — and since spell-level grouping was dropped (§8.9.1), **we no longer use grouping for
   precedence at all**. Parens would name a job the language stopped having.
3. **⭐ PARENS WOULD IMPORT THE WRONG INTUITION — the independent review's sharpest L0 point, which I under-weighted
   first time.** Lucene's `field:(a b)` means `field:a AND field:b` **over the DOCUMENT**; Lucene has no rows, so its
   parens cannot mean "one row satisfies both". Borrowing the familiar spelling for an unfamiliar meaning is **worse
   than an unfamiliar spelling**, because prior knowledge actively misleads. An unfamiliar brace prompts learning; a
   familiar paren prompts a confident wrong guess. That is L12 exactly.

**And each delimiter now means EXACTLY ONE thing**, which is the user's "VERY clear" requirement satisfied structurally
rather than by documentation. One symbol with two roles is what L12 (3) forbids — it is the trap quotes fell into in
1.0.

**Parens keep their 5,894 collisions harmlessly**, because a value group only appears INSIDE a scope. In top-level free
text a paren is ordinary data, so `fireball (rank 2)` still searches literally.

##### EXACT MATCH IS `=`, NOT A QUOTE — the roles stay unshared

**The user asked whether the no-shared-roles rule covers the exact-match requirement. It did not, and that was a gap.**
`"…"` groups words into ONE value with spaces preserved; **matching stays SUBSTRING**. `name:"blood pool"` finds names
CONTAINING that, never names equal to it. Loading exactness onto the quote as well would be precisely the shared role
the rule forbids — and it is what 1.0 half-did by calling quoted spans "exact-phrase tokens".

**`=` already owns exactness, so extending it to text is the SAME role on another type, not a second role.**
`scale:=50` is already "exactly fifty" (§4.2, and `numericTest`'s `=` case in 1.0). Text simply joins:

    name:Fireball        contains        380
    name:=Fireball       IS              239
    name:="Blood Pool"   IS, multi-word    5    ← `=` anchors, `"` groups; each does one job
    name:"Blood Pool"    contains         16

**Measured on 9.2.7**, and `=` appears in only **72** spell names — nearly free, and reserved as an operator anyway.

**Each delimiter keeps exactly one job, and they COMPOSE:**

| token | job                                                 |
|-------|-----------------------------------------------------|
| `"…"` | group words into one value, spaces preserved        |
| `=`   | anchor the match — the whole value, not a substring |
| `{…}` | one row satisfies all of it                         |
| `(…)` | alternatives as one value                           |
| `*`   | any value                                           |

**Per-type meaning, as L9 requires** — the type says what "exact" is: for `text` the whole string, for `enum` the whole
enum name (which its exact-first ladder already does), for `id` always (equality is the only mode it has), and for
`path` the whole path, which is legal but rarely what anyone wants.

**⛔ `=` and `*` are mutually exclusive in one value.** `name:=Fire*` asks for an exact match to a pattern, which is a
contradiction — a static error, not a silent winner. Same class as §2.4.3 (d)/ (e).

**⚠ THIS DOES NOT REOPEN ANCHORING FOR PATHS (§3.2).** `=` matches the WHOLE value; it is not word-boundary anchoring,
and it still cannot separate `bee` from `beer` inside `beecreature`. The bee/beer finding stands untouched.

##### ⚠ THE COROLLARY — the user never SEES a delimiter on a committed query

*"The user doesn't actually see the chip scoping tokens, they aren't rendered."* (user, 2026-08-10). A committed query
is a row of CHIPS: `model:{fire missile}` renders as `Model │ fire missile`. **The delimiter lives in the URL and while
typing, and nowhere else** — which is why it is chosen on parseability and honesty rather than on looks.

**So "the highlighter must show the parse" is true of only ONE of the two moments a query exists in:**

| moment           | what is seen     | what shows the structure                                                |
|------------------|------------------|-------------------------------------------------------------------------|
| **committed**    | chips            | **the CHIP RENDERING is the parse** — no delimiters, structure is shape |
| **while typing** | raw text in `#q` | **the highlighter** — the only thing between the user and a mis-parse   |

So every L12 obligation collected in §8.9.3 and §8.9.4 — draw the OR split, show negation depth, show what an axis
consumed — is a **typing-time** obligation. At rest it is the chip layout's job, and **a chip layout that cannot express
a scope cannot render its own query.** That is a larger UI requirement than syntax highlighting, and it is the one this
design actually imposes.

##### ⭐ BRACES ARE FOR MORE THAN ONE CLAUSE — a single value never needs them

**The user, 2026-08-10: *"do chips accept a single token, like a quoted string, without curly brackets scoping around
it?"* Yes, and this is the property that keeps the common case clean.**

The grammar draws it with two productions and the brace is the whole difference:

    bind  := axis ":" value                   ONE value, no braces
    scope := axis ":" "{" inner "}"           MORE THAN ONE clause, on one row

    model:fire                  a value
    model:"blood pool"          a value that happens to be a phrase
    model:(fire|frost)          a value that happens to be a group
    model:>4                    a value that happens to be a comparison
    model:=Fireball             a value that happens to be anchored

    model:{fire missile}        TWO clauses -> braces
    model:{attach:chest fire}   a bind and a term -> braces

**So braces mark MULTIPLICITY, not scoping-in-general.** A reader sees a brace and knows there is more than one
condition riding on the same row; no brace means exactly one thing is being asked. That is visible in the text with
nothing looked up, which is L12.

**And a single-clause scope is legal but redundant**: `model:{fire}` means what `model:fire` means, because a scope of
one clause is that clause. It parses, it is correct, and the canonical form drops the braces — the same leniency
direction as accepting parens above.

**⚠ THE PRACTICAL CONSEQUENCE: most queries never contain a brace at all.** `desc:kneel`, `attach:chest`,
`target:caster`, `model:fire`, `scale:10-90`, `name:="Blood Pool"` — every one is a bind. Braces appear only when the
user genuinely needs two conditions on the SAME row, which is the advanced case §2.4.2 exists for.

##### LENIENT INPUT: `axis:(…)` is accepted as a scope; `axis:"…"` is NOT

**The user, 2026-08-10: *"chips scoped by quotes and parentheses instead of curly brackets should be okey dokey if they
don't conflict with anything, no? And we can silently replace them because they're not visible to the user at any
point."*** The premise is right — a committed chip shows no delimiters, so the canonical form can be normalised to
`{ }` without anyone seeing it. **The two candidates then differ completely, and only one is safe.**

**✅ PARENS — accepted, and provably unambiguous.** The worry would be a clash with the value group, but check whether
the two readings can ever BOTH parse and disagree:

| written                | as a VALUE GROUP                    | as a SCOPE                               |                 |
|------------------------|-------------------------------------|------------------------------------------|-----------------|
| `model:(fire\|frost)`  | alternatives → content match        | `fire OR frost` as terms → content match | **same answer** |
| `model:(fire)`         | one value                           | one term                                 | **same answer** |
| `model:(fire missile)` | ⛔ invalid — no separator           | `fire AND missile`                       | only one parses |
| `model:(attach:chest)` | ⛔ invalid — a colon is not a value | a bind                                   | only one parses |

**They never both parse into different meanings.** So the rule is a fallback, not a guess: *try value group; if it does
not parse, read it as a scope* — and normalise to `{ }` on commit. That costs nothing in ambiguity and buys leniency for
the two groups most likely to type it: people carrying 1.0 habits, and people carrying Lucene/Google habits.

**⛔ QUOTES — refused, and this is the one real objection.** `model:"fire missile"` has a perfectly valid PHRASE reading
(the literal substring `fire missile`, which matches almost nothing) that DIFFERS from the scope reading (a row matching
both). **Both parse. They disagree. Nothing in the text says which.**

That is exactly the trap §2.4.4 exists to delete — 1.0's two kinds of quote, the one that made
`name:(fire "icon frost")` silently return 0. Re-admitting it as "leniency" would reintroduce the defect under a
friendlier name, and it would break `name:"Blood Pool"`, which must stay a phrase.

**And one correction to the premise, which is why this is a decision rather than a shrug:** the delimiters are invisible
on a COMMITTED chip, but they are visible **while typing** and **in a shared URL**. So a silent replacement is safe on
commit and would be a live rewrite of what the user is looking at if done a keystroke earlier. **Normalise at commit,
never during.**

##### How they NEST — three rules, and a phrase is a LEAF

**1. Parens nest, and they must.** Precedence is `-` > AND > `|` (§8.9.4 depends on it), so `|` is the LOOSEST operator.
That means an alternation cannot be a keyword's argument without a group:

    model:{attach:chest|head}      =  (attach chest) OR head        ← precedence, and probably not meant
    model:{attach:(chest|head)}    =  attached at chest OR head     ← the group IS the single token (L6)

**2. A PHRASE IS A LEAF. No delimiter is active inside it.** Parens, pipes, dashes, stars and colons inside `"…"` are
ordinary characters — which is what makes every awkward spell name searchable:

    name:"Embody Hero: Illidan"    the colon is data, not a prefix
    name:"Elixir (Greater)"        the parens are data
    model:"beam|chain"             the pipe is data

**3. A quote inside a phrase is escaped `\"`.** Only 315 spell names contain a double quote, so this is rare by
measurement — but it must exist, or those 315 are unsearchable as exact phrases:

    name:"the \"real\" one"

Doubling (`""`, the CSV convention) was the alternative and loses: it makes an empty phrase `""` and an escaped quote
ambiguous at the start of a value.

**What CANNOT nest: a phrase inside a phrase.** There is no such thing — rule 2 makes the inner quotes data, and rule 3
is how you write one. So the nesting depth of quotes is always exactly one, which is the property that keeps the
tokenizer simple and the highlighter honest.

#### 2.4.1 The grammar

```
query    := clause ( clause | "|" clause )*      juxtaposition = AND, "|" = OR
clause   := "-"? ( scope | bind | term )

scope    := axis ":" "{" inner "}"               ONE ROW of that column satisfies all of it (L3)
inner    := iclause ( iclause | "|" iclause )*
iclause  := "-"? ( bind | term )                 NO scope here: depth is capped at 1 (§2.4.3g)

bind     := axis ":" value                       an axis and its value — at ANY level
term     := value                                bare = a content match

value    := phrase | word | number | comparison | range | wildcard | vgroup
vgroup   := "(" value ( "|" value )* ")"         alternatives as ONE value
phrase   := '"' ( char | "\\" char )* '"'          a LEAF: no delimiter is active inside
```

**Precedence: `-` > AND (juxtaposition) > `|`.** Standard, and §8.9.4's DNF result depends on it.

##### ⭐ THERE IS NO ARITY RULE IN THIS GRAMMAR, AND THAT IS THE POINT

**An axis always binds with `:`.** `attach:chest` globally, `model:{attach:chest}` inside a scope — the SAME production
either way. So the old "a word takes the single token after it" (L6) **disappears from the grammar entirely**:
`bind := axis ":" value` binds exactly one value by construction, and a `vgroup` or a `phrase` is one value.

**This kills the independent review's worst structural finding.** §8.9 recorded that L6's arity had no production, so
`model:(-attach chest)` and `model:(attach -chest)` shared a parse tree, negation bound by two rules, and **the parser
needed the axis registry to decide where a `-` attached** — meaning registering an axis could change a bookmarked query.
With `:` doing the binding, **the parse is registry-independent**: a token either carries a colon or it does not, and
that is visible in the text (L12).

**The rule a reader can hold: a bare token is ALWAYS content; `axis:value` is ALWAYS an axis.** Nothing is looked up to
decide which.

##### It also fixes the `caster` defect (L4) in the GRAMMAR rather than by renaming

§7's flagship defect is that `caster` is a mask test in four columns and a substring on enum names in the fifth. Under
this grammar the two are simply different forms:

    target:caster            the mask bit — an axis binding
    model:{target:caster}     …scoped to a model row
    mech:caster              a CONTENT match on this column's enum names — a bare term

One word, two spellings, no ambiguity and no rename required. **L4 is satisfied structurally.**

#### 2.4.2 Where nesting SITS — the two levels, and why they differ

Straight out of L3, and there is no bracket at the spell level — **juxtaposition IS the spell-level conjunction:**

| written                   | level       | means                                                              |
|---------------------------|-------------|--------------------------------------------------------------------|
| `model:fire model:arcane` | **spells**  | a fire model row AND an arcane model row — possibly different rows |
| `model:{fire arcane}`     | **one row** | a single model row matching both                                   |

**The same operators at both levels; the brace says which one you are in.** That is the whole distinction, and it is
visible in the text rather than in a bracket's position — which is what L12 demanded and what killed the `(…)` spelling
these two forms used to share (§8.9.1).

**Quantification lands asymmetrically, and honestly:**

    -model:fire        ¬∃row: fire        "has no fire model"          ✅
    model:{-fire}       ∃row: ¬fire       "has a model that isn't fire" ⛔ illegal — no positive anchor, below
    ∀ "all model rows are caster"                                       ⛔ unsayable — register #4, OPEN

##### LOCAL NEGATION — THREE DEPTHS, and the fourth is BANNED

**The user challenged this as "problematic and confusing" (2026-08-10) and was half right: the VALUE is real and
measured, the CONFUSION was concentrated in one form, and that form is now illegal.**

**⚠ THE MEASUREMENT, STATED HONESTLY — IT IS A BOUND, NOT A CORRECTION.** An earlier version of this section called the
figure below "33% silently dropped" and treated it as an error rate. **That was wrong twice: the numbers are a
PARTITION, and the scoped form has never been measured at all** (it cannot be — it does not exist in 1.0).

| query                       | rows       |                                             |
|-----------------------------|------------|---------------------------------------------|
| `model:fire`                | 14,198     | = 9,575 + 4,623 exactly — a partition       |
| `model:fire -model:missile` | 9,575      | the flat form. Every one of these qualifies |
| `model:fire model:missile`  | **4,623**  | the band where the two questions CAN differ |
| **`model:{fire -missile}`** | **?**      | ⛔ **UNMEASURED. Lies in [9,575 · 14,198]** |
| `sound:cast`                | 51,117     | = 30,120 + 20,997                           |
| `sound:cast -sound:impact`  | 30,120     |                                             |
| `sound:cast sound:impact`   | **20,997** | the band, 41%                               |

**So 33% is the MAXIMUM possible divergence between the two readings, not the observed one.** Every spell in the flat
form's 9,575 also satisfies the scoped form; the question is how many of the 4,623 have a fire row that is *itself*
not a missile. Nobody knows, because answering it requires the row model.

**⭐ THEREFORE THIS NUMBER IS THE KERNEL PROTOTYPE'S FIRST ACCEPTANCE TEST** (process log §4.5 step 1, which already
schedules a `Column.rows()` prototype for `model`). **If the scoped form comes back near 9,575, the row scope buys
almost nothing and the whole brace apparatus must be re-costed before the rest is built.** That is a genuine gate, not a
formality — the brace pays for the scope, the positive-anchor rule, the depth-1 cap, the incomplete/invalid dual and a
chip renderer that does not exist.

**What is NOT in doubt is the shape of the need**: §8.9.5 shows row negation earns its keep when the negated term is a
row PROPERTY (a category like `missile`, carried by every row) and is a trap when both terms are content words. The open
question is the size of the population, not the existence of the case.

**THE RULE, and it is a restriction rather than a generalisation: inside a scope, negation REFINES — it may not be the
whole predicate.** Every scope needs a positive anchor.

| written                       | depth            | reads                                  |                                                                                                    |
|-------------------------------|------------------|----------------------------------------|----------------------------------------------------------------------------------------------------|
| `-(model:arcane -model:fire)` | query            | —                                      | ⛔ **no production** — §8.9.1 dropped spell grouping. Write `-model:arcane \| model:fire` (§8.9.4) |
| `-model:fire`                 | chip             | no fire model row exists               | ✅                                                                                                 |
| `model:{fire -missile}`       | row, refining    | a fire model row that is not a missile | ✅                                                                                                 |
| `model:{-fire}`               | row, bare        | —                                      | ⛔ **illegal**                                                                                     |
| `model:{-attach:chest}`       | row, scoped axis | —                                      | ⛔ **illegal — use `-attach:chest`**                                                               |

**⭐ BANNING THE BARE FORM DELETES THE TRAP ENTIRELY.** The confusing case was never `model:{fire -missile}`; it was that
`-model:fire` and `model:{-fire}` disagree on spells with NO models — the first vacuously true, the second false. With a
positive anchor required, **every scope must find a row before it can exclude anything**, so the vacuity has nowhere to
appear and both readings become the obvious ones:

    -model:missile         "don't show me spells with missiles"        — no models? not excluded. obvious.
    model:{fire -missile}  "show me fire models that aren't missiles"  — no models? no match. obvious.

**And it deletes three more problems at a stroke** — all four were separate findings of the independent review (§8.9):

- the ∀ double-negative `-model:{-caster}` becomes unwritable, which is right: its showcase was WRONG (vacuously true of
  model-less spells), and the reviewer's judgement stands that no roleplayer would type it.
- `model:(attach -chest)`'s baffling reading goes with it — and L6's `:` binding now makes it unwritable.
- **negated word-form axes disappear, so the parser stops needing the axis registry to place a `-`.** That was the
  review's finding #2/#3 and its worst structural consequence — registering an axis could change a bookmarked query.

**What is LOST is a genuine capability and it is named honestly: universal quantification.** "All model rows are caster"
is no longer sayable. It was sayable for one day, in a form that was measured wrong and that nobody would type.
**Expressibility register #4 reverts to OPEN** and, if it is ever wanted, gets a word of its own rather than a double
negative.

#### 2.4.3 The edge cases the grammar MUST answer

A recursive grammar creates combinations nobody typed on purpose. Each of these was found by walking the BNF against the
laws; leaving any of them undefined is how 1.0 got its exceptions.

**(a) `count` is a property of the SCOPE, not of a row.** It is the one axis that cannot be a row predicate — a row has
no cardinality. Inside a scope it counts **the rows that satisfy the rest of that scope's predicate**:

    model:{target:caster count:>4}   more than four CASTER model rows   ← filtered count, §9 #3
    model:{count:>4}                 more than four model rows in all
    count:>4                         the same, via the global door (L5)

So the register's filtered-count entry is not a special case; it is what `count` already means once a scope exists.

**(b) A VALUE GROUP is one value.** `(a|b)` after a colon binds as a single value, so nesting never changes what an axis
consumed:

    model:{attach:chest}              one value
    model:{attach:(chest|head)}       still one value — the group IS the value

**(c) `-` prefixes a CLAUSE, and a bind is one clause.** With `:` doing the binding (L6) there is no word-form ambiguity
left to resolve:

    -attach:chest                   NOT attached at chest        ← the only form at clause level
    model:{attach:chest -missile}   at the chest, not a missile  ← refining, legal
    model:{-attach:chest}           ILLEGAL — a scope needs a positive anchor (§2.4.2)
    model:{attach:* -chest}         attached somewhere, "chest" not in the corpus — legal, rarely meant

**Negation is never an axis's VALUE** — there is no "negated value", only a negated clause. `scale:-50` is therefore
minus fifty, unambiguously, because `-` there sits in value position (§4.5).

**(d) A scope may not name another column's axis.** `model:{sound:fire}` is a static error, not an empty result: the
scope is a set of MODEL rows and a sound axis cannot read one. Universal axes (`count`, `target`) are the exception —
they apply in every scope by definition (L1). Reject at parse time and say so in the bar; L2's "answer, never fall
through" is about DATA, not about nonsense.

**(e) EMPTY GROUPS ARE IDENTITIES, NOT ERRORS — corrected 2026-08-10 on the user's challenge** (*"can't `{}` just be
ignored as a junk token?"*). An earlier draft called them a static error. That was wrong for a practical reason and an
arithmetical one.

**Practically: auto-closing braces (§6) mean the EDITOR produces `model:{}`** the instant the user types `model:{`.
Erroring on a state the app itself just generated is hostile, and it is the §4.9.1 failure — shouting at a keystroke the
next one will fix. 1.0 already has this instinct: `query.ts` skips separator-only tokens because *"it can never match,
so it must not narrow the search to nothing either."*

**Arithmetically, they are not junk — they have truth values, and the two brackets get OPPOSITE ones:**

    model:{}          empty CONJUNCTION = true   ->  ∃row: true   ->  "has any model row"  ≡  model:*
    model:{attach:()} empty DISJUNCTION = false  ->  matches nothing

So `{}` needs no rule: the empty scope is satisfied by any row, which is exactly `*` (§3.3), and the two spellings
agreeing is a consequence rather than a coincidence. **This is also a good live-preview**: typing `model:{` narrows to
"spells with a model" straight away, which is where the user was heading.

**`()` is the dual and matches nothing**, which is correct but unhelpful — so while TYPING it is incomplete and silent
(§4.9.1), and on PASTE it is a reported error (§4.9.9), because there nothing more is coming.

**A stray `{}` or `()` in top-level free text is neither** — it is ordinary character data, because those delimiters are
only active where a value or clause is expected (§2.4.0). `fireball {2}` searches literally.

**(f) Two spellings of OR is one too many — `,` is retained ONLY for numbers.** `id:133,134` stays because a bare list
of ids is how people paste them, and the rule is syntactic (every part a number), not per-field. Everywhere else `|` is
the only OR. ⚠ This is a deliberate exception to L1 and the only one in the grammar; if it ever causes a question,
delete it rather than growing it.

**(g) ⭐ NESTED `{ }` — MAXIMUM SCOPE DEPTH IS EXACTLY 1, and that is a referent problem, not a restriction.**

**A row scope binds its contents to ONE ROW. Inside it you are already at a row, so a second scope has nothing left to
bind to.** Depth 2 is not unsupported — it has no meaning to support. Every job a nested brace might be reaching for is
already taken: several clauses on one row is the scope itself, alternatives as one value is `( )`, and a multi-word
value is `" "`.

**So the treatment depends on WHERE the brace sits, and there are three positions:**

| the `{` sits…                                           | treatment                                                          | why                                                                                                     |
|---------------------------------------------------------|--------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| after `axis:` at depth 0                                | **the row scope**                                                  | the only place the production exists                                                                    |
| after `axis:` INSIDE a scope — `model:{attach:{chest}}` | ⛔ **ERROR** — *an axis inside a scope takes a value, not a scope* | `bind := axis ":" value`, and a value is never a scope                                                  |
| bare inside a scope — `model:{fire {`                   | ⛔ **ERROR** — no production admits it                             | see the incompleteness test below                                                                       |
| anywhere in **top-level free text**                     | ✅ **PLAINTEXT** — ordinary character data                         | §2.4.0: delimiters are live only where a clause or value is expected. `fireball {2}` searches literally |
| inside a **phrase**                                     | ✅ **PLAINTEXT** — a phrase is a LEAF                              | `name:"Elixir {Greater}"` is data                                                                       |

**⚠ IT IS INVALID, NOT INCOMPLETE — apply §4.9.1's own test.** *Could appending fix it?* For `model:{fire {` the answer
is no: no suffix produces a legal query, because no production admits a scope at depth 1. **That is the opposite of an
unclosed brace**, which one `}` rescues. So a nested scope errors immediately rather than staying silent while typing —
and this is the same class as §2.4.3 (d)'s foreign axis: L2's *answer, never fall through* governs absent DATA, not
nonsense.

**⛔ DO NOT "just ignore it" and DO NOT flatten it.** Both were considered and both are L12 (4) — a form that reads
correctly and behaves otherwise:

- **Flattening** (`model:{fire {missile}}` ⟶ `model:{fire missile}`) silently answers a question the user did not write.
  It is defensible — a one-clause scope IS that clause (§2.4.0) — but the user who typed the inner brace was reaching
  for something, and flattening tells them they got it.
- **Plaintext inside a scope** is worse: `{` appears in **5** spell names and **0** paths, so `{missile}` matches
  nothing and the result is a silent zero. Note this is what §2.4.0's delimiter rule would mechanically produce if the
  rule were read without this clause — which is exactly why the clause is written down.

**The editor makes the cap visible rather than only enforcing it:** `{` auto-closes only where a scope is legal
(§4.9.5), so typing `{` inside a scope produces a bare brace that does not pair. The absence of the auto-close IS the
signal.

**And if cross-column row correlation (§9 #7) is ever built, it arrives as a NAMED form, not as depth 2** — the same
resolution spell-level grouping got (§8.9.1). A second bracket level would still have no referent.

#### 2.4.4 QUOTES MEAN ONE THING NOW, and that is a deletion

**1.0 has two kinds of quote and it is a documented trap.** Inside a value they are phrase quotes; *around* a value they
are grouping and get stripped. The app's own docs got it wrong once — `name:{fire "icon:frost"}` silently degrades,
because the inner quotes make `icon frost` a phrase, `splitKeyword` never sees the keyword, and the query returns 0 with
no complaint.

**2.0: `"` is ALWAYS a phrase. `()` is ALWAYS a group. `\"` is a literal quote inside a phrase.** One meaning per
delimiter, which is the whole of L1 applied to punctuation.

The consequence is a real and deliberate syntax change — grouping that used to be written with quotes is now written
with parens:

    1.0:  model:"attach chest"          2.0:  model:{attach:chest}   or   attach:chest
    1.0:  name:"desc kneel"             2.0:  name:{desc:kneel}      or   desc:kneel
    1.0:  model:"fire missile"          2.0:  model:{fire missile}

and a phrase with a quote in it is now expressible at all: `name:"the \"real\" one"`.

Note the global door (L5) is the SHORTEST form for the common case, so most of these get shorter, not longer.

#### 2.4.5 What one recursive grammar closes

| problem                    | was                                                          | now                                                   |
|----------------------------|--------------------------------------------------------------|-------------------------------------------------------|
| cross-field OR (§9 #1)     | **silently wrong** — `model:fire\|sound:fire` = `model:fire` | `model:fire \| sound:fire`                            |
| row-level negation (§9 #2) | `model:"fire -missile"` = 0, `-` a literal                   | `model:{fire -missile}`                               |
| arbitrary DNF (§9 #6)      | had to be hand-converted to CNF                              | `model:fire model:arcane \| model:frost model:shadow` |
| implication (§9 #5)        | unexpressible                                                | `-model:arcane \| model:fire` — De Morgan, §8.9.4     |
| ∀ quantification (§9 #4)   | unexpressible                                                | ⛔ **still unexpressible.** Wants a word, not a form  |

**Four of five, one grammar, no new vocabulary** — and note the last two need no bracket at all, because AND binds
tighter than `|` (§8.9.4). That is the argument for nesting: not five features, the absence of an arbitrary restriction.

⚠ **The costs, stated rather than discovered later.** The chip bar is a flat sequence today and must learn to render a
row SCOPE — the real work, and a UI problem rather than an engine one. The highlighter must show the parse, because a
mis-scoped query is the one failure mode this grammar adds. And `|` no longer has a bare shorthand:
`model:fire|frost` parses as `model:fire OR frost`, so value alternation is written `model:{fire|frost}` or
`model:(fire|frost)`.

### 2.5 ⭐ THE EXTENSION CONTRACT — what each new thing is allowed to cost

**The user's standing requirement, 2026-08-10: *"we're making the system with EXPANDABILITY in mind to support new
datatypes and new items in the future."*** This table is that requirement made checkable. **It is the design's
acceptance test, and a better one than the count battery** — the battery says the engine still works, this says the
engine can still be extended.

| you are adding                      | it costs                                               | and it must touch        |
|-------------------------------------|--------------------------------------------------------|--------------------------|
| **a searchable question**           | one `Axis` record                                      | **no kernel file**       |
| **a datatype** (`length`, `colour`) | one `defineAxisType(…)` call                           | **no kernel file**       |
| **a unit** on an existing type      | one entry in `units`                                   | nothing else             |
| **a column** (a new row source)     | one `Column` with `rows()`                             | **no kernel file**       |
| **a notation** on an existing axis  | one entry in `types[]` + a measured collision check    | nothing else             |
| **a game version lacking the data** | `when?(d)` — a declaration                             | nothing else             |
| **a syntax / delimiter change**     | one edit to `GRAMMAR`                                  | nothing else             |
| **an operator**                     | `GRAMMAR` **+ a method on every type that accepts it** | ⚠ **the expensive one** |

**Only the last row is costly, and that is deliberate** — an operator is a promise made to every type (§4.2b), so adding
one is a language change and should feel like it. Everything above it is a declaration.

**⛔ THE FOUR THINGS THAT WOULD BREAK THIS CONTRACT**, each of which 1.0 does somewhere:

1. **A second list.** Any surface needing its own copy of the vocabulary (L11 — `desc` shipped searchable and invisible
   because `fieldCategories` and `help.ts` each held a literal field list).
2. **A per-field or per-type `if` in the kernel.** The kernel's defining property is that it knows no field name and no
   type name; the moment it switches on one, every future addition edits it.
3. **A type that adds its own operator** (§4.2b) — it becomes a dialect, and L1 is gone.
4. **An axis whose value needs the word "or"** — unless the "or" is between two spellings of one subject (§4.2b).

**The concrete test to run before declaring the kernel done: add a throwaway axis over a `float` column nobody has
touched — `BarrageEffect.ConeAngle` is the obvious candidate, 3 distinct values — and count the files edited.** If the
answer is one, the design holds. If it is four, it is 1.0 again with better vocabulary.

---

## 3. Why there is no `+`, and what wildcards are for

**⛔ BOTH ARE CLOSED: no `+`, no ordered override, no word-boundary anchoring.** Designed, approved and deleted the same
day. The measurements are kept because they are what closed it; the argument is in the process log §2.1.

### 3.1 The bee/beer problem does not exist — the operator was solving nothing

```
model:beer             369        ← ALREADY beer with no bee junk
model:bee              388        ← beer ⊂ bee, as substring-match sets
model:bee -model:beer   19        ← the actual bees. Works today, order-free
model:beer -model:bee    0        ← unsatisfiable BY DEFINITION
```

**Zero files in the listfile are both a bee and contain `beer`** (checked in SQL over every `.m2`) — a bee is
`beecreature.m2` / `beemount.m2` / `hangingbeetle01.m2`. So **searching the longer string IS the more specific search**,
free from substring matching, and it runs one way only.

`model:beer -model:bee` = 0 is therefore the CORRECT answer, not a gap: every beer contains "bee". An ordered `+`
returning 369 would not express something AND/NOT cannot — it would override a constraint to produce a set contradicting
its own query, which is why no engine in the L0 table works that way.

**The rule worth carrying forward: subtract the MORE SPECIFIC pattern from the LESS specific one.**
`model:bee -model:beer` = 19; `model:fire -model:firefly`. The direction that fails was already empty before the
operator was typed.

### 3.2 Anchoring cannot substitute either

Asset paths carry no word segmentation — `beecreature.m2`, `beerfest_keg01.m2`, `hangingbeetle01.m2`,
`8riv_beeflowers_b01.m2`. Split on `_` and the words are `beecreature` and `beerfest`, **neither of which equals `bee`
nor `beer`**. An anchored operator separates nothing and breaks both halves. **Substring matching is forced by the
corpus.**

### 3.3 `*` — one rule, and the filter buttons fall out of it

**⚠ `*` HAS TWO ROLES, NOT ONE — an earlier draft claimed "one rule, three readings that coincide" and they do not.**
Stating both is honest and costs nothing; pretending they are one is how `*` ended up on §8.9's FIXED list while still
carrying a third meaning.

| `*` written…                 | role                                   | reads                              |
|------------------------------|----------------------------------------|------------------------------------|
| **alone as the whole value** | **EXISTENCE** — the axis has any value | `model:*` has any model row        |
| **inside a token**           | **GLOB** — a pattern metacharacter     | `model:bee*`, `mech:unit_target_*` |

    *                every spell            — replaces the `-id:0` hack
    model:*          has any model row      ≡ the filter button, ON
    -model:*         has no model row       ≡ the filter button, OFF
    mech:unit_target_*   prefix glob, on a corpus that IS segmented
    model:bee*       prefix glob — still matches beerfest, and the hint says so

**They never collide, because position decides**: a lone `*` is a whole value and cannot also be a pattern; a `*` beside
other characters is a pattern and cannot also be an existence test. That is a rule a reader can apply from the text
(L12), which is the standard the "they coincide" story failed.

**⛔ THERE IS NO THIRD ROLE. `scale:10-*` IS NOT `*`-as-infinity** — an earlier draft spelled an open-ended range that
way and called it "one meaning". "Any value" and "no upper bound" are different propositions. **An open range is written
with the operator that already means it: `scale:>=10`.**

**Negation composes without a rule of its own**, which is the test that the existence role is right: `-model:*` is L3's
negated existential ("no model row"), exactly the tri-state filter row's third state. `-*` is the empty set —
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
/* Sketch. THE definition — including the operator contract, which is the
   substance of this type — is in §4.2b, "Should operators be PROPERTIES of a
   datatype?". Do not maintain two copies. */
export interface AxisType {
    name: string;                                  // "percent", "seconds", "length"
    storage: "int" | "float" | "string" | "locstring" | null;  // §4.1; null = valueless
    /* equals? compare? contains? glob? present?  — §4.2b.
       An ABSENT method is how a type DECLINES that operator. */
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

| name          | storage   | examples                                   | matches                                     | UI                |
|---------------|-----------|--------------------------------------------|---------------------------------------------|-------------------|
| `text`        | string    | spell name, description, kit name          | substring + glob                            | text              |
| `path`        | string    | model / sound files                        | substring + glob, **never anchored** (§3.2) | text              |
| `enum`        | int       | effect / aura / implicit-target names      | exact → substring → glob                    | **value picker**  |
| **`ordinal`** | int       | **expansion** — an enum WITH a total order | exact, plus `< > <= >= ..` on its ladder    | ordered picker    |
| `id`          | int       | spell id, SoundKit id, icon fid            | **equality only, never substring**          | exact + copy      |
| `bitmask`     | int       | target masks, attribute bits               | bit test **and combinations**               | **glyph toggles** |
| `count`       | int       | `count`, vehicle seats                     | integer compare, ≥ 0                        | stepper           |
| `seconds`     | int (ms)  | casttime, channeled                        | compare + `unlimited` sentinel              | number, `s`       |
| `percent`     | int       | scale, speed, desaturate, transparency     | **signed** compare                          | range, `%`        |
| `length`      | **float** | collision/hover height, beam length, range | compare                                     | range, `yd`       |
| `scale`       | **float** | model scale, attached-effect scale         | compare                                     | range, `×`        |
| `angle`       | **float** | cone angle                                 | compare                                     | range, `°`        |
| `rate`        | **float** | anim segment speed, ambient multiplier     | compare                                     | range, `×`        |
| `flag`        | —         | attribute bits, freeze, camo               | membership; **no value at all**             | toggle            |

*(There is no `mixed` type. An axis reading several notations — the sound column's files ∪ kit names ∪ kit ids —
declares `types: [path, text, id]`; see "One subject, several notations" above.)*

### 4.2b OPERATORS ACROSS TYPES — a type IMPLEMENTS an operator, it never REDEFINES one

**The user's question, 2026-08-10: *"should datatypes have defined operator overrides?"*** The answer is yes in a
strictly limited sense, and stating the limit is the whole of it — unlimited overriding would destroy L4 (one word, one
meaning) and L12 (a query reads as its own explanation) in a single stroke.

**THE RULE, in three parts:**

1. **Every operator has ONE ABSTRACT MEANING, fixed by the grammar and identical everywhere.**
2. **A type REALISES that meaning for its own domain. It may not give the operator a different meaning.**
3. **A type may DECLINE an operator — and declining is a STATIC ERROR, never a silent fallback.**

The abstract meanings, which no type may vary:

| operator             | abstract meaning                                        |
|----------------------|---------------------------------------------------------|
| `=`                  | **exactly this** — the whole value, not a part          |
| `<` `>` `<=` `>=`    | **ordering** — earlier/later in this type's total order |
| `-` (between values) | **an interval** in that same order                      |
| `*`                  | **any value**                                           |
| bare token           | **contains** — a partial match                          |

So `=` on a number is numeric equality and on text is the whole string: **the same idea, two domains.** That is
realisation. An operator meaning "greater than" on one type and "contains" on another would be redefinition, and is
forbidden.

**⚠ BUT THE OPERATOR TABLE ALONE DOES NOT MAKE THIS TRUE, and assuming it did was an error — see the section below.**
"Greater" is only unambiguous once each axis has exactly ONE value to be greater than. An axis carrying two numbers
makes `>` ambiguous no matter how carefully the operator is defined, which is what 1.0's `invis` does today.

**Part 3 is the one that prevents a whole class of 1.0 bug.** `name:>m` today substring-searches for the literal
`>m` — a silent nonsense answer. Under this rule the `text` type declines ordering and the bar says so. **This is the
same distinction §2.4.3 (d) draws: L2's "answer, never fall through" is about absent DATA, not about nonsense.**

#### Should operators be PROPERTIES of a datatype? Yes — as implementations, never as overrides

**The user asked directly. The answer is yes, and it is not a preference: it is forced by the architecture.** The only
alternative is a switch on type name inside the kernel — `if (type === "percent") … else if (type === "seconds") …` —
which is exactly the branching the kernel exists not to have. **The kernel's defining property is that it knows no field
name and no type name**, so operator behaviour has to live on the type or the design collapses.

**But "override" is the wrong word, and the distinction is load-bearing:**

|                    |                                                                                              |
|--------------------|----------------------------------------------------------------------------------------------|
| **override**       | a type may give an operator a DIFFERENT meaning — `>` is "greater" here and "contains" there | ⛔ forbidden: destroys L4 and L12 |
| **implementation** | the contract is fixed by the grammar; the type supplies the BODY for its domain              | ✅ required |

**This is the standard pattern for precisely this problem (L0)** — Rust's `Ord`/`PartialOrd`, Java's `Comparable`,
Python's rich comparisons. A type never redefines what `<` MEANS; it supplies the ordering `<` consults.

**The shape, and note that absence IS the decline** — no separate capability list to drift out of step (L11):

```ts
export interface AxisType {
    name: string;
    storage: "int" | "float" | "string" | "locstring" | null;

    /* THE OPERATOR CONTRACT. Each is OPTIONAL, and an ABSENT method means the
     * type DECLINES that operator — which the parser reports as a static error
     * rather than falling through (§4.2b part 3). The contract is fixed here;
     * only the bodies vary. */
    equals?(value: unknown, operand: string): boolean;   // =        exactly this
    compare?(value: unknown, operand: string): number;   // < > <= >= ..   a TOTAL order
    contains?(value: unknown, operand: string): boolean; // bare     partial match
    glob?(value: unknown, pattern: string): boolean;     // *        with a pattern
    present?(value: unknown): boolean;                   // *        bare — has any value

    /* presentation, not matching */
    format(value: unknown): string;

    ui: "text" | "number" | "range" | "picker" | "toggle" | "glyphs";
    unit?: string;
    step?: number;
    sentinels?: Record<number, string>;
}
```

**Reading the §4.2b matrix off this is mechanical**: `text` implements `equals`, `contains`, `glob`, `present` and omits
`compare` — which is why `name:>m` is an error instead of a substring search for `>m`. `ordinal` is `enum` plus a
`compare`. `flag` implements `present` alone.

**⚠ THE ONE RULE THAT KEEPS IMPLEMENTATIONS FROM BECOMING OVERRIDES: `compare` must be a TOTAL ORDER** — transitive,
antisymmetric, and consistent with `equals`. That is the contract a type promises when it implements it, and it is
checkable. A `compare` that is not a real ordering is how `>` quietly starts meaning something else, which is the
failure the user identified.

#### ⭐ ONE AXIS, ONE VALUE — the rule that makes "one abstract meaning" true

**The user pushed back on the claim above: *"Greater can mean a larger %, or it can mean by the count of occurrences of
a pill per spell, or it can mean something else entirely in different datatypes."* They are right, and 1.0 proves it:**

    mech:"invis 13"    16    the CHANNEL number 13
    mech:"invis >0"   703    the DETECTOR COUNT — a different quantity entirely
    mech:"invis =0"     2    a detector count of zero

    mech:"seat 8"      19    eight seats
    mech:"seat >2"     36    more than two seats  — same quantity, no ambiguity

**On `invis`, `13` and `>0` are two different numbers on ONE axis**, and the only thing telling them apart is whether an
operator was typed — `operatorOnly: true` in `pilltypes.ts`. So `invis 13` is channel 13 while `invis =13` would be
*thirteen detectors*: the same digits, the opposite question, distinguished by a character that looks like punctuation.
That is L12 (3) exactly, and it is shipped today.

**SO THE FIX IS NOT AT THE OPERATOR LEVEL. It is: AN AXIS HAS EXACTLY ONE VALUE.**

- **`>` always orders THE AXIS'S OWN VALUE.** What that value IS varies — a percent for `scale`, seconds for
  `casttime`, seats for `seat` — and that is realisation (§4.2b), not redefinition.
- **Cardinality is ALWAYS the separate `count` axis**, never an alternate reading of a comparison. "More than four scale
  pills" is `fx:{scale:* count:>4}`; "a scale above four percent" is `fx:{scale:>4}`. Two questions, two spellings, no
  shared operator.
- **A concept carrying two numbers is TWO AXES.** `invis` carries a channel id and a counterpart count, so it becomes
  two: the channel (an `id`, exact only) and the detector relationship, which is a cross-reference and needs its own
  name. Whatever it is called, it is not a second number on `invis`.

**This deletes `operatorOnly` entirely**, which existed to paper over exactly this. It served two jobs in 1.0 and 2.0
removes the need for both: disambiguating two quantities on one axis (fixed by one-axis-one-value, above), and stopping
a loose number being read numerically when the corpus might also match it (fixed by `:` binding — `speed:>70` binds
explicitly, and a bare `70` inside a scope is unambiguously a content term).

**The test to apply when declaring any axis: can I write down its single value and its unit?** If the answer needs the
word "or", it is two axes.

#### ⭐ ONE SUBJECT, SEVERAL NOTATIONS — and this is NOT a breach of the rule above

**The user's reminder, 2026-08-10: *"some keywords support multiple types. Like `kit` can search both by soundkit name
and soundkit ID."*** True, and it looks like a contradiction of one-axis-one-value until the two cases are separated:

|                                  | example                                                | verdict                        |
|----------------------------------|--------------------------------------------------------|--------------------------------|
| **two QUANTITIES** on a word     | `invis` = a channel id **and** a detector count        | ⛔ **two axes.** Split it      |
| **two NOTATIONS** of one subject | `kit` = a sound kit, written as its name **or** its id | ✅ **one axis, two notations** |

**THE DISCRIMINATOR, and it is decidable rather than a matter of taste: when both readings match, do they select the
SAME row?** `kit:85701` and `kit:SPELL_MA_Revamp_Frostbolt_Precast` name one kit. `invis:13` and `invis:>0` name
unrelated populations. So the §4.2b test stands and gains a clause: **if you cannot write the value without "or", it is
two axes — unless the "or" is between two SPELLINGS of one thing.**

**THE RULES:**

1. **An axis declares an ORDERED list of accepted types.** `types: AxisType[]`. Most axes declare exactly one.
2. **Dispatch is by the SHAPE of the operand, and the declared order is the precedence** — the first type whose grammar
   accepts the text wins. This does not breach L9: L9 forbids a number acquiring MEANING from its shape, and here both
   readings denote the same subject, so nothing is inferred about meaning.
3. **⚠ A COLLISION MUST BE MEASURED, NEVER ASSUMED ABSENT** — and where one exists, the losing notation keeps an
   explicit door. It is never silently unreachable.
4. **An operator is offered only if EVERY declared type implements it.** `kit:>5` is a static error, because `id` and
   `text` both decline ordering (§4.2b) — so a multi-notation axis is the INTERSECTION of its types' capabilities, never
   the union.

**MEASURED for `kit` on the 8.3.0 name table — 84,351 kits: exactly THREE names are all digits**, and they are `"0"`,
`"9"` and `"150"` — placeholder junk, and **not one of them equals its own id** (43783, 39078, 43207). So `kit:<number>`
reads as the ID, the three are still reachable as `kit:="150"`, and nothing real is lost.

**⛔ THIS DELETES THE `mixed` TYPE.** The table below used to carry `mixed` for "the sound column (files ∪ kit names ∪
ids)" — vague, and the independent review correctly called it unrepresentable. It was never a type: it is an axis with
three notations, each of which has a real type. **One less concept, and the thing it stood for is now expressible.**

#### The matrix

| type                                                | `=`              | `< > <= >=`                     | `-` range   | `*`                                        | bare (contains) |
|-----------------------------------------------------|------------------|---------------------------------|-------------|--------------------------------------------|-----------------|
| `text`                                              | whole string     | **decline**                     | **decline** | glob                                       | ✅              |
| `path`                                              | whole path       | **decline**                     | **decline** | glob (weak — §3.2)                         | ✅              |
| `enum`                                              | whole enum name  | **decline**                     | **decline** | glob                                       | ✅ on the name  |
| **`ordinal`**                                       | the rung         | ✅ **its ladder**               | ✅          | has one                                    | ✅ on the name  |
| `id`                                                | ✅ the only mode | **decline** — ids have no order | **decline** | any id                                     | ⛔ **never**    |
| `bitmask`                                           | the exact mask   | **decline**                     | **decline** | any bit set                                | ⛔              |
| `count`                                             | = n              | ✅                              | ✅          | answered, but a NO-OP — see `total` (§4.4) | ⛔              |
| `seconds` `percent` `length` `scale` `angle` `rate` | = n              | ✅                              | ✅          | has a value                                | ⛔              |
| `flag`                                              | **decline**      | **decline**                     | **decline** | presence                                   | ⛔              |

**⭐ `ordinal` IS A NEW TYPE AND IT EXPLAINS WHY `xpac` FELT SPECIAL.** An expansion is an enum WITH a total order, so
`id:{xpac:>legion}` is ordering — realised on the ladder rather than on a number. 1.0 handled this with a private second
operator alphabet (`XPAC_VALUE`), which is exactly the duplication L1 forbids. Declaring `ordinal` puts it back under
the one grammar: same operators, same precedence, a different domain to compare in.

**The other candidates for `ordinal`, none built:** item quality (poor→legendary), spell school if it were ever ordered,
a difficulty tier. Each would cost a declaration rather than a parser.

**⚠ WHAT THIS FORBIDS, so it is not "discovered" later as a feature:** a type may not add an operator of its own, may
not change precedence, and may not make an operator mean something the table above does not say. If a type needs a
question the operators cannot ask, **it needs an AXIS, not an operator** — which is the same answer L1 gives to a field
that wants its own grammar.

### 4.2c UNIT SYMBOLS — a property of the TYPE, and it CONVERTS

**The user's question, 2026-08-10: *"unit symbols. For example s/ms/m for time units, or % for percentage, or `#`
prefix for hex."*** Units sit exactly where operators sit — declared by the type, never by a field (L1) — and the same
three-part rule governs them: one abstract meaning, realised per domain, declined by absence.

**THE SEVEN RULES:**

1. **A unit is OPTIONAL. A bare number means the CANONICAL unit.** `scale:50` is fifty percent. The common case stays as
   short as it is today, exactly as most queries contain no brace (§2.4.0).
2. **⭐ A unit CONVERTS; it does not annotate.** `casttime:500ms` is half a second, and `casttime:500` is five hundred
   seconds. That is what makes `ms` worth having rather than decoration — **9.2.7 has 31 sub-second cast times**, so the
   query is real.
3. **⭐ THE CANONICAL UNIT IS WHAT THE PILL PRINTS, NEVER WHAT THE PACK STORES.** `SpellCastTimes.Base` is milliseconds;
   the delivery line prints seconds; therefore `casttime:2` is two seconds. Any other choice means a query cannot be
   written by reading the screen, which is L12.
4. **A unit NEVER selects an axis** — it only scales a value inside one. If `50%` and `50s` chose different axes, the
   unit would be doing the axis's job, which one-axis-one-value forbids.
5. **An unknown unit is an ERROR, never ignored and never dropped.** `scale:50s` says *scale takes a percentage* — §4.2b
   part 3, taxonomy #4. Silently reading it as `50` is the fall-through L2 exists to ban.
6. **A type that declines `compare` declines units.** `text` has neither, so `name:100%` is ordinary text. **This is why
   the collisions cannot bite: 396 spell names contain `%` and 38 contain `#`, and none is in value position on a
   numeric type.** Structural, and the same argument as the range dash (§4.5).
7. **Every unit has an ASCII spelling; a prettier symbol is display-only.** `×` → `x`, `°` → `deg`, folded by the
   existing typographic pass (§4.9.9a) rather than by new machinery. **Measured: ZERO spell names contain `×` or `°`.**

**Units are PER-TYPE, so there is no global unit vocabulary to collide.** `m` may mean minutes on `seconds` and metres
on `length` — an axis has exactly one type, so the two never meet. Declare a unit when the axis that needs it exists; do
not pre-invent a table of them.

**In a range, the unit may sit on either bound or both, and mixed scales convert:**

    casttime:500ms-2s     legal, and the mixed spelling is the useful one
    scale:10-90%          the unit on the last bound
    scale:(-50%)-10%      §4.5's parenthesised negative, unchanged

**⭐ UNITS AND `domain()` COMPOSE INTO THE WARNING TIER, which is the part that earns its keep.** `casttime:500` is legal
and means 500 seconds — a value no spell has. `domain()` already knows the real spread (§4.5), so an out-of-domain
number raises a WARNING whose fix is the unit conversion: *"did you mean 500ms?"* **That is a STRUCTURAL fix computed
from the type**, not a spelling guess, so it does not breach the no-did-you-mean rule (§4.9.4).

#### A RADIX IS NOT A UNIT — `#` is a different mechanism

|           | changes                              | example         |
|-----------|--------------------------------------|-----------------|
| **unit**  | the SCALE of the value               | `500ms` ≠ `500` |
| **radix** | how the DIGITS ARE READ — same value | `#FF` = `255`   |

Both hang off the type parsing its own operand, but they must stay named apart or something that is really a notation
gets declared as a unit and starts converting.

**⛔ AND HEX IS BLOCKED ON A SEMANTIC, NOT ON SYNTAX.** Tints ship as packed `0xRRGGBB` (§ proc types 1/22/23), so
`tint:#FF00AA` parses fine and is nearly useless: **nobody knows a tint's exact packed value**, and exact equality over
16.7M values answers almost nothing. A colour axis needs nearest-colour distance or named buckets (`tint:red`), which is
a design question, not a notation. **Register entry §9 #8 — do not ship `#` until the matching semantic is decided.**

```text
on AxisType, beside the operator contract — a FRAGMENT, not compilable source

    unit?:  string                     the canonical symbol, for display: "%", "s", "yd"
    units?: Record<string, number>     ASCII symbol -> factor to canonical. ABSENT = takes no unit
    radix?: Record<string, number>     "#" -> 16. NOT a unit — same value, different digits
```

#### ⭐ THE BUILD-SIDE CONSEQUENCE — what `build_data.py` normalises, and what it must NOT

**The user, 2026-08-10: *"obviously it also means that we'll be normalising data in `builddata.py`."*** Right, and the
word needs pinning down, because the obvious reading is the expensive one.

**THERE ARE TWO UNITS PER NUMERIC AXIS, and conflating them is the trap:**

|                  | lives in                         | example                        |
|------------------|----------------------------------|--------------------------------|
| **STORAGE unit** | the pack — integral              | `casttime` in **milliseconds** |
| **DISPLAY unit** | the pill, and a bare query value | `casttime` in **seconds**      |

**⭐ THE QUERY CONVERTS DOWN INTO STORAGE; THE PACK IS NEVER CONVERTED UP INTO DISPLAY.** `casttime:1.5` becomes
`1500` and compares as an integer. Three reasons, and the first is decisive:

1. **Precision.** A cast time is a whole number of ms. Shipped as seconds it becomes `1.5`, `0.1`, `2.75` — and `=` on a
   float that is not exact in binary is a silent wrong answer, which is the one failure §9.1 condemns above all others.
   Comparing in the integer domain is exact by construction.
2. **Size.** `1500` gzips better than `1.5` across 129k rows, and the pack is already 11.42 MB.
3. **Debuggability.** A pack you can eyeball against wago.tools is worth keeping (the same argument that ranks a binary
   container last in the pack-format queue).

**SO WHAT THE BUILD ACTUALLY OWES IS CONSISTENCY AND A DECLARATION, NOT A RESCALING:**

- **One column, one unit, identical on all eleven packs.** This is real work — the source is *not* internally
  consistent, and a column that is ms on one build and s on another is exactly the silent per-version drift
  `OPTIONAL_COLUMNS` exists to make declarative.
- **The unit is DECLARED in the pack**, beside `meta.counts`, so `data.ts`, `export.ts` and `tools/dossier.py` read it
  instead of each hardcoding `/1000`. That is the four-consumer drift the lifecycle doc is being written to prevent.
- **⛔ IDENTITY COLUMNS ARE NEVER NORMALISED.** ids, fids, enum values, bitmasks and packed RGB are not quantities; they
  ship exactly as the source has them. A "unit" on one of those is the radix confusion above.
- **⚠ A SENTINEL MUST BE RECOGNISED BEFORE IT IS SCALED.** `SpellCastTimes.Base` has a min of **−1,000,000**; scaling
  that to −1,000 s produces a plausible-looking number that will enter a range and a domain. Sentinels are classified
  first and excluded from bounds — §4.5's robust-bounds rule, now confirmed on a second column.

**This is a PACK FORMAT change and therefore a lifecycle job, not a search job** — build reader → declaration → format
bump → `meta` → `data.ts` → axis → export → dossier → docs → battery. It is the first real customer of the rewritten
PILLS.md, alongside `SpellRange`.

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

    model:{attach:*}   ≡   attach:*   ≡   "has any attachment point"
    name:{desc:*}      ≡   desc:*     ≡   "has a description"

**⛔ NOTE THE `:*` — AN AXIS WITHOUT ONE IS NOT AN EXISTENCE TEST, IT IS CONTENT.** An earlier draft wrote this as
`model:attach ≡ attach:*`, which was left over from the arity grammar and is now false: §2.4.1's reader's rule is that
**a bare token is ALWAYS content**, so `model:attach` is a substring match on the model corpus — **measured at 16,
against 51,581 for the attachment keyword.** Writing those two as equivalent would have shipped the exact
same-word-two-mechanisms defect L4 exists to ban.

**This still deletes a 1.0 oddity**: today a trailing keyword with nothing after it "stays in text" and degrades into a
substring search *for its own name*, silently and never as an error.

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

**`count`'s global door is NOT an exception — see L5.** `count:>4` desugars, like every global prefix, to the union over
each column carrying the axis, so it means "some column has more than four". That reads oddly, but for the same reason
any wide union does — not because `count` is special. An earlier draft carved it out of L5 as "a door not worth walking
through"; the virtual-tag rewrite removed the need for the carve-out, and the useful form is still the scoped one,
`model:{count:>4}`.

### 4.5 VALUE RANGES — the syntax is GitHub's, the domain is MEASURED

Two halves that must agree: how you WRITE a range, and how the UI knows what range to DRAW.

**⭐ THE SEPARATOR IS `-`, AND `..` IS DROPPED (user, 2026-08-10). Two earlier rejections of `-` were conditional on
delimiter assignments that have since changed, and both are now obsolete:**

| the old objection                                      | why it no longer holds                                                                                                                                                                                                                                    |
|--------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| "a `-` between numbers collides with a NEGATIVE value" | **parens disambiguate it** — the user's original suggestion, rejected only because parens were the row scope at the time. They are the VALUE GROUP now (§2.4.0), and `(-50)` is a one-member group, already legal by the existing production. No new rule |
| "17,557 spell names contain a hyphen"                  | **the type decides.** A range separator exists only on types implementing `compare` (§4.2b). `text` declines ordering, so in `name:anti-magic` the dash is data and there is no range reading to collide with                                             |

    scale:10-90         between
    scale:(-50)-10      a negative lower bound
    scale:(-50)-(-10)   readable — unlike `-50--10`
    scale:>=10          an open-ended range is written with the operator that means it (§3.3)
    scale:<=90          NOT `scale:10-*` — `*` is existence or glob, never infinity
    name:anti-magic     `text` has no `compare`, so the dash is ordinary data

**⛔ A NEGATIVE BOUND IN A RANGE MUST BE PARENTHESISED.** `scale:-50-10` is technically deterministic — a leading `-`
is a sign, one between values is a separator — but nobody can read it, and L12 is a law rather than a preference. It is
an ERROR with the structural fix `scale:(-50)-10`.

**This also retires `..` from a language that no longer needs two range spellings**, and `-` is what the user asked for
in the first place: *"a dash between 2 tokens could mean range. Like 10-90. I think this would be more naturally
readable."*

**⚠ THE TRANSFERABLE LESSON: a rejection is only as durable as the assumptions under it.** `-` was rejected on three
collisions and adopted an hour later, because two of the three assumptions had been dissolved by unrelated decisions in
between. Re-check a closed question's premises before citing it, not just its verdict.

##### `-` IS AN OPERATOR ONLY IN CLAUSE-OPENING POSITION

Settling this here because it is the same question, and the independent review listed it as undefined. **`-` negates
only when it OPENS a clause** — at the start of the query, after whitespace, or after `(`. Anywhere else it is ordinary
character data or part of a value:

    -model:fire      negation      — clause-opening
    model:anti-magic one token     — 17,557 names need this
    scale:-50        minus fifty   — value position, and the axis is signed
    model:-fire      the literal "-fire"  — value position; matches nothing, but consistently nothing

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

## 4.9 BAD SYNTAX — the error model

**The failure mode a design introduces is part of the design.** Ten subsections, because a search-as-you-type bar in a
chip UI has more distinct failure states than a query language does.

### 4.9.1 The distinction that shapes everything: INCOMPLETE is not INVALID

**The bar is a search-as-you-type field.** Typing `model:{fire missile}` passes through
`m`, `mo`, … `model:`, `model:{`, `model:{fire`, … — every one of which is a broken query and **none of which is an
error**.

|                | test                                  | response                                               |
|----------------|---------------------------------------|--------------------------------------------------------|
| **INCOMPLETE** | could still become valid by appending | **not an error.** Search the valid prefix, say nothing |
| **INVALID**    | cannot become valid by appending      | error, reported on the clause                          |

`model:{fire` is incomplete — one `}` fixes it. `name:>m` is invalid — no suffix rescues it, because `text` declines
`compare` (§4.2b). **An incremental parser that cannot tell these apart will shout at the user on every keystroke**,
which is the failure mode that makes people turn off "search as you type".

### 4.9.2 The taxonomy, and one entry is NOT an error

| # | kind                    | example                                               | response                                                                                                                             |
|---|-------------------------|-------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| 1 | **unknown axis**        | `foo:bar`, `Hero: Illidan`                            | ⚠ **NOT an error — literal text**, plus a hint. See below                                                                           |
| 2 | declined operator       | `name:>m`                                             | error: *the name axis has no ordering*                                                                                               |
| 3 | foreign axis in a scope | `model:{sound:fire}`                                  | error: *a sound axis cannot read a model row* (§2.4.3d)                                                                              |
| 4 | ill-typed value         | `scale:abc`                                           | error: *scale takes a percentage* — never a zero result                                                                              |
| 5 | contradictory value     | `name:=Fire*`                                         | error: *exact and pattern cannot combine* (§4.2b)                                                                                    |
| 6 | structural              | unbalanced, or no positive anchor — **on PASTE only** | error (§4.9.9). ⚠ While typing or editing both are INCOMPLETE and silent (§4.9.8); `{}` is never here — it is an identity (§2.4.3e) |

**⭐ #1 IS THE IMPORTANT ONE AND IT IS DATA THAT DECIDES IT. 12,477 spell names contain a colon** — *Embody Hero:
Illidan*, *Power Converters: Summon Electromental*. If an unknown prefix were an error, **pasting a spell name would be
a syntax error**, which is absurd for a spell search. So an unknown prefix is ordinary text, exactly as in 1.0.

The cost is that `modle:fire` silently becomes a text search returning nothing. The mitigation is a **hint, not an
error**: the axis list is right there, so offer *did you mean `model:`?* — cheap, and it cannot be wrong in a way that
blocks anyone.

### 4.9.3 What an erroring query DISPLAYS

**The governing principle is §9.1's: a silently wrong result is worse than no result.** So an invalid clause is never
silently dropped and never silently reinterpreted.

**The chip UI gives a better answer than any of the conventions.** GitHub shows an error and no results; Google silently
ignores what it does not understand (the failure §9.1 condemns); Lucene throws. Here:

1. **The invalid clause renders as a BROKEN CHIP** — visibly, in place, with the reason on it. **The chip IS the error
   message**, which is the same principle as §2.4.0's "the chip rendering is the parse".
2. **The valid clauses still run.** A user with four good chips and one typo gets four chips' worth of results, not a
   blank screen.
3. **The result count says so** — *"1,204 spells · 1 clause ignored"*.
4. **If every clause is invalid there is nothing to constrain**, so the result is the empty-query state — every spell
   (§5). That is not dangerous, because it is the defined behaviour of an unconstrained query rather than a special case
   invented for errors.

**Why exclude rather than treat an invalid clause as unsatisfiable:** making it match nothing would be "safer" in the
narrowing direction, but it hides the mistake behind a plausible zero — the same pathology as §9.1. A broken chip on
screen cannot be missed; an empty result set can be mistaken for a real answer.

### 4.9.4 SEVERITIES, FIXES, AND WHETHER A QUERY CAN FAIL WHOLE

**Both asked by the user, 2026-08-10.**

#### Three severities, because "legal but probably wrong" is a real category here

| severity    | means                                               | examples                                                                                                                                                                               |
|-------------|-----------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **ERROR**   | cannot run; the clause is excluded and drawn broken | `name:>m` (declined operator) · `model:{sound:fire}` (foreign axis) · `scale:abc` (ill-typed) · `name:=Fire*`                                                                          |
| **WARNING** | runs, and is probably not what was meant            | `model:bee*` → a glob on a path is a **no-op** (§3.2) · `model:{arcane -fire}` → row negation whose terms almost never co-occur (§8.9.3) · a clause that alone reduces the result to 0 |
| **NOTE**    | correct, and worth saying                           | `model:{}` ≡ `model:*` "has any model" (§2.4.3e) · `count:>4` is the wide union (L5)                                                                                                   |

**The WARNING tier exists because this design keeps producing forms that are legal, evaluable and misleading** — and
§9.1's whole thesis is that a plausible wrong answer beats no answer only in appearance. An error tier alone would have
to either reject those (wrong: they are valid) or stay silent (wrong: they mislead).

#### A diagnostic may carry a STRUCTURAL fix — never a spelling one

**⛔ NO "DID YOU MEAN" SUGGESTIONS ON AXIS NAMES (user's call, 2026-08-10).** An earlier draft offered `modle:fire` →
`model:fire`. That is wrong twice over: **an unknown prefix is TEXT by decision** (§4.9.2 #1, forced by the 12,477 spell
names containing a colon), so `modle:fire` is a perfectly valid text search and there is nothing to correct — and
guessing at spelling over a 276,332-name corpus is presumptuous noise. **Unknown prefixes are therefore not even warned
about.**

```ts
interface Diagnostic {
    severity: "error" | "warning" | "note";
    clause: number;                 // which chip — diagnostics are clause-local
    message: string;                // the user's words: "the name axis has no ordering"
    fix?: { label: string; query: string };   // STRUCTURAL only
}
```

    name:>m               fix: "search names containing m"   -> name:m
    model:{sound:fire}    fix: "make it its own clause"      -> model:* sound:fire
    name:=Fire*           fix: "drop the exact match"        -> name:Fire*
    model:{fire          fix: "close the scope"             -> model:{fire}

Every one of those is derivable from the registry — the operator contract (§4.2b) says `text` has no `compare`, the
column says a sound axis cannot read a model row — so **a fix is computed, never authored**. That is L11: registering an
axis must not require writing error strings anywhere.

#### Can a query fail WHOLE? Essentially no — and the recovery rule is what makes that true

**Only one shape resists clause-local recovery: an unbalanced scope brace**, because it swallows everything after it. An
unclosed quote has the same shape and 1.0 already answers it — the phrase runs to end of input.

**⚠ BUT CLOSING AT END-OF-INPUT IS A TRAP:**

    model:{fire sound:ice     ->   model:{fire sound:ice}
                                          ^^^^^^^^^ a clause the user wrote CORRECTLY,
                                          absorbed into the scope, now a foreign-axis error

The repair destroys good input — §9.1's pathology caused by the recovery rather than the typo.

**THE RULE: close an unclosed scope at the next CLAUSE BOUNDARY, not at end of input.**

    model:{fire sound:ice     ->   model:{fire} sound:ice      both clauses valid

This is panic-mode recovery to a synchronisation token, which is the standard parser answer; here the sync token is the
start of a top-level clause (`axis:` at depth zero). **Choose the recovery that maximises well-formed clauses**, and
report the inserted brace as a WARNING with the repaired query as its fix.

**So there is no syntax that fails the whole query.** The two things that legitimately refuse everything are not syntax
at all:

1. **Resource limits** — a query past a declared length or nesting depth is refused as a whole, because evaluating it is
   the risk. That is the complexity budget the independent review asked for, and it belongs with the kernel.
2. **No pack loaded** — nothing can be answered, which is a state rather than an error.

### 4.9.5 AUTO-CLOSING — the editor works WITH you (the user's original ask)

**From the opening brief: *"when you input a `"` or `(`, the app has to work with you, and insert a `"` or `)`,
autoscoping in a sense, like in an IDE."*** This is the convenience meant by "autocomplete" here — **structural
completion, not spelling correction** (§4.9.4).

**The behaviours, which are the IDE/browser convention and should not be invented (L0)** — VS Code, JetBrains and
devtools consoles all do exactly this set:

| you type                               | you get                      | note                              |
|----------------------------------------|------------------------------|-----------------------------------|
| `"`                                    | `"‸"`                        | caret between                     |
| `{` after `axis:`                      | `{‸}`                        | only where a scope is legal       |
| `(` in value position                  | `(‸)`                        | only where a value group is legal |
| the closing char, with it already next | caret **steps over** it      | never doubles a delimiter         |
| ⌫ on an empty pair                     | **both** characters go       | `{‸}` deletes to nothing          |
| any opener, with text SELECTED         | the selection is **wrapped** | `fire` + `"` → `"fire"`           |

**⭐ THE OPENER IS ONLY AUTO-CLOSED WHERE THE GRAMMAR ALLOWS IT.** `{` is a scope delimiter only after `axis:`
(§2.4.0); in free text it is ordinary data, so `fireball {` must NOT auto-close — the user is typing a name. **The
registry already knows which position it is in, so this is a parse question, not a keystroke question.** That is what
makes it a convenience rather than a nuisance.

**And it is why `{}` had to become an identity rather than an error (§2.4.3e):** auto-closing means the editor CREATES
the empty pair on the way to a real one. `model:{‸}` is a state the app authored, so erroring on it would be the app
shouting at itself.

**⚠ TYPING ONLY. Auto-closing never applies to a paste** (§4.9.9) — a pasted string is complete by definition, so
inserting a delimiter into it is a repair, and repairs are announced rather than silent.

### 4.9.6 THE `-` KEYSTROKE — concrete rules, derived from the grammar not invented

**The user, 2026-08-10: *"if you press minus when at the beginning of a chip, it will flip it. But if we implement
standalone keywords, `-` can have a meaning, like negative numbers or local negation. I want you to define concrete
rules."*** 1.0's shortcut collides with two new meanings, and one collision is fatal.

**THE FATAL ONE: if `-` at the start of a chip's VALUE flips the chip, then `scale:-50` cannot be typed at all.** The
percent axes are signed and used — `fx:{scale:-50}` is 71 spells, `mech:{speed:<-50}` is 582 (§4.5). So the 1.0 shortcut
cannot survive in that position, and no context rule can rescue it: deciding by whether the axis accepts negatives would
make one keystroke mean two things depending on hidden state, which is L12 (3).

**THE RULE, and it is exactly the grammar's** (§4.5): **`-` is an OPERATOR where it opens a clause, and DATA everywhere
else.** The bar does not need a UI convention — it needs to know where the caret sits in the serialised text.

| caret position                                | typing `-`                                                    | why                                                      |
|-----------------------------------------------|---------------------------------------------------------------|----------------------------------------------------------|
| start of the bar, or after a space at depth 0 | **negates the next clause**                                   | clause-opening                                           |
| **at a chip's LEFT EDGE**, before `axis:`     | **flips that chip** — it becomes `-model:fire`                | clause-opening, and this is where 1.0's gesture moves to |
| immediately after `axis:` (value position)    | **literal** — `scale:-50` is minus fifty                      | not clause-opening                                       |
| after a space INSIDE a scope `{…}`            | **negates the next inner clause** — `model:{fire -missile}`   | clause-opening at depth 1                                |
| immediately after `{`                         | negates, and the clause will fail the anchor rule (§2.4.2)    | legal to TYPE, reported once it settles                  |
| mid-word                                      | **literal** — `anti-magic` is one token, 17,557 names need it | not clause-opening                                       |

**⭐ THE 1.0 GESTURE SURVIVES, ONE POSITION TO THE LEFT.** It used to fire at the start of the chip's VALUE; it now fires
at the start of the CHIP. That is not a workaround — it is where the `-` actually goes in the text (`-model:fire`), so
the keystroke lands exactly where the character it types would land.

**And a deliberate affordance exists besides the keystroke**, because a caret position is a poor place to hide a toggle:
the chip's field label is clickable to flip it, matching the field buttons' existing `+ Name −` shape. **The keystroke
is for typists; the click is for everyone else**, and both write the same character.

**⚠ ONE CONSEQUENCE TO ACCEPT: an empty chip takes the literal.** Caret in `model:‸`, typing `-` gives `model:-`, not a
negated chip — value position, no exception. The chip edge is one arrow-key away and the label is clickable, so the cost
is small and the alternative is a hidden-state rule. **§4.9.7 is what makes that cheap**: the chip survives being
arrowed out of, so stepping left to negate it costs a keystroke rather than the chip.

**Display versus syntax:** the bar renders negation as `−` (U+2212) on the chip, exactly as 1.0 does; the SYNTAX is
always ASCII `-`. Typographic folding (§4.9.9, *Typographic folding*) maps a pasted `−`, en dash or em dash back to `-`,
so a query copied out of the app pastes back into it.

### 4.9.7 THE BAR MUST HOLD WHAT THE USER TYPED — two 1.0 behaviours to change

**The user, 2026-08-10: *"I don't mind if we can insert the minus BEFORE the chip, instead of inside. Right now it's
impossible, and when you arrow out of an empty chip it deletes it, which is actually not very good because it removes
stuff that the user already types."*** Both are real, both are the same failure — **the bar discards work it should be
holding** — and both are small, because the mechanism is already there.

#### (a) The gap before a chip is already a caret position — it just does not accept `-`

`state.pos` IS the gap, and `renderBar` already places the input at it (`editPos = min(state.pos, chips.length)`), so
the caret can already sit before any chip. Nothing new is needed:

> **An empty input sitting immediately before chip N, receiving `-`, negates chip N.**

That is §4.9.6's clause-opening rule with no extra machinery — the character goes exactly where the grammar puts it
(`-model:fire`). A literal `-` as free text is still reachable by quoting (`"-"`) or by typing it beside other text.

#### (b) An empty chip must PERSIST — `bar.ts:222` is the whole of it

Today `commitActiveChip` refuses an empty chip (`if (!text) return -1`), so `model:` never becomes a chip at all and
navigating away loses it. **It was never deleted; it never existed** — which is worse, because the user watched
themselves type it.

> **An incomplete chip is committed, rendered, and kept. It contributes no constraint, raises no diagnostic
> (incomplete is not invalid, §4.9.1), and is removed only by an explicit gesture.**

- **Renders as incomplete** — dimmed, with the axis's `short` placeholder — so it does not read as a bug.
- **Not serialised to the URL.** The URL carries the QUERY; the bar carries the EDITING STATE. A half-typed chip
  contributes nothing, so it has nothing to serialise.
- **Explicit removal only**: the `×`, or backspace at its left edge.

#### ⭐ The principle, which is worth stating once because it generalises

> **NAVIGATION IS NOT EDITING.** Arrowing, clicking elsewhere and blurring must never destroy a chip. Only an explicit
> delete deletes.

1.0 breaks this in the one place it is most costly — the moment just after the user has committed to a field and before
they have chosen a value, which is exactly when they are most likely to look away and think. **The same rule protects
the incomplete-scope case** (`model:{fire`), which §4.9.1 already says must stay silent while typing: silent is
worthless if navigating away throws it out.

### 4.9.8 INTERMEDIARY STATES — ONE rule, and `{}` stops being a special case

**The user, 2026-08-10: *"stuff like model:{} has place as an intermediary. Look for other cases where we need to
account for intermediaries."*** Walking the whole keystroke journey of `model:{attach:chest fire}` catalogues them, and
they collapse into a single rule.

#### ⭐ THE RULE

> **Every INCOMPLETE sub-expression evaluates as if absent. The live query is always the largest well-formed subset of
> what has been typed.**

That is one sentence covering every row below, and **`model:{}` is not an exception to it** — dropping an incomplete
scope body leaves an empty conjunction, which is `true`, which is `model:*` (§2.4.3e). The identity falls out of the
rule rather than being carved beside it.

#### The catalogue

| typed                  | state                       | live meaning                                                        |
|------------------------|-----------------------------|---------------------------------------------------------------------|
| `mod`                  | free text                   | plain search for "mod" — already useful                             |
| `model:`               | **incomplete bind**         | dropped → no constraint                                             |
| `model:{` → autocloses | `model:{}`                  | empty conjunction = true → **`model:*`**, "has any model"           |
| `model:{at`            | content term                | substring — "at" in the row's corpus. Meaningful while partial      |
| `model:{attach:`       | **incomplete bind, nested** | dropped → body is empty → **`model:*`** again                       |
| `model:{attach:c`      | bind, partial value         | substring — "attached somewhere containing c". Meaningful           |
| `scale:>`              | **operator, no operand**    | dropped                                                             |
| `scale:10-`            | **range, no upper bound**   | dropped → falls back to `scale:10`? **NO** — see below              |
| `name:=`               | **exact, no value**         | dropped                                                             |
| `name:"fire`           | **unclosed phrase**         | NOT incomplete — 1.0's rule stands: the phrase runs to end of input |
| `model:fire \|`        | **dangling OR**             | dropped → `model:fire`. 1.0 already skips separator-only tokens     |
| `model:fire -`         | **dangling negation**       | dropped                                                             |
| `model:{fire `         | trailing space              | no-op                                                               |

**⚠ THE ONE THAT NEEDED A DECISION RATHER THAN THE RULE: `scale:10-`** — dropping the incomplete range would silently
demote it to `scale:10`, i.e. **exactly ten**, which is a different and plausible-looking answer. That is §9.1's
pathology in miniature. So a half-written range **drops the whole bind** rather than degrading to its lower bound. *(The
friendly alternative — reading `10-` as `10-*` — was rejected: it guesses, and the guess is invisible.)*

#### Why dropping is safe here, when it would not be elsewhere

Dropping WIDENS the result — `model:fire sound:` shows more than the user will end up with. That is correct for a live
preview: they are watching it narrow as they type. **And the mitigation is the same one the error model uses (§4.9.3):
the incomplete chip is VISIBLE**, dimmed and placeholdered (§4.9.7), so the widening always has a thing on screen
explaining it.

**What makes all of this cheap is auto-closing (§4.9.5)**: with `{`, `(` and `"` closing themselves, the unbalanced
states barely occur while typing at all. They arrive mainly by PASTE and by deleting a closer — which is exactly where
§4.9.9 says a repair is announced rather than assumed.

#### AND WHILE EDITING — a hole in the middle, not a prefix (user, 2026-08-10)

**Typing produces a PREFIX of a query; editing produces a HOLE inside a complete one.** The rule above still governs,
but the failure mode differs and one case was misclassified because of it.

| edit                                        | state                  | live meaning                                               |
|---------------------------------------------|------------------------|------------------------------------------------------------|
| delete `}` from `model:{fire}`              | unclosed scope         | closes at the next clause boundary (§4.9.4)                |
| delete `chest` from `model:{attach:chest}`  | incomplete bind        | dropped → body empty → **`model:*`**                       |
| delete `fire ` from `model:{fire -missile}` | **no positive anchor** | ⚠ **INCOMPLETE, not an error** — see below                |
| delete `{` from `model:{fire missile}`      | restructure            | `model:fire` + free text `missile}` — **meaning changes**  |
| delete `model:` from `model:fire`           | restructure            | `fire` becomes plain search                                |
| undo / redo                                 | any prior state        | may be intermediary; no special case                       |
| drag a chip                                 | none                   | order never matters (L8), so reordering cannot produce one |

**⭐ THE MISCLASSIFICATION: `model:{-missile}` IS NOT AN ERROR WHILE EDITING.** §2.4.3 (c) and the §4.9.2 taxonomy list
the missing positive anchor as a static error. But apply §4.9.1's own test — *could appending fix it?* — and the answer
is yes: type one term and it is valid. **So it is INCOMPLETE, and must stay silent**, exactly like an unclosed brace. It
becomes an ERROR only on PASTE, where nothing more is coming. Same dual, same reason.

That test is worth applying to every rule that says "static error": **if a suffix rescues it, it is incomplete.**

**⚠ THE GENUINELY DANGEROUS EDIT is a delimiter deletion that re-parses the REST of the query.** Deleting `{` from
`model:{fire missile}` silently moves `missile` from a same-row constraint to free text — a different question, no
error, plausible results. That is §9.1's pathology arriving through an edit instead of a typo.

**The mitigation is the chip rendering, and this is the strongest argument yet for it (§2.4.0):** the scope chip visibly
splits into a chip plus loose text. **A structural change the TEXT hides is a structural change the CHIPS show** — which
is why the bar rendering the parse is a requirement rather than a nicety.

**And editing differs from typing in one more way worth stating:** while typing, dropping an incomplete piece widens a
result the user is still narrowing, which they expect. **While editing, it widens a result that was already working**
— 152 rows becoming 276,332 on one keystroke. Honest, but jarring; the incomplete chip on screen is the only thing that
explains it, so it must be unmissable rather than merely present.

### 4.9.9 TWO ARRIVAL PATHS — typing and pasting are not the same problem

**The user's correction, 2026-08-10: *"there are 2 scenarios, when the user types a query and when the user pastes a
query from outside, and our model should accommodate both."*** §4.9.1 assumed everything arrives keystroke by keystroke.
A pasted query differs on four counts, and the same string can deserve a different verdict depending on how it got
there.

|                      | TYPING                            | PASTE / a shared URL                        |
|----------------------|-----------------------------------|---------------------------------------------|
| arrives              | character by character            | **all at once, and complete**               |
| `model:{fire`        | **incomplete** — expected, silent | **malformed** — nothing more is coming      |
| characters           | whatever the keyboard produced    | **may have been substituted by the source** |
| shape                | always meant as a query           | **may not be a query at all**               |
| auto-closing `"` `{` | a convenience as you type         | a **repair**, and must be announced         |

#### (a) Typographic folding — measured safe

Discord, browsers and word processors substitute characters. A query copied out of Discord arrives with `"` as `"` and
`-` as `—`, and a parser that has not folded them sees garbage.

**Measured on 9.2.7 so the fold cannot cause a miss: spell names contain ZERO curly double quotes, ZERO curly single
quotes, ZERO non-breaking spaces and THREE en/em dashes.**

    " " „ ‟   ->  "          ' ' ‛ ´  ->  '        – — ‒ − (U+2212)  ->  -
    NBSP, thin space, zero-width  ->  space        ：(full-width)  ->  :

**Fold the CORPUS as well as the query, exactly as case is folded.** That is what keeps the three em-dash spell names
reachable by a typed hyphen instead of stranding them — a fold applied to only one side is a fold that loses data.

#### (b) A paste may not be a query

1.0 already knows this: `ID_CMD_PASTE` rewrites `.cast 12345` into `id:12345`, because people paste Epsilon commands.
2.0 generalises it into a declared list of paste SHAPES, tried in order, falling through to "treat it as a query":

| pasted                                       | becomes                                      |
|----------------------------------------------|----------------------------------------------|
| `.cast 12345`, `.aura 12345`                 | `id:12345` — 1.0 behaviour, kept             |
| several numbers, comma- or newline-separated | `id:1,2,3` — the numeric-list form (§2.4.3f) |
| an Epsilook URL                              | its own query, restored verbatim             |
| a Wowhead `spell=133` URL                    | `id:133`                                     |
| anything else                                | parse as a query; if that fails, plain text  |

**Falling through to TEXT is what makes pasting a spell name work**, and it is the same decision as §4.9.2 #1 — an
unknown prefix is text, because 12,477 names contain a colon.

#### (b2) WHAT WE CHANGE ABOUT A PASTED QUERY — the exhaustive list

**Asked directly by the user, 2026-08-10. Three tiers, and the tier is not negotiable per case.**

**⚠ FIRST: THE PASTE TARGET DECIDES THE TREATMENT.** Pasting into a chip's VALUE is not the same as pasting into the
bar, and treating them alike would rewrite text the user meant literally.

| target                                  | treatment                                                                                                                      |
|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------|
| **the bar** (empty, or at a clause gap) | full treatment — fold, detect shape, parse                                                                                     |
| **inside a chip's value**               | **fold typography ONLY.** No shape detection, no parsing — `.cast 12345` pasted into a value is the literal text `.cast 12345` |
| **over a selection**                    | by the target the selection sits in, same two rules                                                                            |

##### Tier 1 — SILENT, because meaning cannot change

|                                  |                                                                                                  |
|----------------------------------|--------------------------------------------------------------------------------------------------|
| typographic folding              | `" " – — − ：` NBSP → ASCII. Measured safe: 0 curly quotes, 0 NBSP, 3 em dashes in 276,332 names |
| trim leading/trailing whitespace |                                                                                                  |
| newlines → spaces                | a multi-line Discord paste is one query                                                          |
| collapse whitespace runs         | **outside phrases only** — inside `"…"` spaces are data (`"blood  pool"`)                        |

##### Tier 2 — ANNOUNCED, because meaning changed

|                                 |                                                                                     |
|---------------------------------|-------------------------------------------------------------------------------------|
| closing an unbalanced delimiter | at the next clause boundary (§4.9.4), reported as a warning with the repaired query |
| shape rewriting                 | `.cast 12345` → `id:12345`, a Wowhead URL → `id:133` (§4.9.9b)                      |

##### Tier 3 — NEVER

- **No spelling correction** (§4.9.4, the user's call).
- **No reordering** of clauses — pointless under L8 and not ours to do.
- **No deduplicating** repeated clauses. Harmless, and it is their query.
- **No case rewriting.** Matching folds case; the TEXT stays as pasted.
- **No dropping of invalid clauses.** They become broken chips (§4.9.3) — a paste must never quietly shrink.
- **No adding constraints**, ever. Not a scope, not a default column, not a version pin.

**The governing line: a paste may be NORMALISED silently and REPAIRED loudly, but never REINTERPRETED.** Tier 2 exists
only because refusing to repair would be worse — an unbalanced paste is unusable — and everything in it is announced
with its result shown.

#### (c) The rule that keeps paste honest: VISIBLE and REVERSIBLE

**A paste transformation must show what it did and must be undoable in one step.** 1.0 rewrites `.cast` silently; 2.0
keeps the behaviour and drops the silence — the rewrite lands as chips the user can see, and ⌘/Ctrl+Z restores the raw
text rather than stepping back through the parse.

**And incompleteness is not forgiven on paste.** `model:{fire` typed is a pending state; pasted it is malformed, so it
is repaired — the brace is closed — and the repair is **announced**, never silent. The distinction exists because
nothing more is coming: the only reason to stay quiet while typing is that the next keystroke may fix it.

### 4.9.10 What this obliges

- **The parser must return errors, not throw.** One invalid clause may not lose the other four, so parse is clause-local
  and every clause carries its own verdict.
- **Every error names the CLAUSE and the reason** in the user's words, not the parser's. *"the name axis has no
  ordering"*, never *"unexpected token at 14"*.
- **`when?(d)` absence is NOT an error** (L2): an axis the loaded pack lacks yields an empty result with a note — *"this
  pack has no descriptions"* — because that is missing DATA, not broken syntax. **The two must not be confused**, and
  §2.4.3 (d) already draws the same line.

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
is `model:{attach:chest}`, or the global door `attach:chest`.

---

## 8.9 THE INDEPENDENT REVIEW — what it changed, and what it left open

**2026-08-10. An agent with NO context on this app reviewed this document.** It changed the design more than any other
single input, so the standing instruction is to **run it again after the kernel lands.**

**Its central objection, which shaped everything below: every measured defect in §7 is a LAW violation, and not one is
an expressibility gap.** The laws, the registry and the row model fix all nine with the clause list kept FLAT — so
nesting was paying structural cost for capability nobody had been measured wanting. **The response was to cut until only
the plausibly-earning part remained**: spell-level grouping went (§8.9.1) and bare row negation went (§2.4.2), leaving
one row scope — **whose value is BOUNDED but still UNMEASURED** (§2.4.2). Measuring it is the kernel prototype's first
gate.

**FIXED — each is now the text above, not a note here:** the ∀ showcase was wrong (vacuously true of model-less spells,
§2.4.2) · arity had no production and made the parse registry-DEPENDENT, so registering an axis could change a
bookmarked query — deleted by binding with `:` (L6) · arity broke L8 inside a scope — same fix · bare `count` returned
everything (§4.4, `total`) · `*` was two mechanisms (§3.3) · the error model, incremental parse and unknown-prefix
behaviour (§4.9) · typographic substitution (§4.9.9) · severities, computed fixes and recovery (§4.9.4).

**⛔ STILL OPEN — the honest list, and the first two are the ones that can still move the architecture:**

| # | open finding                                                                                                                          | where it bites                                                                                  |
|---|---------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| 1 | **`Column.rows(d, spellId)` is a FORWARD index replacing inverted ones** — every query touches all 276,332 spells, on every keystroke | **prototype and time `model` BEFORE porting anything.** See §8.9.0                              |
| 2 | **arrays are unmodelled — 374 columns**                                                                                               | an array column is where the row model must decide one-row-vs-N, which sets every `count` on it |
| 3 | `Row.corpus` is ONE string, so §8.1's category/corpus split is unrepresentable                                                        | blocks the corpus-bleed deletion                                                                |
| 4 | case sensitivity is nowhere stated explicitly                                                                                         | not architectural                                                                               |
| 5 | Unicode normalisation (NFC/NFD, accented locale names)                                                                                | not architectural                                                                               |
| 6 | escaping beyond `\"`                                                                                                                  | not architectural                                                                               |

**What survives untouched:** L1, L2, L4, L5, L7, L9, L11, the `Axis`/`Column` collapse, §4.1's storage measurement,
§4.5's cardinality-decides-affordance finding, and the row model's closure of filtered `count`.

### 8.9.0 ⚠ THE FORWARD INDEX — the risk, and the escape hatch that must be designed BEFORE the port

**⛔ A CORRECTION THAT MATTERS, because the wrong version was recorded twice.** An earlier draft said *"`-model:fire`
is answerable by no index at all."* **That is backwards.** Negating an existential is the CHEAPEST thing an inverted
index does — `allSpells \ postings(model:fire)`, one set difference. **It is the FORWARD index that makes negation
expensive**, because it forces a full walk to prove absence. The risk is real; the reason given for it was inverted.

**THE THREE COSTS, stated concretely:**

1. **Allocation.** `rows(d, spellId): Row[]` returns an ARRAY OF OBJECTS. One clause over `model` materialises one
   object per row per spell, per keystroke — high six figures on 9.2.7 (133,699 `.m2` paths; 16,415 spells carry more
   than four model rows).
2. **Plain search is the common case and it is the widest.** L7 makes chipless search `AXES.filter(a => a.plain)`, so
   one character sweeps names, the 79,330-row description corpus, every path corpus and icon names — all of them.
3. **⚠ THE INTERMEDIATE STATES ARE THE EXPENSIVE ONES.** §4.9.8 evaluates the largest well-formed subset, so
   `model:{attach:` is live as `model:*`. **The widest query is the one the user spends most of their keystrokes in.**
4. **`id:133` degrades from a hash lookup to a 276,332-spell scan** — the app's single most common query shape, and
   §4.9.9 (b) routes three more paste forms into it.

**THE ESCAPE HATCH, and it is a DECLARATION so it does not breach §2.5:**

```text
on Column, beside rows() — a FRAGMENT, not compilable source

    forEachRow(d, spellId, visit: (r: Row) => boolean): void
        non-allocating; visit returns false to stop early

    candidates?(d: SpellData, q: AxisQuery): Iterable<number> | null
        an inverted-index seed set, or null to fall back to the full walk
```

`candidates()` lets an axis offer an inverted index where it has one — spell id, icon fid, sound-kit id, the
`(cat, fid)` pair 1.0 already maintains — and the kernel SEEDS from it and intersects, falling back to the full walk
when it returns null. **This is the conventional shape** (L0: Lucene's `DocIdSetIterator`, Postgres choosing index scan
or seq scan), and it is the same move `size?()` already makes for `count`.

**⛔ AND A BUDGET, BECAUSE §2.5's TEST MEASURES FILES EDITED AND NOTHING MEASURES TIME.** Before the kernel is called
done: **a stated p95 milliseconds-per-keystroke target on 9.2.7, measured on the plain-search path**, which is both the
commonest and the widest. A design with no latency number cannot fail a latency test.

---

### 8.9.1 ⭐ SETTLED — spell-level grouping is DROPPED

**Because it failed L12 and cost nothing to lose.** `(model:fire model:arcane)` and `model:{fire arcane}` read
identically aloud; the only difference was whether the prefix sat inside or outside the bracket, which a reader cannot
recover. Worse, it was unstable under auto-closing (§4.9.5): whether you got a group or a scope depended on whether you
typed `(` before or after `model:` — a meaning decided by typing ORDER, failing L12 (2) and (3) at once.

**The two alternatives were costed and both lost:** separate brackets (`[spell group]`) invents semantics no established
system uses, an L0 violation; keeping both and mitigating with highlighting was judged insufficient, because L12 is
about the TEXT, not the rendering.

**And the loss turned out to be nil rather than "one exotic shape"** — §8.9.4 proves the flat clause list is already
expressively complete. `(` now appears only as a value group, with exactly one meaning.

### 8.9.2 REASSESSMENT — every scenario against the reduced grammar

**The reduced grammar is:** a flat clause list, `|` between clauses, `-` on a clause, row scope `column:{…}` with a
positive anchor required, and `-column:{…}` negating a whole scoped clause. **No spell-level group.**

**⚠ THE DISTINCTION THAT DECIDES MOST OF THIS: dropping GROUPING is not dropping OR.** `model:fire | sound:fire` needs
no bracket — it is two clauses joined by `|`. Grouping bought OR of CONJUNCTIONS and negation of a conjunction, and
§8.9.4 shows both survive by precedence and De Morgan.

| #  | scenario                                                 | reduced grammar                                              |                                       |
|----|----------------------------------------------------------|--------------------------------------------------------------|---------------------------------------|
| 1  | `count` universal — "number of spell effects, not speed" | `mech:{count:>4}`                                            | ✅                                    |
| 2  | bees without beerfest junk                               | `model:bee -model:beer` = 19                                 | ✅                                    |
| 3  | "beer without bee junk"                                  | `model:beer` = 369, no operator needed                       | ✅                                    |
| 4  | arcane in the description but NOT the name               | `desc:arcane -name:arcane` = 2,662                           | ✅                                    |
| 5  | **(fire ∧ arcane) ∨ (frost ∧ arcane)**                   | factors: `model:arcane model:{fire\|frost}` = 177            | ✅                                    |
| 6  | cross-field OR                                           | `model:fire \| sound:fire` — clauses, not a group            | ✅                                    |
| 7  | row-level negation                                       | `model:{fire -missile}` — 33% correction (§2.4.2)            | ✅                                    |
| 8  | filtered count                                           | `model:{caster count:>4}`                                    | ✅                                    |
| 9  | "has no model at all" / "everything"                     | `-model:*` / `*`                                             | ✅                                    |
| 10 | attach / target reachable globally                       | `attach:chest`, `target:caster`                              | ✅                                    |
| 11 | **implication — ROW level**                              | `-model:{arcane -fire}` — "no model row arcane-without-fire" | ✅ **survives**                       |
| 12 | **implication — SPELL level**                            | `-model:arcane \| model:fire` = **270,978**                  | ✅ **survives — De Morgan, §8.9.4**   |
| 13 | **arbitrary DNF**                                        | `model:fire model:arcane \| model:frost model:shadow`        | ✅ **survives — precedence, §8.9.4**  |
| 14 | ∀ quantification                                         | —                                                            | ⛔ lost earlier (§2.4.2), register #4 |
| 15 | cross-column row correlation                             | —                                                            | ⛔ never had it, parked               |

**THIRTEEN of fifteen survive.** #11 is worth noting: **the implication shape survives at ROW level**, because
`-column:{…}` is an ordinary negated clause needing no spell-level group — `-model:{arcane -fire}` says "every arcane
model row is also fire". Only the SPELL-level reading, where the arcane row and the fire row are different rows, is
gone.

**#5 is the one to remember**, because it is the user's own first combination case and it never needed grouping: it
FACTORS. `(fire ∧ arcane) ∨ (frost ∧ arcane)` is `arcane ∧ (fire ∨ frost)`, and every DNF whose disjuncts share a term
factors the same way. #13 is the residue — disjuncts sharing nothing — and nobody has asked for one.

#### 8.9.3 THE TWO NEGATIONS ANSWER TWO DIFFERENT QUESTIONS

**Asked by the user, 2026-08-10: "how are we achieving ALL spells that contain across all models the word arcane but
don't contain the word fire across any models?" One line, and it is the PLAIN form:**

    model:arcane -model:fire        5,354

**Chip-level negation IS the across-all-rows reading.** `-model:fire` is `NOT EXISTS row: fire`, which is
`FOR ALL rows: NOT fire` — so "not in any model" is precisely what it already says (L3).

| query                      | means                                     | 9.2.7       |
|----------------------------|-------------------------------------------|-------------|
| `model:arcane -model:fire` | has arcane; **no** model has fire         | **5,354**   |
| `model:{arcane -fire}`     | one model FILE saying arcane and not fire | ~all arcane |
| `model:arcane model:fire`  | an arcane model **and** a fire model      | 152         |

**⚠ NEITHER FORM IS WRONG, AND THE 33% IS NOT AN ERROR RATE.** The flat form correctly answers *"no missile anywhere"*;
the scoped form correctly answers *"a fire model that is not a missile"*. The ambiguity lives in the ENGLISH, and the
two spellings separate the two readings — the system working, not failing. **The 33% is the size of the gap BETWEEN the
questions.**

The residue is a teaching obligation rather than a defect: the readings are close enough in English that a user may pick
the wrong form, so **the help must teach the pair together.**

**No `&` token.** AND stays implicit juxtaposition. An optional `&` would be a second spelling of one thing — the same
wart as `,` beside `|` (§2.4.3 (f)), which is already the grammar's one regretted exception. The readability problem
that `|` creates is real but it is a RENDERING problem: the bar must draw the OR split (§8.9.4). Adding syntax so the
text can explain itself is treating the symptom.

#### 8.9.4 ⭐ THE REDUCED GRAMMAR IS EXPRESSIVELY COMPLETE — grouping bought CONCISENESS, not power

**Because AND is implicit juxtaposition and binds TIGHTER than `|`, the flat clause list already writes DNF:**

    model:fire model:arcane | model:frost model:shadow    =  (fire AND arcane) OR (frost AND shadow)

No parentheses. And De Morgan pushes every negation down into the literals, so a negated conjunction needs no group
either:

    -(a b)                    =  -a | -b
    -(model:arcane -model:fire)  =  -model:arcane | model:fire      ← the implication

**VERIFIED BY SET ARITHMETIC on 9.2.7, not asserted:**

    total spells                              276,332
    model:arcane -model:fire  (to exclude)      5,354
    implication = 276,332 - 5,354             270,978

    -model:arcane                             270,826
    model:fire                                 14,198
    |NOT arcane OR fire| = 270,826 + 14,198 - 14,046 = 270,978      ← identical

**THE GENERAL RESULT: every boolean formula has a DNF; a DNF is a flat list of AND-runs joined by `|`; negation
distributes into the literals. So the reduced grammar can express any boolean combination of clauses.** Dropping
spell-level grouping cost **no expressive power at all**.

**What it DID cost is conciseness on CNF-shaped queries** — an AND of ORs where the ORs span different columns:

    (model:fire | sound:fire) (model:ice | sound:ice)      ← needs grouping, or an exponential DNF expansion

The common case of that is alternation inside ONE column, and it is already handled at value level by
`model:{fire|frost}`. The residue is cross-column OR in more than one conjunct, which nobody has asked for.

**So §8.9.1's option A is now strictly better than it looked when it was chosen:** parens keep exactly one meaning, L12
is satisfied, and the expressive loss is nil rather than "two exotic shapes". **The trade is DNF verbosity against
readability, and readability wins** — which is the same call L12 makes everywhere else.

⚠ **This makes PRECEDENCE load-bearing and it must be visible.** `-` > AND > `|` is standard, but a reader who assumes
left-to-right will misread `a b | c d`. The bar's highlighter has to show the OR split, and `a | b c` — which is
`a OR (b AND c)`, not `(a OR b) AND c` — is the one shape L12 will keep failing until it does.

#### 8.9.5 ⚠ WHEN ROW-LEVEL NEGATION HELPS, AND WHEN IT IS A TRAP

**`model:arcane -model:{arcane -fire}` parses, and returns almost nothing.** Measured over every `.m2` in the listfile:

    paths containing "arcane"              317
      ...that also contain "fire"            1
      ...that do not                       316

At ROW level `arcane -fire` means ONE FILE PATH holding "arcane" and not "fire" — true of 316 of 317. So
`-model:{arcane -fire}` excludes essentially every arcane spell, and the compound lands on the lone file that says both.
Valid, useless.

**Three questions were hiding in one sentence, and only the middle one is actually lost:**

| reading                                     | query                     |                                   |
|---------------------------------------------|---------------------------|-----------------------------------|
| **A** arcane spells that ALSO have fire     | `model:arcane model:fire` | ✅ **152** — trivial, no negation |
| **B** everything EXCEPT arcane-without-fire | —                         | ⛔ lost with spell grouping       |
| **C** no arcane FILE lacking fire           | `-model:{arcane -fire}`   | ✅ legal, ≈ `-model:arcane` here  |

Note **B does not require arcane at all** — it filters everything — which is why it is a different shape from what the
question wrote, and why losing it costs less than it first appears.

**⭐ THE GENERAL RULE, and it is the most practically useful thing in this document:**

> **Row-level negation helps when one term is a PROPERTY of the row and the other is its CONTENT. It is a trap when
> both are content words that rarely co-occur in one row.**

`model:{fire -missile}` works — the 33% correction of §2.4.2 — because `missile` is a CATEGORY carried by every model
row, so every row can be tested against it. `model:{arcane -fire}` fails because both are path substrings and a path
almost never carries both.

**So the autocomplete and the help must steer the negated term toward category words, target words and attachment
points — the row's properties — and away from a second content word.** That is a UI obligation created by a grammar
rule, and exactly the kind of thing L12 exists to catch before it ships. **It is also the WARNING tier's canonical
case** (§4.9.4): row negation over two content words is legal, evaluable and misleading.

---

## 9. The expressibility register — KEEP HUNTING

**Standing instruction from the user, 2026-08-10: *"I want to be on constant lookout for similar scenarios that cannot
be satisfied by our current system."*** This section is where the real gaps are recorded, so the lookout produces a list
instead of a feeling.

**The discipline: when a query cannot be written, add a row here with a MEASUREMENT before deciding whether to build
anything.** It has already paid three ways — one entry turned out to be a silent BUG rather than a missing feature, one
turned out to be a free consequence of the row model, and four were closed at a stroke by the recursive grammar rather
than by four separate features.

| # | the query you could not write                                               | 1.0                                                                        | 2.0                                                                                                                               |
|---|-----------------------------------------------------------------------------|----------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| 1 | **cross-field OR** — "a fire model OR a fire sound"                         | **silently wrong** (§9.1)                                                  | ✅ `model:fire \| sound:fire` — §2.4                                                                                              |
| 2 | **row-level negation** — "a fire model that is not a missile"               | `model:"fire -missile"` = 0, `-` a literal                                 | ✅ `model:{fire -missile}` — §2.4                                                                                                 |
| 3 | **filtered count** — "more than 4 CASTER models"                            | `model:"caster count >4"` = 15,905 = has-a-caster-row ∧ >4 models *in all* | ✅ free from the row model (§9.2)                                                                                                 |
| 4 | **∀ quantification** — "models that ALL play on the caster"                 | unexpressible                                                              | ⛔ **REOPENED** — the `-model:{-caster}` form was measured wrong and is now illegal (§2.4.2). Wants a word, not a double negative |
| 5 | **implication**                                                             | unexpressible                                                              | ✅ `-model:arcane \| model:fire` = 270,978 — De Morgan, no grouping (§8.9.4)                                                      |
| 6 | **arbitrary DNF**                                                           | hand-convert to CNF                                                        | ✅ AND binds tighter than `\|`, so a flat list IS DNF (§8.9.4)                                                                    |
| 7 | **cross-column row correlation** — "a model and a sound on the SAME target" | unexpressible                                                              | ⛔ still open — §9.3                                                                                                              |

**Note what 1–6 have in common: none needed a new word.** Five fell out of one recursive grammar and one out of the row
model. That is the test a proposed feature should face first — *is this a missing capability, or a missing
generalisation?*

### 9.0 `attach` UNDER-COVERS — the keyword reaches 2 columns, the DATA is in 4 (user, 2026-08-10)

**The user: *"attach lives also in sound and some effects."* Checked against `ref.column_info` on 9.2.7 — right about
effects, and the gap is wider than the keyword admits.**

| table                                | column                                       | feeds           | `attach:` reaches it?                         |
|--------------------------------------|----------------------------------------------|-----------------|-----------------------------------------------|
| `SpellVisualKitModelAttach`          | `AttachmentID`                               | model           | ✅                                            |
| `SpellVisual` / `SpellVisualMissile` | `MissileAttachment`, `DestinationAttachment` | model           | ✅                                            |
| `BeamEffect`                         | `SourceAttachID`, `DestAttachID`             | fx — chain      | ✅                                            |
| **`DissolveEffect`**                 | `AttachID`                                   | fx — dissolve   | ❌ **ships in the pack, unsearchable**        |
| **`ShadowyEffect`**                  | `AttachPos`                                  | fx — ghost      | ❌ **ships in the pack, unsearchable**        |
| **`BarrageEffect`**                  | `AttachmentPoint`                            | model — barrage | ❌                                            |
| **`VehicleSeat`**                    | `AttachmentID`, `PassengerAttachmentID`      | **mech** — seat | ❌ (names ship as `vehicleSeats.attachments`) |

`META_KEYWORDS.attach` declares `fields: ["model", "fx"]`, and inside `fx` the matcher walks `spellChainRows` ONLY. So
dissolve and ghost carry their attach point in `data.ts` today (`attaches`, -1 = full body) with no way to ask about it.

**⛔ SOUND IS THE EXCEPTION AND THE CLAIM DOES NOT HOLD THERE.** No sound table on 9.2.7 has an attachment column;
`SpellVisualKitEffect.Effect = 5` is a `SoundKitID`, so a sound hangs off the visual KIT, not off a bone. Do not add a
sound attach axis without new evidence.

**This is the argument for the row model in one example.** The gap exists because `attach` is a hand-declared keyword
with a hand-written field list and two hand-written walks. As a **universal row axis over `Row.src`/`Row.dst`** it
reaches every column whose rows carry an attachment point automatically, and covering dissolve becomes filling in a
field rather than editing a keyword. L1 and L11, doing the job they were written for.

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
kernel evaluates the chip's row predicate first and counts what survives, so `model:{caster count:>4}` becomes "more
than four caster models" — the meaning the docs always claimed.

⚠ **Measure it on landing**: it moves `model:"caster count >4"` off 15,905.

### 9.3 Still open, and honestly costed

**#7, cross-column row correlation.** "A model and a sound that play on the same target" needs rows from two different
columns joined on a shared attribute — the one thing the row model does NOT give, because `Column.rows()` is per-column
by construction. It would need a correlation key in `Row` and a join in the kernel. **Speculative: nobody has asked for
it.** Park unless someone does.

---

## 10. KNOWN DEFECTS AND UNSPECIFIED BEHAVIOUR

**From the second independent review, 2026-08-10.** Everything here is either a defect in this document or a decision
nobody has taken. **⛔ NONE OF IT IS "DEBT" — the kernel must not be written until the BLOCKING rows are closed**, and
each is stated precisely enough to be closed without re-deriving it.

### 10.1 BLOCKING — resolve before any code

| #      | defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the fix                                                                                                                                                                                                                                                      |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **D1** | **Tokenization is registry-dependent at VALUE level, and §2.4.1 claims it is not.** `name:anti-magic` is one token but `scale:10-90` is a range — the tokenizer must know the type to split it, and §4.2c's units do it again (`500ms-2s`). **§2.4.1's claim is true at CLAUSE level only** (where a `-` attaches), which is the weaker statement                                                                                                                                         | State the honest scope of the claim. Then: **changing an axis's type is a BREAKING LANGUAGE CHANGE** — promoting `xpac` from `enum` to `ordinal` silently re-reads `id:{xpac:legion-wotlk}` from a token to a range. It needs the query-version marker in D2 |
| **D2** | **1.0 URLs are silently REINTERPRETED, which is the one pathology §9.1 condemns.** Back-compat was waived for ALIASES (§8.6); it was never waived for meaning. `model:"attach chest"` was **51,581** and becomes a phrase search for the literal substring ≈ **0**                                                                                                                                                                                                                        | Add a query-format marker (`v=2`, or `q2=`). A query without it is **detected and refused with an explanation**, never silently re-read. Cheap, and it is the only thing standing between a shared link and a plausible wrong answer                         |
| **D3** | **Relevance is unspecified beyond a per-axis tier.** L7 gives `tier?: number` and nothing else: no rule for a spell hitting three axes at three tiers, no tie-break, no within-tier score, no statement of stability. §8.5 deleted 1.0's name-only scoring and put nothing in its place                                                                                                                                                                                                   | Specify: the spell's tier is its BEST hit; ties break on a declared secondary; the sort must be stable. And say how the existing `sort=-<column>` coexists                                                                                                   |
| **D4** | **The positive-anchor rule is defeatable and does not compose.** `model:{fire\|-missile}` has an anchor and means ∃row(fire ∨ ¬missile) — true of nearly everything. `model:{count:>4}` has NO row predicate at all yet is legal (§2.4.3a). `model:{}` has none either yet is legal (§2.4.3e)                                                                                                                                                                                             | Restate per DNF TERM inside the scope, not per scope. Then rule explicitly on whether `count` and the empty scope satisfy it — currently three sections disagree                                                                                             |
| **D5** | **The panic-mode recovery rule names a token that cannot occur where it is used.** §4.9.4 synchronises on *"`axis:` at depth zero"* — but recovery happens INSIDE an unclosed scope, i.e. at depth 1, so no such token exists. The rule that actually produces the worked example is *"the next `axis:` not legal in this scope"*, which is registry-dependent and misfires on universals: `model:{fire count:>4` and `model:{fire sound:ice` have the same shape and recover differently | Restate the sync token, and rule on `target:` / `count:` explicitly                                                                                                                                                                                          |

### 10.2 SERIOUS

- **S-a. The quote acquires a SECOND role — notation selection.** §2.4.0 insists each delimiter means exactly one thing;
  then §4.2b resolves the kit collision with `kit:="150"`, where the quote is what pushes the operand out of `id`'s
  shape into `text`'s. `kit:150` and `kit:"150"` select different kits and read identically aloud — L12 (3), in the
  section claiming to have deleted it.
- **S-b. The notation-collision measurement has no enforcement.** §4.2b rule 3 says a collision *"MUST BE MEASURED,
  NEVER ASSUMED ABSENT"* but proposes no guard — unlike G1, which gets one. It is a one-time snapshot of one 8.3.0
  table, and a pack rebuild can introduce a digit-name collision that silently changes a bookmarked query. **Make it a
  build-time assertion in the same commit as the axis.** Also unspecified: which notation runs for `kit:*`, where there
  is no operand shape to dispatch on.
- **S-c. The computed fixes ADD CONSTRAINTS, which §4.9.9 Tier 3 forbids outright.** `model:{sound:fire}` →
  `model:* sound:fire` invents `model:*`. And §2.4.3 (c) tells the user to replace `model:{-attach:chest}` with
  `-attach:chest`, which under L5 desugars across **model | fx | mech** — the error message widens the query.
- **S-d. The zero-result WARNING is unaffordable.** §4.9.4's *"a clause that alone reduces the result to 0"* requires
  evaluating every clause in isolation AND in combination — N+1 full scans per keystroke on a design that cannot yet
  afford one (§8.9.0). Cut it or make it a post-settle diagnostic.
- **S-e. `Row.mask?: number` puts a domain concept in the kernel's data model** — the same sin as a per-field `if`, one
  level down. `bits?: Record<string, number>` costs nothing and keeps `Row` domain-free.
- **S-f. The learnability claim contradicts the justification.** *"Most queries never contain a brace"* (§2.4.0) and *"
  row negation is the correct reading of the query people actually type"* (§2.4.2) cannot both be true of one
  population. D-B3's bound is what decides which; until it is measured, neither sentence should be leaned on.

### 10.3 SIMPLY ABSENT — nobody deferred these, they were never noticed

|                        |                                                                                                                                                                                                                                                                                                                                                                        |
|------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **testing**            | The 40-query battery is a review ritual, not a test suite. The document makes at least six machine-checkable algebraic claims — L8 commutativity · De Morgan (§8.9.4) · `model:{}` ≡ `model:*` · `model:{fire}` ≡ `model:fire` · §2.4.5's "same answer" column · the incomplete/invalid classifier — and schedules **zero** property tests, parser fixtures or fuzzing |
| **performance budget** | §8.9.0 now demands one. There is still no number                                                                                                                                                                                                                                                                                                                       |
| **mobile input**       | `{ } \| " *` are all buried on mobile keyboards, §4.9.6's `-` model is caret-position-dependent (unusable on touch), and auto-closing interacts with IME. **The audience is roleplayers, many on phones**                                                                                                                                                              |
| **accessibility**      | No screen-reader semantics for a scope chip, a broken chip, or `ui: "glyphs"` toggles                                                                                                                                                                                                                                                                                  |
| **URL length**         | §8.9.4 accepts *"an exponential DNF expansion"* as the price of dropping grouping, with no budget                                                                                                                                                                                                                                                                      |
| **i18n**               | Filed as "not architectural". It **is**: `locstring` is a first-class storage type (20 columns, §4.1) and `text.equals`/`contains` must decide NFC/NFD and locale-aware case folding — a per-type operator contract, which is architectural by this document's own definition                                                                                          |
| **case sensitivity**   | Stated only in §4.9.9 Tier 3 as a paste rule. It belongs in §4.2b as a per-type `equals`/`contains` contract                                                                                                                                                                                                                                                           |

### 10.4 TWO USER CALLS THE REVIEW WANTS REOPENED

**Both were the user's decisions, so neither is changed here. Recorded with the argument so the call can be re-taken.**

1. **Lenient `axis:(…)` as a scope** (call 23, §2.4.5). The reviewer argues it delivers exactly what §2.4.0 chose braces
   to prevent: its named beneficiaries are people carrying **Lucene habits**, and Lucene's `field:(a b)` means AND over
   the **document**, not over one row — so they get the confident wrong guess, with no signal. It also forces parser
   backtracking and lets the editor auto-author the ambiguous state. **Cutting it is free.**
2. **The units apparatus** (§4.2c). The reviewer would ship canonical units only — declared in the pack, displayed — and
   revisit when a second unit has a customer, on the grounds that conversion serves 31 sub-second cast times and is the
   second source of D1. **Counter-argument: `ms` is not the whole case** — `SpellRange`, cooldowns and durations are all
   queued and all carry units, so the apparatus is being built one release early rather than speculatively.
