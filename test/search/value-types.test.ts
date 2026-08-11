/* THE TYPE CATALOGUE — tier 1 of the test ladder, written with the first type
 * rather than after the last one (PLAN §7).
 *
 * Two things are under test and they are different in kind:
 *
 *   THE INVARIANT   format(parse(s)) === s, which is what makes "read the
 *                   pill, type what you see" true rather than hoped for.
 *   THE MATRIX      TYPES §3.1's operator table, transcribed as an assertion.
 *                   That table is the LAW; a type quietly gaining or losing an
 *                   operator is a language change, and this is what makes it
 *                   impossible to do by accident.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {exact, ORDERING, present} from "../../src/search/operators";
import {
    angle, bitmask, count, defineType, enumeration, flag, id, length, multiplier, ordinal, path,
    percent, seconds, text, TYPES,
} from "../../src/search/value-types";

/** Canonical spellings — every one is something `format` itself produces. */
const CANONICAL: [string, string[]][] = [
    ["text", ["Fireball", "Blood Pool", "anti-magic", "the \"real\" one", "100%"]],
    ["path", ["spells/fire_missile_01.m2", "beecreature.m2"]],
    ["enum", ["UNIT_TARGET_ENEMY", "JUMP_DEST"]],
    ["ordinal", ["Legion", "Wrath of the Lich King"]],
    ["bitmask", ["caster", "both"]],
    ["id", ["133", "0", "9007199254740991"]],
    ["count", ["0", "4", "128"]],
    ["seconds", ["1.5s", "0s", "120s", "unlimited"]],
    ["percent", ["+30%", "-30%", "0%"]],
    ["length", ["5yd", "0.5yd"]],
    ["angle", ["60deg", "27.5deg"]],
    ["multiplier", ["2x", "0.5x"]],
    ["colour", ["#ff00aa", "#000000"]],
    ["vector", ["0,0,1", "1.5,-2,0"]],
];

describe("the type registry", () => {
    it("holds exactly the catalogue", () => {
        assert.deepEqual([...TYPES.keys()].toSorted(), [
            "angle", "bitmask", "colour", "count", "enum", "flag", "id", "length", "multiplier",
            "ordinal", "path", "percent", "seconds", "text", "vector",
        ]);
    });

    it("merges TYPES §4's `scale` and `rate` into `multiplier`", () => {
        // Their rows in that table are identical in every column a TYPE owns —
        // float, unit `x`, no conversion, unsigned — and differ only in what
        // they measure, which §0 says out loud is none of a type's business.
        // And `scale` collided with the fx `scale` KIND, which §0 bans.
        assert.equal(TYPES.has("scale"), false);
        assert.equal(TYPES.has("rate"), false);
        assert.equal(multiplier.format!(2), "2x");
    });

    it("gives every type a hint, because the diagnostic is built from it", () => {
        for (const type of TYPES.values()) {
            assert.ok(type.hint.length > 0, `${type.name} has no hint`);
        }
    });

    it("keeps every value a JSON scalar, or the query could not be serialised", () => {
        // PLAN §3.2b: an operand travels to a backend that may be SQL or HTTP.
        for (const [name, spellings] of CANONICAL) {
            const type = TYPES.get(name)!;
            for (const spelling of spellings) {
                const value = type.parse!(spelling);
                assert.ok(typeof value === "string" || typeof value === "number",
                    `${name}.parse(${spelling}) is not a scalar`);
            }
        }
    });
});

describe("the round-trip invariant", () => {
    it("holds for every canonical spelling of every type", () => {
        for (const [name, spellings] of CANONICAL) {
            const type = TYPES.get(name)!;
            for (const spelling of spellings) {
                const value = type.parse!(spelling);
                assert.notEqual(value, null, `${name}.parse(${spelling}) returned null`);
                assert.equal(type.format!(value!), spelling, `${name}: ${spelling}`);
            }
        }
    });

    it("covers every type that has values at all", () => {
        // So a new type cannot be added and quietly left untested — the one
        // failure mode a fixture list has.
        const covered = new Set(CANONICAL.map(([name]) => name));
        for (const type of TYPES.values()) {
            if (type.parse) {
                assert.ok(covered.has(type.name), `${type.name} has no canonical spellings`);
            }
        }
    });
});

describe("TYPES §3.1 — the operator matrix", () => {
    const accepts = (type: { accepts: readonly { name: string }[] }): string[] =>
        type.accepts.map((op) => op.name).toSorted();

    it("gives the textual family exact / contains / glob / present and NO ordering", () => {
        // `text` declining `compare` is load-bearing: it is what makes
        // `name:anti-magic` one token rather than a range, and what turns
        // `name:>m` into an honest error instead of a substring search.
        for (const type of [text, path, enumeration]) {
            assert.deepEqual(accepts(type), ["contains", "exact", "glob", "present"], type.name);
        }
    });

    it("gives `ordinal` everything `enum` has PLUS the ordering", () => {
        assert.deepEqual(accepts(ordinal),
            ["contains", "exact", "glob", "gt", "gte", "lt", "lte", "present", "range"]);
    });

    it("gives `id` equality only — no ordering, no substring, no glob", () => {
        // Both refusals are deliberate: spell 5 is not "before" spell 6 in any
        // sense a user means, and substring-matching an id is the defect that
        // made 135812 match 295 spells instead of one.
        assert.deepEqual(accepts(id), ["exact", "present"]);
    });

    it("gives `bitmask` equality only — matching part of a bit's NAME is the L4 defect", () => {
        assert.deepEqual(accepts(bitmask), ["exact", "present"]);
    });

    it("gives `flag` presence only, and no value at all", () => {
        assert.deepEqual(accepts(flag), ["present"]);
        assert.equal(flag.storage, null);
        assert.equal(flag.parse, undefined);
        assert.equal(flag.format, undefined);
    });

    it("gives the numeric family equality, ordering and presence — never substring", () => {
        for (const type of [count, seconds, percent, length, angle, multiplier]) {
            assert.deepEqual(accepts(type),
                ["exact", "gt", "gte", "lt", "lte", "present", "range"], type.name);
        }
    });

    it("declines rather than falls through — an absent operator is a static error", () => {
        // The null-object rule as DATA. Nothing here asks JavaScript.
        assert.equal(text.accepts.includes(ORDERING[0]), false);
        assert.equal(id.accepts.includes(ORDERING[0]), false);
    });
});

describe("what each type refuses to parse", () => {
    it("makes `id` reject anything that is not safe digits", () => {
        assert.equal(id.parse!("frostbolt"), null);
        assert.equal(id.parse!("1.5"), null);
        assert.equal(id.parse!("-1"), null);
        assert.equal(id.parse!(""), null);
        // beyond MAX_SAFE_INTEGER the round trip silently loses precision
        assert.equal(id.parse!("99999999999999999999"), null);
    });

    it("makes every string type accept everything, which is what `text` IS", () => {
        assert.equal(text.parse!("133"), "133");
        assert.equal(path.parse!(">m"), ">m");
    });
});

describe("defineType", () => {
    it("FIRES on a duplicate name", () => {
        assert.throws(
            () => defineType({name: "text", storage: "string", accepts: [present], hint: "x", ui: "text"}),
            /already defined/);
    });

    it("FIRES on an operator this registry has never heard of", () => {
        // A typo in `accepts` would otherwise mean the type silently declines
        // the operator it meant to accept.
        const impostor = {name: "near", symbol: "~", form: "prefix", hint: "x"} as const;
        assert.throws(
            () => defineType({
                name: "spurious", storage: "string", accepts: [impostor], hint: "x", ui: "text",
            }),
            /unregistered operator "near"/);
    });

    it("FIRES on a value-bearing operator with nothing to read the value with", () => {
        assert.throws(
            () => defineType({
                name: "spurious", storage: "string", accepts: [exact], hint: "x", ui: "text",
            }),
            /cannot parse or format one/);
    });

    it("FIRES on units declared without an order", () => {
        // `text` has neither, which is precisely why the 396 spell names
        // containing `%` cannot collide with a percentage. Declaring units on
        // an unordered type would reopen that.
        assert.throws(
            () => defineType<string>({
                name: "spurious", storage: "string", accepts: [exact, present],
                parse: (s) => s, format: (s) => s, units: {"%": 1}, hint: "x", ui: "text",
            }),
            /declares units but does not accept an order/);
    });
});
