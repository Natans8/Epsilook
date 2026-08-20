/**
 * @file Reading the pack's row tables, and putting them back into the arrays 1.0 was written against.
 *
 * The absence tests are the ones with teeth. A property the kind does not declare and a property whose stored value
 * IS its absent marker must both read as absent, because the evaluator's contract is that a property missing from a
 * row matches nothing — not even `present`.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import type {RowTable} from "../../src/packrows";
import {indexRows, rowsAt, storedAt} from "../../src/packrows";

/**
 * A model column holding a missile, a worn model and a carried weapon.
 *
 * Spell 10 has the missile and the weapon; spell 20 has the worn model; spell 30 has nothing. The three kinds
 * number end to end, so the missile is ref 0, the worn model ref 1 and the weapon ref 2.
 */
const MODELS: RowTable = {
    kinds: ["missile", "worn", "equipped"],
    sizes: [1, 1, 1],
    values: {
        missile: {file: [700], from: [5], to: [9], motion: [3], target: [1]},
        worn: {file: [800], attach: [4], target: [0]},
        equipped: {slot: [-2], attach: [-1], target: [2]},
    },
    vocab: {
        missile: {file: "files", from: "attachments", to: "attachments", motion: "motions"},
        worn: {file: "files", attach: "attachments"},
        equipped: {slot: "slots", attach: "attachments"},
    },
    absent: {
        missile: {from: -1, to: -1},
        worn: {attach: -1},
        equipped: {attach: -1},
    },
    counts: [2, 1, 0],
    refs: [0, 2, 1],
};


describe("indexing a row table", () => {
    it("prefix-sums the counts into offsets one longer than the spells", () => {
        const index = indexRows(MODELS);
        assert.deepEqual([...index.at], [0, 2, 3, 3]);
    });

    it("gives every spell exactly the rows its count promised", () => {
        const index = indexRows(MODELS);
        assert.deepEqual(rowsAt(index, 0).map((r) => r.kind), ["missile", "equipped"]);
        assert.deepEqual(rowsAt(index, 1).map((r) => r.kind), ["worn"]);
        assert.deepEqual(rowsAt(index, 2), []);
    });

    it("reads a stored value, and reads absence as absence", () => {
        const index = indexRows(MODELS);
        const [missile] = rowsAt(index, 0);
        assert.equal(storedAt(MODELS, missile, "from"), 5);
        // The worn model's target is 0, which is this property's absent value, not a mask of nobody.
        const [wornRow] = rowsAt(index, 1);
        assert.equal(storedAt(MODELS, wornRow, "target"), undefined);
        // A property the kind does not declare at all.
        assert.equal(storedAt(MODELS, wornRow, "motion"), undefined);
    });
});
