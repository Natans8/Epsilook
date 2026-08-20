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
    for (const text of ["model:fire", 'name:"blood pool" -x', "model:{fire point:chest} 5"]) {
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

test("a clause's ENCLOSURES wear its tone; the universal alternation does not", () => {
    const text = "model:{fire|frost} sound:bell";
    const runs = paint(text);
    for (const brace of ["{", "}"]) {
        assert.equal(runs.find((run) => run.start === text.indexOf(brace))?.tone,
            "model", `the ${brace} wears the model tone`);
    }
    // `|` means the same thing wherever it stands, so it never takes a neighbourhood's colour.
    assert.equal(runs.find((run) => run.start === text.indexOf("|"))?.tone, undefined);
    // A delimiter no clause claims keeps the neutral colouring every structural character shares.
    assert.equal(paint("{").find((run) => run.start === 0)?.tone, undefined);
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
    assert.equal(runFor("model:{fire point:chest}", "chest").vocab, true);
    assert.equal(runFor("model:fire", "fire").vocab, undefined);
    assert.equal(runFor("model:{fire point:chest}", "fire").vocab, undefined);
});

test("a doorless clause paints no doors: a colon inside a value is content, not a property", () => {
    // `model:mount:horse` is one content ask — the parse gave the colon no meaning — so the highlight must not
    // claim the property reading: the known word demotes to plain text and its colon goes quiet with it.
    const runs = paint("model:mount:horse");
    const mount = runs.find((run) => run.start === "model:".length);
    assert.equal(mount?.kind, "word");
    assert.equal(mount?.door, undefined);
    assert.equal(mount?.tone, undefined);
    assert.equal(runs.find((run) => run.start === "model:mount".length)?.kind, "word");
    // An unknown word before a comparison inside a value is content too, and marks no door.
    assert.equal(runFor("model:foo<bar", "foo").door, undefined);
    // The same word inside a scope IS the property it looks like, and stays the door.
    assert.equal(runFor("model:{mount:horse}", "mount").door, true);
    // The words ABOUT the query keep their weight in a doorless clause: the wildcard and the any-word.
    assert.equal(runFor("model:*", "*").kind, "meta");
});

test("a foreign bind marks no door: only what the parse resolved paints as a property", () => {
    // `sound:` inside a model scope binds nothing — painting it loud in model's tone claimed a reading the
    // parse refused. It demotes to plain text; the resolved bind beside it keeps its door.
    const sound = runFor("model:{draenei sound:fire}", "sound");
    assert.equal(sound.kind, "word");
    assert.equal(sound.door, undefined);
    assert.equal(sound.tone, undefined);
    assert.equal(runFor("model:{draenei point:chest}", "point").door, true);
    // A kind word standing beside a bind is the vocabulary it names, marked as one.
    assert.equal(runFor("model:{attach file:wolf}", "attach").vocab, true);
    assert.equal(runFor("model:{attach file:wolf}", "file").door, true);
});

test("a property is marked as the door it is, in its column's tone; a head is not a property", () => {
    const runs = paint("sound:count>2 model:{point:chest}");
    const at = (word: string): Run | undefined =>
        runs.find((run) => run.start === "sound:count>2 model:{point:chest}".indexOf(word));
    // `count` and `point` open their own comparison and bind inside a clause, which is what a chip draws
    // loud; the head that opened the clause is already a head and stays one.
    assert.equal(at("count")?.door, true);
    assert.equal(at("count")?.tone, "sound");
    assert.equal(at("point")?.door, true);
    assert.equal(at("point")?.tone, "model");
    assert.equal(at("chest")?.door, undefined);
});

test("a door is a door whatever its value: the any-word does not demote it to a vocabulary word", () => {
    // `attach:chest` and `attach:*` open the same door — one names a point, the other takes any. Reading the
    // resolved ask alone painted the second as a VALUE, so the word changed colour on a keystroke that only
    // widened what it asked for.
    for (const text of ["model:{attach:chest}", "model:{attach:*}"]) {
        const run = runFor(text, "attach");
        assert.equal(run.door, true, text);
        assert.equal(run.tone, "model", text);
        assert.equal(run.vocab, undefined, text);
    }
    // Standing alone it is the kind word it looks like, and takes the vocabulary's own mark.
    assert.equal(runFor("model:{attach fire}", "attach").vocab, true);
    assert.equal(runFor("model:{attach fire}", "attach").door, undefined);
});

test("a door never wears the value's vocabulary mark: one word says one thing", () => {
    // The mark is blanketed over the term, so a term whose VALUE came from a closed vocabulary was marking
    // the property that opened it too — two underlines on one word, saying it was a value and a property at
    // once. The value keeps the mark; the door keeps its own.
    assert.equal(runFor("id:{xpac:legion}", "xpac").door, true);
    assert.equal(runFor("id:{xpac:legion}", "xpac").vocab, undefined);
    assert.equal(runFor("id:{xpac:legion}", "legion").vocab, true);
    assert.equal(runFor("model:{point:chest}", "point").vocab, undefined);
    assert.equal(runFor("model:{point:chest}", "chest").vocab, true);
});

test("a word reads one way through the keystrokes that build a clause around it", () => {
    // The reader types `attach`, then the colon, then the value. The word meant the same thing throughout and
    // was painted three ways: a gold vocabulary word, then nothing at all, then a toned door. The middle one
    // was the parse dropping the door it had already resolved — its own diagnostic names `attach:` — and the
    // outer two were a hue carrying a role the colon already carries.
    const attach = (text: string): Run => runFor(text, "attach");
    for (const text of ["model:{attach}", "model:{attach:}", "model:{attach:chest}"]) {
        assert.equal(attach(text).tone, "model", text);
    }
    // Standing as a value it keeps the vocabulary's dotted mark; opening a door it does not.
    assert.equal(attach("model:{attach}").vocab, true);
    assert.equal(attach("model:{attach:}").door, true);
    assert.equal(attach("model:{attach:chest}").door, true);
    assert.equal(attach("model:{attach:chest}").vocab, undefined);
});

test("an unfinished value does not un-door the word that opened it, and invents no doors", () => {
    // The clause level has always worked this way: `model:` keeps its column's colour and carries its state.
    assert.equal(runFor("model:", "model").tone, "model");
    assert.equal(runFor("model:", "model").state, "error");
    // A term now does too — the door is resolved, only its value is missing.
    assert.equal(runFor("model:{point:}", "point").door, true);
    assert.equal(runFor("model:{point:}", "point").tone, "model");
    // But only where the parse RESOLVED the word. A foreign bind and an unknown one stay plain: painting them
    // would claim a reading that does not exist, which is the whole reason the demotion is there.
    assert.equal(runFor("model:{draenei sound:}", "sound").door, undefined);
    assert.equal(runFor("model:{draenei sound:}", "sound").tone, undefined);
    assert.equal(runFor("model:{blerg:}", "blerg").door, undefined);
    assert.equal(runFor("model:{blerg:}", "blerg").tone, undefined);
});

test("a word of the LANGUAGE is toned in either role; a word of the DATA never is", () => {
    // A kind word is the language whether it answers or asks, so it keeps its column's tone as a value.
    assert.equal(runFor("model:missile", "missile").tone, "model");
    assert.equal(runFor("model:missile", "missile").vocab, true);
    // An attachment point and an expansion are DATA that happens to come from a closed set: marked, never
    // toned, so a tone in the raw text always means "this word is part of the query's structure".
    assert.equal(runFor("model:{point:chest}", "chest").tone, undefined);
    assert.equal(runFor("model:{point:chest}", "chest").vocab, true);
    assert.equal(runFor("id:{xpac:legion}", "legion").tone, undefined);
    assert.equal(runFor("id:{xpac:legion}", "legion").vocab, true);
});
