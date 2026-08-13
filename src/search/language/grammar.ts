/**
 * @file The token table: every character the query language treats as structure.
 *
 * Changing a symbol here changes the written syntax and nothing else — the parser reads this table and attaches no
 * meaning to a literal of its own. Operator spellings are not restated here either: they come from the operator
 * registry, so declaring an operator is what teaches the grammar its symbol.
 */
import type {Operator} from "../vocabulary/operators";
import {not, OPERATORS, or, present, range, regex} from "../vocabulary/operators";

/**
 * The spelling an operator is written with, for every module that writes syntax — this table and the formatter.
 *
 * @param op The operator.
 * @returns Its symbol.
 * @throws If the operator declares no symbol, which would leave the grammar a role with no character to play it.
 */
export function spelling(op: Operator): string {
    if (op.symbol === null) throw new Error(`operator "${op.name}" has no spelling`);
    return op.symbol;
}

/** The structural characters and words of the query language, by role. */
export const GRAMMAR = {
    /** Binds an axis to its value: `model:fire`. */
    bind: ":",

    /** The row scope: every clause inside must hold of one row. */
    scope: {open: "{", close: "}"},

    /** A value group: alternatives as one value, and the sign shelter for a leading minus. */
    group: {open: "(", close: ")"},

    /** A phrase delimiter. A phrase is a leaf: no other delimiter is active inside one. */
    phrase: '"',

    /** Escapes a quote inside a phrase. */
    escape: "\\",

    /** Separates numbers in a pasted id list: `id:133,134`. Only a run of numbers reads as a list. */
    numberList: ",",

    /** The cardinality axis. It has no top-level door; a scope is the only place the word exists. */
    countWord: "count",

    /** Negates the clause it opens. Anywhere else the character is data or a range separator. */
    negate: spelling(not),

    /** Alternation: between clauses when it stands alone, between alternatives when glued inside a value. */
    or: spelling(or),

    /** Separates a range's two bounds when both sides read as values of an ordered type. */
    range: spelling(range),

    /** Alone as a whole value: existence. Inside a token: a pattern metacharacter. */
    wildcard: spelling(present),

    /** Wraps a regular expression, in value position only — in free text a slash is an ordinary character. */
    regex: spelling(regex),
} as const;

/**
 * The prefix value operators, longest spelling first so that `<=` is read before `<`.
 *
 * Derived from the registry rather than listed, so a declared operator is recognised with no edit here.
 */
export const PREFIX_OPERATORS: readonly Operator[] = Object.freeze(
    [...OPERATORS.values()]
        .filter((op) => op.level === "value" && op.form === "prefix" && op.symbol !== null)
        .toSorted((a, b) => spelling(b).length - spelling(a).length),
);
