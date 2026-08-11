/**
 * @file The value type catalogue.
 *
 * Two separate things are under test. The round-trip invariant, `format(parse(s)) === s`, is what lets a reader type
 * back a value they read off the screen. The operator table is the contract between a type and the query language: a
 * type quietly gaining or losing an operator changes what queries mean, so the table is transcribed here as
 * assertions rather than left to review.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {exact, ORDERING, present} from "../../src/search/operators";
import {
    angle, bitmask, colour, composite, count, defineType, enumeration, flag, id, length, multiplier,
    offset, ordinal, path, percent, seconds, text, TYPES,
} from "../../src/search/value-types";

/** Canonical spellings. Every one is something `format` itself produces. */
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
    ["offset", ["0yd,0yd,1yd", "1.5yd,-2yd,0yd", ",,3yd"]],
];

describe("the type registry", () => {
    it("holds exactly the catalogue", () => {
        assert.deepEqual([...TYPES.keys()].toSorted(), [
            "angle", "bitmask", "colour", "count", "enum", "flag", "id", "length", "multiplier",
            "offset", "ordinal", "path", "percent", "seconds", "text",
        ]);
    });

    it("has one type for a bare factor, whatever the factor measures", () => {
        // What a multiplier is applied to is a property's business, not a type's, so a size factor and a playback
        // factor are one type. It is named for the value rather than for a use, leaving `scale` free for the kind.
        assert.equal(TYPES.has("scale"), false);
        assert.equal(TYPES.has("rate"), false);
        assert.equal(multiplier.format!(2), "2x");
    });

    it("gives every type a hint, because diagnostics and help are built from it", () => {
        for (const type of TYPES.values()) {
            assert.ok(type.hint.length > 0, `${type.name} has no hint`);
        }
    });

    it("keeps every parsed value a JSON scalar", () => {
        // A value that cannot be serialised would confine a query to the process that parsed it.
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
        // Otherwise a new type can be added and left untested, which is the one failure mode a fixture list has.
        const covered = new Set(CANONICAL.map(([name]) => name));
        for (const type of TYPES.values()) {
            if (type.parse) {
                assert.ok(covered.has(type.name), `${type.name} has no canonical spellings`);
            }
        }
    });
});

describe("the operator table", () => {
    const accepts = (type: { accepts: readonly { name: string }[] }): string[] =>
        type.accepts.map((op) => op.name).toSorted();

    it("gives the textual family exact, contains, glob and present, with no ordering", () => {
        // Declining comparison is load-bearing: it is what keeps `name:anti-magic` a single token instead of a range,
        // and what turns `name:>m` into an error rather than a substring search for the characters.
        for (const type of [text, path, enumeration]) {
            assert.deepEqual(accepts(type), ["contains", "exact", "glob", "present"], type.name);
        }
    });

    it("gives an ordinal everything an enum has, plus the ordering", () => {
        assert.deepEqual(accepts(ordinal),
            ["contains", "exact", "glob", "gt", "gte", "lt", "lte", "present", "range"]);
    });

    it("gives an id equality only, with no ordering, substring or glob", () => {
        // One spell id is not "before" another in any sense a reader means, and matching part of an id is how a
        // six-digit number comes to select hundreds of rows instead of one.
        assert.deepEqual(accepts(id), ["exact", "present"]);
    });

    it("gives a bitmask equality only, so part of a role name never matches", () => {
        assert.deepEqual(accepts(bitmask), ["exact", "present"]);
    });

    it("gives a flag presence only, and no value at all", () => {
        assert.deepEqual(accepts(flag), ["present"]);
        assert.equal(flag.storage, null);
        assert.equal(flag.parse, undefined);
        assert.equal(flag.format, undefined);
    });

    it("gives the numeric family equality, ordering and presence, never substring", () => {
        for (const type of [count, seconds, percent, length, angle, multiplier]) {
            assert.deepEqual(accepts(type),
                ["exact", "gt", "gte", "lt", "lte", "present", "range"], type.name);
        }
    });

    it("gives a colour approximate matching but no ordering", () => {
        // A bare colour asks "about this shade", which is the question a reader has; ordering three channels at once
        // has no meaning.
        assert.deepEqual(accepts(colour), ["contains", "exact", "present"]);
    });

    it("gives a composite equality and presence only", () => {
        assert.deepEqual(accepts(offset), ["exact", "present"]);
    });

    it("builds a composite from its members, so their units work inside it", () => {
        // A member's own type parses and formats it, which is what makes a composite a combination of types rather
        // than a second numeric notation.
        assert.equal(offset.parse!("1yd,2yd,3yd"), "1,2,3");
        assert.equal(offset.format!("1,2,3"), "1yd,2yd,3yd");
    });

    it("lets a composite be constrained by naming one member", () => {
        assert.equal(offset.parse!("z=3"), ",,3");
        assert.equal(offset.parse!("z=3"), offset.parse!(",,3"));
    });

    it("shows a component it has no member for rather than failing to render", () => {
        // Stored values come from the game data, where a later version adding a component should degrade visibly.
        assert.equal(offset.format!("1,2,3,4"), "1yd,2yd,3yd,4");
    });

    it("refuses to build a composite from a member that carries no value", () => {
        assert.throws(
            () => composite({name: "spurious", members: {bit: flag}, hint: "x"}),
            /member "bit" has type "flag", which carries no value/);
    });

    it("registers a composite like any other type", () => {
        const point = composite({
            name: "point", members: {x: length, y: length}, hint: "a point",
        });
        try {
            assert.equal(TYPES.get("point"), point);
            assert.equal(point.ui, "fields");
            assert.equal(point.parse!("1,2,3"), null);
        } finally {
            TYPES.delete("point");   // The registry is module-level; leave it as found.
        }
    });

    it("declines by omission, so an unaccepted operator is a static error", () => {
        assert.equal(text.accepts.includes(ORDERING[0]), false);
        assert.equal(id.accepts.includes(ORDERING[0]), false);
    });
});

describe("what each type refuses to parse", () => {
    it("makes an id reject anything that is not safe digits", () => {
        assert.equal(id.parse!("frostbolt"), null);
        assert.equal(id.parse!("1.5"), null);
        assert.equal(id.parse!("-1"), null);
        assert.equal(id.parse!(""), null);
        // Beyond the safe integer range the value no longer survives a round trip.
        assert.equal(id.parse!("99999999999999999999"), null);
    });

    it("makes a colour reject anything that is not a hex triplet", () => {
        assert.equal(colour.parse!("red"), null);
        assert.equal(colour.parse!("#fff"), null);
        assert.equal(colour.parse!("#ff00gg"), null);
    });

    it("makes a composite reject more members than it has, or an unknown member name", () => {
        assert.equal(offset.parse!("1,2,3,4"), null);
        assert.equal(offset.parse!("w=1"), null);
        assert.equal(offset.parse!(",,"), null);
    });

    it("makes a composite reject a member given twice", () => {
        // Accepting it would silently discard one of the two values a reader wrote.
        assert.equal(offset.parse!("x=1,x=2"), null);
    });

    it("makes a composite reject a positional member after a named one", () => {
        // The same rule as a function call: once naming starts there is no position left for a bare value to mean.
        assert.equal(offset.parse!("z=3,5"), null);
        assert.equal(offset.parse!("5,z=3"), "5,,3");
    });

    it("makes every string type accept everything, which is what text is", () => {
        assert.equal(text.parse!("133"), "133");
        assert.equal(path.parse!(">m"), ">m");
    });
});

describe("defineType", () => {
    it("rejects a duplicate name", () => {
        assert.throws(
            () => defineType({name: "text", storage: "string", accepts: [present], hint: "x", ui: "text"}),
            /already defined/);
    });

    it("rejects an operator the registry has never heard of", () => {
        // A typo in `accepts` would otherwise leave the type silently declining the operator it meant to accept.
        const impostor = {name: "near", symbol: "~", form: "prefix", hint: "x"} as const;
        assert.throws(
            () => defineType({
                name: "spurious", storage: "string", accepts: [impostor], hint: "x", ui: "text",
            }),
            /unregistered operator "near"/);
    });

    it("rejects a value-bearing operator with nothing to read the value with", () => {
        assert.throws(
            () => defineType({
                name: "spurious", storage: "string", accepts: [exact], hint: "x", ui: "text",
            }),
            /cannot parse or format one/);
    });

    it("rejects units declared without an order", () => {
        // Text accepts neither, which is what keeps a percent sign inside a spell name from behaving like a unit.
        assert.throws(
            () => defineType<string>({
                name: "spurious", storage: "string", accepts: [exact, present],
                parse: (s) => s, format: (s) => s, units: {"%": 1}, hint: "x", ui: "text",
            }),
            /declares units but does not accept an order/);
    });
});
