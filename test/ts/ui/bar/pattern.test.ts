/**
 * The pattern colouring's one contract: whatever the library says about a pattern, the ranges it comes back as
 * abut, cover the pattern exactly, and index the pattern's own characters — which is what lets a selection
 * split one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {patternRuns} from "../../../../src/ui/bar/pattern";

/** The invariant every case shares: ranges abut from zero and rebuild the pattern verbatim. */
function covers(pattern: string): void {
    const runs = patternRuns(pattern);
    let at = 0;
    let rebuilt = "";
    for (const run of runs) {
        assert.equal(run.start, at, `range starts at ${String(at)} in ${pattern}`);
        assert.ok(run.end > run.start, `empty range in ${pattern}`);
        rebuilt += pattern.slice(run.start, run.end);
        at = run.end;
    }
    assert.equal(rebuilt, pattern);
    assert.equal(at, pattern.length);
}

test("ranges abut and rebuild the pattern, whatever it holds", () => {
    for (const pattern of [
        "fire", "^fireball$", String.raw`\d+`, "(ball|storm)", "[a-z]", String.raw`a\/b`,
        String.raw`(?<name>x)\k<name>`, "a{2,3}", String.raw`[^\w-]`, "((a(b(c(d)))))", "a<b&c",
    ]) covers(pattern);
});

test("a literal is unmarked and a metasequence is not", () => {
    assert.deepEqual(patternRuns("fire"), [{start: 0, end: 4, kind: "literal", depth: 0}]);
    const anchored = patternRuns("^fire");
    assert.equal(anchored[0].kind, "meta");
    assert.deepEqual([anchored[0].start, anchored[0].end], [0, 1]);
    assert.equal(anchored[1].kind, "literal");
});

test("a group carries the library's own depth, and its contents sit inside it", () => {
    const runs = patternRuns("(a(b))");
    const depths = runs.filter((run) => run.kind === "group").map((run) => run.depth);
    assert.deepEqual(depths, [1, 2, 2, 1]);
});

test("a character class tells its brackets, its range hyphen and its metasequences apart", () => {
    const kinds = patternRuns(String.raw`[a-z\d]`).map((run) => run.kind);
    assert.deepEqual(kinds, ["classBoundary", "class", "classRange", "class", "classMeta", "classBoundary"]);
});

test("what the library refuses comes back as an error range carrying its reason", () => {
    const bad = patternRuns("a(b").find((run) => run.kind === "error");
    assert.ok(bad !== undefined);
    assert.match(bad.note ?? "", /unclosed/iu);
});

test("the entities the library writes shrink back, so a range still indexes the pattern", () => {
    covers("a<b");
    covers("a&b");
    assert.deepEqual(patternRuns("a<b"), [{start: 0, end: 3, kind: "literal", depth: 0}]);
});
