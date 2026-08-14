/**
 * @file The operator registry: the vocabulary every type declares against.
 *
 * An operator is a record, so most of what can go wrong is a duplicate claim or a guard that fails to fire on one.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {
    and, anyOf, CLAUSE_OPERATORS, contains, defineOperator, exact, glob, gt, gte, lt, lte, not,
    OPERATORS, ORDERING, or, present, range,
} from "../../../../src/search/vocabulary/operators";

describe("the operator registry", () => {
    it("registers every declared operator under its abstract name", () => {
        const names = [...OPERATORS.keys()].toSorted();
        assert.deepEqual(names, [
            "and", "anyOf", "contains", "exact", "glob", "gt", "gte", "lt", "lte", "not", "or",
            "present", "range", "regex",
        ]);
    });

    it("keeps value and clause operators in one vocabulary, told apart by level", () => {
        // Established query languages name both categories and separate them: comparison against logical operators,
        // predicates against connectives, field lookups against query composition. One registry means generated help
        // and autocomplete enumerate the language from a single place.
        const byLevel = (level: string): string[] =>
            [...OPERATORS.values()].filter((op) => op.level === level).map((op) => op.name).toSorted();
        assert.deepEqual(byLevel("clause"), ["and", "not", "or"]);
        assert.deepEqual(byLevel("value"),
            ["anyOf", "contains", "exact", "glob", "gt", "gte", "lt", "lte", "present", "range", "regex"]);
    });

    it("gives only clause operators a precedence, tightest first", () => {
        // Value operators never compose with one another, so a precedence on one would describe nothing.
        assert.deepEqual([...CLAUSE_OPERATORS], [not, and, or]);
        assert.ok(not.precedence! > and.precedence!);
        assert.ok(and.precedence! > or.precedence!);
        for (const op of OPERATORS.values()) {
            if (op.level === "value") assert.equal(op.precedence, undefined, op.name);
        }
    });

    it("spells alternation the same at both levels, told apart by what it joins", () => {
        // A group of alternatives is one value; alternation between clauses is two questions. Same symbol, because a
        // reader means the same thing by it.
        assert.equal(anyOf.symbol, "|");
        assert.equal(or.symbol, "|");
        assert.notEqual(anyOf.level, or.level);
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
            () => defineOperator({name: "exact", symbol: "~", form: "prefix", level: "value", hint: "x"}),
            /already defined/);
    });

    it("rejects a symbol already claimed in the same position at the same level", () => {
        // Two operators are legal; two unqualified spellings of one thing are not, and the parser would silently pick
        // whichever was registered first.
        assert.throws(
            () => defineOperator({name: "near", symbol: "=", form: "prefix", level: "value", hint: "x"}),
            /already used by "exact"/);
    });

    it("rejects a precedence on a value operator", () => {
        assert.throws(
            () => defineOperator({
                name: "near", symbol: "~", form: "prefix", level: "value", precedence: 1, hint: "x",
            }),
            /cannot carry a precedence/);
    });

    it("allows one symbol in two positions", () => {
        // Guarding on the symbol alone would reject the star, which two shipped operators share.
        assert.equal(OPERATORS.get("glob")?.symbol, OPERATORS.get("present")?.symbol);
        assert.notEqual(OPERATORS.get("glob")?.form, OPERATORS.get("present")?.form);
        try {
            assert.doesNotThrow(
                () => defineOperator({name: "spurious", symbol: "*", form: "infix", level: "value", hint: "x"}));
        } finally {
            OPERATORS.delete("spurious");   // The registry is module-level; leave it as found.
        }
    });

    it("allows one symbol at two levels", () => {
        try {
            assert.doesNotThrow(
                () => defineOperator({name: "spurious", symbol: "-", form: "infix", level: "clause", hint: "x"}));
        } finally {
            OPERATORS.delete("spurious");
        }
    });
});
