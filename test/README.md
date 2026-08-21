# The testing strategy

Five instruments, one rule for choosing between them, and one definition of "does this pass" — `tools/check.py`, which
CI runs unchanged.

```bash
uv run python tools/check.py   # the guards, and both suites below
npm test                       # the TypeScript suite, test/ts
uv run pytest                  # the Python suite, test/py
npm run test:browser           # the browser suite, Playwright
npm run battery                # the count battery — an instrument, not a gate
```

## The law

**Every tier answers a question the tier below it cannot. Reach for the cheapest tier that can answer yours. When no
tier can answer it, that is a missing instrument — not permission to skip the question.**

The corollary is the one that gets broken: a question you cannot afford to answer is still a question. The UI rebuild's
fifteen judged defects were all reachable by a browser tier that did not exist yet, and the cost of not having it was
paid by the user, one defect at a time.

## The five tiers

| tier                | instrument               | the question only it answers               | never ask it                                |
|---------------------|--------------------------|--------------------------------------------|---------------------------------------------|
| **1 · declaration** | `check.py`               | Do two statements of one fact still agree? | Anything about behaviour                    |
| **2 · law**         | `npm test` · `pytest`    | Does this unit obey its stated law?        | Anything needing a pack, a DOM or a network |
| **3 · oracle**      | `--verify` · the oracles | Do two implementations agree?              | Whether the agreed answer is right          |
| **4 · interaction** | `test:browser` · Firefox | Does the gesture do the intended thing?    | Whether it feels right                      |
| **5 · drift**       | `battery` · `measure`    | What moved, and was it intended?           | Pass or fail                                |

### 1 · Declaration guards — `tools/check.py`

The project's own first choice: *a rule in prose cannot fire; add a guard instead.* Thirty-two of them, covering the
seams (`check_layers`, `check_matcher_seam`, `check_build_layers`, `check_react_seam`), the facts stated twice
(`check_listfile_declaration`, `check_soundkit_declaration`, `check_format_declaration`), and the artifact's own shape
(`check_pack_sections`, `check_row_schema`, `check_row_vocabularies`).

A guard is the right tier when the failure is **two declarations drifting apart**, and the wrong tier for anything that
needs the code to run. Write the guard rather than the paragraph; add it the moment what it guards is in the repo.

**A guard fails open.** If its regex stops matching after a refactor, it passes silently and forever. That already
happened once — `check_format_declaration` exists because a consumer warning had stopped firing — so a new guard is
finished only when you have watched it fail. Make the violation, run it, then put the file back.

### 2 · Law — `npm test` and `uv run pytest`

Pure units against the law written for them. This is where the volume is and where it belongs: it is the only tier fast
enough to run on every save, and the only one whose failures point at a line.

The two suites have different centres of gravity, and that is correct rather than accidental. Python covers the build,
where the risk is a route reading the wrong column and nobody noticing for eleven packs. TypeScript covers the query
language, where the risk is the engine and the law in `docs/SEARCH.md` drifting apart.

### 3 · Oracle — two implementations of one answer

The tier that exists because this project keeps building second implementations: `SqlTables` against `CsvTables`,
`rebuild.py --verify` comparing manifests, `wdc3_oracle_test.py` decoding a db2 and comparing to the publisher's own
export of that same db2, the row-diff that proved the B6 port by re-running the deleted reshapers.

Its power and its limit are the same thing: **it proves agreement, never correctness.** Two implementations of one
misunderstanding agree perfectly. So an oracle is worth building when a port or a second provider lands, and worth
retiring when the first implementation goes — a spent oracle is maintenance with no question behind it.

⚠ An oracle must not be circular. The previous db2 oracle compared Epsilon's copy of a file to Epsilon's own values and
excused the differences as Epsilon's edits; it passed for weeks while the float spelling was wrong.

### 4 · Interaction — the browser

**Playwright is the committed instrument** (`npm run test:browser`), driving the real `npm run harness` server with real
keyboard and mouse input. It exists because interaction is the one thing the tiers above structurally cannot reach: a
synthetic event is not a keystroke, and the cells that matter most — the first Ctrl+A, a native selection, a caret
landing on an aimed character — only exist under real input.

**It lives in `test/browser/`** — `playwright.config.ts` at the root owns the server and the Firefox project;
`helpers.ts` holds the three reads every assertion goes through; one spec per family of matrix cells
(`traversal` · `editing` · `keys` · `pairing` · `presses`), each `@file` block naming the cells it covers. It has its
own `tsconfig.json`, a third tsc target beside the browser's and Node's. `check_browser_matrix` in `tools/check.py`
runs it and **skips** when no Playwright Firefox is installed (`npx playwright install firefox`).

Its scope is **the gesture × position matrix**, the same matrix the increment's contract already writes as a table.
Ground rules, ruled and binding:

- **Assert on semantics, never on DOM classes** — `data-query`, the input's value, the caret offset, the position kind.
  The settled-chip rendering changes under this suite repeatedly; a class-based assertion would break on every one of
  those changes while proving nothing.
- **A separate command from the fast loop.** `npm test` stays sub-second and unconditional; the browser suite is a
  skip-when-unavailable gate in `check.py`, exactly like the cache-needing pytest tests.
- **Firefox first**, the project's verification browser. Others are optional.
- **Every increment's checkpoint adds its matrix cells.** A cell without a decided outcome is a design question to ask,
  not an accident to ship.

Firefox DevTools by hand remains the exploratory half — the thing you reach for to find out what is wrong. Playwright is
what stops it coming back.

### 5 · Drift instruments — the battery, `measure`, `verify_live.py`

**These are not tests and must never be made into gates.** `npm run battery` reports counts; a number that moves is a
finding to explain from the pack, not a failure. `npm run measure` reports timings; there is no latency budget.
`tools/verify_live.py` asserts what the deploy actually served.

The rule that makes them work: **an unexplained delta is the failure.** Not the delta itself.

## When a test is written

Not "before" or "after" as a blanket rule — the answer follows from what the thing is.

| the thing                                         | when its test lands                                  | why                                                              |
|---------------------------------------------------|------------------------------------------------------|------------------------------------------------------------------|
| A declaration, a route, a section, a schema entry | **the same commit**                                  | The test is what makes the declaration a claim instead of a note |
| A law that exists on paper first                  | **before the code**                                  | The doc's worked example becomes the fixture                     |
| An interaction                                    | **matrix first, model next, spec at the checkpoint** | The matrix is the design; the spec is the proof                  |
| A bug                                             | **with the fix, asserting the symptom**              | A test named after the mechanism dies with the next refactor     |
| A `tools/` script, an exploration, a spike        | **not at all, until it stops being one**             | Coverage of a throwaway is a throwaway                           |

**The data track already does this** — `de557ba`, `b4027cb`, `82ce02a` each ship the guard and the fixture with the
change.

**The UI track's lesson is subtler and worth keeping, because it looks like compliance.** Seven of its twelve most
recent commits shipped a test — and **every one of those tests was `plan.test.ts`**, the pure model. Not one test in
the whole track touched a component, because until `test/browser/` existed none could. Meanwhile every judged defect
was component-level: an input remounting and scrambling the caret, focus theft on blur, a phantom gap, a dead offset
that stopped the bar rendering. A well-tested model beside untested components reads exactly like a well-tested
feature, right up to the moment a human uses it. **The tier a defect lives in is the tier that has to be instrumented
— testing the neighbouring one harder buys nothing.**

**Where a law exists on paper, the fixture is not optional.** Every worked example in `docs/SEARCH.md`, `docs/TYPES.md`
and every matrix in `docs/UI.md` should end up here. One pass through the search law found four contradictions, each a
superseded statement that survived an edit. A fixture makes that impossible rather than unlikely.

## What we deliberately do not test

- **1.0.** `src/app/`, `data.ts`, `query.ts`, `search.ts`, `pills.ts`, `pilltypes.ts` are dead code walking. Never add a
  test there. `test/ts/packrows.test.ts` is the single exception and is not one: it pins the adapter that proved the row
  port, and it leaves with the adapter.
- **Acquisition over the network.** The 67 skipped Python tests need a local cache and skip cleanly without it. That is
  the design, not debt — a suite that needs someone else's CDN to pass is a suite that fails for reasons that are not
  about the code.
- **That one function calls another.** Assert on the answer, never on the route to it.
- **Framework and library behaviour.** i18next, React and esbuild are not ours to prove.
- **Feel.** Whether the bar is pleasant to type in is the user's judgment and no instrument replaces it. What the
  instruments owe them is a build with no crashes, artifacts or dead ends left in it — they are the judge, never the QA.

**Retired: "do not test the DOM or the UI."** That rule was written when this repo had one UI and one browser
instrument, and it is superseded. The interaction tier is now first-class; what survives of the old rule is narrower and
still true — *do not assert on DOM structure*, which is why the browser tier asserts on semantics.

## The TypeScript suite, `test/ts`

Put a test beside the thing it covers, mirroring `src/` including its directories:
`src/search/vocabulary/units.ts` becomes `test/ts/search/vocabulary/units.test.ts`. Import the module exactly as the app
does, extensionless, because the file is bundled before it runs:

```ts
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {seconds} from "../../../src/search/vocabulary/value-types";

describe("seconds", () => {
    it("converts a unit rather than annotating it", () => {
        assert.equal(seconds.parse!("500ms"), 500);
    });
});
```

`npm test` bundles every `test/ts/**/*.test.ts` into `test/.bundle/` and runs it with `node --test`.

**`test/.bundle/` is emptied on every build.** esbuild only writes, so a deleted or moved test used to leave its last
build behind and `node --test` went on running it — one deleted file kept 32 tests passing for days, inflating every
count reported since. `tools/build.mjs` clears the directory first.

**Each file runs in its own process,** and that isolation is load-bearing rather than incidental: the registries are
module-level, so a test that deliberately corrupts one to prove a guard fires must not reach the others.

## The Python suite, `test/py`

One flat directory of `<module>_test.py`, importing the package absolutely:

```python
from pack.routes.effects import read_spell_effect_rows
from support import BuildTables
```

**Flat, and deliberately not mirroring `build/pack`.** The package is being reorganised into layers, and modules move
between them; a mirrored test tree would have to move in lockstep, which makes the test layout a hostage to a live
design decision. Flat, a module moving between layers costs one import line and no file move. Every test basename is
unique, so nothing collides.

`pyproject.toml` puts `build` and `test/py` on the import path and selects pytest's `importlib` import mode, so nothing
is installed and `sys.path` is not rewritten. `conftest.py` holds the fixtures, and `support.py` the types they share:
a fixture reaches a test through pytest and needs no import, but its type does, and importing a name out of `conftest`
is not something pytest supports.

**No framework beyond `node:test` and `pytest`.** A suite with nothing on top cannot rot when the thing on top does, and
this app is maintained solo: the tests are the handover.

## What earns a test

| test                                                           | why it earns its keep                                             |
|----------------------------------------------------------------|-------------------------------------------------------------------|
| A documented example                                           | It is what stops the law drifting from the engine                 |
| A guard firing                                                 | A guard nobody has seen fail is not known to work                 |
| An invariant, such as `format(parse(s)) === s`                 | It holds for values nobody thought to enumerate                   |
| A declared table against the code that reads it                | The two cannot silently disagree                                  |
| A measured number, with the measurement cited in the assertion | A moved count becomes a finding to explain rather than a surprise |
| A pinned order or name that the artifact keys on               | Reordering two imports would otherwise re-ship the whole roster   |
| A sentinel colliding with a real value                         | The bug class that survives every count-based check               |

That last row is worth stating plainly, because it is what the row-diff caught twice in one change: a real value equal
to the "no value" sentinel loses data silently and moves no total. Counts do not see it. Only a value-by-value
comparison does.

## Where we are thin

Named, so the next session picks one instead of guessing. Ordered by what a defect there would cost.

1. **`derive/spelltext.py` — the description cooker.** 618 lines of template parser, producing the text that is roughly
   44% of a pack's bytes and the whole corpus behind `name:"desc …"`. `spelltext_test.py` now pins one piece of it,
   the arithmetic an expression body resolves to, against the interpreter's own answer over that grammar. That is the
   evaluator and nothing above it: substitution, redirects, conditionals, plurals and the shape of a cooked sentence
   are all still untested, and a template-shape regression there is invisible to every other tier. **This remains the
   single most valuable place to write the next test.**
2. **`check.py` has no test.** Thirty-two guards, and the entries reading "verified to fire" record a one-time manual
   act, not a repeatable one. Guards fail open. The cheapest fix is not a suite — it is a fixture directory of
   deliberate violations that the guard is run against.
3. **The 2.0 components, now partly covered.** `test/browser/` closed the bar's ruled matrix cells; what stays open is
   everything the matrix does not yet name — `app.tsx`, `harness.tsx`, and every cell a future increment adds. The
   standing obligation is the checkpoint one: an increment that ships gestures without adding its cells is incomplete.
4. **Accessibility is unmeasured, and 1.0 is the floor.** 1.0 ships a real accessibility surface — `aria-sort` on
   sortable columns, `aria-activedescendant` for autocomplete, `aria-expanded`, twenty-one `aria-label`s. The 2.0
   rebuild currently ships three such attributes in total. Nothing measures the gap, and the standing rule is that the
   rebuild must be *better* than 1.0. The shape of the tier, when it is built, follows the current published
   guidance (`modern-web-guidance`, the `accessibility` guide) rather than house invention: automated checks —
   axe-core or a Lighthouse audit — for the mechanical failures, **plus a keyboard-only sweep of every interactive
   element**, confirming each is reachable, operable, and never traps focus. The two are not interchangeable, and a
   perfect automated score does not mean the bar is usable. Note also that the browser tier already owns the input
   this needs: a keyboard sweep is Playwright's natural shape, not a second instrument.
5. **Contrast has no 2.0 instrument.** `Oracle.contrast()` walks 1.0's page only. The open contrast debts are all
   recorded against a page the rebuild is replacing, so they will need re-measuring against the harness, with matching
   pills and any dialog open — a resting page hides the whole `--text-dim`-on-hit-wash failure class.

## Where we are not thin — including where it looks like excess

Asked directly: **the suites are not bloated.** Around 1,450 tests over ~16k lines of Python and ~10k of TypeScript is
proportionate, and — more to the point — they assert on answers rather than on call routes, which is the difference
between a suite that survives a refactor and one that blocks it. The 60-name `REGISTERED_ORDER` pin looks like excess
and is not: registration order is the artifact's key order, key order is each module's bytes, and the bytes are the
module's content-addressed name, so a reorder re-ships every pack. That pin is the cheapest possible statement of a very
expensive fact.

**The imbalance is distribution, not volume.** Everything declarative has been well served for a long time; everything
interactive was served by one pure model until `test/browser/` landed, and everything perceptual — contrast,
accessibility — is still served by nothing. Adding tests to the first buys nothing; the five items above are where the
same effort buys something.

## Why there is no coverage number

Line coverage would be actively misleading here. It would report `src/app/` — deliberately dead code — as the largest
hole in the project and rank it above the cooker; and it would score the cooker's 618 lines as "covered" on the strength
of one constant import and one evaluator test. The map that matters is the tier table plus the thin list above, both
of which say what is *unanswered*, which is the thing coverage is a proxy for.

If a number is ever wanted, measure the one that means something: **how many of the laws written in `docs/` have a
fixture here.**

## The battery is not in this directory

The canonical counts need a real pack, take seconds per sorted query, and are a diff instrument rather than a pass gate:
every number that moves must be explained and intended, which is a judgement a test cannot make. They run through
`npm run battery` and the recorded baselines in `.claude/docs/OPERATIONS.md` §6.
