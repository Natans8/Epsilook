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

import {flatOffers, NO_OFFERS, offerGhost, offerSlot, offersAt} from "../../../../src/ui/bar/utils/offers";
import type {Offer, Offers, Vocabulary} from "../../../../src/ui/bar/utils/offers";
import {planAt, slotStart, writeSlot} from "../../../../src/ui/bar/utils/plan";
import type {Rung} from "../../../../src/search/index";
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

test("a kind STANDING in the scope narrows the offers to its own: only what can still match", () => {
    // With `attach` said, the row's kind is settled: the panel becomes attach's children — its properties —
    // and never a sibling kind, whose conjunction could only ever answer nothing.
    const query = "model:{attach }";
    const offers = at(query, query.indexOf("}"));
    const doors = words(offers, "doors");
    assert.ok(doors.includes("point"), "the standing kind's own point property is offered");
    assert.ok(!doors.includes("file"), "its SUBJECT is reached by the kind's own word, not offered again");
    assert.ok(!doors.includes("missile"), "a sibling kind is not");
    assert.ok(!doors.includes("motion"), "nor a property only a sibling declares");
    assert.ok(!doors.includes("attach"), "nor the standing kind again");
    // A NEGATED kind refines rather than sorts, so it narrows nothing.
    const refined = "model:{-attach }";
    assert.ok(words(at(refined, refined.indexOf("}")), "doors").includes("missile"));
});

test("two positive kinds on one row warn: a row is one kind, the scope can match nothing", () => {
    const warned = parse("model:{attach missile}");
    assert.ok(warned.diagnostics.some((d) => d.severity === "warning"
        && d.message.includes("one kind")), "the empty meet is said, never silent");
    // The scope still parses and runs; and a negated kind collides with nothing.
    assert.equal(warned.clauses[0].state, "ok");
    assert.ok(!parse("model:{attach -missile}").diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("one kind")));
});

test("a top-level word offers the doors it could open, from its first character", () => {
    assert.ok(words(at("m", 1), "axes").includes("model"));
    const offers = at("mo", 2);
    assert.deepEqual(offers.groups.map((group) => group.id), ["axes"]);
    // What starts with the word comes first; what merely contains it follows.
    assert.deepEqual(words(offers, "axes").slice(0, 2), ["model", "morph"]);
    assert.ok(words(offers, "axes").includes("summon"));
    assert.equal(offers.groups[0].offers[0].insert, "model:");
});

test("a top-level bind whose word opens no door says so, with the real doors unnarrowed", () => {
    const offers = at("point:chest", 11);
    assert.equal(offers.takes?.what.includes("point"), true);
    // The doors that DO exist are the answer; the unknown word narrows nothing.
    assert.ok(words(offers, "axes").includes("model"));
    // The known-door and escaped spellings stay out of it.
    assert.equal(at("model:fire", 10).takes?.what.includes("opens no door") ?? false, false);
    assert.equal(at(String.raw`\point:chest`, 12).takes, null);
});

test("inside the sort scope the doors offer bare — no colon — and the directives stay out", () => {
    const offers = at("sort:{na}", 8);
    const doors = words(offers, "doors");
    assert.ok(doors.includes("name"), doors.join(" "));
    for (const group of offers.groups) {
        for (const offer of group.offers) assert.ok(!offer.insert.includes(":"), offer.insert);
    }
    const all = words(at("sort:{}", 6), "doors");
    assert.ok(!all.includes("sort") && !all.includes("first"));
});

test("an unscoped bound head takes its doors WITH the scope, the caret landing before the closer", () => {
    // The plain view's standing state: no gesture spawns the braces, so gluing `kit:` to `sound:` would spell
    // a second colon nothing reads. The offer writes the legal spelling itself.
    const offers = at("sound:k", 7);
    const kit = offers.groups.flatMap((group) => group.offers).find((offer) => offer.word === "kit");
    assert.ok(kit !== undefined);
    assert.equal(kit.insert, "{kit:}");
    const applied = offerSlot(planAt("sound:k", 7), offers, kit);
    assert.equal(applied.value, "{kit:}");
    assert.equal(applied.caret, 5);
});

test("a caret outside the slot — past a scope's closer in the plain view — is handed nothing", () => {
    const plan = planAt("scale:{50|60}", 13);
    assert.deepEqual(offersAt(plan, 13 - slotStart(plan), []), NO_OFFERS);
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

test("inside a column's scope, every door stands in one section: its kinds and its properties alike", () => {
    const offers = at("model:{}", 7);
    assert.deepEqual(offers.groups.map((group) => group.id), ["doors"]);
    assert.ok(words(offers, "doors").includes("missile"));
    assert.ok(words(offers, "doors").includes("count"));
    // A property most of the column's kinds declare stands here; one a single kind declares is that kind's,
    // and is reached by opening it.
    assert.ok(words(offers, "doors").includes("target"));
    assert.ok(!words(offers, "doors").includes("motion"));
    assert.ok(words(at("missile:{}", 9), "doors").includes("motion"));
    // A kind's word completes in INCREMENTS: the bare word first — a complete ask — and its bind only once
    // the word already stands typed whole. A property's door always carries the bind: it needs the value.
    const missile = offers.groups[0].offers.find((offer) => offer.word === "missile");
    assert.equal(missile?.insert, "missile");
    const whole = at("model:{missile}", 14).groups[0].offers.find((offer) => offer.word === "missile");
    assert.equal(whole?.insert, "missile:");
    const target = offers.groups[0].offers.find((offer) => offer.word === "target");
    assert.equal(target?.insert, "target:");
});

test("inside a kind's scope: what its own word asks for, then that kind's properties", () => {
    const offers = at("missile:{}", 9);
    // The kind's word is the door to its subject, so the scope takes a value for it — and its other
    // properties are the same row said another way.
    assert.deepEqual(offers.groups.map((group) => group.id), ["words", "doors"]);
    // `file` is missing on purpose: the kind's own word asks for it and plain search reads it, so a row would
    // only offer `missile:{file:...}` — the head said the same thing.
    assert.deepEqual(words(offers, "doors").toSorted((a, b) => a.localeCompare(b)),
        ["count", "from", "motion", "projectiles", "target", "to"]);
});

test("a kind with no properties is offered as the bare word it is, never as a door", () => {
    // `pose` holds nothing a bind could name: offering `pose:` taught a door the language cannot open — the
    // scope then complained there was no pose property, and taking any other offer replaced the word whole.
    const offers = at("anim:{}", 6);
    assert.ok(words(offers, "words").includes("pose"));
    assert.ok(!words(offers, "doors").includes("pose"));
    const row = offers.groups.flatMap((group) => group.offers).find((offer) => offer.word === "pose");
    assert.equal(row?.insert, "pose");
    assert.equal(row?.shape, "word");
});

test("the words that complete a condition stand together, whatever declaration each came from", () => {
    // A sentinel, a flag and the any-word are one thing to the reader — a word that finishes the ask where it
    // stands — so they share a section, ordered from the most specific claim to the least. The doors that take
    // a value of their own follow, and `count` is missing because a spell has at most one range row.
    const offers = at("range:{}", 7);
    assert.deepEqual(offers.groups.map((group) => group.id), ["words", "doors"]);
    assert.deepEqual(words(offers, "words"), ["self", "unlimited", "melee", "weapon", "any"]);
    assert.deepEqual(words(offers, "doors"), ["min"]);
});

test("a flag property is offered as the bare word it is written as, standing with the values", () => {
    const offers = at("spell:{}", 7);
    // The delivery kind has no word to open, so the column's head is the only door to its properties — and a
    // flag completes a condition where it stands, so it is offered as a value rather than as a door.
    const flag = words(offers, "words");
    assert.ok(flag.includes("unbreakable"));
    const row = offers.groups.flatMap((group) => group.offers).find((offer) => offer.word === "unbreakable");
    assert.equal(row?.insert, "unbreakable");
    assert.equal(row?.shape, "word");
});

test("a property's value offers its sentinels and the any-word, never a corpus value", () => {
    const offers = at("cast:", 5);
    assert.deepEqual(offers.groups.map((group) => group.id), ["words"]);
    assert.deepEqual(words(offers, "words"), ["instant", "any"]);
    // A path property has no words of its own, so nothing but the any-word is on offer.
    assert.deepEqual(words(at("missile:{file:}", 14), "words"), ["any"]);
});

test("a target mask offers the roles it is written with", () => {
    const offers = at("missile:{target:}", 16);
    assert.deepEqual(words(offers, "words").slice(0, 5), ["area", "both", "caster", "others", "target"]);
});

test("past an inner bind the property answers, not the scope it sits in", () => {
    // Before the bind the caret is still choosing a property, so the property's own door is what stands; past
    // the bind it is composing that property's value.
    assert.deepEqual(words(at("spell:{cast}", 11), "doors"), ["cast"]);
    assert.deepEqual(words(at("spell:{cast:}", 12), "words").slice(0, 1), ["instant"]);
    // A KIND's word binds too, and what it takes is its own first property — not silence. It resolves in the
    // parser's own order: inside the spell column `name:` is the name KIND, not the icon's name property.
    assert.equal(at("spell:{name:}", 12).takes?.title, "name");
    assert.match(at("spell:{name:}", 12).takes?.how ?? "", /matched anywhere/);
});

test("the offers narrow to the word under the caret, not to the whole slot", () => {
    // Two terms in one scope: the second is what is being typed.
    // The standing missile narrows the doors to its own, so "mo" completes to motion — never to the
    // sibling mount, whose conjunction with a standing missile could only answer nothing.
    const offers = at("model:{missile mo}", 17);
    assert.deepEqual(words(offers, "doors"), ["motion"]);
    assert.deepEqual(offers.stub, {start: 8, end: 10});
});

test("the ghost completes only at the slot's end, and only what starts with what was typed", () => {
    assert.equal(at("mo", 2).ghost, "del:");
    // Mid-slot the mirror would have to shift the text under the caret, so nothing is drawn.
    assert.equal(at("mo del", 2).ghost, "");
    // A word reached by containment completes nothing: the letters typed are not its first ones.
    assert.equal(at("odel", 4).ghost, "");
});

test("a lit offer previews as the slot's ghost — the remainder it would append, or nothing", () => {
    const offers = at("mo", 2);
    const flat = flatOffers(offers);
    // Steering to a row ghosts what taking it would write past the caret.
    assert.equal(offerGhost(offers, flat.find((offer) => offer.word === "morph")), "rph:");
    // An offer reached by containment does not extend what is typed, so it previews nothing.
    assert.equal(offerGhost(offers, flat.find((offer) => offer.word === "summon")), "");
    // On the empty bar nothing is typed, so a door previews whole — and a remembered query previews whole too,
    // since it is only ever offered there, where replacing the bar and appending to it are the same thing.
    const empty = at("", 0, ["model:fire"]);
    const rows = flatOffers(empty);
    assert.equal(offerGhost(empty, rows.find((offer) => offer.word === "model")), "model:");
    assert.equal(offerGhost(empty, rows.find((offer) => offer.shape === "query")), "model:fire");
    // Away from the slot's end a ghost cannot be appended, so nothing previews there either.
    const mid = at("mo del", 2);
    assert.equal(offerGhost(mid, flatOffers(mid)[0]), "");
});

test("a bar at rest offers nothing at all", () => {
    assert.deepEqual(NO_OFFERS.groups, []);
    assert.equal(flatOffers(NO_OFFERS).length, 0);
});

test("a role is taken with the glue behind it, and the same list is offered again", () => {
    // The multiple choice is the whole reason the roles are a vocabulary a row holds several of, so taking one
    // leaves the run open: the glue is written behind the word, the caret lands where the next value goes, and
    // the panel that reopens is the same panel because the offers are read from the POSITION rather than held.
    const text = "missile:{target:}";
    const caret = 16;
    const plan = planAt(text, caret);
    const offers = offersAt(plan, caret - slotStart(plan), []);
    const role = flatOffers(offers).find((offer) => offer.word === "caster");
    assert.ok(role !== undefined, "the roles are offered where a target takes its value");
    assert.equal(role.chains, true);

    const {value, caret: within} = offerSlot(plan, offers, role);
    assert.equal(value, "target:caster,");

    // The dangling glue separates nothing, so what stands is a whole query rather than a broken one.
    const written = "missile:{" + value + "}";
    assert.deepEqual(parse(written).diagnostics.filter((d) => d.severity === "error"), []);

    // And the position the caret lands on offers the roles again, which is what makes it a chain.
    const next = planAt(written, slotStart(plan) + within);
    const again = offersAt(next, slotStart(plan) + within - slotStart(next), []);
    assert.deepEqual(
        flatOffers(again).filter((offer) => offer.chains === true).map((offer) => offer.word).toSorted(),
        ["area", "both", "caster", "others", "target"]);
});

test("a value chains only where a second one could say something", () => {
    // The arity question, which the vocabulary being CLOSED does not answer. An expansion's kind holds one row
    // per spell, so two of them read as alternatives and a list is meaningful. An attach point's kind REPEATS
    // and each row carries one point, so two of them describe one row and no row is two things --
    // `model:{point:chest,head}` is nothing at all, and a list that answers nothing is worse than no list.
    const offerFor = (text: string, caret: number, vocab: Vocabulary, word: string): Offer | undefined => {
        const plan = planAt(text, caret);
        return flatOffers(offersAt(plan, caret - slotStart(plan), [], vocab))
            .find((offer) => offer.word === word);
    };

    const expansion = offerFor("xpac:", 5, {rungs: LADDER}, "TBC");
    assert.equal(expansion?.chains, true, "an expansion's kind holds one row, so a second reads as an alternative");

    const motion = offerFor("missile:{motion:}", 16, {rungs: [], enums: {"missile.motion": ["Parabola"]}},
        "Parabola");
    assert.ok(motion !== undefined, "the motions are offered where a motion takes its value");
    assert.notEqual(motion.chains, true, "two motions describe one missile, and no missile is two motions");
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
            // the reader will write, so what is under test is the WORD rather than their next keystroke. The
            // directive doors take a door word or a count instead of a value, so their stand-ins differ.
            const filler = offer.word === "sort" ? "id" : offer.word === "first" ? "5" : "*";
            const written = writeSlot(plan, offer.shape === "door" ? `${value}${filler}` : value);
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
    assert.match(takes?.what ?? "", /cast time/);
    assert.match(takes?.how ?? "", /seconds/);
    // A scope is not composing a value, so it says nothing.
    assert.equal(at("model:{}", 7).takes, null);
});

test("a number is ghosted with the unit its axis writes, and a half-typed unit with the rest of itself", () => {
    assert.equal(at("scale:15", 8).ghost, "%");
    assert.equal(at("cast:15m", 8).ghost, "s");
    // A range writes one notation, so the second bound takes the one the first bound set.
    assert.equal(at("cast:2ms-5", 10).ghost, "ms");
    assert.equal(at("cast:2s-5", 9).ghost, "s");
    // The unit only completes a number, and only at the value's end.
    assert.equal(at("scale:x", 7).ghost, "");
});

test("a bind on a word the scope has no property for says so, and offers the ones it has", () => {
    const offers = at("model:{blerg:}", 13);
    assert.equal(offers.takes?.title, "blerg");
    assert.match(offers.takes?.what ?? "", /blerg/);
    assert.ok(words(offers, "doors").includes("target"));
});

test("a property not every kind of the column declares names the ones that do", () => {
    const rows = at("model:{}", 7).groups.flatMap((group) => group.offers);
    // Eight of the column's nine kinds play on a target; the ninth is named rather than assumed away.
    assert.match(rows.find((offer) => offer.word === "target")?.owner ?? "", /missile/);
    // A property every kind has needs no owner: it IS the column's.
    assert.equal(rows.find((offer) => offer.word === "count")?.owner, undefined);
});

test("a property no other spelling reaches is still offered, subject or not", () => {
    // The delivery kind is wordless and its cast length is not plain-searchable, so nothing else reaches it.
    assert.ok(words(at("spell:{}", 7), "doors").includes("cast"));
    // The expansion's rung, and the id's own value, are both reached without naming them.
    assert.ok(!words(at("id:{}", 4), "doors").includes("rung"));
    assert.ok(!words(at("id:{}", 4), "doors").includes("value"));
    // And counting is only a question where a spell can carry more than one row of the thing — a spell has one
    // name, one description, one icon and one id, so none of those scopes may ask how many.
    assert.ok(!words(at("id:{}", 4), "doors").includes("count"));
    assert.ok(!words(at("name:{}", 6), "doors").includes("count"));
    assert.ok(!words(at("desc:{}", 6), "doors").includes("count"));
    assert.ok(!words(at("icon:{}", 6), "doors").includes("count"));
    assert.ok(!words(at("spell:{}", 7), "doors").includes("count"), "no spell-column kind repeats");
    assert.ok(words(at("model:{}", 7), "doors").includes("count"));
});

/** An expansion ladder as the pack ships one: the name, everything that reaches it, and what it is called. */
const LADDER: Rung[] = [
    {word: "Vanilla", reads: ["vanilla", "classic", "1"], note: "Classic"},
    {word: "TBC", reads: ["tbc", "bc", "burning crusade", "2"], note: "The Burning Crusade"},
    {word: "WotLK", reads: ["wotlk", "wrath", "3"], note: "Wrath of the Lich King"},
    {word: "Cata", reads: ["cata", "cataclysm", "4"], note: "Cataclysm"},
];

test("an expansion is offered as the pack spells it, named by what it is called", () => {
    const rows = offersAt(planAt("xpac:", 5), 0, [], {rungs: LADDER}).groups
        .flatMap((group) => group.offers);
    // The shorts are consistent where the keys are not — `shadowlands` is spelled out and `tbc` is not — and
    // the note is the expansion's own name rather than a number nobody asked for.
    assert.equal(rows[1].word, "TBC");
    assert.equal(rows[1].note, "The Burning Crusade");
});

test("a vocabulary's own picture rides with its word", () => {
    const art = {WotLK: "/site/img/expansions/wotlk.png"};
    const rows = offersAt(planAt("xpac:", 5), 0, [], {rungs: LADDER, art}).groups
        .flatMap((group) => group.offers);
    assert.equal(rows.find((offer) => offer.word === "WotLK")?.art, "/site/img/expansions/wotlk.png");
    // A word with no picture shipped for it carries none, and says nothing about that.
    assert.equal(rows.find((offer) => offer.word === "TBC")?.art, undefined);
});

test("a number typed where an expansion belongs finds the one standing at it", () => {
    const offers = offersAt(planAt("xpac:3", 6), 1, [], {rungs: LADDER});
    assert.equal(offers.groups.flatMap((group) => group.offers)[0].word, "WotLK");
});

test("every spelling that reaches a rung narrows to it, not the number alone", () => {
    // The rung already carries the ways in, because the ordinal type parses against them. Reading the same list
    // here is what stops the surface deciding separately which spellings exist.
    const first = (typed: string, caret: number): string =>
        offersAt(planAt(typed, caret), caret - 5, [], {rungs: LADDER})
            .groups.flatMap((group) => group.offers)[0].word;
    assert.equal(first("xpac:wrath", 10), "WotLK", "the key the pack stores");
    assert.equal(first("xpac:burning", 12), "TBC", "a name spelled out");
    assert.equal(first("xpac:cataclysm", 14), "Cata");
});

test("an enum property lists the pack's own words for it, quoted where a spelling carries a space", () => {
    const vocab = {rungs: [], enums: {"missile.motion": ["Parabola", "Follow Ground"]}};
    const offers = offersAt(planAt("missile:{motion:}", 16), 7, [], vocab);
    const rows = flatOffers(offers);
    const straight = rows.find((offer) => offer.word === "Parabola");
    assert.equal(straight?.insert, "Parabola");
    // A spelling with a space would split into two terms where it lands, so it travels as a phrase — and the
    // written query still parses.
    const spaced = rows.find((offer) => offer.word === "Follow Ground");
    assert.equal(spaced?.insert, '"Follow Ground"');
    const {value} = offerSlot(planAt("missile:{motion:}", 16), offers, spaced ?? rows[0]);
    const written = writeSlot(planAt("missile:{motion:}", 16), value);
    assert.deepEqual(parse(written).diagnostics.filter((d) => d.severity === "error"), [], written);
});

test("a vocabulary the panel would truncate waits for a keystroke; a small one lists itself whole", () => {
    const many = Array.from({length: 150}, (_, i) => `word${String(i).padStart(3, "0")}`);
    const vocab = {rungs: [], enums: {"missile.motion": many}};
    // Untyped, a 150-word list is a corpus in spirit — nothing but the any-word stands.
    const eager = words(offersAt(planAt("missile:{motion:}", 16), 7, [], vocab), "words");
    assert.ok(!eager.some((held) => held.startsWith("word")));
    // One character in, it narrows like the doors do — capped, and saying what it held back.
    const typed = offersAt(planAt("missile:{motion:word01}", 22), 13, [], vocab);
    const narrowed = typed.groups.find((held) => held.id === "words");
    assert.ok((narrowed?.offers.length ?? 0) > 0);
    assert.ok(narrowed?.offers.every((offer) => offer.word.startsWith("word01") || offer.word === "any"));
});

test("a column's scope never offers a word that belongs to one of its kinds", () => {
    // Every one of these was a complaint about the surface teaching the schema's own shape: an id that is a
    // creature display's, a file id that is an icon's, an attachment that only some models have, and an `anim`
    // property inside the anim column. Each is reached by opening the kind that declares it.
    const model = words(at("model:{}", 7), "doors");
    assert.ok(!model.includes("id"), "a creature display's id is not the model column's");
    assert.ok(!model.includes("fid"), "an icon's file id is not the model column's");
    assert.ok(!words(at("anim:{}", 6), "doors").includes("anim"), "the anim column has no anim property");
    assert.ok(!words(at("spell:{}", 7), "doors").includes("fid"));
    // What most of a column's kinds declare stays: five of the model column's nine put their model somewhere
    // on the body, so where it attaches is the column's own question.
    assert.ok(model.includes("attach"));
    // And a kind's own property is there when the kind is the door.
    assert.ok(words(at("icon:{}", 6), "doors").includes("fid"));
});

test("an escaped quote wants no closer, and an escaped word is offered nothing", () => {
    // The user's report: at `name:\"` the surface offered a closing quote — for a quote the escape had made a
    // literal character, which opens nothing and wants nothing.
    assert.equal(at('name:\\"', 7).ghost, "");
    // An escaped word opens no door, so the surface has nothing to offer it.
    const offers = at("\\mod", 4);
    assert.deepEqual(offers.groups, []);
});

test("an enclosure left open is ghosted with what would close it", () => {
    // The pairing spawns closers as they are typed, so an open one means the reader deleted it or pasted
    // around it — and until it closes, everything after it is inside it.
    assert.equal(at('name:{"blood', 12).ghost, '"');
    assert.equal(at('name:{"blood', 12).ghostIs, "closer");
    // Innermost first, and nothing at all when the value is balanced.
    assert.equal(at("fx:{chain from:(a", 17).ghost, ")");
    assert.equal(at("model:{fire", 11).ghost, "");
});

test("a word that names no property has no notation line to introduce", () => {
    const takes = at("model:{blerg:}", 13).takes;
    assert.equal(takes?.how, "");
    assert.match(takes?.what ?? "", /blerg/);
});

test("the ghost names the offer that taking it delivers, wherever that offer sits in the list", () => {
    // The ghost previews the first offer in ANY group that completes the typed characters, so a door two
    // groups down can be the completion — while the key that takes it was reading the first ROW. Where a
    // word higher up merely CONTAINS what was typed, the two came apart: `spell:ra` drew `range` and
    // delivered `tracking`.
    const offers = at("spell:ra", 8);
    assert.equal(offers.ghost, "nge");
    const named = flatOffers(offers)[offers.ghostAt];
    assert.equal(named.insert, "range");
    assert.notEqual(flatOffers(offers)[0].insert, "range");
    // The whole language, at every prefix of every door, in and out of a scope: what the slot spells is what
    // the named offer writes. An assertion list would only cover the spellings somebody thought of.
    for (const shell of ["", "spell:", "model:", "sound:", "mech:", "fx:", "anim:", "id:", "model:{"]) {
        for (const word of ["i", "n", "d", "de", "r", "ra", "e", "m", "mo", "o", "ca", "att"]) {
            const text = shell + word;
            const here = at(text, text.length);
            if (here.ghostIs !== "offer") continue;
            const takes = flatOffers(here)[here.ghostAt];
            assert.equal(takes?.insert, here.typed + here.ghost, `${text} ghosts one offer and takes another`);
        }
    }
});

test("a ghost that stands for no offer names none", () => {
    // A unit and a closer are written straight into the slot, so there is no row to point at.
    assert.equal(at("scale:15", 8).ghostAt, -1);
    assert.equal(at('name:{"blood', 12).ghostAt, -1);
    assert.equal(NO_OFFERS.ghostAt, -1);
});
