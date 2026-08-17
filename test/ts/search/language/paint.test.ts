/**
 * The rich painting's contract: the lexical runs still cover the text exactly, and what the PARSE understood is
 * layered over them — the column a head reaches, the state of a clause, and which words came from a closed
 * vocabulary rather than from the corpus.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {Run} from "../../../../src/search/language/classify";
import {classify, paint} from "../../../../src/search/language/classify";

/** The run covering a text's first occurrence of a word. */
function runFor(text: string, word: string): Run {
    const at = text.indexOf(word);
    const found = paint(text).find((run) => run.start <= at && run.end >= at + word.length);
    assert.ok(found !== undefined, `no run covers "${word}"`);
    return found;
}

test("the runs still cover the text exactly, as the lexical pass does", () => {
    for (const text of ["model:fire", 'name:"blood pool" -x', "model:{fire attach:chest} 5"]) {
        const runs = paint(text);
        assert.equal(runs.map((run) => text.slice(run.start, run.end)).join(""), text);
        assert.deepEqual(runs.map((run) => [run.start, run.end, run.kind]),
            classify(text).map((run) => [run.start, run.end, run.kind]));
    }
});

test("a head wears the tone of the column it reaches, whichever door it went through", () => {
    assert.equal(runFor("model:fire", "model").tone, "model");
    assert.equal(runFor("cast:2s", "cast").tone, "spell");
    assert.equal(runFor("scale:>50", "scale").tone, "fx");
    assert.equal(runFor("sound:bell", "sound").tone, "sound");
    // An unknown word before a colon is ordinary text, and carries no tone.
    assert.equal(runFor("nonsense:fire", "nonsense").tone, undefined);
});

test("a clause that failed carries its state, and one merely warned carries the lighter one", () => {
    assert.equal(runFor("scale:abc", "scale").state, "error");
    assert.equal(runFor("model:", "model").state, "error");
    // A healthy clause beside a broken one is untouched.
    const runs = paint("model:fire scale:abc");
    assert.equal(runs.find((run) => run.start === 0)?.state, undefined);
});

test("a closed-vocabulary word is marked as one; corpus text is not", () => {
    assert.equal(runFor("model:missile", "missile").vocab, true);
    assert.equal(runFor("model:{fire attach:chest}", "chest").vocab, true);
    assert.equal(runFor("model:fire", "fire").vocab, undefined);
    assert.equal(runFor("model:{fire attach:chest}", "fire").vocab, undefined);
});
