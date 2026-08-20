/**
 * @file Applying one operator to one stored value.
 *
 * The coverage test at the end is the one that earns its keep. Every (operator, type) pair a type accepts must have an
 * implementation here; without that assertion the accepted-operator table and this one drift apart silently, and a
 * type that gains an operator answers "nothing matches" rather than answering at all.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {matcher, roleNames, verbatimContains} from "../../../../src/search/evaluate/value-matching";
import type {Rung} from "../../../../src/search/vocabulary/value-types";
import {setOrdinalLadder, TARGET_ROLES, TYPES} from "../../../../src/search/vocabulary/value-types";

describe("the textual family", () => {
    const run = (op: string, stored: string, operand: string): boolean =>
        matcher(op, "text")!(stored, operand);

    it("matches a bare token anywhere in the value", () => {
        assert.equal(run("contains", "Fireball", "fire"), true);
        assert.equal(run("contains", "Fireball", "ball"), true);
        assert.equal(run("contains", "Fireball", "frost"), false);
    });

    it("normalises both sides, so case and typography cannot strand a value", () => {
        // Normalising the query alone would make a name carrying an em dash unreachable by a typed hyphen rather than
        // more reachable.
        assert.equal(run("contains", "FIREBALL", "fire"), true);
        assert.equal(run("exact", "Anti—Magic", "anti-magic"), true);
    });

    it("ignores punctuation when matching part of a value", () => {
        assert.equal(run("contains", "Anti-Magic Shell", "antimagic"), true);
        assert.equal(run("contains", "Anti-Magic Shell", "magicshell"), true);
    });

    it("a quoted operand matches its characters as written — quotes are strict", () => {
        // Case and typography still fold; punctuation and spaces stay. The bare spelling's squash is what the
        // quotes opt out of, which is also what makes punctuation searchable at all.
        assert.equal(verbatimContains("Anti-Magic Shell", "anti-magic"), true);
        assert.equal(verbatimContains("Anti-Magic Shell", "antimagic"), false);
        assert.equal(verbatimContains('"Well Fed"', '"well fed"'), true);
        assert.equal(verbatimContains("Mark \"S\" Boomstick", '"s"'), true);
        assert.equal(verbatimContains("A-a", "-a"), true);
        assert.equal(verbatimContains("Aa", "-a"), false);
        assert.equal(verbatimContains("Anti—Magic", "anti-magic"), true);
        // An empty phrase asks for nothing and selects nothing.
        assert.equal(verbatimContains("Fireball", ""), false);
    });

    it("keeps exact matching against the whole value, never a part", () => {
        assert.equal(run("exact", "Fireball", "Fireball"), true);
        assert.equal(run("exact", "Fireball", "fire"), false);
    });

    it("treats a star as the only metacharacter in a pattern", () => {
        const glob = (stored: string, pattern: string): boolean =>
            matcher("glob", "path")!(stored, pattern);
        assert.equal(glob("spells/fire_missile.m2", "spells/fire*"), true);
        assert.equal(glob("spells/fire_missile.m2", "*missile*"), true);
        assert.equal(glob("spells/fire_missile.m2", "*frost*"), false);
        // A path is full of characters a regular expression would otherwise read as syntax.
        assert.equal(glob("elixir (greater).m2", "elixir(*"), true);
        assert.equal(glob("a+b.m2", "a+b*"), true);
    });

    it("still matches beer when asked for bee", () => {
        // Asset paths run words together, so there is no boundary to anchor a pattern to.
        assert.equal(matcher("glob", "path")!("beerfest_keg01.m2", "bee*"), true);
    });

    it("reads presence as having any text at all", () => {
        assert.equal(matcher("present", "text")!("Fireball", "*"), true);
        assert.equal(matcher("present", "text")!("", "*"), false);
    });
});

describe("regular expressions", () => {
    const run = (stored: string, pattern: string): boolean => matcher("regex", "text")!(stored, pattern);

    it("matches case-insensitively, which is the family convention", () => {
        assert.equal(run("Fireball", "^fire"), true);
        assert.equal(run("Fireball", "BALL$"), true);
    });

    it("runs against the stored text as written — punctuation is not squashed away", () => {
        assert.equal(run("Anti-Magic Shell", "anti-magic"), true);
        assert.equal(run("Anti-Magic Shell", "antimagic"), false);
        assert.equal(run("Zul'jin", "zul'jin"), true);
    });

    it("answers false for a pattern that does not compile, and stays false when asked again", () => {
        assert.equal(run("Fireball", "fire("), false);
        assert.equal(run("Fireball", "fire("), false);
    });

    it("answers false for an operand that is not text", () => {
        assert.equal(matcher("regex", "path")!("spells/fire.m2", "fire"), true);
        const range = matcher("regex", "text")!;
        assert.equal(range("Fireball", ["a", "z"]), false);
    });
});

describe("the numeric family", () => {
    const run = (op: string, stored: number, operand: number): boolean =>
        matcher(op, "seconds")!(stored, operand);

    it("compares in storage units, where the data holds integers", () => {
        assert.equal(run("exact", 1500, 1500), true);
        assert.equal(run("lt", 1500, 2000), true);
        assert.equal(run("lte", 1500, 1500), true);
        assert.equal(run("gt", 1500, 1000), true);
        assert.equal(run("gte", 1500, 1500), true);
        assert.equal(run("gt", 1500, 1500), false);
    });

    it("reads a range inclusively at both ends", () => {
        const range = matcher("range", "percent")!;
        assert.equal(range(10, [10, 90]), true);
        assert.equal(range(90, [10, 90]), true);
        assert.equal(range(50, [10, 90]), true);
        assert.equal(range(9, [10, 90]), false);
    });

    it("sorts the bounds, so a descending range means what an ascending one means", () => {
        // A hyphen between two values is a range whichever way round they are, so the grammar cannot tell them apart.
        // Returning nothing for one of them would be a query that reads correctly and behaves otherwise.
        const range = matcher("range", "percent")!;
        assert.equal(range(50, [90, 10]), true);
    });

    it("treats presence as true, because an absent property never reaches a matcher", () => {
        assert.equal(matcher("present", "count")!(0, "*"), true);
    });
});

describe("colours", () => {
    const near = matcher("contains", "colour")!;

    it("matches a nearby shade for a bare colour", () => {
        assert.equal(near(0xff0000, 0xf50505), true);
        assert.equal(near(0xff0000, 0x00ff00), false);
    });

    it("keeps exact matching exact", () => {
        const same = matcher("exact", "colour")!;
        assert.equal(same(0xff00aa, 0xff00aa), true);
        assert.equal(same(0xff00aa, 0xff00ab), false);
    });
});

describe("target roles", () => {
    const plays = (mask: number, role: string): boolean => matcher("exact", "bitmask")!(mask, role);

    it("names the roles a query may use", () => {
        assert.deepEqual(roleNames(), ["area", "both", "caster", "others", "target"]);
    });

    it("realises exactly the vocabulary the type declares", () => {
        // The names live on the declaration side so parsing can refuse a stranger; the bits live here. This is the
        // seam between them, held together by assertion rather than by memory.
        assert.deepEqual(roleNames(), [...TARGET_ROLES]);
    });

    it("reads a role that spans two bits as either of them", () => {
        assert.equal(plays(2, "target"), true);
        assert.equal(plays(8, "target"), true);
        assert.equal(plays(1, "target"), false);
    });

    it("reads `both` as a conjunction no single bit spells", () => {
        assert.equal(plays(1 | 2, "both"), true);
        assert.equal(plays(1, "both"), false);
        assert.equal(plays(2, "both"), false);
    });

    it("refuses a role name it does not know rather than matching everything", () => {
        assert.equal(plays(255, "everyone"), false);
    });
});

/** A ladder of plain names, no rung answering to anything but itself. */
const rungs = (...words: string[]): Rung[] => words.map((word) => ({word, reads: []}));

describe("ordinals", () => {
    it("compares by rank once a ladder is supplied", () => {
        setOrdinalLadder(rungs("Classic", "Burning Crusade", "Wrath of the Lich King", "Legion"));
        assert.equal(matcher("gt", "ordinal")!("Legion", "Classic"), true);
        assert.equal(matcher("lt", "ordinal")!("Classic", "Legion"), true);
        assert.equal(matcher("range", "ordinal")!("Burning Crusade", ["Classic", "Legion"]), true);
    });

    it("refuses a rung the ladder does not hold rather than guessing its place", () => {
        setOrdinalLadder(rungs("Classic", "Legion"));
        assert.equal(matcher("gt", "ordinal")!("Midnight", "Classic"), false);
        assert.equal(matcher("gt", "ordinal")!("Legion", "Midnight"), false);
    });

    it("refuses a partial rung rather than picking one of the rungs it could mean", () => {
        // `leg` is not a weaker claim on Legion, it is a claim on every rung carrying those letters. There is
        // nothing to rank between those, so the surface offers the names and the reader writes one.
        setOrdinalLadder(rungs("Classic", "Burning Crusade", "Legion"));
        assert.equal(matcher("exact", "ordinal")!("Legion", "leg"), false);
        assert.equal(matcher("gt", "ordinal")!("Legion", "burning"), false);
        assert.equal(matcher("exact", "ordinal")!("Legion", "Legion"), true);
    });

    it("reads a bare rung as its name, not as a substring of the stored spelling", () => {
        // The regression this pins: a rung whose name and stored key differ (SL against shadowlands) shares no
        // substring with itself, so a `contains` doing text matching answered nought for a whole expansion.
        setOrdinalLadder([{word: "Shadowlands", reads: ["sl", "9"]}, {word: "DF", reads: ["dragonflight"]}]);
        assert.equal(matcher("contains", "ordinal")!("sl", "Shadowlands"), true);
        assert.equal(matcher("contains", "ordinal")!("dragonflight", "DF"), true);
        assert.equal(matcher("contains", "ordinal")!("sl", "DF"), false);
    });
});

describe("composites", () => {
    const same = matcher("exact", "offset")!;

    it("matches every member a query states", () => {
        assert.equal(same("1,2,3", "1,2,3"), true);
        assert.equal(same("1,2,3", "1,2,4"), false);
    });

    it("ignores a member a query leaves blank", () => {
        assert.equal(same("1,2,3", "1"), true);
        assert.equal(same("1,2,3", ",,3"), true);
        assert.equal(same("1,2,3", ",,4"), false);
    });

    it("compares members numerically, so trailing zeroes do not decide a match", () => {
        assert.equal(same("1.5,0,0", "1.50,,"), true);
    });

    it("never matches a component the stored value does not have", () => {
        // A blank stored component means the row has no value there. Comparing it numerically would read it as zero,
        // so a query for x=0 would select every row missing an x.
        assert.equal(same(",,3", "0"), false);
        assert.equal(same(",,3", ",,3"), true);
    });
});

describe("alternation", () => {
    it("selects what each alternative selects, on anything textual", () => {
        // A group of alternatives means the same as writing the alternatives separately, so each one gets the reading
        // a bare token already has.
        const any = matcher("anyOf", "text")!;
        assert.equal(any("Fireball", ["fire", "frost"]), true);
        assert.equal(any("Frostbolt", ["fire", "frost"]), true);
        assert.equal(any("Arcane Blast", ["fire", "frost"]), false);
    });

    it("compares numerically where a bare token is an equality test", () => {
        const any = matcher("anyOf", "id")!;
        assert.equal(any(133, [133, 116]), true);
        assert.equal(any(999, [133, 116]), false);
    });

    it("reads a lone operand as a list of one", () => {
        assert.equal(matcher("anyOf", "text")!("Fireball", "fire"), true);
    });

    it("names roles, so a target can be either of two", () => {
        assert.equal(matcher("anyOf", "bitmask")!(4, ["caster", "area"]), true);
        assert.equal(matcher("anyOf", "bitmask")!(2, ["caster", "area"]), false);
    });
});

describe("operand shape", () => {
    it("refuses a range operand on every textual operator rather than matching everything", () => {
        // A range reduced to an empty string would satisfy `contains` for every stored value, which is the worst
        // possible reading of an operand the operator does not accept.
        for (const op of ["contains", "exact", "glob"]) {
            assert.equal(matcher(op, "text")!("Fireball", ["a", "b"]), false, op);
        }
        assert.equal(matcher("contains", "ordinal")!("Legion", ["a", "b"]), false);
    });

    it("refuses a range operand on roles and composites", () => {
        assert.equal(matcher("exact", "bitmask")!(3, ["caster", "target"]), false);
        assert.equal(matcher("exact", "offset")!("1,2,3", ["1", "2"]), false);
    });

    it("refuses a range operand on a single-value comparison", () => {
        assert.equal(matcher("exact", "seconds")!(1500, [1000, 2000]), false);
        assert.equal(matcher("lt", "seconds")!(1500, [1000, 2000]), false);
    });
});

describe("coverage", () => {
    it("implements every operator every type accepts", () => {
        const missing: string[] = [];
        for (const type of TYPES.values()) {
            for (const operator of type.accepts) {
                if (matcher(operator.name, type.name)) continue;
                // A flag carries no value: its whole answer is whether the row exists at all, which the kernel decides
                // without consulting a matcher.
                if (type.name === "flag") continue;
                missing.push(`${operator.name}:${type.name}`);
            }
        }
        assert.deepEqual(missing, []);
    });
});
