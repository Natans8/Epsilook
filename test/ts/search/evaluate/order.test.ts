/**
 * @file The ordering of a query's answer: the sort directives applied over the kernel's set.
 *
 * Ordering never changes what the set holds — the directives are read APART from the clauses — so every case
 * here runs the same pipeline the application will: parse, run, order.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {order} from "../../../../src/search/evaluate/order";
import {run} from "../../../../src/search/evaluate/kernel";
import {parse} from "../../../../src/search/language/parse";
import {modelColumn} from "../../../../src/search/schema/columns";
import {DATA} from "../world";

const ordered = (query: string): number[] => {
    const parsed = parse(query);
    return order(run(parsed, DATA), parsed.sorts, DATA);
};

describe("the sort directives", () => {
    it("a directive selects nothing: the set is the clauses' own, in spell order without one", () => {
        assert.deepEqual(new Set(ordered("model:missile sort:name")), new Set(ordered("model:missile")));
    });

    it("a prop door orders by the value, ascending by default and the other way negated", () => {
        const up = ordered("model:missile sort:name");
        const down = ordered("model:missile sort:-name");
        assert.deepEqual(up.toReversed(), down);
        // The name kind's subject keys the spell column, so the first spell is the alphabetically first name.
        const byId = ordered("model:missile sort:id");
        assert.deepEqual(byId, [...byId].toSorted((a, b) => a - b));
    });

    it("a row-backed column door orders by how many rows the spell has", () => {
        const spells = ordered("model:* sort:-model");
        const source = DATA.source(modelColumn);
        const counts = spells.map((spell) => source?.rows(spell).length ?? 0);
        for (let i = 1; i < counts.length; i++) assert.ok(counts[i - 1] >= counts[i]);
    });

    it("several directives apply in written order, and the tiebreak is the spell's own order", () => {
        const spells = ordered("model:* sort:-model sort:id");
        assert.equal(new Set(spells).size, spells.length);
    });

    it("a single kind keys by its subject row: a spell sorts by its name, never by its subtext", () => {
        const up = ordered("sort:name");
        // Silence's subtext folds before every name; keying off it would put the spell first.
        assert.equal(up[0], 10);
        assert.equal(up.at(-1), 11);
    });

    it("a spell with no value on the door sorts last whichever direction", () => {
        const up = ordered("sort:cast");
        const down = ordered("sort:-cast");
        // The instants key nought, the casts follow by time, and the castless spells close both orders.
        assert.deepEqual(up, [2, 4, 0, 1, 3, 5, 6, 7, 8, 9, 10, 11]);
        assert.deepEqual(down, [1, 0, 2, 4, 3, 5, 6, 7, 8, 9, 10, 11]);
    });

    it("an ordinal door keys by its rank on the ladder, not by how its rungs spell", () => {
        // Alphabetical rungs would open on bfa; the ladder opens on classic.
        assert.deepEqual(ordered("sort:xpac"), [0, 1, 11, 2, 9, 3, 7, 4, 10, 5, 8, 6]);
    });
});
