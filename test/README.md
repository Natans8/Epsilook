# The test suite

Two suites, one directory, split by language. `tools/check.py` runs both, so there is one definition of "does this
pass".

```bash
npm test        # the TypeScript suite, test/ts
uv run pytest   # the Python suite, test/py
```

## What these are

**`node:test` and `pytest`, with nothing on top** — no Jest, no Vitest, no plugins. A suite with no framework cannot
rot when the framework does, and this app is maintained solo: the tests are the handover.

## The TypeScript suite, `test/ts`

Put a test beside the thing it covers, mirroring `src/` including its directories:
`src/search/vocabulary/units.ts` becomes `test/ts/search/vocabulary/units.test.ts`. Import the module exactly as the
app does, extensionless, because the file is bundled before it runs:

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

## What to test

| test                                                              | why it earns its keep                                            |
|-------------------------------------------------------------------|------------------------------------------------------------------|
| A documented example                                              | It is what stops the law drifting from the engine                |
| A guard firing                                                    | A guard nobody has seen fail is not known to work                |
| An invariant, such as `format(parse(s)) === s`                    | It holds for values nobody thought to enumerate                  |
| A declared table against the code that reads it                   | The two cannot silently disagree                                 |
| A measured number, with the measurement cited in the assertion    | A moved count becomes a finding to explain rather than a surprise|

**Do not test the DOM or the UI.** It is expensive and brittle, and Firefox with `site/dev/oracle.js` covers it better.
`check_layers` guards the seam; the oracle guards the rendering.

**Do not test that one function calls another.** Assert on the answer, never on the route to it.

## The rule worth stating twice

Every worked example in `docs/SEARCH.md` and `docs/TYPES.md` should end up here as a fixture. A single pass through
those documents found four contradictions, every one a superseded statement that survived an edit. A fixture makes that
impossible rather than unlikely.

## The count battery is not here

The canonical counts need a real pack, take seconds per sorted query, and are a diff instrument rather than a pass
gate: every number that moves must be explained and intended, which is a judgement a test cannot make. They run through
`npm run query` and the oracle.
