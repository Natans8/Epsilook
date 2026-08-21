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

import {exact, ORDERING, present} from "../../../../src/search/vocabulary/operators";
import type {Rung} from "../../../../src/search/vocabulary/value-types";
import {
    angle, animKitId, bitmask, channelId, colour, composite, count, creatureId, defineType, displayId, enumeration,
    fileId, flag, isIdentity, itemId, length, multiplier, objectId, offset, ordinal, path, percent, percentChange,
    rotation, seconds, setOrdinalLadder, soundKitId, spellId, TARGET_ROLES, text, TYPES,
} from "../../../../src/search/vocabulary/value-types";

/** Four rungs of a real ladder, synonyms and all — enough for every reading rule to have a case that separates it. */
const LADDER: Rung[] = [
    {word: "Vanilla", reads: ["vanilla", "classic", "1"]},
    {word: "TBC", reads: ["tbc", "bc", "burning crusade", "2"]},
    {word: "WoD", reads: ["wod", "warlords", "draenor", "6"]},
    {word: "DF", reads: ["dragonflight", "10"]},
];

/**
 * Runs a body against a loaded ladder, and puts the empty one back whatever happens.
 *
 * The ladder is module-level state the whole file shares, so a test that left one loaded would decide the
 * outcome of every test declared after it.
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

/** Canonical spellings. Every one is something `format` itself produces. */
const CANONICAL: [string, string[]][] = [
    ["text", ["Fireball", "Blood Pool", "anti-magic", "the \"real\" one", "100%"]],
    ["path", ["spells/fire_missile_01.m2", "beecreature.m2"]],
    ["enum", ["UNIT_TARGET_ENEMY", "JUMP_DEST"]],
    ["ordinal", ["Legion", "Wrath of the Lich King"]],
    ["bitmask", ["caster", "both"]],
    ["spellId", ["133", "0", "9007199254740991"]],
    ["soundKitId", ["1234"]],
    ["creatureId", ["299"]],
    ["objectId", ["180000"]],
    ["displayId", ["307"]],
    ["itemId", ["19019"]],
    ["fileId", ["135812"]],
    ["animKitId", ["1119"]],
    ["channelId", ["0", "3"]],
    ["count", ["0", "4", "128"]],
    ["seconds", ["1.5s", "0s", "120s"]],
    ["percent", ["30%", "0%", "7.5%"]],
    ["percentChange", ["+30%", "-30%", "+0%"]],
    ["length", ["5yd", "0.5yd"]],
    ["coordinate", ["5yd", "-2yd", "0yd"]],
    ["angle", ["60deg", "27.5deg"]],
    ["colour", ["#ff00aa", "#000000"]],
    ["offset", ["0yd,0yd,1yd", "1.5yd,-2yd,0yd", ",,3yd"]],
    ["rotation", ["90deg,0deg,0deg", ",90deg,", "0deg,0deg,0deg"]],
    ["multiplier", ["x1.5", "x1", "x0.5"]],
];

describe("the type registry", () => {
    it("holds exactly the catalogue", () => {
        assert.deepEqual([...TYPES.keys()].toSorted(), [
            "angle", "animKitId", "bitmask", "channelId", "colour", "coordinate",
            "count", "creatureId", "displayId", "enum", "fileId", "flag",
            "itemId", "length", "multiplier", "objectId", "offset", "ordinal",
            "path", "percent", "percentChange", "rotation", "seconds", "soundKitId",
            "spellId", "text",
        ]);
    });

    it("keeps a size change one type, not one per spelling", () => {
        // A proportion and a factor are ways of WRITING a change, not different quantities: same storage, same
        // operators, same meaning. Declaring one type per notation made a property list three that never differed.
        assert.equal(TYPES.has("scale"), false);
        assert.equal(TYPES.has("proportion"), false);
        assert.equal(percentChange.notations?.length, 3);
    });

    it("keeps an absolute size apart from a change, which is a different quantity and not a spelling", () => {
        // `multiplier` is not the factor NOTATION of a change under another name -- the rule above still holds. A
        // size aura stores the CHANGE and composes by addition, because two of them at +50% leave a character at
        // +100%. An attached model's scale is the size it is drawn at and stacks with nothing, so unchanged is one
        // and not nought. Storing them alike is what would make `x1` mean two things.
        assert.equal(percentChange.parse!("x1"), 0, "no change");
        assert.equal(multiplier.parse!("x1"), 1000, "native size, in thousandths");
        assert.equal(multiplier.parse!("150%"), 1500, "a proportion says the same thing");
        assert.equal(multiplier.parse!("2"), 2000, "a bare number in command range is a factor");
        assert.equal(multiplier.parse!("150"), 1500, "above ten it is a proportion");
        assert.equal(multiplier.parse!("-2"), null, "a size has no direction");
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

    it("refuses an ordinal no loaded rung answers to, and accepts anything when no ladder is loaded", () => {
        // The ladder is pack data: once loaded, the pack defines the vocabulary and an unknown expansion is refused
        // at parse; with nothing loaded there is nothing to refuse against.
        withLadder([{word: "Classic", reads: []}, {word: "Legion", reads: []}], () => {
            assert.equal(ordinal.parse!("Legion"), "Legion");
            assert.equal(ordinal.parse!("leg"), null, "a partial name reaches no rung");
            assert.equal(ordinal.parse!("Midnight"), null);
        });
        assert.equal(ordinal.parse!("Midnight"), "Midnight");
    });

    it("names the rung a synonym reached, because a rung has one name", () => {
        // Every spelling the pack declares is a way IN. What comes back is what the expansion is called, so the
        // number that reached it never survives to be quoted as a string by the formatter.
        withLadder(LADDER, () => {
            assert.equal(ordinal.parse!("6"), "WoD");
            assert.equal(ordinal.parse!("warlords"), "WoD");
            assert.equal(ordinal.parse!("wod"), "WoD");
            assert.equal(ordinal.parse!("WoD"), "WoD");
            assert.equal(ordinal.parse!("draen"), null, "a half-typed synonym reaches nothing");
        });
    });

    it("answers only to a whole spelling, so no rung swallows another's characters", () => {
        // `1` is Vanilla's own alias and also sits inside `10`, and `wo` opens both WotLK and WoD. A containment
        // scan answered all three from whichever rung stood first.
        withLadder(LADDER, () => {
            assert.equal(ordinal.parse!("1"), "Vanilla");
            assert.equal(ordinal.parse!("10"), "DF");
            assert.equal(ordinal.parse!("0"), null, "and nought is nobody, though 10 carries the character");
            assert.equal(ordinal.parse!("bc"), "TBC");
        });
    });

    it("names no rung for nothing typed, which every spelling would otherwise contain", () => {
        // A containment scan takes the empty string as a substring of everything, so an empty operand would be
        // handed whichever rung happens to stand first — silently, and as a valid ask.
        withLadder(LADDER, () => {
            assert.equal(ordinal.parse!(""), null);
            assert.equal(ordinal.parse!("  "), null, "and neither does whitespace that squashes away");
        });
    });

    it("declares its values named, which is what stops a surface upholding the way in", () => {
        // The display rule reads this flag rather than the type's identity, so a second named vocabulary needs
        // no change anywhere above it.
        assert.equal(ordinal.named, true);
        assert.notEqual(percent.named, true, "a notation IS information about how the reader thinks");
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
        assert.deepEqual(accepts(spellId), ["anyOf", "exact", "present"]);
    });

    it("reads and writes every identity alike, whatever its number names", () => {
        // The family exists so a SURFACE can tell a spell id from a file id. Matching cannot, and must not: an
        // operand that parses one way here and another way there would make the same digits mean two things.
        const family = [animKitId, channelId, creatureId, displayId, fileId, itemId, objectId, soundKitId, spellId];
        for (const type of family) {
            assert.deepEqual(accepts(type), ["anyOf", "exact", "present"], type.name);
            assert.equal(type.storage, "int", type.name);
            assert.equal(type.quantity, true, type.name);
            assert.equal(type.parse!("133"), 133, type.name);
            assert.equal(type.parse!("frostbolt"), null, type.name);
            assert.equal(type.parse!("-1"), null, type.name);
            assert.equal(type.format!(133), "133", type.name);
        }
    });

    it("knows its own members, and claims no type that is not one", () => {
        // The question every surface asks is "is this an identity", and asking it by comparing against one member
        // answers for that member alone -- which is how a family quietly stops being recognised as it grows.
        const family = [animKitId, channelId, creatureId, displayId, fileId, itemId, objectId, soundKitId, spellId];
        for (const type of family) assert.ok(isIdentity(type), type.name);
        for (const type of [count, text, path, enumeration, ordinal, colour, flag, bitmask, angle]) {
            assert.equal(isIdentity(type), false, type.name);
        }
        assert.equal(isIdentity(undefined), false);
    });

    it("registers every identity under its own name, so no two share a declaration", () => {
        const family = [animKitId, channelId, creatureId, displayId, fileId, itemId, objectId, soundKitId, spellId];
        const names = family.map((type) => type.name);
        assert.equal(new Set(names).size, family.length);
        for (const type of family) assert.equal(TYPES.get(type.name), type, type.name);
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
        assert.equal(offset.parse!("1yd,2yd,3yd"), "1000,2000,3000");
        assert.equal(offset.format!("1000,2000,3000"), "1yd,2yd,3yd");
    });

    it("lets a composite be constrained by naming one member", () => {
        assert.equal(offset.parse!("z=3"), ",,3000");
        assert.equal(offset.parse!("z=3"), offset.parse!(",,3"));
    });

    it("shows a component it has no member for rather than failing to render", () => {
        // Stored values come from the game data, where a later version adding a component should degrade visibly.
        assert.equal(offset.format!("1000,2000,3000,4"), "1yd,2yd,3yd,4");
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
        assert.equal(spellId.accepts.includes(ORDERING[0]), false);
    });
});

describe("what each type refuses to parse", () => {
    it("makes an id reject anything that is not safe digits", () => {
        assert.equal(spellId.parse!("frostbolt"), null);
        assert.equal(spellId.parse!("1.5"), null);
        assert.equal(spellId.parse!("-1"), null);
        assert.equal(spellId.parse!(""), null);
        // Beyond the safe integer range the value no longer survives a round trip.
        assert.equal(spellId.parse!("99999999999999999999"), null);
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
        // Stored in thousandths of a yard, the way a duration is stored in milliseconds: a component parses through
        // its own type, so the composite carries whatever scale that type declares.
        assert.equal(offset.parse!("5,z=3"), "5000,,3000");
    });

    it("stores a position and a rotation as the fixed-point their types declare", () => {
        // Thousandths of a yard and tenths of a degree, so both ship as whole numbers. The scale is the type's, not
        // the composite's -- a composite parses each component through the type that member names.
        assert.equal(offset.parse!("0.035,-5,3"), "35,-5000,3000");
        assert.equal(rotation.parse!("90,0,0"), "900,0,0");
        assert.equal(rotation.parse!("pitch=90"), ",900,");
    });

    it("writes a position and a rotation back in the units they were written in", () => {
        assert.equal(offset.format!("35,-5000,3000"), "0.035yd,-5yd,3yd");
        assert.equal(rotation.format!("900,0,0"), "90deg,0deg,0deg");
    });

    it("makes every string type accept everything, which is what text is", () => {
        assert.equal(text.parse!("133"), "133");
        assert.equal(path.parse!(">m"), ">m");
    });

    it("folds a value to the declared casing on format, and only there", () => {
        // No shipped type declares a casing, so the mechanism is exercised through one defined here. Folding on
        // format and not on parse is the whole point: the stored value stays what the corpus holds.
        const shouty = defineType<string>({
            name: "shouty", storage: "string", parse: (s) => s, format: (s) => s,
            casing: "upper", accepts: [present], hint: "x", ui: "text",
        });
        assert.equal(shouty.format!("Spells/Fel_Fire.m2"), "SPELLS/FEL_FIRE.M2");
        assert.equal(shouty.parse!("Spells/Fel_Fire.m2"), "Spells/Fel_Fire.m2");
    });

    it("keeps a path's own case, because the corpus is mixed", () => {
        // The listfile is taken in its capitalised form, since these paths are shown to a reader rather than only
        // matched against. Most carry real casing, so folding them would make every one of those read wrong.
        assert.equal(path.format!("Spells/FEL_FIRE.M2"), "Spells/FEL_FIRE.M2");
        assert.equal(path.parse!("Spells/FEL_FIRE.M2"), "Spells/FEL_FIRE.M2");
        // Text declares no casing either: name corpora are mixed-case for the same reason.
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
