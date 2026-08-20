/**
 * @file The kernel's algebra, proved against a synthetic dataset small enough to verify by hand.
 *
 * The fixtures run whole queries through `parse` and `run`, so every assertion exercises the same pipeline the
 * application will: text in, spell set out. The world they run against lives in `world.ts`, built so each
 * algebraic identity has a spell that separates the two sides.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import type {Ask} from "../../../../src/search/language/ast";
import type {Dataset} from "../../../../src/search/evaluate/rows";
import {formatQuery} from "../../../../src/search/index";

import {answers, complement, DATA, EVERY, parsed} from "../world";

const ids = (query: string, data: Dataset = DATA): number[] => answers(parsed(query), data);

describe("the walk", () => {
    it("answers a column content term over every row of the column", () => {
        assert.deepEqual(ids("model:fire"), [0, 2, 9]);
        assert.deepEqual(ids("model:arcane"), [2, 3, 10]);
    });

    it("answers a kind word as the rows of that kind", () => {
        assert.deepEqual(ids("model:missile"), [0, 1, 2, 9, 10]);
    });

    it("answers existence, and its negation as the complement", () => {
        assert.deepEqual(ids("model:*"), [0, 1, 2, 3, 9, 10]);
        assert.deepEqual(ids("-model:*"), complement([0, 1, 2, 3, 9, 10]));
    });

    it("dispatches a bare token after a kind across all its properties", () => {
        // "chest" lives in `from` on one spell and in `to` on three others; the precise forms tell them apart.
        assert.deepEqual(ids("missile:chest"), [0, 1, 9, 10]);
        assert.deepEqual(ids("missile:{from:chest}"), [9]);
        assert.deepEqual(ids("missile:{to:chest}"), [0, 1, 10]);
    });

    it("anchors a content match to the whole value", () => {
        assert.deepEqual(ids("model:{=parabola}"), [0, 1, 10]);
        assert.deepEqual(ids("model:{parab}"), [0, 1, 10]);
        assert.deepEqual(ids("model:{=parab}"), []);
    });

    it("matches a phrase with punctuation and spacing folded, like any other token", () => {
        assert.deepEqual(ids('model:"right hand"'), [0, 1, 10]);
    });

    it("reads a colon inside a value as content, squashed like any bare token", () => {
        // A second colon has no meaning, so the token is one content term and its squashed reading crosses the
        // colon exactly as it crosses a space; the quoted spelling is the strict string, and separates.
        assert.deepEqual(ids("model:right:hand"), [0, 1, 10]);
        assert.deepEqual(ids('model:"right:hand"'), []);
    });

    it("answers the same set for a query and its formatted spellings", () => {
        for (const query of [
            "model:right:hand", 'model:"right:hand"', "sound:{kit:150}", "model:{fire -missile}",
            "model:(fire|arcane)", "cast:instant", 'name:{"fire" "ball"}',
            "model:right:hand|fire", "range:{min=5yd}", "sound:{count>2}",
        ]) {
            for (const tier of ["canonical", "written"] as const) {
                assert.deepEqual(ids(formatQuery(parsed(query), tier)), ids(query), `${query} (${tier})`);
            }
        }
    });
});

describe("the row scope", () => {
    it("binds its conjunction to one row, which the flat form cannot say", () => {
        // Flame Shield holds a fire attachment and an arcane missile: no single row is fire-without-missile
        // anywhere else, and the flat form excludes the spell for having any missile at all.
        assert.deepEqual(ids("model:{fire -missile}"), [2]);
        assert.deepEqual(ids("model:fire -model:missile"), []);
    });

    it("reads an empty scope as existence", () => {
        assert.deepEqual(ids("model:{}"), ids("model:*"));
    });

    it("collapses a one-term scope to the flat form", () => {
        assert.deepEqual(ids("model:{fire}"), ids("model:fire"));
    });

    it("counts the rows the scope's other terms leave", () => {
        assert.deepEqual(ids("model:>4"), [3]);
        assert.deepEqual(ids("model:{arcane count:>1}"), [3]);
        assert.deepEqual(ids("model:{arcane count:1}"), [2, 10]);
    });

    it("tests a target mask by role, inside the column that names the subject", () => {
        assert.deepEqual(ids("model:{target:caster}"), [2]);
        assert.deepEqual(ids("mech:{JUMP_DEST target:area}"), [8]);
    });
});

describe("the algebra", () => {
    it("returns the same set under any clause permutation", () => {
        const clauses = ["model:arcane", "-model:fire", "xpac:>tbc"];
        const expected = ids(clauses.join(" "));
        assert.deepEqual(expected, [3, 10]);
        for (const permuted of permutations(clauses)) {
            assert.deepEqual(ids(permuted.join(" ")), expected, permuted.join(" "));
        }
    });

    it("pushes negation through a conjunction, as De Morgan says", () => {
        assert.deepEqual(ids("-model:arcane | model:fire"), complement(ids("model:arcane -model:fire")));
    });

    it("reads alternatives as the union of their separate clauses", () => {
        assert.deepEqual(ids("model:(fire|arcane)"), ids("model:fire | model:arcane"));
    });

    it("starts an exclusion-only query from every spell", () => {
        assert.deepEqual(ids("-model:fire"), complement([0, 2, 9]));
    });

    it("answers an empty query with everything, because an empty conjunction is true", () => {
        assert.deepEqual(ids(""), EVERY);
        assert.deepEqual(ids("*"), EVERY);
    });
});

describe("properties and doors", () => {
    it("reaches a property door with its sentinel words", () => {
        assert.deepEqual(ids("cast:instant"), [2, 4]);
        assert.deepEqual(ids("channel:unlimited"), [5]);
        assert.deepEqual(ids("channel:>3"), [3, 9]);
    });

    it("matches a set flag by its word, as row content", () => {
        assert.deepEqual(ids("spell:unbreakable"), [3]);
        // A substring reaches both flag words, exactly as it reaches a category word or a file name.
        assert.deepEqual(ids("spell:break"), [3, 9]);
    });

    it("binds a flag and a duration to the one delivery row", () => {
        assert.deepEqual(ids("spell:{unbreakable channel:>3}"), [3]);
        assert.deepEqual(ids("spell:{breaksmove channel:>3}"), [9]);
    });

    it("keeps a bare number an id and a quoted number a name, on the same property", () => {
        assert.deepEqual(ids("sound:{kit:150}"), [0]);
        assert.deepEqual(ids('sound:{kit:"150"}'), [6]);
        assert.deepEqual(ids("sound:{kit:fireimpact}"), [0]);
    });

    it("compares an ordinal by its rung on the loaded ladder", () => {
        assert.deepEqual(ids("xpac:>wotlk"), [4, 5, 6, 8, 10]);
        assert.deepEqual(ids("xpac:classic"), [0, 1, 11]);
    });

    it("matches a colour name against nearby shades", () => {
        assert.deepEqual(ids("fx:{tint red}"), [4]);
    });
});

describe("plain search", () => {
    it("reads names, descriptions and asset paths, nothing else", () => {
        assert.deepEqual(ids("fire"), [0, 2, 9]);
        assert.deepEqual(ids("arcane"), [2, 3, 7, 10]);
    });

    it("reads a bare number as the spell's own id, and as text where text is plain", () => {
        assert.deepEqual(ids("133"), [7]);
        // The kit ID 150 is keyword-only: the digits reach the kit NAMED "150", never the kit numbered 150.
        assert.deepEqual(ids("150"), [6]);
    });
});

describe("candidates", () => {
    // A deliberately coarse seed: every spell with any row in the ask's column, and no seed at all for plain
    // search. Sound but lazy, which is the contract — the kernel must verify, so the answers cannot move.
    const seeded: Dataset = {
        ...DATA,
        candidates(ask: Ask): Iterable<number> | null {
            const column = ask.on === "column" ? ask.column
                : ask.on === "kind" ? ask.kind.column
                    : ask.on === "prop" ? ask.ref.kind.column : null;
            if (column === null) return null;
            return EVERY.filter((spell) => DATA.source(column)!.rows(spell).length > 0);
        },
    };

    it("changes the cost of a query and never its answer", () => {
        const queries = [
            "model:fire", "model:{fire -missile}", "-model:*", "model:>4", "missile:{from:chest}",
            "cast:instant", "spell:{unbreakable channel:>3}", "model:arcane -model:fire | xpac:>legion",
            "fire", "sound:{kit:150}",
        ];
        for (const query of queries) {
            assert.deepEqual(ids(query, seeded), ids(query), query);
        }
    });
});

function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
        permutations(items.toSpliced(index, 1)).map((rest) => {
            rest.unshift(item);
            return rest;
        }));
}
