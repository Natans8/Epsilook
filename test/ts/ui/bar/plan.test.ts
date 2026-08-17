/**
 * The display plan's contract: the split is a pure read of the text, `settled + open` reconstructs it verbatim,
 * the transformation fires exactly when a known head meets its glue, and the boundary backspace deletes the one
 * character left of the caret in the underlying text — with the caret landing where that character was.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {backspaceAtStart, openHead, plan, splitAt} from "../../../../src/ui/bar/plan";

test("the open segment is the text after the last balanced space, and reconstruction is verbatim", () => {
    for (const text of ["", "fire", "model:fire ", "model:fire scale:>50",
        'name:"blood pool', "model:{fire ball} more", "a  ", "-scale:5"]) {
        const p = plan(text);
        assert.equal(p.settled + p.open, text, `reconstruction of "${text}"`);
        assert.equal(p.settled.length, splitAt(text));
    }
    assert.deepEqual(plan("model:fire scale:>50").settled, "model:fire ");
    assert.deepEqual(plan("model:fire ").open, "");
});

test("a space inside a phrase or a scope separates nothing — the segment stays whole while they are open", () => {
    assert.equal(plan('name:"blood pool').open, 'name:"blood pool');
    assert.equal(plan("model:{fire ball").open, "model:{fire ball");
    assert.equal(plan("model:{fire ball} next").open, "next");
    assert.equal(plan('name:"a b" next').open, "next");
});

test("an escaped quote does not close the phrase for the split", () => {
    assert.equal(plan('name:"a\\" b').open, 'name:"a\\" b');
});

test("the transformation fires when a known head meets the bind, and consumes it", () => {
    const p = plan("scale:");
    assert.deepEqual(p.head, {word: "scale", negated: false, consumed: 6, bound: true});
    assert.equal(p.slot, "");
    assert.equal(plan("scale:>50").slot, ">50");
});

test("an operator glue transforms but stays in the slot; an unknown word never transforms", () => {
    const p = plan("scale>50");
    assert.deepEqual(p.head, {word: "scale", negated: false, consumed: 5, bound: false});
    assert.equal(p.slot, ">50");
    assert.equal(plan("bogus:50").head, null);
    assert.equal(plan("scale").head, null);
});

test("a negated head carries its glyph and consumes it into the cell", () => {
    const p = plan("-model:fire");
    assert.deepEqual(p.head, {word: "model", negated: true, consumed: 7, bound: true});
    assert.equal(p.slot, "fire");
});

test("the transformation only reads the OPEN segment — a head in settled text is not this plan's business", () => {
    const p = plan("scale:5 fire");
    assert.equal(p.settled, "scale:5 ");
    assert.equal(p.head, null);
    assert.equal(p.slot, "fire");
});

test("boundary backspace on a bound head dissolves the bind, caret where it was", () => {
    const step = backspaceAtStart(plan("scale:>50"));
    assert.equal(step?.text, "scale>50");
    // The dissolved text still transforms through the operator glue, so the slot is ">50" and the caret sits at
    // its start — exactly where the bind was.
    assert.equal(plan(step?.text ?? "").slot, ">50");
    assert.equal(step?.caret, 0);
});

test("boundary backspace on an operator-glued head shrinks the word, untransforming when unknown", () => {
    const step = backspaceAtStart(plan("scale>50"));
    assert.equal(step?.text, "scal>50");
    assert.equal(plan(step?.text ?? "").head, null);
    assert.equal(step?.caret, 4);
});

test("boundary backspace with no head merges the settled tail back into the open segment", () => {
    const step = backspaceAtStart(plan("model:fire "));
    assert.equal(step?.text, "model:fire");
    // The merged segment transforms again; the caret sits at the end of its slot, where the space was.
    assert.equal(step?.caret, 4);
    assert.equal(backspaceAtStart(plan("")), null);
});

test("a dissolved negated head keeps its glyph in the raw text", () => {
    const step = backspaceAtStart(plan("-scale:5"));
    assert.equal(step?.text, "-scale5");
    assert.equal(plan(step?.text ?? "").head, null);
    assert.equal(step?.caret, 6);
});

test("openHead is the plan's own read exposed: null on the empty segment", () => {
    assert.equal(openHead(""), null);
});
