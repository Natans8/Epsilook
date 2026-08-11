/* THE IN-MEMORY BACKEND's operator table — the bodies PLAN §3.2b moved off the
 * types.
 *
 * ⭐ THE HIGHEST-VALUE TEST HERE IS THE LAST ONE: every (operator, type) pair
 * a type ACCEPTS must either have an implementation or be a declared, reasoned
 * gap. Without it, `types.ts` and this file drift silently — a type gains an
 * operator, the backend never learns, and the query answers "no spells" rather
 * than answering at all. That is the exact failure mode the whole rewrite
 * exists to delete.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {coverage, matcher} from "../../src/search/backend/memory";
import {TYPES} from "../../src/search/types";

/** The two types this backend cannot answer yet, and why. Asserted below to
 *  be EXACTLY the gaps, so a third one cannot appear unnoticed. */
const DECLARED_GAPS = new Set(["bitmask", "ordinal"]);

describe("the textual family", () => {
    const run = (op: string, stored: string, operand: string): boolean =>
        matcher(op, "text")!(stored, operand);

    it("matches `contains` unanchored, which the corpus forces", () => {
        assert.equal(run("contains", "Fireball", "fire"), true);
        assert.equal(run("contains", "Fireball", "ball"), true);
        assert.equal(run("contains", "Fireball", "frost"), false);
    });

    it("folds both sides, so case and typography cannot strand a spell", () => {
        // SEARCH.md §4.9.9a: fold the CORPUS as well as the query. Three spell
        // names on 9.2.7 carry an em dash; folding one side only would make
        // them unreachable by a typed hyphen instead of more reachable.
        assert.equal(run("contains", "FIREBALL", "fire"), true);
        assert.equal(run("exact", "Anti—Magic", "anti-magic"), true);
    });

    it("matches `exact` against the WHOLE value, never a part", () => {
        assert.equal(run("exact", "Fireball", "Fireball"), true);
        assert.equal(run("exact", "Fireball", "fire"), false);
    });

    it("globs with `*` as the ONLY metacharacter", () => {
        const glob = (stored: string, pattern: string): boolean =>
            matcher("glob", "path")!(stored, pattern);
        assert.equal(glob("spells/fire_missile.m2", "spells/fire*"), true);
        assert.equal(glob("spells/fire_missile.m2", "*missile*"), true);
        assert.equal(glob("spells/fire_missile.m2", "*frost*"), false);
        // a path is full of characters a regex would otherwise read
        assert.equal(glob("elixir (greater).m2", "elixir (*"), true);
        assert.equal(glob("a+b.m2", "a+b*"), true);
        assert.equal(glob("axb.m2", "a+b*"), false, "`+` must be escaped, not quantified");
    });

    it("still matches beer when asked for bee*, and the hint says so", () => {
        // SEARCH.md §3.2: asset paths run words together, so there is no
        // boundary to anchor to. Measured, not assumed — and the reason the
        // ordered `+` operator was deleted.
        assert.equal(matcher("glob", "path")!("beerfest_keg01.m2", "bee*"), true);
    });

    it("reads `present` as having any text at all", () => {
        assert.equal(matcher("present", "text")!("Fireball", "*"), true);
        assert.equal(matcher("present", "text")!("", "*"), false);
    });
});

describe("the numeric family", () => {
    const run = (op: string, stored: number, operand: number): boolean =>
        matcher(op, "seconds")!(stored, operand);

    it("compares in storage units, where the pack holds integers", () => {
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

    it("sorts the bounds, so `90-10` means what `10-90` means", () => {
        // The grammar cannot tell them apart — `-` between two values is a
        // range whichever way round they are — and a silently empty result
        // would be L12 (4): a form that reads correctly and behaves otherwise.
        const range = matcher("range", "percent")!;
        assert.equal(range(50, [90, 10]), true);
    });

    it("treats `present` as true, because an absent property never gets here", () => {
        assert.equal(matcher("present", "count")!(0, "*"), true);
    });
});

describe("coverage", () => {
    it("implements every operator every type accepts, or declares the gap", () => {
        const missing: string[] = [];
        for (const type of TYPES.values()) {
            for (const operator of type.accepts) {
                if (matcher(operator.name, type.name)) continue;
                if (DECLARED_GAPS.has(type.name)) continue;
                // `flag` accepts only `present`, and a flag has no value: its
                // whole answer is whether the ROW exists, which is the
                // kernel's question and never reaches a matcher.
                if (type.name === "flag") continue;
                missing.push(`${operator.name}:${type.name}`);
            }
        }
        assert.deepEqual(missing, []);
    });

    it("has EXACTLY the two declared gaps, both waiting on pack data", () => {
        // bitmask: `target` is `2|8`, `area` is `4|16`, `both` is `1 AND 2` —
        //          the name -> bits table is a fact about the bits, so it
        //          belongs to whatever produces the rows.
        // ordinal: the ladder ships as pack.expansions, so a constant here
        //          would be a second copy of tools/expansions.py.
        const covered = new Set(coverage().map((pair) => pair.split(":")[1]));
        for (const gap of DECLARED_GAPS) {
            assert.equal(covered.has(gap), false, `${gap} is no longer a gap — update the list`);
        }
    });

    it("returns undefined for a gap rather than false, so it cannot read as an answer", () => {
        // A stub returning `false` would make `xpac:>legion` answer "no
        // spells" — a wrong answer that looks like a right one.
        assert.equal(matcher("gt", "ordinal"), undefined);
        assert.equal(matcher("exact", "bitmask"), undefined);
    });
});
