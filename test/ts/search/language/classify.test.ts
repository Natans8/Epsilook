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
    // The or-word standing alone IS the alternation, at either level; embedded in a word it is data.
    assert.deepEqual(spelled("model:{a or b}"), [
        ["model:", "head"], ["{", "delim"], ["a", "word"], [" ", "space"], ["or", "delim"],
        [" ", "space"], ["b", "word"], ["}", "delim"],
    ]);
    assert.deepEqual(spelled("orb"), [["orb", "word"]]);
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

test("a head is what OPENS a clause, whichever glue it takes; the same word inside one is a property", () => {
    // `model:fire` and `model>=4` are the same door said two ways, so both class as the head they are — the
    // comparison stays its own operator, because it is the question rather than the door.
    assert.deepEqual(spelled("model>=4"), [["model", "head"], [">=", "op"], ["4", "number"]]);
    // A word the schema knows only INSIDE a clause is not a head, so the lexer leaves it a word; what marks
    // it as the property it is comes from the parse, which is what `paint` layers on.
    assert.deepEqual(spelled("sound:count>2"), [
        ["sound:", "head"], ["count", "word"], [">", "op"], ["2", "number"],
    ]);
    assert.deepEqual(spelled("model:{attach:chest}"), [
        ["model:", "head"], ["{", "delim"], ["attach", "word"], [":", "op"], ["chest", "word"], ["}", "delim"],
    ]);
    // A negation opens the term it excludes, so the head after it is still a head.
    assert.deepEqual(spelled("-model:fire")[1], ["model:", "head"]);
});


test("a slash opens a pattern where a value opens, and is an ordinary character everywhere else", () => {
    // After the glue that binds a value: the slashes class apart from the pattern between them.
    assert.deepEqual(spelled("name:/^fire/"), [
        ["name:", "head"], ["/", "quote"], ["^fire", "regex"], ["/", "quote"],
    ]);
    // Inside a row scope a term opens a value directly, so a slash there opens a pattern too.
    assert.deepEqual(spelled("model:{/beam/}"), [
        ["model:", "head"], ["{", "delim"], ["/", "quote"], ["beam", "regex"], ["/", "quote"], ["}", "delim"],
    ]);
    // Free text is where a pasted path has to stay searchable: nothing here is a pattern.
    assert.deepEqual(spelled("spells/fire"), [["spells/fire", "word"]]);
    assert.deepEqual(spelled("fire /bolt/"), [
        ["fire", "word"], [" ", "space"], ["/bolt/", "word"],
    ]);
});

test("a pattern is a leaf: its own escape survives, and an unclosed one stops at the term's end", () => {
    assert.deepEqual(spelled(String.raw`name:/a\/b/`), [
        ["name:", "head"], ["/", "quote"], [String.raw`a\/b`, "regex"], ["/", "quote"],
    ]);
    assert.deepEqual(spelled("name:/fire next"), [
        ["name:", "head"], ["/", "quote"], ["fire", "regex"], [" ", "space"], ["next", "word"],
    ]);
});

test("a group admits no pattern, so a slash inside one stays an ordinary character", () => {
    assert.deepEqual(spelled("model:(/a/)"), [
        ["model:", "head"], ["(", "delim"], ["/a/", "word"], [")", "delim"],
    ]);
});

test("the coverage invariant holds over patterns too", () => {
    for (const text of ["name:/^a(b|c)$/", "model:{/x/ /y/}", "name:/", "a/b//c"]) covers(text, classify(text));
});

test("inside a pattern the query's own metacharacters stop meaning anything", () => {
    // The pipe is the query's alternation and the star its any-value, and neither is either here: the whole
    // pattern is one run, so what those characters mean is regex's answer and not this lexer's.
    assert.deepEqual(spelled("name:/a*b|c/"), [
        ["name:", "head"], ["/", "quote"], ["a*b|c", "regex"], ["/", "quote"],
    ]);
});
