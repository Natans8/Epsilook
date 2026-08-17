/**
 * The display plan's contract: segments are a pure read of the text, `before + open + after` reconstructs it
 * verbatim whichever segment is open, the transformation fires exactly when a known head meets its glue, and the
 * boundary backspace deletes the one character left of the caret in the underlying text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
    backspaceAtStart, commitSegment, deleteAtEnd, firstDiff, grownSegment, insertAtGap, openHead, planAt,
    removeSegment, removeTerm, scopedForm, scopeGesture, segmentAt, segmentStarts, slotStart,
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
    assert.equal(step.removed, false);
});

test("committing an empty scope removes the chip whole, separator included, and says so", () => {
    assert.deepEqual(commitSegment("model:{} fire", 4), {text: "fire", caret: 0, removed: true});
    assert.deepEqual(commitSegment("fire model:{}", 10), {text: "fire", caret: 4, removed: true});
    assert.deepEqual(commitSegment("model:{}", 4), {text: "", caret: 0, removed: true});
    // A blank interior is as empty as none — spaces are not an ask.
    assert.deepEqual(commitSegment("model:{  } fire", 4), {text: "fire", caret: 0, removed: true});
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

test("typing into a gap writes the value and the separator that keeps the next segment a segment", () => {
    assert.deepEqual(insertAtGap("model:fire scale:5", 11, "x"), {text: "model:fire x scale:5", caret: 12});
    assert.deepEqual(insertAtGap("fire", 0, "a"), {text: "a fire", caret: 1});
});

test("a blank value writes nothing into a gap — a bare separator has no term to separate", () => {
    assert.equal(insertAtGap("model:fire scale:5", 11, " "), null);
    assert.equal(insertAtGap("model:fire scale:5", 11, "  "), null);
});

test("commit simplifies to its fixpoint: a whole-scope interior sheds every layer at once", () => {
    assert.deepEqual(commitSegment("model:{{fire}}", 8), {text: "model:fire", caret: 10, removed: false});
    assert.deepEqual(commitSegment("model:{{fire}", 8), {text: "model:fire", caret: 10, removed: false});
    const multi = commitSegment("model:{{fire frost}}", 8);
    assert.equal(multi.text, "model:{fire frost}");
    assert.deepEqual(commitSegment("model:{{}}", 8), {text: "", caret: 0, removed: true});
    // A pair that is not the WHOLE interior keeps its braces — only redundant outer layers shed.
    assert.equal(commitSegment("model:{{a} b}", 8).text, "model:{{a} b}");
});

test("delete at the slot's end mirrors the boundary backspace: pair-dissolve on a scope, plain merge otherwise", () => {
    const scoped = deleteAtEnd(planAt("model:{fire}", 8));
    assert.equal(scoped?.text, "model:fire");
    assert.equal(scoped?.caret, 10);
    const merge = deleteAtEnd(planAt("fire abc", 0));
    assert.equal(merge?.text, "fireabc");
    assert.equal(merge?.caret, 4);
    assert.equal(deleteAtEnd(planAt("fire", 0)), null);
});

test("firstDiff finds where an undo landed; equal texts answer their length", () => {
    assert.equal(firstDiff("model:fire scale:5", "model:fire"), 10);
    assert.equal(firstDiff("model:fire", "model:{fire}"), 6);
    assert.equal(firstDiff("same", "same"), 4);
});

test("the brace shed is the engine's call: a spelling that would change the ask keeps its braces", () => {
    // The colon-glued spelling reads as content, so shedding would silently change the question.
    assert.equal(commitSegment("model:{attach:chest}", 0).text, "model:{attach:chest}");
    // The operator-glued spelling reads back as the same one-term scope, so it sheds.
    assert.equal(commitSegment("model:{count>=4}", 0).text, "model:count>=4");
    assert.equal(commitSegment("model:{fire}", 0).text, "model:fire");
});

test("a commit takes a dangling alternation separator back out of a bound segment", () => {
    assert.equal(commitSegment("model:fire|", 0).text, "model:fire");
    assert.equal(commitSegment("cast:2s| next", 0).text, "cast:2s next");
    // A separator that means something stays.
    assert.equal(commitSegment("model:fire|frost", 0).text, "model:fire|frost");
});

test("removeSegment takes the chip and one adjacent separator, the caret landing where it stood", () => {
    assert.deepEqual(removeSegment("model:fire scale:5", 0), {text: "scale:5", caret: 0, removed: true});
    assert.deepEqual(removeSegment("model:fire scale:5", 12), {text: "model:fire", caret: 10, removed: true});
    assert.deepEqual(removeSegment("a model:fire z", 3), {text: "a z", caret: 2, removed: true});
    assert.deepEqual(removeSegment("model:fire", 0), {text: "", caret: 0, removed: true});
});

test("removeTerm keeps the alternation between survivors, and a lone run takes its or-edge with it", () => {
    // `model:{fire ball | frost}`: fire 7..11, ball 12..16, frost 19..24.
    const text = "model:{fire ball | frost}";
    assert.equal(removeTerm(text, 0, {start: 12, end: 16}, false).text, "model:{fire | frost}");
    assert.equal(removeTerm(text, 0, {start: 7, end: 11}, false).text, "model:{ball | frost}");
    // `model:{fire | frost}`: fire 7..11, frost 14..19 — each alone in its run.
    assert.equal(removeTerm("model:{fire | frost}", 0, {start: 14, end: 19}, true).text, "model:fire");
    assert.equal(removeTerm("model:{fire | frost}", 0, {start: 7, end: 11}, true).text, "model:frost");
});

test("removeTerm collapses a two-term scope to the compact spelling, and an emptied scope goes whole", () => {
    assert.equal(removeTerm("model:{fire ball}", 0, {start: 12, end: 16}, true).text, "model:fire");
    assert.equal(removeTerm("model:{fire attach:chest}", 0, {start: 12, end: 24}, true).text, "model:fire");
    const gone = removeTerm("model:{fire} next", 0, {start: 7, end: 11}, true);
    assert.deepEqual(gone, {text: "next", caret: 0, removed: true});
});

test("grownSegment offers a fresh term slot inside the scoped form, or an alternative separator", () => {
    assert.deepEqual(grownSegment("model:fire", 0, "term"),
        {text: "model:{fire }", caret: 12, operation: true});
    assert.deepEqual(grownSegment("model:{a b}", 0, "term"),
        {text: "model:{a b }", caret: 11, operation: true});
    assert.deepEqual(grownSegment("cast:2s", 0, "alternative"),
        {text: "cast:2s|", caret: 8, operation: true});
    assert.deepEqual(grownSegment("id:133,134 x", 0, "alternative"),
        {text: "id:133,134| x", caret: 11, operation: true});
});

test("the editing wrap is ask-preserving: a prop door and a broken segment open raw, never braced", () => {
    // A property takes a value, never a scope — `cast:{2s}` would be invalid, so no wrap.
    assert.equal(scopedForm("cast:2s", 0), null);
    // A segment that does not parse opens as the raw text it failed as.
    assert.equal(scopedForm('scale:"50"', 0), null);
    // The ordinary chip still wraps.
    assert.equal(scopedForm("model:fire", 0)?.text, "model:{fire}");
});

test("the scope gesture skips a property door: its slot stays braceless and a space commits", () => {
    const before = planAt("cast", 4);
    const step = scopeGesture(before, {text: "cast:", caret: 5});
    assert.deepEqual(step, {text: "cast:", caret: 5});
    const model = scopeGesture(planAt("model", 5), {text: "model:", caret: 6});
    assert.equal(model.text, "model:{}");
});

test("a shed that would change the ask is refused even when the interior is broken", () => {
    // `scale:{"50"}` is a scope whose one term is dead — it means existence and runs; the braceless spelling
    // is an error that asks nothing. Different questions, so the commit leaves the braces standing.
    assert.equal(commitSegment('scale:{"50"}', 0).text, 'scale:{"50"}');
});

test("the brace shed asks the FORMATTER's rule, not two spellings: an alternation value sheds", () => {
    // `model:{fire|frost}` and `model:fire|frost` ask one question and canonicalise to two different strings,
    // so a textual comparison refuses a shed the language allows.
    assert.equal(commitSegment("model:{fire|frost}", 0).text, "model:fire|frost");
    assert.equal(commitSegment("id:{133,134}", 0).text, "id:133,134");
    // And the reverse still holds: alike spellings that ask differently keep their braces.
    assert.equal(commitSegment("model:{attach:chest}", 0).text, "model:{attach:chest}");
});

test("a scope closing before its segment ends never gains a second brace", () => {
    // `model:{a b}c` — the closer is mid-segment, so the slot is not an interior.
    assert.equal(commitSegment("model:{a b}c", 0).text, "model:{a b}c");
    // The dangling separator is trimmed by the same commit, which is the point: no second brace either way.
    assert.equal(commitSegment("model:{a b}|", 0).text, "model:{a b}");
    // A scope that never closes still commits as one; the commit is what supplies the brace.
    assert.equal(commitSegment("model:{fire", 0).text, "model:fire");
});

test("an operator-glued head opens scoped too, so its chip can grow a lane", () => {
    // `model>=4` desugars to a one-term count scope, and `model:{>=4}` is that scope written out.
    assert.equal(scopedForm("model>=4", 0)?.text, "model:{>=4}");
    assert.equal(grownSegment("model>=4", 0, "term").text, "model:{>=4 }");
    // An alternation chip grows the same way.
    assert.equal(grownSegment("model:fire|frost", 0, "term").text, "model:{fire|frost }");
});

test("a head opens on a comparison ALIAS exactly as on its symbol — the glyph a chip draws is typeable", () => {
    assert.deepEqual(openHead("model≥4"), openHead("model>=4"));
    assert.deepEqual(openHead("scale≤2"), openHead("scale<=2"));
    assert.equal(openHead("model≥4")?.word, "model");
});

test("a commit prefers the spelling that parses: the editing braces never break a signed value", () => {
    // `-50%` is a negation at a term's start and a signed value after a bind, so the editing form's own
    // braces are what break `scale:-50%` — the commit gives back exactly what was typed.
    assert.equal(commitSegment("scale:{-50%}", 0).text, "scale:-50%");
    assert.equal(commitSegment("scale:{-50}", 0).text, "scale:-50");
    // A braced form that asks something real still keeps its braces where shedding would change the ask.
    assert.equal(commitSegment("model:{attach:chest}", 0).text, "model:{attach:chest}");
});
