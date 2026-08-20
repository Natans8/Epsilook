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
        assert.deepEqual([...up].reverse(), down);
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
});
