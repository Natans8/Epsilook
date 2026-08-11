/* The operator registry — the vocabulary every type and every backend
 * promises against.
 *
 * Small on purpose: an operator is a RECORD, so most of what could go wrong is
 * a duplicate claim or a guard that does not fire. Both are here.
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

    it("uses Django's field-lookup vocabulary, so the names can be looked up", () => {
        // exact / contains / lt / lte / gt / gte / range are Django lookups
        // verbatim; L0 says name the convention rather than invent one.
        for (const name of ["exact", "contains", "lt", "lte", "gt", "gte", "range"]) {
            assert.ok(OPERATORS.has(name), `${name} is a Django field lookup and should be declared`);
        }
    });

    it("hands out frozen records, because one is shared by every type that accepts it", () => {
        assert.ok(Object.isFrozen(exact));
    });

    it("lets `*` be two operators, because POSITION decides which", () => {
        // SEARCH.md §3.3: a lone `*` is a whole value and cannot also be a
        // pattern; a `*` beside other characters is a pattern and cannot also
        // be an existence test. Two roles, so two operators sharing a symbol.
        assert.equal(glob.symbol, "*");
        assert.equal(present.symbol, "*");
        assert.equal(glob.form, "embedded");
        assert.equal(present.form, "whole");
    });

    it("gives `contains` no symbol, because a bare token IS the spelling", () => {
        assert.equal(contains.symbol, null);
        assert.equal(contains.form, "bare");
    });

    it("collects the five ordering operators under one name", () => {
        // So that a numeric type writes `...ORDERING` once instead of five
        // names eight times over — one fact, one place.
        assert.deepEqual([...ORDERING], [lt, lte, gt, gte, range]);
    });
});

describe("defineOperator", () => {
    it("FIRES on a duplicate name", () => {
        assert.throws(
            () => defineOperator({name: "exact", symbol: "~", form: "prefix", hint: "x"}),
            /already defined/);
    });

    it("FIRES when a symbol is claimed twice in the SAME position", () => {
        // Two operators are legal; two unqualified spellings of one thing are
        // not, and the parser would silently pick whichever it saw first.
        assert.throws(
            () => defineOperator({name: "near", symbol: "=", form: "prefix", hint: "x"}),
            /already used by "exact"/);
    });

    it("allows one symbol in two POSITIONS, which is what makes `*` work", () => {
        // `glob` and `present` both ship, both spelled `*`. A guard on the
        // symbol alone would have thrown while loading types.ts — the first
        // version of it did, and this test is why that was caught.
        assert.equal(OPERATORS.get("glob")?.symbol, OPERATORS.get("present")?.symbol);
        assert.notEqual(OPERATORS.get("glob")?.form, OPERATORS.get("present")?.form);
        try {
            assert.doesNotThrow(
                () => defineOperator({name: "anyOf", symbol: "*", form: "infix", hint: "x"}));
        } finally {
            OPERATORS.delete("anyOf");   // the registry is module-level; leave it as found
        }
    });
});
