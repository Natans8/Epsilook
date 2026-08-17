/**
 * The classifier's contract: runs cover the text verbatim, phrases are leaves scanned as the parser scans them,
 * and a word is a head exactly when the schema knows it AND the bind glues it. A classification that disagreed
 * with the parser's reading is the bug class this suite exists to catch.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {Run} from "../../../../src/search/language/classify";
import {classify} from "../../../../src/search/language/classify";

/** The runs re-spelled over the text, for readable assertions. */
const spelled = (text: string): [string, string][] =>
    classify(text).map((run) => [text.slice(run.start, run.end), run.kind]);

/** The concatenation invariant: the runs cover the text exactly, in order, with no gap or overlap. */
function covers(text: string, runs: Run[]): void {
    let at = 0;
    for (const run of runs) {
        assert.equal(run.start, at, `run starts at ${String(run.start)}, expected ${String(at)}`);
        assert.ok(run.end > run.start, "empty run");
        at = run.end;
    }
    assert.equal(at, text.length, "runs do not reach the end");
}

test("every text is covered exactly — no gap, no overlap, empty text included", () => {
    for (const text of ["", "fireball", 'model:{fire -missile} scale:>50 name:"blood pool"', "a  b", "((("]) {
        covers(text, classify(text));
    }
});

test("a known word glued to the bind is a head, the bind included; the same word bare is text", () => {
    // `model:` is one token: the word is text until the colon makes it a door, so the two class as one run.
    assert.deepEqual(spelled("model:fire"), [
        ["model:", "head"], ["fire", "word"],
    ]);
    assert.deepEqual(spelled("model fire"), [
        ["model", "word"], [" ", "space"], ["fire", "word"],
    ]);
});

test("an unknown word glued to a colon stays text — the highlight never invents an axis", () => {
    assert.deepEqual(spelled("bogus:fire")[0], ["bogus", "word"]);
});

test("a phrase is a leaf: its quotes class apart, its content is words even where it looks structural", () => {
    assert.deepEqual(spelled('"fire {x} |"'), [
        ['"', "quote"], ["fire {x} |", "word"], ['"', "quote"],
    ]);
});

test("an escaped quote stays inside the phrase, and an unclosed phrase runs to the end", () => {
    assert.deepEqual(spelled('"a\\"b"'), [
        ['"', "quote"], ['a\\"b', "word"], ['"', "quote"],
    ]);
    assert.deepEqual(spelled('"open'), [
        ['"', "quote"], ["open", "word"],
    ]);
});

test("scopes, groups and alternation are delimiters; comparisons and the wildcard are operators", () => {
    assert.deepEqual(spelled("model:{fire|frost}"), [
        ["model:", "head"], ["{", "delim"], ["fire", "word"],
        ["|", "delim"], ["frost", "word"], ["}", "delim"],
    ]);
    // The comparison stays an operator of its own: the bind opens the door, the comparison is the question.
    assert.deepEqual(spelled("scale:>=50"), [
        ["scale:", "head"], [">=", "op"], ["50", "number"],
    ]);
});

test("typographic quotes fold to the parser's before classing, and spans still index the typed text", () => {
    const text = "name:“fire”";
    const runs = classify(text);
    covers(text, runs);
    assert.deepEqual(runs.map((run) => run.kind), ["head", "quote", "word", "quote"]);
});

test("a digit-led word is a number; digits inside a word are not", () => {
    assert.deepEqual(spelled("id:133")[1], ["133", "number"]);
    assert.deepEqual(spelled("keg01")[0], ["keg01", "word"]);
});
