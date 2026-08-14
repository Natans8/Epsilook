import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {GRAMMAR, OPERATORS, PREFIX_OPERATORS} from "../../../../src/search/index";

describe("the token table", () => {
    it("declares each structural character once, by role", () => {
        assert.equal(GRAMMAR.bind, ":");
        assert.deepEqual(GRAMMAR.scope, {open: "{", close: "}"});
        assert.deepEqual(GRAMMAR.group, {open: "(", close: ")"});
        assert.equal(GRAMMAR.phrase, '"');
        assert.equal(GRAMMAR.escape, "\\");
        assert.equal(GRAMMAR.numberList, ",");
        assert.equal(GRAMMAR.countWord, "count");
    });

    it("reads the operator spellings from the registry rather than restating them", () => {
        assert.equal(GRAMMAR.negate, OPERATORS.get("not")?.symbol);
        assert.equal(GRAMMAR.or, OPERATORS.get("or")?.symbol);
        assert.equal(GRAMMAR.range, OPERATORS.get("range")?.symbol);
        assert.equal(GRAMMAR.wildcard, OPERATORS.get("present")?.symbol);
    });
});

describe("the prefix operators", () => {
    it("derives from the registry: every entry is a symbolled value-level prefix", () => {
        for (const op of PREFIX_OPERATORS) {
            assert.equal(op.level, "value");
            assert.equal(op.form, "prefix");
            assert.notEqual(op.symbol, null);
        }
    });

    it("orders longest spelling first, so <= is read before <", () => {
        const symbols = PREFIX_OPERATORS.map((op) => op.symbol as string);
        assert.ok(symbols.indexOf("<=") < symbols.indexOf("<"));
        assert.ok(symbols.indexOf(">=") < symbols.indexOf(">"));
        for (let i = 1; i < symbols.length; i++) {
            assert.ok(symbols[i - 1].length >= symbols[i].length);
        }
    });

    it("carries the five comparison spellings", () => {
        const symbols = new Set(PREFIX_OPERATORS.map((op) => op.symbol));
        for (const s of ["=", "<", "<=", ">", ">="]) assert.ok(symbols.has(s), s);
    });
});
