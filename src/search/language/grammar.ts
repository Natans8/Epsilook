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

/**
 * Every spelling an operator answers to: the symbol, then its aliases.
 *
 * The reading direction of the spelling declaration — every module that recognises syntax reads this, while
 * everything writing syntax stays with {@link spelling}, so an alias can never leak into a formatted query.
 *
 * @param op The operator.
 * @returns Its spellings, or an empty list for an operator with no symbol.
 */
export function spellingsOf(op: Operator): string[] {
    return op.symbol === null ? [] : [op.symbol, ...(op.aliases ?? [])];
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

    /**
     * The ordering directive: `sort:<door>` orders the results by that door, `sort:-<door>` or `-sort:<door>` the
     * other way (either exclusion, and both together, mean the same), several applied in the order written. A
     * directive, not a clause: it selects nothing. Bare `sort` is `sort:` of the default door.
     */
    sortWord: "sort",

    /** The door a bare `sort` orders by: the spell's id. */
    sortDefault: "id",

    /**
     * The results-limiting directive: `first:20` shows the first twenty of the ordered answer. A directive
     * like the sort — it selects nothing and the count stays the query's truth; only what is LISTED trims.
     * Where several stand, the last one written wins.
     */
    limitWord: "first",

    /** The typed synonyms that reach the limit directive; every surface still writes `first`. */
    limitReads: ["limit", "top"],

    /**
     * The word synonym of the wildcard, in every position that reads a bound value — a typed way in, and the word
     * chips display for existence. Plain search keeps it as text: a bare top-level word is content, always.
     */
    anyWord: "any",

    /** The word synonym of alternation, standing alone between terms exactly as the symbol does. */
    orWord: "or",

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

/**
 * First characters of the prefix operators, aliases included — what a comparison BEGINS with.
 *
 * Where one follows a known head word the colon is implied, so `model<=4` reads as `model:<=4`; the parser
 * resolves that and the highlighter reads the same characters, which is why the derivation is here rather than
 * in either of them.
 */
export const COMPARISON_STARTS: ReadonlySet<string> = new Set(
    PREFIX_OPERATORS.flatMap((op) => spellingsOf(op).map((held) => held[0])));
