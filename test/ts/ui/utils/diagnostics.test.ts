/**
 * The strip's model: rows read the parse and nothing else, the offending text is cut by the clause's own span, and
 * the order is the written order with an error outranking a warning on the same clause.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {parse} from "../../../../src/search/index";
import {changedSpan, mergeEditing, stripRows} from "../../../../src/ui/utils/diagnostics";

test("a query the reader accepts draws no rows", () => {
    assert.deepEqual(stripRows(parse("model:fire sound:bell", {mode: "final"}), "model:fire sound:bell"), []);
});

test("a refused clause is an error row carrying the clause verbatim, and removal is always its last offer", () => {
    const text = "model:fire model:{-attach>2}";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, "error");
    assert.equal(rows[0].verbatim, "model:{-attach>2}");
    // The reader's own offer first, the comparison turned round; then the value cleared; then the clause taken
    // out whole.
    assert.deepEqual(rows[0].fixes.map((fix) => fix.query),
        ["model:fire model:{attach<=2}", "model:fire model:", "model:fire"]);
});

test("a note offers nothing: it reports a reading rather than a flaw", () => {
    const text = "model:{attach>2}";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].severity, "note");
    assert.deepEqual(rows[0].fixes, []);
});

test("a warning with a fix carries the whole-query rewrite the fix would apply", () => {
    const text = "model:{fire}sound:bell";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    const warned = rows.find((r) => r.severity === "warning" && r.fixes.length > 0);
    assert.ok(warned !== undefined, "the missing space after a scope's close warns with a fix");
    // The reader's own fix, then removal of the warned clause alone.
    assert.deepEqual(warned.fixes.map((fix) => fix.query), ["model:{fire} sound:bell", "sound:bell"]);
});

test("rows come in written order, whatever order the reader raised them in", () => {
    const text = "model:{-attach>1} sound:bell model:{-attach>2}";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    assert.deepEqual(rows.map((r) => r.verbatim), ["model:{-attach>1}", "model:{-attach>2}"]);
});

test("the changed span of a rewrite is what lies between the common prefix and suffix, in the rewrite", () => {
    assert.deepEqual(changedSpan("model:{fire}sound:bell", "model:{fire} sound:bell"), {start: 12, end: 13});
    assert.deepEqual(changedSpan("a model:{x y} b", "a model:x model:y b"), {start: 8, end: 17});
    // A pure removal leaves nothing to mark.
    assert.equal(changedSpan("model:fire sort:zzz", "model:fire"), null);
    assert.equal(changedSpan("same", "same"), null);
});

test("a finding about a regular expression says so, and every other row names no sublanguage", () => {
    const text = "model:fire model:/fir";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].about, "regex");
    const plain = stripRows(parse("model:{-attach>2}", {mode: "final"}), "model:{-attach>2}");
    assert.equal(plain[0].about, null);
});

test("a finding about the value alone offers to clear it and keep the field, before removal", () => {
    const text = "model:fire scale:x2+50%";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    assert.deepEqual(rows[0].fixes.map((fix) => [fix.label, fix.query]),
        [["clear the value", "model:fire scale:"], ["remove", "model:fire"]]);
    // A structural fault has no value to keep: removal alone closes its offers.
    const shape = stripRows(parse("model:fire sort:zzz", {mode: "final"}), "model:fire sort:zzz");
    assert.deepEqual(shape[0].fixes.map((fix) => fix.label), ["remove"]);
});

test("the clear offer lands the caret right after the bind, in the emptied slot", () => {
    const text = "model:fire scale:x2+50%";
    const rows = stripRows(parse(text, {mode: "final"}), text);
    const clear = rows[0].fixes.find((fix) => fix.label === "clear the value");
    assert.equal(clear?.caret, "model:fire scale:".length);
});

test("a stretch being edited is read in typing mode, where an unfinished value is silent", () => {
    const text = "model:fire scale: sort:zzz";
    const settled = stripRows(parse(text, {mode: "final"}), text);
    const typing = stripRows(parse(text, {mode: "typing"}), text);
    assert.deepEqual(settled.map((r) => r.verbatim), ["scale:", "sort:zzz"]);
    // The open slot is quiet; the settled fault elsewhere still stands.
    const editing = {start: 11, end: 17};
    assert.deepEqual(mergeEditing(settled, typing, editing).map((r) => r.verbatim), ["sort:zzz"]);
    // Nothing being edited: the final reading, untouched.
    assert.deepEqual(mergeEditing(settled, typing, null), settled);
});
