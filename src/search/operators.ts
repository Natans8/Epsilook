/* SEARCH 2.0 — L2 vocabulary. THE OPERATOR REGISTRY.
 *
 * An operator is one ABSTRACT question you can ask of a value. `=` means "the
 * whole value, not a part" whether the value is a number, a name or a file
 * path; `<` means "earlier in this type's order" whether that order is
 * arithmetic or an expansion ladder. A TYPE realises that meaning for its own
 * domain and may never redefine it (SEARCH.md L9, TYPES §3).
 *
 * WHY A REGISTRY RATHER THAN A LIST OF SYMBOLS IN THE GRAMMAR: adding an
 * operator has to be ONE declaration. SEARCH.md §2.1 used to spell the same
 * set as literal arrays inside `GRAMMAR` (`compare: ["<=", ">=", "<", ">",
 * "="]`), which is this file written a second time — and two copies of one
 * fact drift. `grammar.ts` (PHASE 3) reads THIS; it does not restate it.
 *
 * ⭐ THE NAMES ARE DJANGO'S FIELD LOOKUPS — `exact`, `contains`, `lt`, `lte`,
 * `gt`, `gte`, `range` (docs.djangoproject.com/en/stable/ref/models/querysets
 * /#field-lookups). That is L0 doing its job: an abstract operation named by
 * an ORM that maps the same vocabulary onto SQL is exactly the vocabulary a
 * SQL backend would want, and the next reader can look it up. `glob` is the
 * shell's word for the same thing SQL spells `LIKE`; `present` is Django's
 * `isnull=False` said the way this app says it (`model:*`).
 *
 * ⛔ THE COST OF ADDING ONE IS REAL AND DELIBERATE. An operator is a promise
 * to every TYPE ("what does `~` mean for an enum?") and now to every BACKEND
 * ("can SQL express it?" — `contains` is `LIKE '%x%'`, a fuzzy `~` is not).
 * A type may DECLINE, and declining is a static error reported to the user,
 * never a silent fallback. But it must be an answer. That friction is the
 * feature (PLAN §3.4).
 *
 * ⚠ `~` IS SPOKEN FOR AND NOT BUILT: fuzzy/edit-distance on text, "close to
 * this value" on the numeric family (the user, 2026-08-11 — a note for later,
 * not a work order, and the same meaning Lucene's `roam~` carries). Do not
 * give the symbol to anything else.
 */

/** How the parser RECOGNISES an operator — which is the only thing about its
 *  notation that the grammar has to know. Not "arity": `*` takes no operand at
 *  all, and a bare token has no symbol to count operands around. */
export type OperatorForm =
/** the symbol opens the value: `=Fireball`, `>4`, `<=mop` */
    | "prefix"
    /** the symbol sits between two operands: `10-90`, `500ms-2s` */
    | "infix"
    /** the symbol IS the whole value: `*` */
    | "whole"
    /** the symbol appears inside a token: `bee*`, `unit_target_*` */
    | "embedded"
    /** no symbol — the default reading of a plain token: `fire` */
    | "bare";

export interface Operator {
    /**
     * The abstract operation. THIS is the key a type's `accepts` names and a
     * backend's implementation table is keyed on — never the symbol, because a
     * symbol is a spelling and spellings are the grammar's business.
     */
    readonly name: string;

    /** How it is written. `null` for `contains`, which is what a bare token
     *  means and therefore has no spelling of its own. */
    readonly symbol: string | null;

    readonly form: OperatorForm;

    /** One line, in the user's words. The parser builds "the name axis has no
     *  ordering" out of this and the type's own hint; nothing else writes that
     *  sentence (L11 — a declaration is complete). */
    readonly hint: string;
}

/** Every declared operator, by abstract name. */
export const OPERATORS = new Map<string, Operator>();

/**
 * Register one operator. Frozen, because it is DATA that crosses into a type's
 * `accepts` list and out to a backend — a mutable record shared by both is a
 * shared mutable global with two owners.
 */
export function defineOperator(op: Operator): Operator {
    if (OPERATORS.has(op.name)) throw new Error(`operator "${op.name}" already defined`);

    /* THE COLLISION IS (SYMBOL, FORM), NOT THE SYMBOL ALONE, and the
     * difference is the whole of how `*` works. `glob` and `present` share the
     * character DELIBERATELY and are told apart by POSITION — a lone `*` is a
     * whole value and cannot also be a pattern (SEARCH.md §3.3). Banning the
     * share outright would make the two roles unwritable; allowing an
     * unqualified one would leave the parser picking whichever it saw first. */
    for (const other of OPERATORS.values()) {
        if (op.symbol !== null && other.symbol === op.symbol && other.form === op.form) {
            throw new Error(`operator "${op.name}" claims "${op.symbol}" as a ${op.form},`
                + ` already used by "${other.name}"`);
        }
    }

    const frozen = Object.freeze({...op});
    OPERATORS.set(op.name, frozen);
    return frozen;
}

/* ─────────────────────────────────────────────────────── the operators ──
 *
 * ⚠ THERE IS NO `precedence` FIELD, and PLAN §3.4's sketch had one. Nothing
 * reads it: value operators never compose (`=` and `*` are mutually exclusive
 * by §2.4.0, and `scale:>10-90` has no production), so there is no ladder to
 * slot into. The ladder that IS real — `-` > AND > `|` — is CLAUSE level and
 * belongs to `grammar.ts`, where the `-` that negates a clause lives. Adding
 * an unread field here would be a declaration nothing can be wrong about,
 * which is the kind this repo has been bitten by.
 */

export const exact = defineOperator({
    name: "exact", symbol: "=", form: "prefix",
    hint: "exactly this — the whole value, never a part",
});

export const lt = defineOperator({
    name: "lt", symbol: "<", form: "prefix",
    hint: "less than",
});

export const lte = defineOperator({
    name: "lte", symbol: "<=", form: "prefix",
    hint: "at most",
});

export const gt = defineOperator({
    name: "gt", symbol: ">", form: "prefix",
    hint: "more than",
});

export const gte = defineOperator({
    name: "gte", symbol: ">=", form: "prefix",
    hint: "at least",
});

/* THE RANGE SHARES `-` WITH NEGATION, and POSITION is what tells them apart:
 * `-` negates only in clause-opening position (SEARCH.md §4.1), so between two
 * values it can only be a range. That is decided by the tokenizer before any
 * type is consulted, which is why both may hold the character. */
export const range = defineOperator({
    name: "range", symbol: "-", form: "infix",
    hint: "between these two, inclusive",
});

/* THE DEFAULT READING OF A PLAIN TOKEN. Unanchored substring, and on `path`
 * that is not a choice but the corpus talking: asset paths carry no word
 * segmentation, so `bee` cannot be separated from `beecreature` (SEARCH.md
 * §3.2). No symbol, because there is nothing to write. */
export const contains = defineOperator({
    name: "contains", symbol: null, form: "bare",
    hint: "contains this",
});

/* `*` HAS TWO ROLES AND POSITION DECIDES, so they are two operators rather
 * than one with a footnote (SEARCH.md §3.3). A lone `*` is a whole value and
 * cannot also be a pattern; a `*` beside other characters is a pattern and
 * cannot also be an existence test. */
export const glob = defineOperator({
    name: "glob", symbol: "*", form: "embedded",
    hint: "a pattern — * stands for any run of characters",
});

export const present = defineOperator({
    name: "present", symbol: "*", form: "whole",
    hint: "has any value at all",
});

/**
 * THE FIVE THAT NEED A TOTAL ORDER, as one name — because a type that can be
 * ordered can be ordered five ways and writing all five on each of the eight
 * numeric types is one fact stated eight times (PLAN §5.2).
 *
 * ⚠ A type accepting these promises its order is a TOTAL order: transitive,
 * antisymmetric, and consistent with `exact`. That contract is what stops a
 * backend implementation quietly becoming an override.
 */
export const ORDERING: readonly Operator[] = Object.freeze([lt, lte, gt, gte, range]);
