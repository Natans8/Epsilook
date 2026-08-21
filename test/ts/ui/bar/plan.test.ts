/**
 * The display plan's contract: segments are a pure read of the text, `before + open + after` reconstructs it
 * verbatim whichever segment is open, the transformation fires exactly when a known head meets its glue, and the
 * boundary backspace deletes the one character left of the caret in the underlying text.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
    backspaceAtStart, commitSegment, deleteAtEnd, firstDiff, grownSegment, insertAtGap, keywordBehind,
    negatesBefore, openHead, pairDelimiter, planAt, removeSegment, removeSelection, removeTerm, replaceSelection,
    scopedForm, scopeGesture, segmentAt, segmentsOf, selectionOver, selectionStep, shiftScope, slotStart,
    termStarts, toggleSort,
} from "../../../../src/ui/bar/plan";

test("a door's arrow turns that door alone, respelled through the formatter", () => {
    assert.deepEqual(toggleSort("model:fire sort:cast", 12, 0),
        {text: "model:fire sort:-cast", caret: 21, removed: false});
    assert.deepEqual(toggleSort("model:fire sort:-cast", 12, 0),
        {text: "model:fire sort:cast", caret: 20, removed: false});
    // In a sequence each door has its own arrow; the others stand as they are.
    assert.equal(toggleSort("sort:{name -cast} fire", 3, 0)?.text, "sort:{-name -cast} fire");
    assert.equal(toggleSort("sort:{name -cast} fire", 3, 1)?.text, "sort:{name cast} fire");
    // The exclusion spelling collapses into the door's minus on the way through.
    assert.equal(toggleSort("-sort:cast", 0, 0)?.text, "sort:cast");
    // A segment that is no sort — plain text, a chip, the limit — offers no turn, and neither does a door
    // the directive does not have.
    assert.equal(toggleSort("model:fire sort:cast", 3, 0), null);
    assert.equal(toggleSort("first:5", 3, 0), null);
    assert.equal(toggleSort("sort:{name -cast}", 3, 2), null);
});

test("the directive words open like heads, so the control chips edit like every other chip", () => {
    // The sort's bind spawns its scope, composing a sequence with spaces INSIDE the chip; the commit sheds
    // the braces of a single door and keeps a sequence's.
    assert.deepEqual(openHead("sort:{name -cast}"),
        {word: "sort", negated: false, consumed: 6, bound: true, scoped: true});
    assert.deepEqual(openHead("first:5"),
        {word: "first", negated: false, consumed: 6, bound: true, scoped: false});
    const spawned = scopeGesture(planAt("", 0), {text: "sort:", caret: 5});
    assert.equal(spawned.text, "sort:{}");
    // The limit takes one count, never a scope.
    const flat = scopeGesture(planAt("", 0), {text: "first:", caret: 6});
    assert.equal(flat.text, "first:");
    // A single door sheds the editing braces on commit; a sequence keeps them.
    assert.equal(commitSegment("sort:{name}", 3).text, "sort:name");
    assert.equal(commitSegment("sort:{name -cast}", 3).text, "sort:{name -cast}");
    // Reopening the plain spelling grows them back, so editing always composes inside the chip.
    assert.equal(scopedForm("sort:name", 3)?.text, "sort:{name}");
});

test("terms start at zero and after each balanced space; a trailing space opens an empty tail", () => {
    assert.deepEqual(termStarts(""), [0]);
    assert.deepEqual(termStarts("fire"), [0]);
    assert.deepEqual(termStarts("model:fire scale:>50"), [0, 11]);
    assert.deepEqual(termStarts("model:fire "), [0, 11]);
    assert.deepEqual(termStarts("big red dragon"), [0, 4, 8]);
});

test("a space inside a phrase or a scope separates nothing — those terms stay whole", () => {
    assert.deepEqual(termStarts('name:"blood pool'), [0]);
    assert.deepEqual(termStarts("model:{fire ball} next"), [0, 18]);
    assert.deepEqual(termStarts('name:"a\\" b'), [0]);
});

test("neighbouring plain words are ONE segment — the space between them is a character, not a boundary", () => {
    assert.deepEqual(segmentsOf("big red dragon"), [{start: 0, end: 14, plain: true}]);
    // A chip breaks a run; the text either side of it is one segment each.
    assert.deepEqual(segmentsOf("big red model:fire cold one"), [
        {start: 0, end: 7, plain: true},
        {start: 8, end: 18, plain: false},
        {start: 19, end: 27, plain: true},
    ]);
    // An unknown head is text, and so is a negated word. A delimiter alone does not make a chip either — the
    // display model is asked, and it draws a bare phrase as the text it is.
    assert.deepEqual(segmentsOf("foo:bar -big red").length, 1);
    assert.deepEqual(segmentsOf('big "blood pool" red').length, 1);
    // A resolved head with its glue is a chip on sight, so it splits the run either side of it.
    assert.deepEqual(segmentsOf('big name:"blood pool" red').map((seg) => seg.start), [0, 4, 22]);
    // The empty tail a commit leaves belongs to the run before it, so its trailing space stays editable text.
    assert.deepEqual(segmentsOf("big red "), [{start: 0, end: 8, plain: true}]);
    assert.deepEqual(segmentsOf("model:fire "), [
        {start: 0, end: 10, plain: false},
        {start: 11, end: 11, plain: true},
    ]);
});

test("segmentAt clamps to the segment containing the offset, the text's end included", () => {
    assert.deepEqual(segmentAt("model:fire scale:>50", 0), {start: 0, end: 10, plain: false});
    assert.deepEqual(segmentAt("model:fire scale:>50", 15), {start: 11, end: 20, plain: false});
    assert.deepEqual(segmentAt("model:fire ", 99), {start: 11, end: 11, plain: true});
    // Inside a run of words, any offset — the separators included — answers with the whole run.
    assert.deepEqual(segmentAt("big red dragon", 7), {start: 0, end: 14, plain: true});
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

test("a closer followed only by the separator is still the scope's, however the term split hid it", () => {
    // An unclosed phrase runs to the end of the input, so the space a commit appended never separates a term:
    // the segment arrives as `name:{"} ` and its closer is second-to-last. Requiring the brace to be FINAL left
    // it inside the slot, where the next commit saw no closer and wrote another — one more per reopen.
    const held = planAt('name:{"} ', 7);
    assert.equal(held.slot, '"');
    assert.equal(held.suffix, "}");
    // The separator goes back to the query rather than into the slot, and the plan still reads verbatim.
    assert.equal(held.after, " ");
    assert.equal(held.before + held.open + held.after, 'name:{"} ');

    // Content glued after the closer is NOT a separator: that stays raw, by the ruling above.
    assert.equal(planAt("model:{a}x", 9).suffix, "");
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

test("boundary backspace on a bound head takes the whole keyword in one press", () => {
    // The ruled reading: backspace straight after a head erases the head, never one character of it.
    const step = backspaceAtStart(planAt("scale:>50", 9));
    assert.equal(step?.text, ">50");
    assert.equal(step?.caret, 0);
    assert.equal(step?.operation, true);
    // Mid-bar, the neighbours stand untouched and the caret lands where the keyword began.
    const mid = backspaceAtStart(planAt("fire cast:2s frost", 11));
    assert.equal(mid?.text, "fire 2s frost");
    assert.equal(mid?.caret, 5);
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

test("a negated head goes whole too — the glyph is part of the cell the press removes", () => {
    const step = backspaceAtStart(planAt("-scale:5", 8));
    assert.equal(step?.text, "5");
    assert.equal(step?.caret, 0);
});

test("the keyword behind a caret is the word and its bind, at any depth, unescaped binds only", () => {
    // The inner-bind half of the same ruling: fx:{scale:|} steps to fx:{|} in one press.
    assert.equal(keywordBehind("scale:", 6), 0);
    assert.equal(keywordBehind("missile from:", 13), 8);
    // Not a bind just left of the caret, or an escaped one: nothing to take.
    assert.equal(keywordBehind("scale:5", 7), null);
    assert.equal(keywordBehind("a\\:", 3), null);
    assert.equal(keywordBehind(":", 1), 0);
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
    // Past a chip's own end sits the separator, which deletes plainly and merges what follows into it.
    const merge = deleteAtEnd(planAt("model:fire abc", 0));
    assert.equal(merge?.text, "model:fireabc");
    assert.equal(merge?.caret, 10);
    assert.equal(deleteAtEnd(planAt("fire", 0)), null);
    // Two words are one segment, so their separator is inside the slot and the input owns that Delete.
    assert.equal(deleteAtEnd(planAt("fire abc", 0)), null);
});

test("firstDiff finds where an undo landed; equal texts answer their length", () => {
    assert.equal(firstDiff("model:fire scale:5", "model:fire"), 10);
    assert.equal(firstDiff("model:fire", "model:{fire}"), 6);
    assert.equal(firstDiff("same", "same"), 4);
});

test("a commit converges the chip-invisible rewrites: the settled text says what the chip draws", () => {
    // The chip already draws the inner bind through its own door, so the text follows on commit.
    assert.equal(commitSegment("spell:{desc:hello}", 0).text, "desc:hello");
    assert.equal(commitSegment("missile:*", 0).text, "model:missile");
    // The operator-glued count spelling IS the canonical one; the commit must never grow it a colon,
    // whichever editing form it was composed in.
    assert.equal(commitSegment("model>=5", 0).text, "model>=5");
    assert.equal(commitSegment("model:{>=5}", 0).text, "model>=5");
    assert.equal(commitSegment("model:>=5", 0).text, "model>=5");
    assert.equal(commitSegment("model:{count>5}", 0).text, "model>5");
    // A kind's subject binds through the KIND's word: never the schema's own property name, which once
    // settled this as the `name:horse` nobody typed.
    assert.equal(commitSegment("model:{mount:horse}", 0).text, "model:{mount:horse}");
});

test("the brace shed is the engine's call: a spelling that would change the ask keeps its braces", () => {
    // The colon-glued spelling reads as content, so shedding would silently change the question.
    assert.equal(commitSegment("model:{point:chest}", 0).text, "model:{point:chest}");
    // A kind with a TOP-LEVEL door of its own sheds all the way onto it: `attach:chest` is the same ask.
    assert.equal(commitSegment("model:{attach:chest}", 0).text, "attach:chest");
    // The operator-glued spelling reads back as the same one-term scope, so it sheds — and the commit then
    // converges on the canonical count spelling, which the chip draws identically.
    assert.equal(commitSegment("model:{count>=4}", 0).text, "model>=4");
    assert.equal(commitSegment("model:{fire}", 0).text, "model:fire");
});

test("a commit takes a dangling alternation separator back out of a bound segment", () => {
    assert.equal(commitSegment("model:fire|", 0).text, "model:fire");
    // The bare quantity bind converges on its exact-operator spelling — the same parse, the same chip.
    assert.equal(commitSegment("cast:2s| next", 0).text, "cast:2s next");
    // A separator that means something stays, converged on the canonical group spelling.
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
    assert.equal(scopedForm("scale:abc", 0), null);
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
    // `scale:{abc}` is a scope whose one term is dead: the scope still runs, asking for any scale row at all,
    // while the braceless `scale:abc` is an error that asks nothing. Different questions, so the braces stay.
    assert.equal(commitSegment("scale:{abc}", 0).text, "scale:{abc}");
});

test("the brace shed asks the FORMATTER's rule, not two spellings: an alternation value sheds", () => {
    // `model:{fire|frost}` and `model:fire|frost` ask one question and canonicalise to two different strings,
    // so a textual comparison refuses a shed the language allows; the shed then settles on the group spelling.
    assert.equal(commitSegment("model:{fire|frost}", 0).text, "model:fire|frost");
    // The comma list converges on the formatter's group spelling; whether the comma list should BE the
    // canonical identity-list spelling is an open formatter question, not this rule's.
    assert.equal(commitSegment("id:{133,134}", 0).text, "id:133,134");
    // And the reverse still holds: alike spellings that ask differently keep their braces.
    assert.equal(commitSegment("model:{point:chest}", 0).text, "model:{point:chest}");
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
    // braces are what break `scale:-50%` — the commit gives it back, settled on the exact-operator spelling.
    assert.equal(commitSegment("scale:{-50%}", 0).text, "scale:-50%");
    // The bare number settles wearing the unit it was read in, as the written tier's law says it must.
    assert.equal(commitSegment("scale:{-50}", 0).text, "scale:-50%");
    // A braced form that asks something real still keeps its braces where shedding would change the ask.
    assert.equal(commitSegment("model:{point:chest}", 0).text, "model:{point:chest}");
});

test("a selection takes text by the character and a chip whole", () => {
    const text = "model:fire big red sound:bell";
    // Inside text it is exactly what was covered — the space between two words included.
    assert.deepEqual(selectionOver(text, 11, 14), {from: 11, to: 14});
    assert.deepEqual(selectionOver(text, 14, 15), {from: 14, to: 15});
    // Reaching into a chip takes the whole chip, whichever way the gesture was dragged.
    assert.deepEqual(selectionOver(text, 3, 14), {from: 0, to: 14});
    assert.deepEqual(selectionOver(text, 14, 3), {from: 0, to: 14});
    assert.deepEqual(selectionOver(text, 16, 22), {from: 16, to: 29});
    // A collapsed gesture is a press, not a selection.
    assert.equal(selectionOver(text, 3, 3), null);
    assert.equal(selectionOver("", 0, 0), null);
});

test("a selection step walks one character through text and one whole chip past a chip", () => {
    const text = "model:fire big sound:bell";
    // Through the text between the two chips, character by character.
    assert.equal(selectionStep(text, 11, 1), 12);
    assert.equal(selectionStep(text, 13, -1), 12);
    // A separator that joins a chip goes with the chip: the language put it there, not the reader.
    assert.equal(selectionStep(text, 11, -1), 0);
    assert.equal(selectionStep(text, 14, 1), 25);
    // And leaving a chip clears its own separator too, so the step never strands one inside the selection.
    assert.equal(selectionStep("model:fire sound:bell cast:2s ", 11, 1), 22);
    // The text's own ends clamp.
    assert.equal(selectionStep(text, 0, -1), 0);
    assert.equal(selectionStep(text, text.length, 1), text.length);
});

test("removing a selection leaves no stranded separator", () => {
    const text = "model:fire sound:bell cast:2s";
    assert.deepEqual(removeSelection(text, {from: 0, to: 10}), {text: "sound:bell cast:2s", caret: 0, removed: true});
    assert.deepEqual(removeSelection(text, {from: 11, to: 21}),
        {text: "model:fire cast:2s", caret: 11, removed: true});
    assert.deepEqual(removeSelection(text, {from: 0, to: 29}), {text: "", caret: 0, removed: true});
    // Inside text exactly the characters go, because a selection over text is a selection of characters.
    assert.deepEqual(removeSelection("big red dragon", {from: 3, to: 7}),
        {text: "big dragon", caret: 3, removed: true});
    assert.deepEqual(removeSelection("big red dragon", {from: 4, to: 7}),
        {text: "big  dragon", caret: 4, removed: true});
});

test("Ctrl+] and Ctrl+[ adjust the boundary at the caret: text barfs out, nothing slurps in", () => {
    // Forward barf: what follows the caret leaves the enclosure, WITHOUT the boundary brace.
    assert.deepEqual(shiftScope("model:{a b}", 0, 1, 1), {text: "model:{a} b", caret: 8, operation: true});
    // Backward barf: what precedes the caret leaves to stand before the segment.
    assert.deepEqual(shiftScope("model:{a b}", 0, 2, -1), {text: "a model:{b}", caret: 9, operation: true});
    // Forward slurp: nothing between the caret and the closer, so the closer swallows the next term whole.
    assert.deepEqual(shiftScope("model:{a} b c", 0, 1, 1), {text: "model:{a b} c", caret: 10, operation: true});
    // Backward slurp mirrors it on the opener — and a chip is one term, so it comes in whole.
    assert.deepEqual(shiftScope("x model:{a}", 4, 0, -1), {text: "model:{x a}", caret: 9, operation: true});
    // Nothing to move on that side is a no-op, and an unscoped segment offers nothing.
    assert.equal(shiftScope("model:{a}", 0, 1, 1), null);
    assert.equal(shiftScope("fireball", 0, 4, 1), null);
});

test("a trailing lone escape is literal text: the commit doubles it so it cannot eat the closer", () => {
    // The escape shields the next character, and at the slot's end the next character is the brace or quote
    // the commit itself supplies — which the reader never typed. A lone backslash means the literal
    // character, and the one-term shed then applies as it does to any literal term.
    assert.equal(commitSegment("name:{\\", 0).text, "name:\\\\");
    assert.equal(commitSegment('name:{"a\\', 0).text, 'name:"a\\\\"');
    // An even run is already paired — every escape shields the one after it — and stays untouched.
    assert.equal(commitSegment("name:{\\\\", 0).text, "name:\\\\");
    // The creation gesture's own closer, shielded by the typed escape, comes back off the interior: the
    // reader typed one backslash, and one literal backslash is what settles.
    assert.equal(commitSegment("model:{\\}", 0).text, "model:\\\\");
});

test("replacing a selection lands the new text where it stood, the caret after it", () => {
    const text = "model:fire sound:bell cast:2s";
    // A pasted clause takes the selected chip's place, keeping the separator the next segment needs.
    assert.deepEqual(replaceSelection(text, {from: 0, to: 10}, "anim:walk"),
        {text: "anim:walk sound:bell cast:2s", caret: 9, removed: true});
    // At the query's end no separator grows: the reader may keep typing.
    assert.deepEqual(replaceSelection(text, {from: 22, to: 29}, "fx:glow"),
        {text: "model:fire sound:bell fx:glow", caret: 29, removed: true});
    // Newlines become the separator they stand for, because a query is one line.
    assert.deepEqual(replaceSelection(text, {from: 0, to: 29}, "model:fire\nsound:ice"),
        {text: "model:fire sound:ice", caret: 20, removed: true});
    // Nothing pasteable is the removal alone.
    assert.deepEqual(replaceSelection(text, {from: 0, to: 10}, "  \n "),
        {text: "sound:bell cast:2s", caret: 0, removed: true});
});

test("a separator typed over a selection writes nothing, so no doubled separator is left behind", () => {
    // The symptom: selecting the first chip and pressing the space bar wrote the space on top of the one the
    // removal had already left, and the query opened with two — which the term split reads as an empty term.
    const text = "model:fire sound:bell";
    assert.deepEqual(replaceSelection(text, {from: 0, to: 10}, " "),
        {text: "sound:bell", caret: 0, removed: true});
    // The same rule a separator typed into a gap answers to: nothing to separate, so nothing is written.
    assert.equal(insertAtGap(text, 11, " "), null);
});

test("an escape shields the next character, but never whitespace: `a\\ b` is two terms, not one", () => {
    // The lexer's own limit (scan.ts, classify.ts): a shielded space would draw one segment across two clauses,
    // and an edit inside that segment would then cross a clause boundary.
    assert.deepEqual(termStarts("a\\ b"), [0, 3]);
    assert.deepEqual(segmentsOf("model:fire\\ sound:bell").map((seg) => seg.start), [0, 12]);
    // A shielded NON-space still shields, everywhere — inside a phrase and outside one alike.
    assert.deepEqual(termStarts("a\\:b c"), [0, 5]);
    assert.deepEqual(termStarts('name:"a\\" b'), [0]);
    // A trailing escape shields nothing, because there is no next character for it to shield.
    assert.deepEqual(termStarts("a\\"), [0]);
});

test("a minus before a digit is a sign, and before anything else it excludes", () => {
    // One statement of the rule, so the keyboard's flip and the offers' exclusion mark cannot read the same
    // character two ways: `scale:{-50%}` has to keep agreeing with `scale:-50%`.
    assert.equal(negatesBefore("50%"), false);
    assert.equal(negatesBefore(".5"), false);
    assert.equal(negatesBefore("fire"), true);
    assert.equal(negatesBefore(""), true);
});

test("the delimiter pairing is one rule: enclose, spawn, step over, and take both halves back", () => {
    // Over a selection the pair encloses it, and the selection survives inside.
    assert.deepEqual(pairDelimiter("model:fire", 6, 10, '"'),
        {value: 'model:"fire"', caret: 11, anchor: 7});
    // Alone, the closer spawns with the caret between the halves.
    assert.deepEqual(pairDelimiter("model:", 6, 6, "{"), {value: "model:{}", caret: 7});
    // A closer against its own next character steps over it: the value is unchanged, only the caret moves.
    assert.deepEqual(pairDelimiter("model:{}", 7, 7, "}"), {value: "model:{}", caret: 8});
    // Backspace between two halves of an empty pair takes both.
    assert.deepEqual(pairDelimiter("model:{}", 7, 7, "Backspace"), {value: "model:", caret: 6});
    // Anything else pairs nothing.
    assert.equal(pairDelimiter("model:fire", 10, 10, "x"), null);
    assert.equal(pairDelimiter("model:fire", 10, 10, "Backspace"), null);
});

test("an unclosed phrase does not swallow the scope's own closing brace", () => {
    // `name:"` spawns its pair inside the chip's scope; deleting the closing quote leaves the phrase open, and
    // the brace after it is still the scope's. Read otherwise, the commit writes a second one — and every
    // reopen writes another.
    const plan = planAt('name:{"}', 7);
    assert.equal(plan.slot, '"');
    assert.equal(plan.suffix, "}");
    // The commit closes the phrase rather than writing a second brace, and the result is stable: running the
    // cycle twice was what caught the compounding, since one pass only added one brace.
    const once = commitSegment('name:{"}', 7).text;
    assert.equal(once, 'name:""');
    assert.equal(commitSegment(once, 7).text, once);
});

test("committing a chip closes a phrase the reader left open", () => {
    // A phrase runs to the end of the input, so an unclosed one swallows the separator the commit appends and
    // every term after it. The commit supplies the closer, which discards nothing that was typed.
    assert.equal(commitSegment('name:{"blood pool', 8).text, 'name:"blood pool"');
    assert.equal(commitSegment('name:{"}', 7).text, 'name:""');
});

test("a slash pairs where it opens a pattern, and is ordinary text everywhere else", () => {
    // In value position it is a delimiter like any other, so it spawns its own closer.
    assert.deepEqual(pairDelimiter("name:", 5, 5, "/"), {value: "name://", caret: 6});
    assert.deepEqual(pairDelimiter("model:{file:", 12, 12, "/"), {value: "model:{file://", caret: 13});
    // In free text it is a character a pasted path is made of, and pairing one would break typing that path.
    assert.equal(pairDelimiter("spells", 6, 6, "/"), null);
    assert.equal(pairDelimiter("model:fire", 10, 10, "/"), null);
});

test("an escaped delimiter is the character itself, so it pairs nothing", () => {
    // The user's rule: with a backslash before it, ONE delimiter is written, not two.
    assert.equal(pairDelimiter("name:/a\\", 8, 8, "/"), null);
    // The same holds for the phrase, which had the same defect: the escape is the language's, not the regex's.
    assert.equal(pairDelimiter('name:"foo\\', 10, 10, '"'), null);
    // And OUTSIDE a leaf too, since the escape shields the next character everywhere: a quote typed after a
    // backslash at a value's start is the literal character, opening nothing.
    assert.equal(pairDelimiter("name:\\", 6, 6, '"'), null);
    assert.equal(pairDelimiter("model:\\", 7, 7, "{"), null);
});

test("the step-over needs a real closer: a slash that is only text swallows nothing", () => {
    assert.deepEqual(pairDelimiter("name:/fire/", 10, 10, "/"), {value: "name:/fire/", caret: 11});
    // Here the slashes are ordinary characters, so the keystroke must insert rather than step over one.
    assert.equal(pairDelimiter("a/b", 1, 1, "/"), null);
});

test("the slot reads its position from the head cell, which holds characters the field does not", () => {
    // The field is empty and the head cell holds `name:` — a value position, so the slash is a delimiter.
    assert.deepEqual(pairDelimiter("", 0, 0, "/", "name:"), {value: "//", caret: 1});
    // A scoped head puts the slot inside the scope, where a term opens a value directly.
    assert.deepEqual(pairDelimiter("", 0, 0, "/", "model:{"), {value: "//", caret: 1});
    // With no head the segment is plain text, and a slash there is a character of a path.
    assert.equal(pairDelimiter("spells", 6, 6, "/", ""), null);
});
