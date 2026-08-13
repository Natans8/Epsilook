/**
 * @file The simplifier, proved rule by rule: the registry's own examples are the fixture table.
 *
 * Three properties hold every fixture together. Each documented example rewrites to exactly its documented target;
 * each rewrite is answer-equal to its input on the synthetic world — the world that separates each law's sides, so
 * an unsound rewrite has a spell that exposes it; and each target is stable, both as a canonical spelling and
 * under a second simplification. The boundaries are tested as refusals: a query a boundary protects comes back
 * with no rule applied.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {formatQuery} from "../../../src/search/language/format";
import {KEPT, RULES} from "../../../src/search/rewrite/rules";
import {equivalent, simplify, suggestions} from "../../../src/search/rewrite/simplify";

import {answers, complement, EVERY, parsed} from "../world";

/** The canonical spelling of a query string, with no simplification. */
const canonical = (query: string): string => formatQuery(parsed(query));

/** The canonical spelling of a query string after simplification. */
const simplified = (query: string): string => formatQuery(simplify(parsed(query)).parsed);

const SIMPLIFY_RULES = RULES.filter((rule) => rule.tier === "simplify");
const FORMAT_RULES = RULES.filter((rule) => rule.tier === "format");

describe("the rule examples", () => {
    for (const rule of SIMPLIFY_RULES) {
        it(`${rule.id} ${rule.name}: every example lands on its target`, () => {
            for (const {from, to} of rule.examples) {
                assert.equal(simplified(from), to, from);
            }
        });
    }

    for (const rule of FORMAT_RULES) {
        it(`${rule.id} ${rule.name}: every example is the canonical spelling, with no rule fired`, () => {
            for (const {from, to} of rule.examples) {
                assert.equal(canonical(from), to, from);
            }
        });
    }

    it("every non-empty target is itself canonical and simplifies to itself", () => {
        for (const rule of RULES) {
            for (const {to} of rule.examples) {
                if (to === "") continue;
                assert.equal(canonical(to), to, to);
                assert.equal(simplified(to), to, to);
            }
        }
    });

    it("every rewrite is answer-equal to its input on the world", () => {
        for (const rule of SIMPLIFY_RULES) {
            for (const {from, to} of rule.examples) {
                const before = parsed(from);
                const after = simplify(before).parsed;
                assert.deepEqual(answers(after), answers(before), from);
                assert.deepEqual(answers(parsed(to)), answers(before), `${from} vs "${to}"`);
            }
        }
    });

    it("simplification is idempotent over every example", () => {
        for (const rule of SIMPLIFY_RULES) {
            for (const {from} of rule.examples) {
                const once = simplify(parsed(from));
                const twice = simplify(once.parsed);
                assert.equal(formatQuery(twice.parsed), formatQuery(once.parsed), from);
            }
        }
    });
});

describe("the boundaries, as refusals", () => {
    /** Asserts that no rule touches the query: what comes back is what went in. */
    function untouched(query: string): void {
        const result = simplify(parsed(query));
        assert.deepEqual(result.applied, [], query);
        assert.equal(formatQuery(result.parsed), canonical(query), query);
    }

    it("B1 rows-stay-apart: two clauses never fuse into one scope, and the world tells them apart", () => {
        untouched("model:fire model:frost");
        // Flame Shield holds a fire attachment beside an arcane missile: the clause pair admits it, the scope
        // refuses it — so any rule that fused them would move this answer.
        assert.notDeepEqual(answers(parsed("model:fire model:missile")), answers(parsed("model:{fire missile}")));
        assert.ok(!equivalent(parsed("model:fire model:missile"), parsed("model:{fire missile}")));
    });

    it("B4 no-demorgan: a disjunction of negations stays two groups", () => {
        untouched("-model:fire | -model:frost");
    });

    it("B5 patterns-opaque: regex bodies join no implication, while a glob's literal runs do", () => {
        untouched("name:/fire/ name:/^fire/");
        assert.equal(simplified("model:fireball* model:fire"), "model:fireball*");
    });

    it("B7 existentials-stay-apart: bounds fuse across clauses only on a kind declared single", () => {
        // Scale rows may repeat on one spell, so its clauses stay existentials; a delivery row cannot.
        untouched("scale:>=+10% scale:<=+50%");
        assert.equal(simplified("cast>=2s cast<=5s"), "cast:2s-5s");
        assert.equal(simplified("spell:{cast>=2s cast<=5s}"), "cast:2s-5s");
    });

    it("a contradiction across single-kind clauses, or inside one row, is an empty meet", () => {
        assert.equal(simplified("cast=2s cast=4s | name:frost"), "name:frost");
        const whole = simplify(parsed("spell:{cast=2s cast=4s}"));
        assert.deepEqual(whole.applied, []);
        assert.equal(whole.notes.length, 1);
    });

    it("B8 unsat-unspelled: a fully contradictory query is returned as written, with a note", () => {
        const result = simplify(parsed("model:fire -model:fire"));
        assert.deepEqual(result.applied, []);
        assert.equal(formatQuery(result.parsed), canonical("model:fire -model:fire"));
        assert.equal(result.notes.length, 1);
    });

    it("B9 every-dataset: a value the pack happens to lack is still a constraint", () => {
        untouched("model:fire model:qqqq");
    });

    it("B11 conservative: ordinal rungs across different operands stay untouched", () => {
        untouched("xpac>tbc xpac>wotlk");
    });

    it("B3 notation-upheld: the written tier survives simplification on every untouched value", () => {
        const result = simplify(parsed("model:fire model:fire scale:x1.5"));
        assert.deepEqual(result.applied, ["R1"]);
        assert.equal(formatQuery(result.parsed, "written"), "model:fire scale=x1.5");
    });

    it("the registry states every boundary of the law", () => {
        assert.deepEqual(
            KEPT.map((boundary) => boundary.id),
            ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11"],
        );
    });
});

describe("standalone suggestions", () => {
    it("offers each applicable rule alone, leaving the other defects in place", () => {
        const offers = suggestions(parsed("model:fire model:fire cast:5s-2s"));
        const byId = new Map(offers.map((offer) => [offer.rule.id, formatQuery(offer.parsed)]));
        assert.equal(byId.get("R1"), "model:fire cast:5s-2s");
        assert.equal(byId.get("R10"), "model:fire model:fire cast:2s-5s");
    });

    it("offers nothing for a query already in simplest form", () => {
        assert.deepEqual(suggestions(parsed("model:fire cast:2s-5s")), []);
    });

    it("a clause still in its parse shape does not block unrelated standalone rules", () => {
        // model:{fire} parses as a scope of one content term, which formats braceless: an unrewritten clause of
        // that shape must not trip the round-trip guard for rules acting elsewhere in the tree.
        const ids = suggestions(parsed("model:{fire} model:fire cast:5s-2s")).map((offer) => offer.rule.id);
        assert.ok(ids.includes("R1"), ids.join(" "));
        assert.ok(ids.includes("R10"), ids.join(" "));
    });

    it("a rewrite that changes no spelling is not offered", () => {
        assert.deepEqual(suggestions(parsed("model:{fire}")), []);
    });

    it("each suggestion is answer-equal to the input", () => {
        const input = parsed("model:{fire} model:fire cast:5s-2s | name:frost | name:frost");
        for (const offer of suggestions(input)) {
            assert.deepEqual(answers(offer.parsed), answers(input), offer.rule.id);
        }
    });
});

describe("equivalence reads through simplification", () => {
    it("holds across the rewrites the rules certify", () => {
        assert.ok(equivalent(parsed("-model:*"), parsed("model=0")));
        assert.ok(equivalent(parsed("model:{fire}"), parsed("model:fire")));
        assert.ok(equivalent(parsed("spell:{cast>=2s cast<=5s}"), parsed("cast:2s-5s")));
        assert.ok(equivalent(parsed("missile:*"), parsed("model:{missile}")));
    });

    it("calls a query that constrains nothing equivalent to the empty query", () => {
        assert.ok(equivalent(parsed("model:fire | -model:fire"), parsed("")));
    });

    it("still separates what no rule may join", () => {
        assert.ok(!equivalent(parsed("model:fire"), parsed("model:frost")));
        assert.ok(!equivalent(parsed("cast>2s"), parsed("cast>=2s")));
    });
});

describe("the notes", () => {
    it("says out loud when a query matches every spell", () => {
        const result = simplify(parsed("model:fire | -model:fire"));
        assert.deepEqual(result.applied, ["R6"]);
        assert.equal(formatQuery(result.parsed), "");
        assert.equal(result.notes.length, 1);
        assert.deepEqual(answers(result.parsed), [...EVERY]);
        assert.deepEqual(answers(parsed("model:fire | -model:fire")), [...EVERY]);
    });

    it("keeps a dead alternative's drop quiet, because the query that remains says it", () => {
        const result = simplify(parsed("model:fireball -model:fire | name:frost"));
        assert.equal(formatQuery(result.parsed), "name:frost");
        assert.deepEqual(result.notes, []);
    });
});

describe("the world separates the laws it proves", () => {
    it("holds a spell whose two models satisfy a clause pair but no single row", () => {
        assert.deepEqual(answers(parsed("model:{fire -missile}")), [2]);
        assert.deepEqual(answers(parsed("model:fire -model:missile")), []);
    });

    it("holds spells on both sides of the count edges", () => {
        assert.deepEqual(answers(parsed("model=0")), complement([0, 1, 2, 3, 9, 10]));
        assert.deepEqual(answers(parsed("model:*")), [0, 1, 2, 3, 9, 10]);
    });
});
