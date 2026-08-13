# The test suite

```bash
npm test
```

Bundles every `test/**/*.test.ts` into `test/.bundle/` and runs it with `node --test`. `tools/check.py` runs the same
command, so there is one definition of "does this pass".

## What this is

**`node:test` and nothing else** — no Jest, no Vitest, no config, no plugins. It is built into Node, it matches this
repo's stdlib-only instinct, and a suite with no framework cannot rot when the framework does. The user maintains this
app solo after the subscription ends; **the tests are the handover**.

## Writing one

Put it beside the thing it tests, mirroring `src/` **including its directories**: `src/search/vocabulary/units.ts` →
`test/search/vocabulary/units.test.ts`. Import the module exactly as the app does — extensionless — because the file is
bundled before it runs:

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

**`test/.bundle/` is emptied on every build.** esbuild only writes, so a deleted or moved test file used to leave its
last build behind and `node --test` went on running it: `backend-memory.test.ts` was deleted in `b462cff` and its 32
tests kept passing for days, inflating every count reported since. `tools/build.mjs` clears the directory first.

**Each file runs in its own process.** That isolation is load-bearing, not incidental: the registries (`TYPES`,
`KINDS`, `COLUMNS`, `OPERATORS`) are module-level, so a test that deliberately corrupts one — proving a guard fires —
must not reach the others.

## What to test

| test                                                                  | why it earns its keep                                            |
|-----------------------------------------------------------------------|------------------------------------------------------------------|
| **a documented example**                                              | it is what stops the law drifting from the engine — see below    |
| **a guard FIRING**                                                    | a guard nobody has seen fail is not known to work                |
| **an invariant** (`format(parse(s)) === s`)                           | it holds for values nobody thought to enumerate                  |
| **a declared table against the code that reads it**                   | the two cannot silently disagree                                 |
| **a measured number** *(with the measurement cited in the assertion)* | a moved count becomes a finding to explain instead of a surprise |

**⛔ WHAT NOT TO TEST: the DOM and the UI.** Expensive, brittle, and Firefox plus `site/dev/oracle.js` already cover it
better — `Oracle.q` for counts, `Oracle.pills` for snapshots, `Oracle.contrast()` for the WCAG walk. `check_layers`
guards the seam; the Oracle guards the rendering.

**⛔ AND DO NOT TEST THAT A FUNCTION CALLS ANOTHER FUNCTION.** Assert on the answer, never on the route to it.

## The one rule worth stating twice

> **Every worked example in `docs/SEARCH.md` and `docs/TYPES.md` should end up here as a fixture.**

Four contradictions were found in those documents in a single pass, and every one was a superseded statement surviving
an edit — `§2.4.2` and `§2.4.5` were both still teaching forms that had been deleted. A fixture makes that impossible
rather than unlikely.

## The count battery is NOT here

The 40 canonical counts (CLAUDE.md → *Canonical measurements*) need a real pack, take ~12 s for a sorted query, and are
a **diff instrument rather than a pass gate** — every number that moves must be explained and intended, which is a
judgement a test cannot make. They run through `npm run query` and `Oracle.q`.
