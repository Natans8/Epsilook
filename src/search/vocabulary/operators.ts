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
import {t} from "../../i18n";

/**
 * What an operator combines.
 *
 * A value operator asks a question of one stored value, and a type declares which of them it answers. A clause
 * operator combines whole clauses and is the same for every type, so no type declares it.
 *
 * Established query languages draw this line and keep both categories in one vocabulary: comparison against logical
 * operators in document stores, predicates against connectives in SQL, field lookups against query-object composition
 * in ORMs. Naming both here means generated help and autocomplete enumerate the language from one place.
 */
export type OperatorLevel = "value" | "clause";

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
    /** The symbol wraps the value on both sides: `/fire/`. */
    | "circumfix"
    /** The symbol is the entire value: `*`. */
    | "whole"
    /** The symbol appears within a token: `bee*`, `unit_target_*`. */
    | "embedded"
    /** No symbol; the default reading of a plain token: `fire`. */
    | "bare";

/** One question a query can ask. */
export interface Operator {
    /**
     * The abstract operation, and the key used by a type's `accepts` list and by the matcher table.
     *
     * Never the symbol: a symbol is a spelling, and spellings belong to the grammar.
     */
    readonly name: string;

    /** The symbol, or `null` when the operator has no spelling because juxtaposition implies it. */
    readonly symbol: string | null;

    /**
     * Further spellings of the symbol, accepted on input and written by no surface — `≥` for `>=`.
     *
     * Reading and writing are declared apart because they are not symmetric, exactly as a numeric type's
     * notations are: every spelling reads, the symbol is what formatted queries write, and {@link glyph} is what
     * rich display surfaces draw.
     */
    readonly aliases?: readonly string[];

    /**
     * The glyph a rich display surface draws for this operator, where it differs from the symbol.
     *
     * A chip prints `≥` where the query writes `>=`. Every glyph must read back — as the symbol's own fold, or as
     * one of {@link aliases} — because everything displayed must be typeable.
     */
    readonly glyph?: string;

    readonly form: OperatorForm;

    /** What the operator combines. Only a value operator may appear in a type's `accepts` list. */
    readonly level: OperatorLevel;

    /**
     * Binding strength, for clause operators only.
     *
     * Negation binds tightest, then conjunction, then alternation, which is the ladder every language with these
     * three uses. Value operators never compose with one another, so they carry no precedence.
     */
    readonly precedence?: number;

    /** One line describing the operator to a user, used by generated help and by diagnostics. */
    readonly hint: string;
}

/** Every declared operator, keyed by abstract name. */
export const OPERATORS = new Map<string, Operator>();

/** An operator's spellings for the collision check: the symbol and its aliases are one namespace. */
const spellings = (op: Operator): string[] =>
    (op.symbol === null ? [] : [op.symbol, ...(op.aliases ?? [])]);

/**
 * Registers an operator.
 *
 * @param op The operator to register.
 * @returns The frozen operator, for use in a type's `accepts` list.
 * @throws If the name is taken, or if another operator already claims the same symbol in the same position.
 */
export function defineOperator(op: Operator): Operator {
    if (OPERATORS.has(op.name)) throw new Error(`operator "${op.name}" already defined`);

    if (op.level === "value" && op.precedence !== undefined) {
        throw new Error(`operator "${op.name}" is a value operator and cannot carry a precedence`);
    }

    // A symbol may be shared, but not by two operators the parser would have to choose between in one position at one
    // level. `glob` and `present` are both `*`, told apart by whether the star stands alone; `anyOf` and `or` are both
    // `|`, told apart by whether it sits inside a value group. Aliases enter the same check: an alias is a spelling.
    for (const other of OPERATORS.values()) {
        const shared = spellings(op).find((s) => spellings(other).includes(s));
        if (shared !== undefined && other.form === op.form && other.level === op.level) {
            throw new Error(
                `operator "${op.name}" claims "${shared}" as a ${op.level}-level ${op.form}, `
                + `already used by "${other.name}"`);
        }
    }

    const frozen = Object.freeze({...op});
    OPERATORS.set(op.name, frozen);
    return frozen;
}

/* ------------------------------------------------------------------ value operators
 *
 * Each asks a question of one stored value. A type declares which of them it answers.
 */

/** Matches the whole value rather than any part of it. Written `=`. */
export const exact = defineOperator({
    name: "exact", symbol: "=", form: "prefix", level: "value",
    hint: t("tooltips:operator.exact"),
});

/** Ordered comparison, strictly below the operand. Written `<`. */
export const lt = defineOperator({
    name: "lt", symbol: "<", form: "prefix", level: "value",
    hint: t("tooltips:operator.lt"),
});

/** Ordered comparison, at or below the operand. Written `<=`, drawn `≤`. */
export const lte = defineOperator({
    name: "lte", symbol: "<=", aliases: ["≤"], glyph: "≤", form: "prefix", level: "value",
    hint: t("tooltips:operator.lte"),
});

/** Ordered comparison, strictly above the operand. Written `>`. */
export const gt = defineOperator({
    name: "gt", symbol: ">", form: "prefix", level: "value",
    hint: t("tooltips:operator.gt"),
});

/** Ordered comparison, at or above the operand. Written `>=`, drawn `≥`. */
export const gte = defineOperator({
    name: "gte", symbol: ">=", aliases: ["≥"], glyph: "≥", form: "prefix", level: "value",
    hint: t("tooltips:operator.gte"),
});

/**
 * A closed interval between two operands, inclusive at both ends. Written `10-90`.
 *
 * The hyphen is shared with clause negation. Position decides: a hyphen negates only where a clause may begin, so
 * between two values it can only be a range.
 */
export const range = defineOperator({
    // The en dash folds to the hyphen on input, so the glyph needs no alias to stay typeable.
    name: "range", symbol: "-", glyph: "–", form: "infix", level: "value",
    hint: t("tooltips:operator.range"),
});

/**
 * Unanchored substring match, and the default reading of a plain token.
 *
 * Asset paths run words together (`beecreature.m2`, `beerfest_keg01.m2`), so there are no word boundaries to anchor
 * to and substring matching is what the corpus permits.
 */
export const contains = defineOperator({
    name: "contains", symbol: null, form: "bare", level: "value",
    hint: t("tooltips:operator.contains"),
});

/** Pattern match where `*` stands for any run of characters. Written inside a token, as `bee*`. */
export const glob = defineOperator({
    name: "glob", symbol: "*", form: "embedded", level: "value",
    hint: t("tooltips:operator.glob"),
});

/**
 * Pattern match by regular expression, written between slashes: `name:/^fire/`.
 *
 * The superuser door, with the family conventions: slash delimiters, string values only — a type whose values are
 * quantities declines it — and case-insensitive always. It tests the stored text as written rather than the folded
 * form, because character classes are the whole point of reaching for one.
 */
export const regex = defineOperator({
    name: "regex", symbol: "/", form: "circumfix", level: "value",
    hint: t("tooltips:operator.regex"),
});

/** Tests that the property has a value at all. Written as a lone `*`. */
export const present = defineOperator({
    name: "present", symbol: "*", form: "whole", level: "value",
    hint: t("tooltips:operator.present"),
});

/**
 * Any one of several values, written as a group: `(chest|head)`.
 *
 * The `in` lookup of an ORM or document store, under a name that is not a reserved word. It is one operator rather
 * than a parse-time expansion into several clauses so that a control offering a multiple choice produces a single
 * term, which the query bar can then draw as one chip instead of re-collapsing several.
 */
export const anyOf = defineOperator({
    name: "anyOf", symbol: "|", form: "infix", level: "value",
    hint: t("tooltips:operator.anyOf"),
});

/* ----------------------------------------------------------------- clause operators
 *
 * Each combines whole clauses and means the same thing whatever the clause asks about, so no type declares them.
 * Precedence is the ladder every language with these three uses: negation binds tightest, then conjunction, then
 * alternation.
 */

/** Excludes what the clause selects. Written `-` before a clause, drawn as the true minus. */
export const not = defineOperator({
    // The minus sign folds to the hyphen on input, so the glyph needs no alias to stay typeable.
    name: "not", symbol: "-", glyph: "−", form: "prefix", level: "clause", precedence: 3,
    hint: t("tooltips:operator.not"),
});

/** Both clauses must hold. Written as juxtaposition, with no symbol of its own. */
export const and = defineOperator({
    name: "and", symbol: null, form: "bare", level: "clause", precedence: 2,
    hint: t("tooltips:operator.and"),
});

/** Either clause may hold. Written `|` between clauses. */
export const or = defineOperator({
    name: "or", symbol: "|", form: "infix", level: "clause", precedence: 1,
    hint: t("tooltips:operator.or"),
});

/**
 * The operators that require a total order, as one list.
 *
 * A type accepting these asserts that its order is transitive, antisymmetric and consistent with `exact`.
 */
export const ORDERING: readonly Operator[] = Object.freeze([lt, lte, gt, gte, range]);

/**
 * The ordered comparisons by the name their expression carries, for every surface that writes or draws one.
 *
 * Declared here rather than beside each surface: the formatter and the display model both turn an expression's
 * `op` back into an operator, and two copies of that map would let a newly declared comparison render on one
 * surface and vanish from the other.
 */
export const COMPARISONS = Object.freeze({lt, lte, gt, gte});

/**
 * Each ordered comparison's complement: the comparison that selects exactly what it rejects. A refusal to
 * negate a comparison offers this instead, since "not more than two" is "at most two".
 */
export const COMPLEMENTS: ReadonlyMap<Operator, Operator> = new Map([[lt, gte], [lte, gt], [gt, lte], [gte, lt]]);

/** Every operator that combines clauses, tightest-binding first. */
export const CLAUSE_OPERATORS: readonly Operator[] = Object.freeze([not, and, or]);
