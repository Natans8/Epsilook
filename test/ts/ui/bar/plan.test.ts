/**
 * The display plan's contract: segments are a pure read of the text, `before + open + after` reconstructs it
 * verbatim whichever segment is open, the transformation fires exactly when a known head meets its glue, and the
 * boundary backspace deletes the one character left of the caret in the underlying text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
    backspaceAtStart, commitSegment, openHead, planAt, scopedForm, scopeGesture, segmentAt, segmentStarts, slotStart,
} from "../../../../src/ui/bar/plan";

test("segments start at zero and after each balanced space; a trailing space opens an empty tail", () => {
    assert.deepEqual(segmentStarts(""), [0]);
    assert.deepEqual(segmentStarts("fire"), [0]);
    assert.deepEqual(segmentStarts("model:fire scale:>50"), [0, 11]);
    assert.deepEqual(segmentStarts("model:fire "), [0, 11]);
});

test("a space inside a phrase or a scope separates nothing — those segments stay whole", () => {
    assert.deepEqual(segmentStarts('name:"blood pool'), [0]);
    assert.deepEqual(segmentStarts("model:{fire ball} next"), [0, 18]);
    assert.deepEqual(segmentStarts('name:"a\\" b'), [0]);
});

test("segmentAt clamps to the segment containing the offset, the text's end included", () => {
    assert.deepEqual(segmentAt("model:fire scale:>50", 0), {start: 0, end: 10});
    assert.deepEqual(segmentAt("model:fire scale:>50", 15), {start: 11, end: 20});
    assert.deepEqual(segmentAt("model:fire ", 99), {start: 11, end: 11});
});

test("reconstruction is verbatim whichever segment is open", () => {
    for (const text of ["", "fire", "model:fire scale:>50 x", 'name:"a b" next', "-scale:5"]) {
        for (const at of [0, Math.floor(text.length / 2), text.length]) {
            const p = planAt(text, at);
            assert.equal(p.before + p.open + p.after, text, `reconstruction of "${text}" at ${String(at)}`);
        }
    }
});

test("the transformation fires when a known head meets the bind, and consumes it", () => {
    const p = planAt("scale:", 6);
    assert.deepEqual(p.head, {word: "scale", negated: false, consumed: 6, bound: true, scoped: false});
    assert.equal(p.slot, "");
    assert.equal(planAt("scale:>50", 9).slot, ">50");
});

test("an operator glue transforms but stays in the slot; an unknown word never transforms", () => {
    const p = planAt("scale>50", 8);
    assert.deepEqual(p.head, {word: "scale", negated: false, consumed: 5, bound: false, scoped: false});
    assert.equal(p.slot, ">50");
    assert.equal(planAt("bogus:50", 8).head, null);
    assert.equal(planAt("scale", 5).head, null);
});

test("a negated head carries its glyph and consumes it into the cell", () => {
    const p = planAt("-model:fire", 11);
    assert.deepEqual(p.head, {word: "model", negated: true, consumed: 7, bound: true, scoped: false});
    assert.equal(p.slot, "fire");
});

test("a scoped head consumes both braces: the slot is the interior, spaces and all", () => {
    const p = planAt("model:{fire frost}", 10);
    assert.equal(p.head?.scoped, true);
    assert.equal(p.slot, "fire frost");
    assert.equal(p.suffix, "}");
    assert.equal(p.before + p.open + p.after, "model:{fire frost}");
    assert.equal(slotStart(p), 7);
});

test("an unclosed scope has no suffix yet; an interior whose brace closes early keeps its raw tail", () => {
    const open = planAt("model:{fire fro", 10);
    assert.equal(open.slot, "fire fro");
    assert.equal(open.suffix, "");
    const early = planAt("model:{a}x", 9);
    assert.equal(early.slot, "a}x");
    assert.equal(early.suffix, "");
});

test("the creation gesture: a bind that just landed opens a scope with the caret inside", () => {
    const step = scopeGesture(planAt("model", 5), {text: "model:", caret: 6});
    assert.equal(step.text, "model:{}");
    assert.equal(step.caret, 7);
});

test("the gesture fires on the transition only — an existing bound head never re-grows braces", () => {
    // Deleting the last interior character of an already-bound head leaves the text alone.
    const was = planAt("model:{f}", 8);
    const step = scopeGesture(was, {text: "model:", caret: 6});
    assert.equal(step.text, "model:");
    // And a plain value edit does not insert braces either.
    const typing = scopeGesture(planAt("scale:5", 7), {text: "scale:", caret: 6});
    assert.equal(typing.text, "scale:");
});

test("scopedForm rewraps a simplified chip for editing; commit simplifies a single term back", () => {
    const wrapped = scopedForm("model:fire scale:5", 2);
    assert.equal(wrapped?.text, "model:{fire} scale:5");
    assert.equal(wrapped?.caret, 11);
    const committed = commitSegment("model:{fire} scale:5", 2);
    assert.equal(committed.text, "model:fire scale:5");
    assert.equal(committed.caret, 10);
});

test("commit keeps the braces when several terms share the row, and trims the interior", () => {
    const step = commitSegment("model:{fire frost } x", 4);
    assert.equal(step.text, "model:{fire frost} x");
    assert.equal(step.caret, 18);
});

test("committing an empty scope removes the chip whole, separator included", () => {
    assert.deepEqual(commitSegment("model:{} fire", 4), {text: "fire", caret: 0});
    assert.deepEqual(commitSegment("fire model:{}", 10), {text: "fire", caret: 4});
});

test("boundary backspace on a scoped head deletes the brace pair, interior kept as raw text", () => {
    const step = backspaceAtStart(planAt("model:{fire frost}", 10));
    assert.equal(step?.text, "model:fire frost");
    assert.equal(step?.caret, 6);
});

test("a MIDDLE segment opens too, its neighbours settled on both sides", () => {
    const p = planAt("model:fire scale:5 extra", 12);
    assert.equal(p.before, "model:fire ");
    assert.equal(p.open, "scale:5");
    assert.equal(p.after, " extra");
    assert.equal(p.head?.word, "scale");
    assert.equal(p.slot, "5");
});

test("slotStart translates the input caret into a text offset", () => {
    const p = planAt("model:fire scale:5", 12);
    assert.equal(slotStart(p), 11 + 6);
    assert.equal(slotStart(planAt("fire", 0)), 0);
});

test("boundary backspace on a bound head dissolves the bind, caret where it was", () => {
    const step = backspaceAtStart(planAt("scale:>50", 9));
    assert.equal(step?.text, "scale>50");
    assert.equal(step?.caret, 5);
    // The dissolved text still transforms through the operator glue; the caret offset lands at its slot start.
    const next = planAt(step?.text ?? "", step?.caret ?? 0);
    assert.equal(next.slot, ">50");
    assert.equal((step?.caret ?? 0) - slotStart(next), 0);
});

test("boundary backspace on an operator-glued head shrinks the word, untransforming when unknown", () => {
    const step = backspaceAtStart(planAt("scale>50", 8));
    assert.equal(step?.text, "scal>50");
    assert.equal(planAt(step?.text ?? "", step?.caret ?? 0).head, null);
    assert.equal(step?.caret, 4);
});

test("boundary backspace on a headless segment deletes the separator, merging the segments", () => {
    const step = backspaceAtStart(planAt("model:fire ", 11));
    assert.equal(step?.text, "model:fire");
    assert.equal(step?.caret, 10);
    assert.equal(backspaceAtStart(planAt("", 0)), null);
});

test("boundary backspace on a MIDDLE segment merges it into its left neighbour", () => {
    const step = backspaceAtStart(planAt("model:fire extra", 11));
    assert.equal(step?.text, "model:fireextra");
    assert.equal(step?.caret, 10);
});

test("a dissolved negated head keeps its glyph in the raw text", () => {
    const step = backspaceAtStart(planAt("-scale:5", 8));
    assert.equal(step?.text, "-scale5");
    assert.equal(planAt(step?.text ?? "", 0).head, null);
    assert.equal(step?.caret, 6);
});

test("openHead is the plan's own read exposed: null on the empty segment", () => {
    assert.equal(openHead(""), null);
});
