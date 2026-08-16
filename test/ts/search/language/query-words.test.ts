import {strict as assert} from "node:assert";
import {after, describe, it} from "node:test";

import {applyQueryWords, catalogue, formatQuery, parse, QUERY_WORD_LANGUAGES} from "../../../../src/search/index";

/* A fixture language rather than a real one: the mechanism is what is under test, and a real table's words are
 * content that arrives with its translation. */
const FIXTURE = {
    columns: {model: ["модель"]},
    kinds: {"model.missile": ["снаряд"], "spell.desc": ["описание"]},
    props: {"model.missile.motion": ["полёт"]},
    units: {s: ["с", "сек"]},
};

/** Errors of one parse, as messages. */
const errors = (query: string): string[] =>
    parse(query).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);

describe("applyQueryWords", () => {
    after(() => applyQueryWords("en"));

    it("locale words read at every level once applied, and stop reading when the language reverts", () => {
        applyQueryWords("test", FIXTURE);
        assert.equal(errors("модель:снаряд").length, 0);
        assert.equal(formatQuery(parse("model:снаряд")), "model:missile");
        assert.equal(errors("модель:{снаряд полёт:parabola}").length, 0);
        assert.equal(formatQuery(parse("описание:kneel")), "desc:kneel");

        // An unknown word before a colon is ordinary text, never an error — so the proof of the revert is the head
        // no longer resolving, not a diagnostic appearing.
        applyQueryWords("en");
        assert.notEqual(formatQuery(parse("модель:снаряд")), "model:missile");
    });

    it("the canonical form stays English: locale words are ways in, written nowhere", () => {
        applyQueryWords("test", FIXTURE);
        assert.equal(formatQuery(parse("модель:снаряд")), "model:missile");
        assert.equal(formatQuery(parse("модель:{снаряд полёт:parabola}")), "model:{missile motion:parabola}");
    });

    it("a locale unit word parses as its symbol, and stops when the language reverts", () => {
        applyQueryWords("test", FIXTURE);
        const seconds = catalogue.delivery.props.cast.types[0];
        assert.equal(seconds.parse?.("2сек"), seconds.parse?.("2s"));
        assert.equal(seconds.parse?.("2с"), 2000);
        applyQueryWords("en");
        assert.equal(seconds.parse?.("2сек"), null);
    });

    it("refuses a table naming nothing declared", () => {
        assert.throws(() => applyQueryWords("test", {kinds: {"model.bogus": ["x"]}}), /model\.bogus/);
        assert.throws(() => applyQueryWords("test", {columns: {bogus: ["x"]}}), /bogus/);
        assert.throws(() => applyQueryWords("test", {props: {"model.missile.bogus": ["x"]}}), /bogus/);
        assert.throws(() => applyQueryWords("test", {units: {sec: ["сек"]}}), /unit "sec"/);
    });

    it("every registered table validates — a shipped typo must fail here, not on a reader's first load", () => {
        for (const language of QUERY_WORD_LANGUAGES) {
            applyQueryWords(language);
        }
    });

    it("a colliding locale word fails the same checks a declared spelling does, and is backed out whole", () => {
        assert.throws(() => applyQueryWords("test", {columns: {model: ["sound"]}}), /claimed by both/);
        assert.notEqual(formatQuery(parse("модель:missile")), "model:missile");

        // A unit word landing on another notation's symbol is the numeric ambiguity check, re-run on apply.
        assert.throws(() => applyQueryWords("test", {units: {s: ["ms"]}}), /both accept one operand/);
        const seconds = catalogue.delivery.props.cast.types[0];
        assert.equal(seconds.parse?.("2s"), 2000);
    });
});
