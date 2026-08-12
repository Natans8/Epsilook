/**
 * The parser's import-time guard, in its own file: proving it fires means corrupting the operator registry before
 * the parser module loads, which the static imports of `parse.test.ts` would forbid. Per-file process isolation is
 * what keeps the corruption from reaching any other test.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {defineOperator} from "../../src/search/operators";

describe("the expression-shape guard", () => {
    it("fails the parser's import when a prefix operator has no expression shape", async () => {
        // A declared prefix operator is recognised by the scanner immediately — the grammar derives its spellings
        // from the registry — so one the expression tree cannot carry must fail at import, not run as something else.
        defineOperator({name: "similar", symbol: "~", form: "prefix", level: "value", hint: "roughly this"});
        await assert.rejects(async () => import("../../src/search/parse"),
            /no shape in the expression tree/);
    });
});
