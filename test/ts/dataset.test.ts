/**
 * @file What the pack reader does when the pack and this build disagree.
 *
 * A pack is data the app fetches, not code it ships with, so the two can be a version apart: a pack built by another
 * version carries a kind this catalogue has since renamed or dropped. That used to be fatal for every query. The
 * rows of that one kind are skipped now, and the only thing that must not slip is the count agreeing with them.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import type {RowTable} from "../../src/packrows";
import {PackRowSource} from "../../src/dataset";
import {COLUMNS, kindsOf, wordOf} from "../../src/search/index";

/** A sound column whose second kind is one this build does not declare. */
const TABLE: RowTable = {
    kinds: ["sound", "gramophone"],
    sizes: [1, 1],
    values: {sound: {file: [700], kit: [3], target: [1]}, gramophone: {file: [900]}},
    vocab: {},
    absent: {},
    carried: {},
    // Spell 0 has one of each; spell 1 has only the unreadable one. Where each
    // spell's refs begin is derived by `indexRows`, not carried by the table.
    counts: [2, 1],
    refs: [0, 1, 1],
};

const column = COLUMNS.get("sound");
if (column === undefined) throw new Error("the sound column is gone");
const known = new Map(kindsOf(column).map(kind => [wordOf(kind), kind]));

describe("a pack from another version of this app", () => {
    it("skips the rows of a kind this build cannot name, rather than refusing the pack", () => {
        const source = new PackRowSource(TABLE, known, {});
        const rows = source.rows(0);
        assert.equal(rows.length, 1, "the readable row survives");
        assert.equal(rows[0].kind.column.key, "sound");
        assert.deepEqual(source.rows(1), [], "a spell with only unreadable rows has none");
    });

    it("counts what it can actually read, so size never promises rows that are gone", () => {
        const source = new PackRowSource(TABLE, known, {});
        // The shipped counts say 2 and 1; only one row of each spell is readable.
        assert.equal(source.size(0), source.rows(0).length);
        assert.equal(source.size(1), source.rows(1).length);
    });
});
