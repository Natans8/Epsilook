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
    display: {unit: "s", factor: 1000},
    accepts: [{unit: "ms", factor: 1, bare: "never"}, {unit: "m", factor: 60_000, bare: "never"}],
} as const;

const percentSpec = {
    storage: "int",
    display: {unit: "%", factor: 1, sign: "required"},
} as const;

const floatSpec = {storage: "float", display: {unit: "yd", factor: 1}} as const;

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

    it("scales a typed negative into storage, where a sentinel's stored number cannot be reached", () => {
        // Minus one stored means unlimited on the axis that declares it, while a typed -1 asks for minus one second
        // and scales to -1000. The two cannot collide, which follows from converting down into storage.
        assert.equal(seconds("-1"), -1000);
    });

    it("throws when two notations could both accept one operand", () => {
        // The same text would otherwise mean two things, decided by which notation happened to be declared first.
        // Checked when the parser is built, so it cannot reach a reader.
        assert.throws(
            () => parseNumber({
                storage: "int",
                display: {unit: "%", factor: 1},
                accepts: [{unit: "%", factor: 1}],
            }),
            /would both accept one operand/);
    });

    it("splits the bare numbers between two notations at a declared threshold", () => {
        // The factor of a hundred between the two scalings is what makes the split sound: a number small enough to be
        // a factor is far too small to be a proportion anyone means.
        const change = parseNumber({
            storage: "float",
            display: {unit: "+", factor: 1, sign: "required"},
            accepts: [
                {unit: "x", position: "before", factor: 100, offset: -100, sign: "refused", bare: {atMost: 10}},
                {unit: "%", factor: 1, offset: -100, sign: "refused", bare: {above: 10}},
            ],
        });
        assert.equal(change("2"), 100, "at or under the threshold, a factor");
        assert.equal(change("10"), 900, "the threshold itself belongs to the factor");
        assert.equal(change("11"), -89, "above it, a proportion");
        assert.equal(change("0.5"), -50);
    });

    it("throws when two thresholds leave a bare number claimable by both", () => {
        assert.throws(
            () => parseNumber({
                storage: "float",
                display: {unit: "x", position: "before", factor: 100, bare: {atMost: 20}},
                accepts: [{unit: "%", factor: 1, bare: {above: 10}}],
            }),
            /would both accept one operand/);
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

    it("prints an explicit + only where the notation requires a sign", () => {
        // Where a sign is required, zero carries one too, so that everything `format` writes is something `parse`
        // accepts back.
        const percent = formatNumber(percentSpec);
        assert.equal(percent(30), "+30%");
        assert.equal(percent(-30), "-30%");
        assert.equal(percent(0), "+0%");
        assert.equal(formatNumber(floatSpec)(5), "5yd");
    });

    it("writes the symbol on the side the notation declares", () => {
        const factor = formatNumber({storage: "float", display: {unit: "x", factor: 1, position: "before"}});
        assert.equal(factor(1.5), "x1.5");
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
                    `${spec.display.unit}: ${stored} formatted as ${written}`);
            }
        }
    });
});
