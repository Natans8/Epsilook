/**
 * @file Units, sentinels and the number grammar.
 *
 * Three rules are under test: a unit converts rather than annotates, a query converts down into storage units and
 * never the other way, and a sentinel is classified before it is scaled.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {formatNumber, parseNumber} from "../../src/search/units";

/** The shipped duration spec: stored in milliseconds, written in seconds. */
const secondsSpec = {
    storage: "int",
    unit: "s",
    units: {s: 1000, ms: 1, m: 60000},
    sentinels: {[-1]: "unlimited"},
} as const;

const percentSpec = {
    storage: "int",
    unit: "%",
    units: {"%": 1},
    signed: true,
} as const;

const floatSpec = {storage: "float", unit: "yd", units: {yd: 1}} as const;

describe("parseNumber", () => {
    const seconds = parseNumber(secondsSpec);

    it("reads a bare number as the canonical unit", () => {
        // A cast time of 2 is two seconds, not two milliseconds, because seconds is what the value is written in.
        assert.equal(seconds("2"), 2000);
    });

    it("converts a unit rather than annotating it", () => {
        // Sub-second cast times exist, so 500ms has to mean half a second while 500 means five hundred seconds.
        assert.equal(seconds("500ms"), 500);
        assert.equal(seconds("500"), 500_000);
        assert.equal(seconds("2m"), 120_000);
    });

    it("does not read a millisecond as a minute", () => {
        // The pattern captures the whole remainder after the digits, so there is no longest-match rule to get wrong.
        assert.equal(seconds("500ms"), 500);
        assert.equal(seconds("500m"), 30_000_000);
    });

    it("rounds into integer storage, because 0.1 * 1000 is not 100 in binary", () => {
        assert.equal(seconds("0.1"), 100);
        assert.equal(seconds("1.5"), 1500);
        assert.equal(seconds("1.234"), 1234);
    });

    it("accepts a leading sign, which a formatted percentage carries", () => {
        // A plus has no clause-level meaning inside a value, and format writes one, so parse must accept it or the
        // round trip breaks.
        const percent = parseNumber(percentSpec);
        assert.equal(percent("+30%"), 30);
        assert.equal(percent("-30%"), -30);
    });

    it("returns null on an unknown unit rather than ignoring it", () => {
        // Null means "not my shape", which is how a property with several notations dispatches. The message naming
        // the unit a property does take is composed once no declared type has accepted the operand.
        assert.equal(parseNumber(percentSpec)("50s"), null);
        assert.equal(seconds("2 s"), null);         // a value cannot contain a space
        assert.equal(seconds("1e3"), null);         // no exponent: `e` would be a unit
    });

    it("returns null on text, so a multi-notation property can fall through", () => {
        assert.equal(seconds("frostbolt"), null);
        assert.equal(seconds(""), null);
        assert.equal(seconds("-"), null);
    });

    it("classifies a sentinel before reading any digit", () => {
        assert.equal(seconds("unlimited"), -1);
        assert.equal(seconds("UNLIMITED"), -1);     // Normalised, like every other operand.
    });

    it("makes a sentinel reachable by its name and never by its number", () => {
        // Minus one stored means unlimited, while a typed -1 asks for minus one second and scales to -1000. The two
        // cannot collide, which follows from converting down into storage rather than from a rule of its own.
        assert.equal(seconds("-1"), -1000);
        assert.notEqual(seconds("-1"), seconds("unlimited"));
    });

    it("throws when a type's canonical unit is absent from its own table", () => {
        // Otherwise every value scales by undefined and the property silently matches nothing. Checked at
        // registration, so it cannot reach a reader.
        assert.throws(
            () => parseNumber({storage: "int", unit: "s", units: {ms: 1}}),
            /canonical unit "s", absent/);
    });
});

describe("formatNumber", () => {
    const seconds = formatNumber(secondsSpec);

    it("prints the canonical unit, never the stored one", () => {
        // Any other choice means a value on screen cannot be typed back into a query.
        assert.equal(seconds(1500), "1.5s");
        assert.equal(seconds(500), "0.5s");
        assert.equal(seconds(120_000), "120s");
    });

    it("prints a sentinel's word, before the division", () => {
        // Otherwise minus one prints as -0.001s and the meaning is lost.
        assert.equal(seconds(-1), "unlimited");
    });

    it("prints an explicit + only where the sign is the information", () => {
        const percent = formatNumber(percentSpec);
        assert.equal(percent(30), "+30%");
        assert.equal(percent(-30), "-30%");
        assert.equal(percent(0), "0%");
        assert.equal(formatNumber(floatSpec)(5), "5yd");
    });

    it("rounds away binary artefacts a float column really holds", () => {
        assert.equal(formatNumber(floatSpec)(1.2000000000000002), "1.2yd");
    });
});

describe("the round trip", () => {
    it("holds over everything format itself produces", () => {
        // Input is lenient, since 50 and 500ms both parse; output is one form.
        for (const spec of [secondsSpec, percentSpec, floatSpec]) {
            const parse = parseNumber(spec);
            const format = formatNumber(spec);
            for (const stored of [0, 1, -1, 5, 100, 1500, 60_000, -30]) {
                const written = format(stored);
                assert.equal(format(parse(written)!), written,
                    `${spec.unit}: ${stored} formatted as ${written}`);
            }
        }
    });
});
