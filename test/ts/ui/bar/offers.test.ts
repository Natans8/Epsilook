/**
 * The control surface's contract: what each position may be offered, that every offer comes from a declaration
 * rather than from the data, and that taking one writes a query the language actually reads.
 *
 * The last of those is an oracle rather than an assertion list — every offer the surface can make, at every
 * position it can make it, is applied and handed to the parser. A word that reached the list without being
 * typeable would be caught by the engine itself, not by a fixture somebody remembered to update.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {flatOffers, NO_OFFERS, offerSlot, offersAt} from "../../../../src/ui/bar/offers";
import type {Offers} from "../../../../src/ui/bar/offers";
import {planAt, slotStart, writeSlot} from "../../../../src/ui/bar/plan";
import {parse} from "../../../../src/search/index";

/** The offers at one caret, addressed the way the bar addresses them: a text offset into the whole query. */
function at(text: string, caret: number, history: readonly string[] = []): Offers {
    const plan = planAt(text, caret);
    return offersAt(plan, caret - slotStart(plan), history);
}

/** The words one group holds, or an empty array where the group is absent. */
function words(offers: Offers, id: string): string[] {
    return offers.groups.find((group) => group.id === id)?.offers.map((offer) => offer.word) ?? [];
}

test("an empty bar offers the remembered searches, then every door", () => {
    const offers = at("", 0, ["model:fire", "scale:>50"]);
    assert.deepEqual(offers.groups.map((group) => group.id), ["history", "axes"]);
    assert.deepEqual(words(offers, "history"), ["model:fire", "scale:>50"]);
    // The whole menu, in the order a reader reaches for them rather than by spelling: this is the click-path
    // for every axis the language has, so what opens the list is what most searches start from.
    const doors = words(offers, "axes");
    assert.deepEqual(doors.slice(0, 5), ["name", "model", "sound", "anim", "fx"]);
    assert.ok(doors.includes("xpac") && doors.includes("cast"));
    // Nothing is typed, so nothing completes.
    assert.equal(offers.ghost, "");
});

test("an empty bar with nothing remembered still offers the axes", () => {
    assert.deepEqual(at("", 0).groups.map((group) => group.id), ["axes"]);
});

test("a top-level word offers nothing until its second character, then the doors it could open", () => {
    assert.deepEqual(at("m", 1).groups, []);
    const offers = at("mo", 2);
    assert.deepEqual(offers.groups.map((group) => group.id), ["axes"]);
    // What starts with the word comes first; what merely contains it follows.
    assert.deepEqual(words(offers, "axes").slice(0, 2), ["model", "morph"]);
    assert.ok(words(offers, "axes").includes("summon"));
    assert.equal(offers.groups[0].offers[0].insert, "model:");
});

test("a door reads by every spelling it has, and writes only its own", () => {
    // `animation` and `animations` both reach the anim door; the offer still spells it `anim`.
    const offers = at("animat", 6);
    assert.deepEqual(words(offers, "axes"), ["anim"]);
    assert.equal(offers.groups[0].offers[0].insert, "anim:");
});

test("a word typed whole still offers its own door — the bind is what it is still missing", () => {
    assert.deepEqual(words(at("model", 5), "axes").slice(0, 1), ["model"]);
});

test("a minus before the word negates what the offers would ask, and is not part of what they replace", () => {
    const offers = at("-mod", 4);
    assert.equal(offers.negated, true);
    assert.deepEqual(offers.stub, {start: 1, end: 4});
    assert.equal(offers.ghost, "el:");
    assert.equal(at("mod", 3).negated, false);
});

test("inside a column's scope: its kinds, its properties, and the count axis", () => {
    const offers = at("model:{}", 7);
    assert.deepEqual(offers.groups.map((group) => group.id), ["kinds", "props"]);
    assert.ok(words(offers, "kinds").includes("missile"));
    assert.ok(words(offers, "props").includes("motion"));
    assert.ok(words(offers, "props").includes("count"));
    // A kind word stands alone inside the scope; a property opens with its bind.
    const missile = offers.groups[0].offers.find((offer) => offer.word === "missile");
    assert.equal(missile?.insert, "missile");
    const motion = offers.groups[1].offers.find((offer) => offer.word === "motion");
    assert.equal(motion?.insert, "motion:");
});

test("inside a kind's scope: what its own word asks for, then that kind's properties", () => {
    const offers = at("missile:{}", 9);
    // The kind's word is the door to its subject, so the scope takes a value for it — and its other
    // properties are the same row said another way.
    assert.deepEqual(offers.groups.map((group) => group.id), ["words", "props"]);
    assert.deepEqual(words(offers, "props").toSorted((a, b) => a.localeCompare(b)),
        ["count", "file", "from", "motion", "projectiles", "target", "to"]);
});

test("a flag property is offered as the bare word it is written as", () => {
    const offers = at("spell:{}", 7);
    const flag = offers.groups.flatMap((group) => group.offers).find((offer) => offer.word === "unbreakable");
    assert.equal(flag?.insert, "unbreakable");
    assert.equal(flag?.shape, "word");
});

test("a property's value offers its sentinels and the any-word, never a corpus value", () => {
    const offers = at("cast:", 5);
    assert.deepEqual(offers.groups.map((group) => group.id), ["sentinels", "words"]);
    assert.deepEqual(words(offers, "sentinels"), ["instant"]);
    assert.deepEqual(words(offers, "words"), ["any"]);
    // A path property has no words of its own, so nothing but the any-word is on offer.
    assert.deepEqual(words(at("missile:{file:}", 14), "sentinels"), []);
});

test("a target mask offers the roles it is written with", () => {
    const offers = at("missile:{target:}", 16);
    assert.deepEqual(words(offers, "roles"), ["area", "both", "caster", "others", "target"]);
});

test("past an inner bind the property answers, not the scope it sits in", () => {
    // Before the bind the caret is still choosing a property, so the property's own door is what stands; past
    // the bind it is composing that property's value.
    assert.deepEqual(words(at("spell:{cast}", 11), "props"), ["cast"]);
    assert.deepEqual(words(at("spell:{cast:}", 12), "sentinels"), ["instant"]);
});

test("the offers narrow to the word under the caret, not to the whole slot", () => {
    // Two terms in one scope: the second is what is being typed.
    const offers = at("model:{missile mo}", 17);
    assert.deepEqual(words(offers, "props"), ["motion"]);
    assert.deepEqual(offers.stub, {start: 8, end: 10});
});

test("the ghost completes only at the slot's end, and only what starts with what was typed", () => {
    assert.equal(at("mo", 2).ghost, "del:");
    // Mid-slot the mirror would have to shift the text under the caret, so nothing is drawn.
    assert.equal(at("mo del", 2).ghost, "");
    // A word reached by containment completes nothing: the letters typed are not its first ones.
    assert.equal(at("odel", 4).ghost, "");
});

test("a bar at rest offers nothing at all", () => {
    assert.deepEqual(NO_OFFERS.groups, []);
    assert.equal(flatOffers(NO_OFFERS).length, 0);
});

test("every offer, taken, writes a query the parser reads without an error", () => {
    // One caret per position the surface can be opened at, covering every branch of the taxonomy.
    const positions: [string, number][] = [
        ["", 0], ["mo", 2], ["-mo", 3], ["model:{}", 7], ["missile:{}", 9], ["spell:{}", 7],
        ["cast:", 5], ["missile:{target:}", 16], ["spell:{cast:}", 12], ["model:{missile }", 15],
        ["fire model:{}", 12], ["model:{} scale:5", 7],
    ];
    let seen = 0;
    for (const [text, caret] of positions) {
        const plan = planAt(text, caret);
        const offers = offersAt(plan, caret - slotStart(plan), ["model:fire"]);
        for (const offer of flatOffers(offers)) {
            seen += 1;
            if (offer.shape === "query") {
                // A remembered search is written back whole, so it is its own query and nothing composes it.
                assert.equal(parse(offer.insert).diagnostics.filter((d) => d.severity === "error").length, 0);
                continue;
            }
            const {value} = offerSlot(plan, offers, offer);
            // A door leaves the value to be typed, which is not yet an ask: the wildcard stands in for the value
            // the reader will write, so what is under test is the WORD rather than their next keystroke.
            const written = writeSlot(plan, offer.shape === "door" ? `${value}*` : value);
            const errors = parse(written).diagnostics.filter((d) => d.severity === "error");
            assert.deepEqual(errors.map((d) => d.message), [], `${offer.word} wrote ${written}`);
        }
    }
    // A guard on the guard: an offer model that quietly stopped offering anything would pass every line above.
    assert.ok(seen > 60, `only ${String(seen)} offers were tested`);
});

test("a caret dropped into the middle of a word offers nothing — it is fixing, not composing", () => {
    // `fi|re` would otherwise complete `file` and eat the `re` past the caret.
    assert.deepEqual(at("model:{fire}", 9).groups, []);
    // At the word's own end the same caret is composing, and the offers stand.
    assert.ok(at("model:{fi}", 9).groups.length > 0);
});

test("a value position says what it takes — the property, then how a value is written", () => {
    const takes = at("cast:", 5).takes;
    assert.equal(takes?.title, "cast");
    // Two declarations, two lines: the property says what it is, the type says how to spell one.
    assert.match(takes?.what ?? "", /cast bar/);
    assert.match(takes?.how ?? "", /seconds/);
    // A scope is not composing a value, so it says nothing.
    assert.equal(at("model:{}", 7).takes, null);
});

test("a bare number is ghosted with the unit its axis writes", () => {
    assert.equal(at("scale:15", 8).ghost, "%");
    // The unit only completes a number, and only at the value's end.
    assert.equal(at("scale:x", 7).ghost, "");
});

test("a bind on a word the scope has no property for says so, and offers the ones it has", () => {
    const offers = at("model:{blerg:}", 13);
    assert.equal(offers.takes?.title, "blerg");
    assert.match(offers.takes?.what ?? "", /blerg/);
    assert.ok(words(offers, "props").includes("motion"));
});

test("a property only some of a column's kinds declare names them", () => {
    const offers = at("model:{}", 7);
    const motion = offers.groups.flatMap((group) => group.offers).find((offer) => offer.word === "motion");
    assert.equal(motion?.owner, "missile");
    // A property every kind of the column has needs no owner: it IS the column's.
    const target = offers.groups.flatMap((group) => group.offers).find((offer) => offer.word === "target");
    assert.equal(target?.owner, undefined);
});
