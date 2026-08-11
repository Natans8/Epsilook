/**
 * @file The operator registry: the vocabulary every type declares against.
 *
 * An operator is a record, so most of what can go wrong is a duplicate claim or a guard that fails to fire on one.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {
    contains, defineOperator, exact, glob, gt, gte, lt, lte, OPERATORS, ORDERING, present, range,
} from "../../src/search/operators";

describe("the operator registry", () => {
    it("registers every declared operator under its abstract name", () => {
        const names = [...OPERATORS.keys()].toSorted();
        assert.deepEqual(names, [
            "contains", "exact", "glob", "gt", "gte", "lt", "lte", "present", "range",
        ]);
    });

    it("uses the field-lookup names an ORM or search engine would, so they can be looked up", () => {
        for (const name of ["exact", "contains", "lt", "lte", "gt", "gte", "range"]) {
            assert.ok(OPERATORS.has(name), `${name} is a conventional field lookup and should be declared`);
        }
    });

    it("hands out frozen records, because one is shared by every type that accepts it", () => {
        assert.ok(Object.isFrozen(exact));
    });

    it("lets a star be two operators, told apart by position", () => {
        // A lone star is an existence test and cannot also be a pattern; a star beside other characters is a pattern
        // and cannot also be an existence test. Two roles, so two operators sharing one symbol.
        assert.equal(glob.symbol, "*");
        assert.equal(present.symbol, "*");
        assert.equal(glob.form, "embedded");
        assert.equal(present.form, "whole");
    });

    it("gives a bare token no symbol, because the absence of one is its spelling", () => {
        assert.equal(contains.symbol, null);
        assert.equal(contains.form, "bare");
    });

    it("collects the five ordering operators under one name", () => {
        // So a numeric type spreads one list instead of repeating five names for every type that orders.
        assert.deepEqual([...ORDERING], [lt, lte, gt, gte, range]);
    });
});

describe("defineOperator", () => {
    it("rejects a duplicate name", () => {
        assert.throws(
            () => defineOperator({name: "exact", symbol: "~", form: "prefix", hint: "x"}),
            /already defined/);
    });

    it("rejects a symbol already claimed in the same position", () => {
        // Two operators are legal; two unqualified spellings of one thing are not, and the parser would silently pick
        // whichever was registered first.
        assert.throws(
            () => defineOperator({name: "near", symbol: "=", form: "prefix", hint: "x"}),
            /already used by "exact"/);
    });

    it("allows one symbol in two positions", () => {
        // Guarding on the symbol alone would reject the star, which two shipped operators share.
        assert.equal(OPERATORS.get("glob")?.symbol, OPERATORS.get("present")?.symbol);
        assert.notEqual(OPERATORS.get("glob")?.form, OPERATORS.get("present")?.form);
        try {
            assert.doesNotThrow(
                () => defineOperator({name: "anyOf", symbol: "*", form: "infix", hint: "x"}));
        } finally {
            OPERATORS.delete("anyOf");   // The registry is module-level; leave it as found.
        }
    });
});
