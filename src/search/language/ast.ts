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
import type {Head} from "../schema/schema";
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

/** The sublanguages a finding can be about, where the query language itself is not the one at fault. */
export type Sublanguage = "regex";

/** The parts of a clause a finding can be about on their own, with the rest of the clause standing. */
export type ClausePart = "value";

/**
 * Whether two spans share any character. A span standing on one character, `{start, end: start + 1}`, is a
 * point; an empty span shares nothing.
 *
 * @param a One span.
 * @param b The other.
 * @returns True where the two overlap.
 */
export function overlaps(a: Span, b: Span): boolean {
    return a.start < b.end && a.end > b.start;
}

/** A structural correction a diagnostic can offer — never a spelling guess. */
export interface Fix {
    readonly label: string;
    readonly query: string;
    /**
     * Where the caret lands once the fix is applied, as an offset into `query`; absent, it lands after the
     * query's end. A fix that empties a slot names the slot, so the reader is left typing into it.
     */
    readonly caret?: number;
}

/** One finding about one clause, in the reader's words. */
export interface Diagnostic {
    readonly severity: Severity;
    /** Index into {@link Parsed.clauses} of the clause the finding is about. */
    readonly clause: number;
    readonly message: string;
    /**
     * The corrections on offer, in the order the reader ranks them: one where the reading is settled, several
     * where the reader declined to choose between readings.
     */
    readonly fixes?: readonly Fix[];
    /**
     * The sublanguage the finding belongs to, where the query language is not the one at fault: a regular
     * expression has its own grammar and its own errors, and a surface names it so the reader knows which
     * language to think in.
     */
    readonly about?: Sublanguage;
    /**
     * Which part of the clause the finding is about, where a surface can act on the part alone: the value,
     * with the field standing — a reading the axis refused, a pattern that did not compile — as against the
     * clause's structure, where nothing short of the whole can be kept.
     */
    readonly at?: ClausePart;
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
 *
 * `verbatim` marks an operand the reader QUOTED: its characters are matched as written — case and typography
 * still fold, punctuation stays — where a bare spelling's substring test squashes punctuation away. It changes
 * what the ask MEANS, so unlike `written` it is semantic and equivalence separates on it.
 */
export type ParsedOperand =
    | { readonly text: string; readonly verbatim?: true }
    | { readonly type: string; readonly value: Value; readonly written?: string; readonly verbatim?: true };

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
    /**
     * The word that opened this term, kept where its value never arrived.
     *
     * The clause level already works this way — an incomplete clause carries the head it resolved and a null
     * test, which is why `model:` still wears its column's colour. A term had nowhere to keep the same fact, so
     * `model:{attach:}` forgot between two keystrokes that `attach` was a door at all, and the word went from
     * coloured to plain and back as the value was typed. Set only where the bind RESOLVED: a word this scope
     * cannot read is foreign, and is refused before it reaches here.
     */
    readonly door?: string;

    /**
     * Whether this term was written glued to the one before it rather than separated by a space.
     *
     * The reading is identical either way -- the glue IS the scope's separator, written where the braces are
     * not -- so nothing downstream of the parse consults this. What it carries is the spelling, for the one
     * surface that must give a reader their own words back: a run typed `target:caster,area` is written that
     * way again instead of exploding into a repeated head. It also says WHICH run this is: `door` means the
     * values were written under a property's own door, which has no braced spelling to converge on, where
     * `bare` means they stood under a column or kind that could have opened a scope instead.
     */
    readonly glued?: "bare" | "door";
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

/**
 * One ordering directive: `sort:<door>`, kept apart from the clauses because it selects nothing.
 *
 * The head is what the door word resolved to; descending is the exclusion, before the sort word or before the
 * door — either, and both together, mean the other way round. Several directives apply in the order written.
 */
export interface SortDirective {
    readonly head: Head;
    readonly descending: boolean;
    readonly span: Span;
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
    /** The ordering directives, in written order; empty for the unordered query. */
    readonly sorts: readonly SortDirective[];
    /**
     * How many results to list, or null for all of them. A display directive: the count stays the query's
     * truth, and only what is LISTED trims. Negative counts from the END of the ordered answer — `first:-5`
     * lists the last five. Where several limits are written the smallest count consumes the larger, whichever
     * end each takes from, and the span is the winner's.
     */
    readonly limit: { readonly value: number; readonly span: Span } | null;
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

/**
 * The kind word and the count comparison the desugar sets after it, where two neighbouring terms are that pair.
 *
 * `attach>2` reads as "an attach row, and more than two of them", two terms in one run; every surface that draws
 * or writes a scope treats the pair as the one term the reader typed, and this is the one place that says which
 * two terms are it. A negated or unfinished term is never half of a pair.
 *
 * @param term A scope term.
 * @param next The term after it in the same run, if any.
 * @returns The pair's kind and its count expression, or null where the two are not that pair.
 */
export function rowCountPair(term: ScopeTerm, next: ScopeTerm | undefined): { kind: Kind; value: ValueExpr } | null {
    if (next === undefined || term.not || next.not || term.state !== "ok" || next.state !== "ok") return null;
    if (term.ask?.on !== "kindWord" || next.ask?.on !== "count") return null;
    return {kind: term.ask.kind, value: next.ask.value};
}
