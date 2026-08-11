/**
 * @file The operator registry: the set of questions a query can ask of a value.
 *
 * An operator has one abstract meaning that is identical for every type. `exact` means "the whole value, not a part"
 * whether the value is a number, a name or a file path; `lt` means "earlier in this type's order" whether that order
 * is arithmetic or an expansion ladder. A type realises the meaning for its own domain and may not redefine it.
 *
 * The names follow the field-lookup vocabulary used by ORMs and search engines (`exact`, `contains`, `lt`, `lte`,
 * `gt`, `gte`, `range`), so the abstract operation is one a reader can look up. `glob` is the shell's name for
 * pattern matching; `present` tests that a value exists at all.
 *
 * Adding an operator is one `defineOperator` call plus an implementation for every type that accepts it. A type may
 * decline, and declining is reported to the user as a static error rather than silently matching nothing.
 */

/**
 * How the parser recognises an operator in the query text.
 *
 * This is notation, not arity: `present` takes no operand, and `contains` has no symbol to count operands around.
 */
export type OperatorForm =
    /** The symbol opens the value: `=Fireball`, `>4`, `<=mop`. */
    | "prefix"
    /** The symbol separates two operands: `10-90`, `500ms-2s`. */
    | "infix"
    /** The symbol is the entire value: `*`. */
    | "whole"
    /** The symbol appears within a token: `bee*`, `unit_target_*`. */
    | "embedded"
    /** No symbol; the default reading of a plain token: `fire`. */
    | "bare";

/** One question a query can ask of a value. */
export interface Operator {
    /**
     * The abstract operation, and the key used by a type's `accepts` list and by the matcher table.
     *
     * Never the symbol: a symbol is a spelling, and spellings belong to the grammar.
     */
    readonly name: string;

    /** How the operator is written, or `null` when it has no spelling because a bare token implies it. */
    readonly symbol: string | null;

    readonly form: OperatorForm;

    /** One line describing the operator to a user, used by generated help and by diagnostics. */
    readonly hint: string;
}

/** Every declared operator, keyed by abstract name. */
export const OPERATORS = new Map<string, Operator>();

/**
 * Registers an operator.
 *
 * @param op The operator to register.
 * @returns The frozen operator, for use in a type's `accepts` list.
 * @throws If the name is taken, or if another operator already claims the same symbol in the same position.
 */
export function defineOperator(op: Operator): Operator {
    if (OPERATORS.has(op.name)) throw new Error(`operator "${op.name}" already defined`);

    // A symbol may be shared across positions but not within one. `glob` and `present` are both `*`, told apart by
    // whether the star stands alone; two operators sharing both symbol and position would leave the parser choosing
    // arbitrarily between them.
    for (const other of OPERATORS.values()) {
        if (op.symbol !== null && other.symbol === op.symbol && other.form === op.form) {
            throw new Error(
                `operator "${op.name}" claims "${op.symbol}" as a ${op.form}, already used by "${other.name}"`);
        }
    }

    const frozen = Object.freeze({...op});
    OPERATORS.set(op.name, frozen);
    return frozen;
}

// Value operators do not compose with one another, so they carry no precedence. The precedence ladder that does
// exist -- negation, conjunction, alternation -- applies to clauses and belongs to the grammar.

/** Matches the whole value rather than any part of it. Written `=`. */
export const exact = defineOperator({
    name: "exact", symbol: "=", form: "prefix",
    hint: "exactly this, matching the whole value",
});

/** Ordered comparison, strictly below the operand. Written `<`. */
export const lt = defineOperator({
    name: "lt", symbol: "<", form: "prefix",
    hint: "less than",
});

/** Ordered comparison, at or below the operand. Written `<=`. */
export const lte = defineOperator({
    name: "lte", symbol: "<=", form: "prefix",
    hint: "at most",
});

/** Ordered comparison, strictly above the operand. Written `>`. */
export const gt = defineOperator({
    name: "gt", symbol: ">", form: "prefix",
    hint: "more than",
});

/** Ordered comparison, at or above the operand. Written `>=`. */
export const gte = defineOperator({
    name: "gte", symbol: ">=", form: "prefix",
    hint: "at least",
});

/**
 * A closed interval between two operands, inclusive at both ends. Written `10-90`.
 *
 * The hyphen is shared with clause negation. Position decides: a hyphen negates only where a clause may begin, so
 * between two values it can only be a range.
 */
export const range = defineOperator({
    name: "range", symbol: "-", form: "infix",
    hint: "between these two, inclusive",
});

/**
 * Unanchored substring match, and the default reading of a plain token.
 *
 * Asset paths run words together (`beecreature.m2`, `beerfest_keg01.m2`), so there are no word boundaries to anchor
 * to and substring matching is what the corpus permits.
 */
export const contains = defineOperator({
    name: "contains", symbol: null, form: "bare",
    hint: "contains this",
});

/** Pattern match where `*` stands for any run of characters. Written inside a token, as `bee*`. */
export const glob = defineOperator({
    name: "glob", symbol: "*", form: "embedded",
    hint: "a pattern, where * stands for any run of characters",
});

/** Tests that the property has a value at all. Written as a lone `*`. */
export const present = defineOperator({
    name: "present", symbol: "*", form: "whole",
    hint: "has any value at all",
});

/**
 * The operators that require a total order, as one list.
 *
 * A type accepting these asserts that its order is transitive, antisymmetric and consistent with `exact`.
 */
export const ORDERING: readonly Operator[] = Object.freeze([lt, lte, gt, gte, range]);
