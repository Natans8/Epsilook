/**
 * @file The AST: the tree {@link parse} emits, and the shape every layer above the parser reads.
 *
 * The output is data all the way down. A clause holds no functions, so a parsed query can be inspected, rendered,
 * rewritten and evaluated by layers that had no part in parsing it — the query-object convention of Django's Q
 * objects and Lucene's Query classes. Declaring the shape apart from the parser is what makes that real: the
 * formatter, the simplifier and the kernel depend on the tree, not on the machinery that produced it.
 *
 * A note on positions. Every span indexes the query text after typographic folding, which is one-to-one, so a span
 * taken here lines up with the characters the reader typed. A synthetic node — one a rewrite built rather than a
 * reader wrote — carries a span all the same, because the type is what every consumer reads; what it does not carry
 * is a meaningful position in any typed text.
 */
import type {Column} from "../schema/columns";
import type {Kind, Prop} from "../schema/kinds";
import type {Value} from "../vocabulary/value-types";
import {count as countType} from "../vocabulary/value-types";

/** A character range in the query text, end exclusive. Spans survive typographic folding, which is one-to-one. */
export interface Span {
    readonly start: number;
    readonly end: number;
}

/**
 * How the text arrived.
 *
 * While typing, an incomplete construct is expected — the next keystroke may finish it — so it is dropped without a
 * word. In final text nothing more is coming: what can be repaired is repaired and announced, and what cannot is an
 * error. The same string can deserve a different verdict depending on which way it arrived.
 */
export type ParseMode = "typing" | "final";

/** How strongly a {@link Diagnostic} objects, from a blocking error to a note in passing. */
export type Severity = "error" | "warning" | "note";

/** A structural correction a diagnostic can offer — never a spelling guess. */
export interface Fix {
    readonly label: string;
    readonly query: string;
}

/** One finding about one clause, in the reader's words. */
export interface Diagnostic {
    readonly severity: Severity;
    /** Index into {@link Parsed.clauses} of the clause the finding is about. */
    readonly clause: number;
    readonly message: string;
    readonly fix?: Fix;
}

/**
 * An operand: the text as written, or a stored value with the notation that read it.
 *
 * A typed operand appears where a property's notation accepted the text, so `+50` on a size change arrives as the
 * stored `50`. Text remains where several properties will each apply their own reading, or where the match folds the
 * text at evaluation time.
 *
 * `written` is the operand text the reader actually typed, kept so a rendering surface can echo the spelling they
 * chose — `x1.5` stays `x1.5` — where the canonical form would converge it. Absent on an operand built
 * programmatically, which has no written spelling to uphold; equivalence never reads it.
 */
export type ParsedOperand =
    | { readonly text: string }
    | { readonly type: string; readonly value: Value; readonly written?: string };

/** One value expression: an operator from the registry applied to its operands. */
export type ValueExpr =
    | { readonly op: "present" }
    | { readonly op: "contains"; readonly operand: ParsedOperand }
    | { readonly op: "glob"; readonly operand: ParsedOperand }
    | { readonly op: "regex"; readonly operand: ParsedOperand }
    | { readonly op: "exact"; readonly operand: ParsedOperand }
    | { readonly op: "lt" | "lte" | "gt" | "gte"; readonly operand: ParsedOperand }
    | { readonly op: "range"; readonly lo: ParsedOperand; readonly hi: ParsedOperand }
    | { readonly op: "anyOf"; readonly alternatives: readonly ValueExpr[] };

/** One property of one kind, by name. */
export interface PropRef {
    readonly kind: Kind;
    readonly prop: string;
}

/** What one term inside a row scope asks of the row. */
export type ScopeAsk =
    | { readonly on: "content"; readonly value: ValueExpr }
    | { readonly on: "kindWord"; readonly kind: Kind }
    | { readonly on: "props"; readonly props: readonly PropRef[]; readonly value: ValueExpr }
    | { readonly on: "count"; readonly value: ValueExpr };

/** One term inside a row scope. Incomplete terms are kept for display and skipped by evaluation. */
export interface ScopeTerm {
    readonly span: Span;
    readonly not: boolean;
    readonly state: "ok" | "incomplete";
    readonly ask: ScopeAsk | null;
}

/**
 * What must hold of one row.
 *
 * A scope's terms are alternation groups of conjunctions, exactly as clauses are at the top level. A scope with no
 * evaluable term is satisfied by any row: an empty conjunction is true, which is why `model:{}` means `model:*`.
 */
export type RowTest =
    | { readonly is: "exists" }
    | { readonly is: "content"; readonly value: ValueExpr }
    | { readonly is: "props"; readonly props: readonly PropRef[]; readonly value: ValueExpr }
    | { readonly is: "scope"; readonly terms: ReadonlyArray<readonly ScopeTerm[]> };

/**
 * What one clause asks.
 *
 * A plain ask is chipless search over every property declaring itself plain. The others carry the head that was
 * named: a column over any of its rows, a kind over rows of that kind, a property door over one property. `test` and
 * `value` are null on an incomplete clause, where the head is known and the question is not yet.
 */
export type Ask =
    | { readonly on: "plain"; readonly value: ValueExpr }
    | { readonly on: "column"; readonly column: Column; readonly test: RowTest | null }
    | { readonly on: "kind"; readonly kind: Kind; readonly test: RowTest | null }
    | { readonly on: "prop"; readonly ref: PropRef; readonly value: ValueExpr | null };

/**
 * Whether a clause runs.
 *
 * Only `ok` clauses evaluate. An incomplete clause could still become valid by appending and is kept for display; an
 * invalid clause cannot, and carries an error diagnostic.
 */
export type ClauseState = "ok" | "incomplete" | "invalid";

/** One top-level unit of the query. One clause renders as one chip. */
export interface Clause {
    readonly span: Span;
    readonly not: boolean;
    readonly state: ClauseState;
    readonly ask: Ask | null;
}

/** The parse: every clause in written order, the evaluable structure over them, and every finding. */
export interface Parsed {
    readonly clauses: readonly Clause[];
    /**
     * Alternation groups of conjunctions, as indices into `clauses` — the query in disjunctive normal form.
     * Only `ok` clauses appear; a group left empty by exclusions is dropped, and no groups at all means the query
     * constrains nothing.
     */
    readonly groups: ReadonlyArray<readonly number[]>;
    readonly diagnostics: readonly Diagnostic[];
}

/**
 * The synthetic property behind the count word, so cardinality reads operands like any numeric axis.
 *
 * Declared here rather than beside the desugar that binds it, because simplification's count reasoning must read
 * operands through exactly this property — a second declaration would drift from it.
 */
export const COUNT_PROP: Prop = {types: [countType]};

/**
 * The property a {@link PropRef} names.
 *
 * @param ref The reference.
 * @returns The property record.
 */
export const propOf = (ref: PropRef): Prop => ref.kind.props[ref.prop];

/**
 * A group of alternatives as one expression.
 *
 * A constructor rather than an object literal at each site: simplification builds alternative groups when it folds
 * clauses, and that is the one expression node it constructs rather than carries through.
 */
export const anyOfExpr = (alternatives: readonly ValueExpr[]): ValueExpr => ({op: "anyOf", alternatives});
