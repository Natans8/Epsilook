/* Units, sentinels and the number grammar.
 *
 * Three rules are under test, and each cost a measurement to establish:
 * a unit CONVERTS rather than annotates; the query converts DOWN into storage
 * and never the other way; and a sentinel is classified BEFORE it is scaled.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {formatNumber, parseNumber} from "../../src/search/units";

/** The shipped `seconds` spec: stored in milliseconds, printed in seconds. */
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

    it("reads a bare number as the CANONICAL unit", () => {
        // TYPES §5.1 rule 1. `casttime:2` is two seconds, not two milliseconds,
        // because seconds is what the pill prints.
        assert.equal(seconds("2"), 2000);
    });

    it("CONVERTS a unit rather than annotating it", () => {
        // Earned: 9.2.7 has 31 sub-second cast times, so `500ms` has to mean
        // half a second and `500` has to mean five hundred seconds.
        assert.equal(seconds("500ms"), 500);
        assert.equal(seconds("500"), 500_000);
        assert.equal(seconds("2m"), 120_000);
    });

    it("does not read `ms` as `m`", () => {
        // The number pattern captures the WHOLE remainder, so there is no
        // longest-match rule to get wrong.
        assert.equal(seconds("500ms"), 500);
        assert.equal(seconds("500m"), 30_000_000);
    });

    it("rounds into integer storage, because 0.1 * 1000 is not 100 in binary", () => {
        assert.equal(seconds("0.1"), 100);
        assert.equal(seconds("1.5"), 1500);
        assert.equal(seconds("1.234"), 1234);
    });

    it("accepts a sign, and a leading + is not the prohibited-term operator", () => {
        // SEARCH.md §3 deletes `+` at CLAUSE level. Inside a value there is no
        // clause reading available, and `format` emits `+30%`, so parse must
        // accept what format writes or the round trip breaks.
        const percent = parseNumber(percentSpec);
        assert.equal(percent("+30%"), 30);
        assert.equal(percent("-30%"), -30);
    });

    it("returns null on an unknown unit rather than ignoring it", () => {
        // Null is "not my shape" — the dispatch mechanism (TYPES §7). The
        // sentence *"scale takes a percentage"* is composed one level up, once
        // NO declared type has accepted the operand.
        assert.equal(parseNumber(percentSpec)("50s"), null);
        assert.equal(seconds("2 s"), null);         // a value cannot contain a space
        assert.equal(seconds("1e3"), null);         // no exponent: `e` would be a unit
    });

    it("returns null on text, so a multi-notation property can fall through", () => {
        assert.equal(seconds("frostbolt"), null);
        assert.equal(seconds(""), null);
        assert.equal(seconds("-"), null);
    });

    it("classifies a sentinel BEFORE reading any digit", () => {
        assert.equal(seconds("unlimited"), -1);
        assert.equal(seconds("UNLIMITED"), -1);     // folded, like everything else
    });

    it("makes a sentinel reachable by its NAME and never by its number", () => {
        // −1 stored is "unlimited"; typing `-1` asks for minus one SECOND,
        // which scales to −1000. The two cannot be confused, and that falls
        // out of "the query converts down into storage" rather than needing a
        // rule of its own.
        assert.equal(seconds("-1"), -1000);
        assert.notEqual(seconds("-1"), seconds("unlimited"));
    });

    it("throws when a type's canonical unit is absent from its own table", () => {
        // Otherwise every value scales by undefined and the whole axis matches
        // nothing, silently. Registration-time, so it cannot reach a user.
        assert.throws(
            () => parseNumber({storage: "int", unit: "s", units: {ms: 1}}),
            /canonical unit "s", absent/);
    });
});

describe("formatNumber", () => {
    const seconds = formatNumber(secondsSpec);

    it("prints the canonical unit, never the stored one", () => {
        // TYPES §5.4 rule 3: any other choice means a query cannot be written
        // by reading the screen, which is L12.
        assert.equal(seconds(1500), "1.5s");
        assert.equal(seconds(500), "0.5s");
        assert.equal(seconds(120_000), "120s");
    });

    it("prints a sentinel's WORD, before the division", () => {
        // Or −1 prints as `-0.001s` and the meaning is lost.
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
    it("holds over the IMAGE of format, which is what the pill shows", () => {
        // `format(parse(s)) === s` for every s that format PRODUCED. Input is
        // lenient (`50`, `500ms` both parse); output is one form.
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
