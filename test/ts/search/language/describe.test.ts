/**
 * The chip display model's contract: which clause becomes a chip, a lane, or stays text; how each value class
 * displays; and that every rule of the chip language — meaning over minimal spelling, notation-explicit numbers,
 * list against gate, the `{x} ≡ x` compact rule — reads straight off the parse.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type {ChipView, ClauseView, LaneView} from "../../../../src/search/language/describe";
import {describe} from "../../../../src/search/language/describe";
import {parse} from "../../../../src/search/language/parse";
import type {Rung} from "../../../../src/search/vocabulary/value-types";
import {setOrdinalLadder} from "../../../../src/search/vocabulary/value-types";

/**
 * Runs a body against a loaded expansion ladder, and puts the empty one back whatever happens.
 *
 * @param rungs The ladder to load.
 * @param body What to run against it.
 */
function withLadder(rungs: Rung[], body: () => void): void {
    setOrdinalLadder(rungs);
    try {
        body();
    } finally {
        setOrdinalLadder([]);
    }
}

/** The views of one query's final-text parse. */
const views = (query: string): ClauseView[] => describe(parse(query));

/** The single clause's view, asserting there is exactly one. */
function view(query: string): ClauseView {
    const all = views(query);
    assert.equal(all.length, 1, `expected one clause in "${query}"`);
    return all[0];
}

/** The single clause's chip, asserting the form. */
function chip(query: string): ChipView {
    const v = view(query);
    assert.equal(v.form, "chip", `expected a chip for "${query}"`);
    return (v as ClauseView & { form: "chip" }).chip;
}

/** The single clause's lane, asserting the form. */
function lane(query: string): LaneView {
    const v = view(query);
    assert.equal(v.form, "lane", `expected a lane for "${query}"`);
    return (v as ClauseView & { form: "lane" }).lane;
}

test("a named value draws the name, whichever way in the reader wrote", () => {
    // `6` is a declared synonym of the rung, so it matches — and drawing it back would put a numeral on a worded
    // axis, which the quote law then has to quote. Naming the rung is what removes the quote rather than
    // excusing it. The ladder is the fixture world's, whose rungs answer only to themselves.
    withLadder([{word: "WoD", reads: ["wod", "warlords", "6"]}], () => {
        for (const query of ["xpac:6", "xpac:warlords", "xpac:wod", "xpac:WoD"]) {
            const pieces = chip(query).body;
            assert.deepEqual(pieces, [{is: "word", text: "WoD"}], query);
        }
    });
});

test("a freeform term stays text, negated or not — never a chip", () => {
    assert.equal(view("fireball").form, "text");
    assert.equal(view("-fireball").form, "text");
    assert.equal(view("any").form, "text");
});

test("an invalid clause never chipifies: it is the error form, its message carried", () => {
    const v = view("model:");
    assert.equal(v.form, "error");
    assert.equal(v.notes.length, 1);
    assert.equal(view("scale:abc").form, "error");
});

test("a content bind is a compact chip: head, column tone, plain value", () => {
    assert.deepEqual(chip("model:fire"), {
        head: "model", tone: "model", not: false,
        body: [{is: "value", text: "fire"}], grow: "term",
    });
});

test("a kind word displays as vocabulary, and the bind fuses negation into the head", () => {
    assert.deepEqual(chip("model:missile").body, [{is: "word", text: "missile"}]);
    assert.equal(chip("-model:missile").not, true);
});

test("existence displays the any-word, from the star and from the word alike", () => {
    assert.deepEqual(chip("model:*").body, [{is: "meta", text: "any"}]);
    assert.deepEqual(chip("model:any").body, [{is: "meta", text: "any"}]);
    assert.deepEqual(chip("model:{}").body, [{is: "meta", text: "any"}]);
});

test("the chip displays the meaning, not the minimal spelling: an elided count surfaces as its word", () => {
    const c = chip("model>=4");
    // The bound property is a CELL of its own — `model | count | ≥ 4` — rather than a loud word leading the
    // body, which read as two things standing side by side rather than one saying what the other is.
    assert.equal(c.sub, "count");
    assert.deepEqual(c.body, [{is: "op", text: "≥"}, {is: "value", text: "4"}]);
    // The desugar's note rides along for the tooltip.
    assert.equal(view("model>=4").notes.length, 1);
});

test("a bare number never displays bare: the notation that read it is made explicit, in its own family", () => {
    assert.deepEqual(chip("scale:5").body, [{is: "value", text: "×5"}]);
    assert.deepEqual(chip("scale:150").body, [{is: "value", text: "150%"}]);
    assert.deepEqual(chip("scale:+50").body, [{is: "value", text: "+50%"}]);
    assert.deepEqual(chip("scale:x1.5").body, [{is: "value", text: "×1.5"}]);
    assert.deepEqual(chip("scale:>50").body, [{is: "op", text: ">"}, {is: "value", text: "50%"}]);
});

test("a range displays the unit on both bounds, glued by the en dash", () => {
    assert.deepEqual(chip("cast:2-5s").body, [{is: "value", text: "2s–5s"}]);
});

test("a sentinel word is an answer, not structure: value-styled, no anchor glyph", () => {
    assert.deepEqual(chip("cast:instant").body, [{is: "value", text: "instant"}]);
    assert.deepEqual(chip("cast:=instant").body, [{is: "value", text: "instant"}]);
});

test("a phrase wears its quotes: the piece marks it so the renderer draws them as delimiters", () => {
    assert.deepEqual(chip('name:"blood pool"').body, [{is: "phrase", text: "blood pool"}]);
    // A word that needs no quotes never gains them, however it was typed.
    assert.deepEqual(chip('name:"fire"').body, [{is: "value", text: "fire"}]);
});

test("an identity list joins with commas, identical whatever separator was typed", () => {
    const expected = [{is: "value", text: "133, 11839, 25306"}];
    assert.deepEqual(chip("id:133|11839|25306").body, expected);
    assert.deepEqual(chip("id:133,11839,25306").body, expected);
    assert.equal(chip("id:133,11839,25306").grow, "alternative");
});

test("a logical gate over words keeps its or-connective, each phrase wearing its own quotes", () => {
    const c = chip("model:{attach:chest|head}");
    assert.equal(c.sub, "attach");
    assert.deepEqual(c.body, [{is: "word", text: "chest"}, {is: "or"}, {is: "word", text: "head"}]);
});

test("a bound property is a cell, and a chip with no bound property carries none", () => {
    // `model:fire` binds nothing — the value is content over the column — so the key is ABSENT rather than
    // present and empty, which is what a whole-view comparison reads.
    assert.equal("sub" in chip("model:fire"), false);
    assert.equal(chip("model:{attach:chest}").sub, "attach");
});

test("one condition is a compact chip whatever its spelling — the braced form converges", () => {
    assert.deepEqual(chip("model:{fire}"), chip("model:fire"));
});

test("two conditions sharing a row are the lane, terms as text in written order", () => {
    const l = lane("model:{fire -missile}");
    assert.equal(l.head, "model");
    assert.deepEqual(l.items, [
        {is: "term", not: false, body: [{is: "value", text: "fire"}], span: {start: 7, end: 11}, lone: false},
        {is: "term", not: true, body: [{is: "word", text: "missile"}], span: {start: 12, end: 20}, lone: false},
    ]);
});

test("a lane's runs join on the or item, from the symbol and from the word alike", () => {
    const shape = (l: LaneView): string[] => l.items.map((item) => item.is);
    assert.deepEqual(shape(lane("model:{fire ball | frost}")), ["term", "term", "or", "term"]);
    assert.deepEqual(shape(lane("model:{fire ball or frost}")), ["term", "term", "or", "term"]);
});

test("an inner bind is a chip of its own inside the lane; a grown count binds under its word", () => {
    const l = lane("model:{fire attach:chest}");
    assert.deepEqual(l.items[1], {
        is: "bind", not: false, head: "attach",
        body: [{is: "word", text: "chest"}], span: {start: 12, end: 24}, lone: false,
    });
    assert.deepEqual(lane("model:{fire count>=4}").items[1], {
        is: "bind", not: false, head: "count",
        body: [{is: "op", text: "≥"}, {is: "value", text: "4"}], span: {start: 12, end: 20}, lone: false,
    });
});

test("a colour value displays a swatch beside the written word", () => {
    const l = lane("fx:{glow colour:red}");
    assert.deepEqual(l.items[1], {
        is: "bind", not: false, head: "colour",
        body: [{is: "swatch", colour: "#ff0000"}, {is: "word", text: "red"}], span: {start: 9, end: 19},
        lone: false,
    });
});

test("a dead term stays a raw fragment inside a healthy scope, the clause warned", () => {
    const v = view("model:{fire attach:}");
    assert.equal(v.form, "lane");
    const l = (v as ClauseView & { form: "lane" }).lane;
    assert.deepEqual(l.items[1], {is: "dead", span: {start: 12, end: 19}});
    assert.equal((v as ClauseView & { form: "lane" }).warned, true);
});

test("a pattern displays as written — the glob's star and the regex's slashes are its spelling", () => {
    assert.deepEqual(chip("model:fi*e").body, [{is: "value", text: "fi*e"}]);
    // A pattern is its own piece carrying the pattern alone: the slashes are the renderer's, exactly as a
    // phrase's quotes are, because the surface colours what is between them by regex's own grammar.
    assert.deepEqual(chip("name:/^fire/").body, [{is: "regex", pattern: "^fire"}]);
});

test("the anchor displays its glyph before the value", () => {
    assert.deepEqual(chip("name:=fireball").body, [{is: "op", text: "="}, {is: "value", text: "fireball"}]);
});

test("a property door chips under its own word; growth appends an alternative there", () => {
    const c = chip("cast:2s");
    assert.equal(c.head, "cast");
    assert.equal(c.tone, "spell");
    assert.equal(c.grow, "alternative");
});

test("a parse of several clauses yields one view per clause, in written order", () => {
    const all = views("model:fire frost");
    assert.equal(all.length, 2);
    assert.equal(all[0].form, "chip");
    assert.equal(all[1].form, "text");
});

test("a lane item knows whether it stands alone in its run — the per-term delete rule reads it", () => {
    // One run of two: neither term is alone, so removing one leaves the other beside it.
    const conjunction = lane("model:{fire -missile}");
    assert.deepEqual(conjunction.items.map((item) => "lone" in item && item.lone), [false, false]);

    // Two runs of one: each term is alone, so removing one takes the stranded alternation edge with it.
    const alternation = lane("model:{fire | frost}");
    assert.deepEqual(alternation.items.map((item) => "lone" in item && item.lone), [true, false, true]);
});

test("a value's own sign draws as the true minus, so it is not read as the range separator", () => {
    assert.deepEqual(chip("scale:-50%").body, [{is: "value", text: "−50%"}]);
    assert.deepEqual(chip("scale:{-50%--10%}").body, [{is: "value", text: "−50%–−10%"}]);
});
