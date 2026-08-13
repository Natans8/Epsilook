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

import {exact, ORDERING, present} from "../../../src/search/vocabulary/operators";
import {
    angle, bitmask, colour, composite, count, defineType, enumeration, flag, id, length, offset,
    ordinal, path, percent, percentChange, seconds, setOrdinalLadder, TARGET_ROLES, text, TYPES,
} from "../../../src/search/vocabulary/value-types";

/** Canonical spellings. Every one is something `format` itself produces. */
const CANONICAL: [string, string[]][] = [
    ["text", ["Fireball", "Blood Pool", "anti-magic", "the \"real\" one", "100%"]],
    ["path", ["spells/fire_missile_01.m2", "beecreature.m2"]],
    ["enum", ["UNIT_TARGET_ENEMY", "JUMP_DEST"]],
    ["ordinal", ["Legion", "Wrath of the Lich King"]],
    ["bitmask", ["caster", "both"]],
    ["id", ["133", "0", "9007199254740991"]],
    ["count", ["0", "4", "128"]],
    ["seconds", ["1.5s", "0s", "120s"]],
    ["percent", ["30%", "0%", "7.5%"]],
    ["percentChange", ["+30%", "-30%", "+0%"]],
    ["length", ["5yd", "0.5yd"]],
    ["angle", ["60deg", "27.5deg"]],
    ["colour", ["#ff00aa", "#000000"]],
    ["offset", ["0yd,0yd,1yd", "1.5yd,-2yd,0yd", ",,3yd"]],
];

describe("the type registry", () => {
    it("holds exactly the catalogue", () => {
        assert.deepEqual([...TYPES.keys()].toSorted(), [
            "angle", "bitmask", "colour", "count", "enum", "flag", "id", "length", "offset", "ordinal",
            "path", "percent", "percentChange", "seconds", "text",
        ]);
    });

    it("keeps a size change one type, not one per spelling", () => {
        // A proportion and a factor are ways of WRITING a change, not different quantities: same storage, same
        // operators, same meaning. Declaring one type per notation made a property list three that never differed.
        assert.equal(TYPES.has("scale"), false);
        assert.equal(TYPES.has("proportion"), false);
        assert.equal(TYPES.has("multiplier"), false);
        assert.equal(percentChange.notations?.length, 3);
    });

    it("spells one size or speed change three ways, all reaching the same stored value", () => {
        // The data stores the CHANGE, because these auras accumulate by addition: two spells at +50% leave a
        // character at +100%, not at 2.25 times its size.
        for (const [change, asProportion, asFactor, stored] of
            [["+50", "150", "x1.5", 50], ["-50", "50", "x0.5", -50], ["+0", "100", "x1", 0]] as const) {
            for (const written of [change, asProportion, asFactor]) {
                assert.equal(percentChange.parse!(written), stored, written);
            }
            assert.equal(percentChange.format!(stored), `${stored > 0 ? "+" : stored === 0 ? "+" : ""}${stored}%`);
        }
    });

    it("splits a bare number at ten: a factor below, a proportion above", () => {
        // Ten is the ceiling of the game's own scale command, so a bare number in command range means what the
        // command means: scale:2 is double, exactly as .mod scale 2 is.
        assert.equal(percentChange.parse!("2"), 100, "double, as the command reads it");
        assert.equal(percentChange.parse!("10"), 900, "the command's ceiling still reads as a factor");
        assert.equal(percentChange.parse!("0.5"), -50, "half");
        assert.equal(percentChange.parse!("50"), -50, "above ten, a proportion of the original");
        assert.equal(percentChange.parse!("150"), 50);
        assert.equal(percentChange.parse!("7.5%"), -92.5, "an explicit percentage is a proportion");
        assert.equal(percentChange.parse!("+7.5"), 7.5, "a signed one is a change");
    });

    it("accepts a factor written either side of its number", () => {
        assert.equal(percentChange.parse!("x1.5"), percentChange.parse!("1.5x"));
        assert.equal(percentChange.parse!("×2"), 100);
    });

    it("keeps plain percent absolute, for a proportion of a whole", () => {
        // Transparency and desaturation are not measured from a baseline of a hundred, so they take no sign and no
        // offset: 50 is half.
        assert.equal(percent.parse!("50"), 50);
        assert.equal(percent.format!(50), "50%");
    });

    it("refuses a sign on an absolute percentage", () => {
        // A proportion has no direction, so a signed operand is refused rather than parsed into a value that means
        // nothing for a transparency.
        assert.equal(percent.parse!("-50"), null);
        assert.equal(percent.parse!("+50"), null);
    });

    it("reads a colour by its CSS name as well as by hex", () => {
        // The vocabulary is the web's own named-colour list, vendored verbatim, so a reader types the name they
        // already know and the nearness matching makes it mean "about this colour".
        assert.equal(colour.parse!("red"), 0xff0000);
        assert.equal(colour.parse!("REBECCAPURPLE"), 0x663399);
        assert.equal(colour.parse!("grey"), colour.parse!("gray"));
        assert.equal(colour.format!(colour.parse!("red")!), "#ff0000");
    });

    it("refuses a role name the target mask does not have", () => {
        // The roles are a closed vocabulary, so a mistyped one is a diagnostic rather than a silently empty result.
        assert.equal(bitmask.parse!("caster"), "caster");
        assert.equal(bitmask.parse!("CASTER"), "caster");
        assert.equal(bitmask.parse!("everyone"), null);
        assert.deepEqual([...TARGET_ROLES].toSorted(), [...TARGET_ROLES]);
    });

    it("refuses an ordinal no loaded rung contains, and accepts anything when no ladder is loaded", () => {
        // The ladder is pack data: once loaded, the pack defines the vocabulary and an unknown expansion is refused
        // at parse; with nothing loaded there is nothing to refuse against.
        setOrdinalLadder(["Classic", "Legion"]);
        try {
            assert.equal(ordinal.parse!("Legion"), "Legion");
            assert.equal(ordinal.parse!("leg"), "leg", "a partial rung still parses");
            assert.equal(ordinal.parse!("Midnight"), null);
        } finally {
            setOrdinalLadder([]);
        }
        assert.equal(ordinal.parse!("Midnight"), "Midnight");
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
        // and what turns `name:>m` into an error rather than a substring search for the characters. Free text and
        // paths additionally take a regular expression; an enum's closed vocabulary does not need one.
        for (const type of [text, path]) {
            assert.deepEqual(accepts(type), ["anyOf", "contains", "exact", "glob", "present", "regex"], type.name);
        }
        assert.deepEqual(accepts(enumeration), ["anyOf", "contains", "exact", "glob", "present"]);
    });

    it("gives an ordinal everything an enum has, plus the ordering", () => {
        assert.deepEqual(accepts(ordinal),
            ["anyOf", "contains", "exact", "glob", "gt", "gte", "lt", "lte", "present", "range"]);
    });

    it("gives an id equality only, with no ordering, substring or glob", () => {
        // One spell id is not "before" another in any sense a reader means, and matching part of an id is how a
        // six-digit number comes to select hundreds of rows instead of one.
        assert.deepEqual(accepts(id), ["anyOf", "exact", "present"]);
    });

    it("gives a bitmask equality only, so part of a role name never matches", () => {
        assert.deepEqual(accepts(bitmask), ["anyOf", "exact", "present"]);
    });

    it("gives a flag presence only, and no value at all", () => {
        assert.deepEqual(accepts(flag), ["present"]);
        assert.equal(flag.storage, null);
        assert.equal(flag.parse, undefined);
        assert.equal(flag.format, undefined);
    });

    it("gives the numeric family equality, ordering and presence, never substring", () => {
        for (const type of [count, seconds, percent, percentChange, length, angle]) {
            assert.deepEqual(accepts(type),
                ["anyOf", "exact", "gt", "gte", "lt", "lte", "present", "range"], type.name);
        }
    });

    it("keeps count answering every operator a column-head comparison can spell", () => {
        // A lone comparison at a column head is the count question — `model:>4` desugars to `model:{count:>4}` at
        // parse time — so whatever operator that spelling carries lands on this type. Each one must stay accepted,
        // or the desugar would turn the spelling into a declined-operator error.
        for (const op of ["exact", ...ORDERING.map((o) => o.name)]) {
            assert.ok(accepts(count).includes(op), op);
        }
    });

    it("gives a colour approximate matching but no ordering", () => {
        // A bare colour asks "about this shade", which is the question a reader has; ordering three channels at once
        // has no meaning.
        assert.deepEqual(accepts(colour), ["anyOf", "contains", "exact", "present"]);
    });

    it("gives a composite equality and presence only", () => {
        // Alternation is declined: a composite's own components are comma-separated, so a group of alternatives
        // inside one would need a second level of delimiter to read unambiguously.
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

    it("makes a colour reject anything that is neither a hex triplet nor a known name", () => {
        assert.equal(colour.parse!("#fff"), null);
        assert.equal(colour.parse!("#ff00gg"), null);
        assert.equal(colour.parse!("notacolour"), null);
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

    it("folds a value to the declared casing on format, and only there", () => {
        // The path corpus is all-lowercase (33,199 of 33,199 on 9.2.7), so that is how a path reads back.
        assert.equal(path.format!("Spells/FEL_FIRE.M2"), "spells/fel_fire.m2");
        assert.equal(path.parse!("Spells/FEL_FIRE.M2"), "Spells/FEL_FIRE.M2");
        // Text declares no casing: name corpora are mixed-case, so a value keeps the case it was written with.
        assert.equal(text.format!("Fireball"), "Fireball");
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
        const impostor = {name: "near", symbol: "~", form: "prefix", level: "value", hint: "x"} as const;
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

    it("rejects a casing on a type with no value to case", () => {
        assert.throws(
            () => defineType({
                name: "spurious", storage: null, casing: "lower", accepts: [present], hint: "x", ui: "toggle",
            }),
            /carries no value to case/);
    });

    it("rejects notations declared without an order", () => {
        // Text accepts neither, which is what keeps a percent sign inside a spell name from behaving like a unit.
        assert.throws(
            () => defineType<string>({
                name: "spurious", storage: "string", accepts: [exact, present],
                parse: (s) => s, format: (s) => s,
                notations: [{unit: "%", factor: 1}], hint: "x", ui: "text",
            }),
            /declares notations but does not accept an order/);
    });
});
