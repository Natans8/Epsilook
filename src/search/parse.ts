/**
 * @file The parser: query text in, clauses and diagnostics out.
 *
 * The parser is total — it never throws, whatever the input. Failure is per clause: an invalid clause is reported and
 * excluded while the rest of the query runs. While the reader is still typing, anything a further keystroke could
 * complete is dropped silently rather than reported; what no suffix can rescue is an error in both modes. That
 * distinction — incomplete against invalid — is what lets a search-as-you-type bar stay quiet on every intermediate
 * state without ever swallowing a real mistake.
 *
 * Structure comes from the token table in {@link ./grammar!}; what a word means comes from the schema. An unknown
 * word before a colon is ordinary text, never an error, because thousands of spell names contain a colon and pasting
 * one must remain a search rather than a syntax error.
 *
 * A tag's value runs to the next whitespace at depth zero of the value, or to the brace closing the enclosing scope.
 * Balanced pairs are part of the value, so `model:fire|frost` is one value with two alternatives while
 * `model:fire | frost` is three clauses. An unclosed scope is recovered at the first clause that cannot belong to it,
 * which is the only recovery that does not destroy correctly-written input; a closer with text glued to it is
 * repaired, except where the glue means something — a group holding alternatives distributes over glued text the way
 * shell brace expansion does.
 *
 * The output is data all the way down. A clause holds no functions, so a parsed query can be inspected, rendered and
 * evaluated by layers that had no part in parsing it — the query-object convention of Django's Q objects and
 * Lucene's Query classes.
 */
import type {Column} from "./columns";
import {GRAMMAR, PREFIX_OPERATORS} from "./grammar";
import type {Kind, ParsedValue, Prop} from "./kinds";
import {doorOf, hintOf, parseValue, sentinelOf, wordOf} from "./kinds";
import type {Operator} from "./operators";
import {ORDERING} from "./operators";
import type {Head} from "./schema";
import {HEADS, kindIn, kindsOf, propIn} from "./schema";
import {compilePattern, escapeRegExp} from "./patterns";
import {fold, foldTypography} from "./text-normalization";
import type {AxisType, Value} from "./value-types";
import {count as countType, path as pathType} from "./value-types";

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
 * Parses a query.
 *
 * @param text The query as typed or pasted. Typographic substitutes — curly quotes, dashes, exotic spaces — are read
 *   as their plain forms.
 * @param options `mode` defaults to `"final"`, the right reading for a URL, a paste or a programmatic call; a bar
 *   passes `"typing"` while the reader is mid-keystroke.
 * @returns The parse. Never throws.
 */
export function parse(text: string, options?: { readonly mode?: ParseMode }): Parsed {
    return new Parser(foldTypography(text), options?.mode ?? "final", text).run();
}

/* ------------------------------------------------------------------ scanning */

/** Characters that end the word scanned as a possible head. */
const HEAD_ENDS = new Set<string>([
    GRAMMAR.bind, GRAMMAR.phrase, GRAMMAR.scope.open, GRAMMAR.scope.close,
    GRAMMAR.group.open, GRAMMAR.group.close, GRAMMAR.or,
]);

/**
 * First characters of the prefix operators. Where one follows a known head word, the colon is implied: `model<=4`
 * reads as `model:<=4` — the family convention, and measured safe: no name glues a head word to a comparison.
 * An unknown word keeps the whole token as ordinary text, so `a=b` stays searchable.
 */
const COMPARISON_STARTS: ReadonlySet<string> = new Set(
    PREFIX_OPERATORS.flatMap((op) => (typeof op.symbol === "string" ? [op.symbol[0]] : [])));

/** A run of numbers separated by the list character: the one shape a comma is structural in. */
const NUMBER_LIST = new RegExp(String.raw`^\d+(${escapeRegExp(GRAMMAR.numberList)}\d+)+$`);

const isWs = (c: string): boolean => /\s/.test(c);

/** A head that can open a row scope: a column or a kind. A property door takes a value, never a scope. */
type ScopeHead = Exclude<Head, { role: "prop" }>;

/** One piece of a value token: a bare run, a phrase, a regular expression, or a parenthesised group. */
interface Seg {
    readonly form: "bare" | "phrase" | "regex" | "group";
    /** Bare: the run itself. Phrase: the content, unescaped. Regex: the pattern. Group: the raw inner text. */
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly closed: boolean;
}

/** How one position reads an operand. Implementations differ by what the head resolved to. */
interface ValueCtx {
    operator(op: Operator, operand: string, opts: { readonly whole: string; readonly phrase?: boolean }): Interp;

    /** Reads `lo-hi`, or null when nothing in this position orders. */
    range(text: string): Interp | null;

    /** Reads a range whose bounds arrive already split, as in `(-50)-10`. */
    rangeParts(lo: string, hi: string): Interp | null;

    glob(pattern: string): Interp;

    /** `alone` is false inside alternation, where a kind word reads as content rather than as a kind test. */
    bare(word: string, alone: boolean): Interp;

    phrase(text: string): Interp;

    regex(pattern: string): Interp;

    star(): Interp;
}

/** What an operand resolved to, before it is shaped into a clause or a scope term. */
type Interp =
    | { readonly r: "content"; readonly value: ValueExpr }
    | { readonly r: "props"; readonly props: readonly PropRef[]; readonly value: ValueExpr }
    | { readonly r: "count"; readonly value: ValueExpr }
    | { readonly r: "kindWord"; readonly kind: Kind }
    | { readonly r: "exists" }
    | { readonly r: "empty"; readonly why: string }
    | {
    readonly r: "fail";
    readonly message: string;
    /** A symbol whose removal is the offered fix. */
    readonly fixDrop?: string;
    /** Offer removing the quotes as the fix. */
    readonly fixQuotes?: true;
    /**
     * A further keystroke could still change the verdict — the value did not parse, but more characters might
     * complete a word that does. Such a failure is held quietly while typing and reported only in final text,
     * where declined operators and structural impossibilities stay errors in both modes.
     */
    readonly rescuable?: true;
};

/** A finding collected while a clause is still being interpreted, attached once its index exists. */
interface Pending {
    readonly severity: Severity;
    readonly message: string;
    readonly fix?: Fix;
}

/** The operators that require an order, by name — the ones whose refusal message says "no ordering". */
const ORDERING_NAMES: ReadonlySet<string> = new Set(ORDERING.map((op) => op.name));

/** The comparisons written before a value, by name — the operators the count desugar answers. */
const COMPARABLE: ReadonlySet<string> = new Set(PREFIX_OPERATORS.map((op) => op.name));

/**
 * The prefix operators the expression tree can shape.
 *
 * A prefix operator outside this set would be recognised by the scanner — the grammar derives its spellings from the
 * registry — pass every acceptance check, and then have no {@link ValueExpr} variant to become. Declaring one
 * therefore starts by extending the union; until then the declaration fails here, at import, where it was made.
 */
const EXPRESSIBLE_PREFIX: ReadonlySet<string> = new Set(["exact", "lt", "lte", "gt", "gte"]);
for (const op of PREFIX_OPERATORS) {
    if (!EXPRESSIBLE_PREFIX.has(op.name)) {
        throw new Error(`prefix operator "${op.name}" has no shape in the expression tree`);
    }
}

const accepts = (type: AxisType, opName: string): boolean =>
    type.accepts.some((op) => op.name === opName);

/**
 * The synthetic property behind the count word, so cardinality reads operands like any numeric axis.
 *
 * Exported for simplification, whose count reasoning must read operands through exactly the property the desugar
 * binds them to — a second declaration would drift from this one.
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
 * Whether a type's values are quantities rather than strings.
 *
 * The quote rule turns on this: a phrase is a literal string value, and a quantity has no string reading, so a
 * quoted number is refused where a quoted word is read. Decided from the declarations — a type measuring in
 * notations, or edited as a bare number, holds quantities; everything read from words or text does not.
 */
const quantity = (type: AxisType): boolean => type.quantity === true;

/**
 * A group of alternatives as one expression.
 *
 * Exported for simplification, which builds alternative groups when folding clauses — the one expression node it
 * constructs that is not already in the tree it rewrites.
 */
export const anyOfExpr = (alternatives: readonly ValueExpr[]): ValueExpr => ({op: "anyOf", alternatives});

/**
 * Why a pattern will not compile, or null when it will.
 *
 * Validation goes through the evaluator's own compiler, so a pattern that validates always runs.
 *
 * @param pattern A regular expression's source, as written between the slashes.
 * @returns The engine's own complaint, or null.
 */
function patternProblem(pattern: string): string | null {
    const compiled = compilePattern(pattern);
    return typeof compiled === "string" ? compiled : null;
}

/**
 * The pattern's compile failure as an interpretation, or null when it compiles.
 *
 * Rescuable, because a pattern is broken on most keystrokes of the way to being written.
 */
function badPattern(pattern: string): Interp | null {
    const problem = patternProblem(pattern);
    if (problem === null) return null;
    return {r: "fail", rescuable: true, message: `not a valid pattern: ${problem}`};
}

/** Whether any of the types is the path type, whose glued names make patterns weak — the warning turns on this. */
const pathTyped = (types: readonly AxisType[]): boolean => types.includes(pathType);

/**
 * Reads a phrase opened at `at`: a leaf — nothing inside is active — whose escape restores a literal quote. Every
 * walker that must step over a phrase goes through this, so the escape rule exists once.
 */
function scanPhrase(text: string, at: number, limit: number): Seg {
    let out = "";
    let i = at + 1;
    let closed = false;
    while (i < limit) {
        const c = text[i];
        if (c === GRAMMAR.escape && i + 1 < limit) {
            out += text[i + 1];
            i += 2;
            continue;
        }
        if (c === GRAMMAR.phrase) {
            closed = true;
            i++;
            break;
        }
        out += c;
        i++;
    }
    return {form: "phrase", text: out, start: at, end: i, closed};
}

/** The message a regex gets on an axis with nothing textual to run it over. */
const NO_REGEX = "regular expressions run on text and file paths only";

/** The content interpretation of a value expression, the shape plain search and column content share. */
const content = (value: ValueExpr): Interp => ({r: "content", value});

/** The refusal for an operator an axis cannot answer, with the drop-the-symbol fix. */
function declined(word: string, op: Operator): Interp {
    return {
        r: "fail",
        message: ORDERING_NAMES.has(op.name)
            ? `the ${word} axis has no ordering`
            : `the ${word} axis cannot answer ${op.symbol ?? op.name}`,
        fixDrop: op.symbol ?? undefined,
    };
}

/** The refusal for an operand the axis cannot read; rescuable, because the next keystroke may finish a word. */
function illTyped(word: string, prop: Prop): Interp {
    return {r: "fail", rescuable: true, message: `${word} takes ${hintOf(prop)}`};
}

/** The refusal for a quoted quantity, with the drop-the-quotes fix. */
function quotedQuantity(word: string, prop: Prop): Interp {
    return {
        r: "fail", rescuable: true, fixQuotes: true,
        message: `${word} takes ${hintOf(prop)} — a quoted value is text`,
    };
}

/** A pattern on a file path is honest but weak, and the warning says why — once per clause. */
function warnPathGlob(pend: Pending[]): void {
    const message = "a pattern on a file path rarely helps — path names run words together";
    if (!pend.some((p) => p.message === message)) pend.push({severity: "warning", message});
}

/**
 * Merges the interpretations of a value's alternatives into one.
 *
 * Alternatives must resolve the same way — all content, all one property family, all counts — because a single chip
 * carries one question. A failure in any alternative is the whole value's failure.
 */
function combineAlternatives(parts: readonly Interp[]): Interp {
    const failed = parts.find((p) => p.r === "fail");
    if (failed !== undefined) return failed;
    const real = parts.filter((p) => p.r !== "empty");
    if (real.length === 0) return {r: "empty", why: "names no value"};
    if (real.length === 1) return real[0];

    if (real.every((p) => p.r === "content")) {
        return {r: "content", value: anyOfExpr(real.map((p) => (p as { value: ValueExpr }).value))};
    }
    if (real.every((p) => p.r === "props")) {
        const props: PropRef[] = [];
        for (const p of real as ReadonlyArray<{ props: readonly PropRef[] }>) {
            for (const ref of p.props) {
                if (!props.some((have) => have.kind === ref.kind && have.prop === ref.prop)) props.push(ref);
            }
        }
        return {r: "props", props, value: anyOfExpr(real.map((p) => (p as { value: ValueExpr }).value))};
    }
    if (real.every((p) => p.r === "count")) {
        return {r: "count", value: anyOfExpr(real.map((p) => (p as { value: ValueExpr }).value))};
    }
    return {r: "fail", message: "these alternatives ask different questions"};
}

/* ------------------------------------------------------------------ the parser */

class Parser {
    private readonly clauses: Clause[] = [];
    private readonly diagnostics: Diagnostic[] = [];
    private readonly runs: number[][] = [];
    private current: number[] = [];

    /**
     * @param text The query, typography folded — what every structural decision reads.
     * @param mode Keystroke state or final text.
     * @param raw The query as typed, for the one value that must not fold: a regex pattern matches stored text
     *   as written, so its characters are taken from here. Folding is one-to-one, so positions line up.
     */
    constructor(private readonly text: string, private readonly mode: ParseMode,
                private readonly raw: string = text) {
    }

    run(): Parsed {
        const n = this.text.length;
        let i = 0;
        let guard = n + 1;
        while (i < n && guard-- > 0) {
            const c = this.text[i];
            if (isWs(c)) {
                i++;
                continue;
            }
            if (c === GRAMMAR.or) {
                this.closeRun();
                i++;
                continue;
            }
            const next = this.clause(i, n);
            // Progress is structural, but a guard keeps a defect here from hanging the page rather than throwing.
            i = next > i ? next : i + 1;
        }
        this.closeRun();
        return {
            clauses: this.clauses,
            groups: this.runs.filter((run) => run.length > 0),
            diagnostics: this.diagnostics,
        };
    }

    private closeRun(): void {
        this.runs.push(this.current);
        this.current = [];
    }

    /** Adds a clause, files it into the current alternation group, and attaches its findings. */
    private push(span: Span, not: boolean, state: ClauseState, ask: Ask | null, pend: readonly Pending[]): number {
        const index = this.clauses.length;
        this.clauses.push({span, not, state, ask});
        if (state === "ok") this.current.push(index);
        for (const p of pend) {
            this.diagnostics.push({severity: p.severity, clause: index, message: p.message, fix: p.fix});
        }
        return index;
    }

    /** A repaired copy of the whole query, for a diagnostic's fix. */
    private splice(start: number, end: number, replacement: string): string {
        return this.text.slice(0, start) + replacement + this.text.slice(end);
    }

    /* -------------------------------------------------------------- clauses */

    /** Parses one clause starting at `i`. Returns the position to continue from. */
    private clause(i: number, limit: number): number {
        const start = i;
        let not = false;
        if (this.text[i] === GRAMMAR.negate) {
            const next = i + 1 < limit ? this.text[i + 1] : "";
            if (next === "" || isWs(next) || next === GRAMMAR.or) {
                const pend: Pending[] = this.mode === "final"
                    ? [{severity: "error", message: `"${GRAMMAR.negate}" negates nothing`}]
                    : [];
                this.push({start, end: i + 1}, true, this.mode === "final" ? "invalid" : "incomplete", null, pend);
                return i + 1;
            }
            not = true;
            i++;
        }

        // A word followed by a colon is a head when the schema knows it; otherwise the whole token is ordinary text.
        // A comparison straight after a head word implies the colon: `model<=4` is `model:<=4`. Neither reads
        // across whitespace: at the top level, space separates clauses, and only a scope's body bridges it.
        const j = this.wordEnd(i, limit);
        if (j > i) {
            const head = HEADS.get(fold(this.text.slice(i, j)));
            if (head !== undefined) {
                if (this.text[j] === GRAMMAR.bind) return this.bound(start, not, head, j + 1, limit);
                if (COMPARISON_STARTS.has(this.text[j])) return this.bound(start, not, head, j, limit);
            }
        }
        return this.term(start, not, i, limit);
    }

    /**
     * Scans past the run that could be a head word: to whitespace, a structural character, or a comparison — the
     * one rule the implied colon turns on, shared by the top level and the scope body.
     */
    private wordEnd(i: number, limit: number): number {
        let j = i;
        while (j < limit && !isWs(this.text[j]) && !HEAD_ENDS.has(this.text[j])
        && !COMPARISON_STARTS.has(this.text[j])) j++;
        return j;
    }

    /** Parses a bare term: plain search over everything declared plain. */
    private term(start: number, not: boolean, i: number, limit: number): number {
        const {segs, end} = this.scanToken(i, limit, {inScope: false, groups: false});
        if (segs.length === 0) return end;
        const pend: Pending[] = [];
        const {main, extras} = this.interpretSegs(segs, this.topCtx(), pend);
        this.pushInterp({start, end: segs[0].end}, not, null, main, pend, segs[0]);
        this.emitExtras(extras);
        return end;
    }

    /** Re-emits segments split off a glued token as terms of their own. A single segment sheds no extras. */
    private emitExtras(extras: readonly Seg[]): void {
        const ctx = this.topCtx();
        for (const seg of extras) {
            const pend: Pending[] = [];
            const {main} = this.interpretSegs([seg], ctx, pend);
            this.pushInterp({start: seg.start, end: seg.end}, false, null, main, pend, seg);
        }
    }

    /** The first position at or after `i` holding a non-whitespace character, capped at `limit`. */
    private skipWs(i: number, limit: number): number {
        let j = i;
        while (j < limit && isWs(this.text[j])) j++;
        return j;
    }

    /**
     * Scans the value token at `vpos`, bridging one whitespace gap between a lone operator and its operand —
     * `{count > 5}` reads as `{count>5}` — inside a scope's body only, and in final text only, so the top level
     * and keystroke states keep whitespace as the separator it is everywhere else.
     */
    private valueToken(vpos: number, limit: number, opts: { inScope: boolean; groups: boolean }):
        { segs: Seg[]; end: number } {
        const first = this.scanToken(vpos, limit, opts);
        if (this.mode !== "final" || !opts.inScope || first.segs.length !== 1) return first;
        const [only] = first.segs;
        if (only.form !== "bare" || !PREFIX_OPERATORS.some((op) => op.symbol === only.text)) return first;
        const k = this.skipWs(first.end, limit);
        if (k === first.end || k >= limit) return first;
        const c = this.text[k];
        if (c === GRAMMAR.or || c === GRAMMAR.negate || c === GRAMMAR.scope.close || c === GRAMMAR.scope.open) {
            return first;
        }
        const operand = this.scanToken(k, limit, opts);
        if (operand.segs.length === 0) return first;
        return {segs: [...first.segs, ...operand.segs], end: operand.end};
    }

    /** Parses `head:` and whatever follows the colon. */
    private bound(start: number, not: boolean, head: Head, vpos: number, limit: number): number {
        const c = vpos < limit ? this.text[vpos] : "";
        if (c === "" || isWs(c) || c === GRAMMAR.scope.close) {
            return this.emptyBind(start, not, head, vpos);
        }
        if (c === GRAMMAR.scope.open) {
            if (head.role === "prop") return this.propScope(start, not, head, vpos, limit);
            return this.scope(start, not, head, vpos, limit);
        }

        if (head.role !== "prop") {
            const glued = this.innerGlue(start, not, head, vpos, limit);
            if (glued !== null) return glued;
        }

        const {segs, end} = this.scanToken(vpos, limit, {inScope: false, groups: true});
        const only = segs.length === 1 ? segs[0] : undefined;
        if (only !== undefined && only.form === "group" && head.role !== "prop" && this.scopeShaped(only.text)) {
            // Lenient input: a parenthesised scope is accepted and read as one, since the two readings never both
            // parse into different meanings.
            return this.scopeBody(start, not, head, only.start + 1, only.start + 1 + only.text.length,
                only.closed, end, limit);
        }

        const pend: Pending[] = [];
        const {main, extras} = this.interpretSegs(segs, this.ctxFor(head, pend), pend);
        this.noteCountDesugar(head, main, segs, pend);
        this.pushInterp({start, end: segs.length > 0 ? segs[segs.length - 1 - extras.length].end : end}, not, head,
            main, pend, segs[0]);
        this.emitExtras(extras);
        return end;
    }

    /**
     * A glued inner bind straight after the head's colon: `model:count<5`, `model:file=foo`.
     *
     * The lenient reading lands on the very structure the braced spelling parses to — a one-term row scope —
     * through the same word resolution the scope body uses, so the two spellings cannot drift. Only an OPERATOR
     * binds the word: the colon-glued shape (`sound:kit:150`) deliberately keeps its content reading, because a
     * second colon in a value has never been given a meaning. Only a word the head resolves binds; an unknown or
     * foreign word keeps its content reading, and a quoted value remains the escape for text that happens to
     * carry an operator.
     */
    private innerGlue(start: number, not: boolean, head: ScopeHead, vpos: number, limit: number): number | null {
        const j = this.wordEnd(vpos, limit);
        if (j <= vpos || j >= limit) return null;
        if (!COMPARISON_STARTS.has(this.text[j])) return null;
        const pend: Pending[] = [];
        const bind = this.innerBind(head, fold(this.text.slice(vpos, j)), pend);
        if (bind === null || bind.kind === "foreign") return null;
        const {segs, end} = this.scanToken(j, limit, {inScope: false, groups: true});
        if (segs.length === 0) return null;
        const {main, extras} = this.interpretSegs(segs, bind.ctx, pend);
        if (main.r === "fail" || main.r === "empty") {
            this.pushInterp({start, end: segs[segs.length - 1 - extras.length].end}, not, head, main, pend, segs[0]);
            this.emitExtras(extras);
            return end;
        }
        const last = segs[segs.length - 1 - extras.length].end;
        const term: ScopeTerm = {span: {start: vpos, end: last}, not: false, state: "ok", ask: this.scopeAsk(main)};
        const test: RowTest = {is: "scope", terms: [[term]]};
        const ask: Ask = head.role === "column"
            ? {on: "column", column: head.column, test}
            : {on: "kind", kind: head.kind, test};
        this.push({start, end: last}, not, "ok", ask, pend);
        this.emitExtras(extras);
        return end;
    }

    /** A bind with no value: incomplete while typing, a broken chip in final text. */
    private emptyBind(start: number, not: boolean, head: Head, vpos: number): number {
        const word = this.headWord(head);
        const ask = this.incompleteAsk(head);
        if (this.mode === "final") {
            this.push({start, end: vpos}, not, "invalid", ask,
                [{severity: "error", message: `${word}: names no value`}]);
        } else {
            this.push({start, end: vpos}, not, "incomplete", ask, []);
        }
        return vpos;
    }

    private headWord(head: Head): string {
        if (head.role === "column") return head.column.key;
        if (head.role === "kind") return wordOf(head.kind);
        return doorOf(head.name, head.prop);
    }

    private incompleteAsk(head: Head): Ask {
        if (head.role === "column") return {on: "column", column: head.column, test: null};
        if (head.role === "kind") return {on: "kind", kind: head.kind, test: null};
        return {on: "prop", ref: {kind: head.kind, prop: head.name}, value: null};
    }

    /** The column-form count desugar is correct and worth saying, so it carries a note. */
    private noteCountDesugar(head: Head, main: Interp, segs: readonly Seg[], pend: Pending[]): void {
        if (main.r !== "count") return;
        const label = head.role === "column" ? head.column.label.toLowerCase()
            : head.role === "kind" ? wordOf(head.kind) : "";
        const raw = this.text.slice(segs[0].start, segs[segs.length - 1].end);
        pend.push({severity: "note", message: `${this.headWord(head)}:${raw} counts ${label} rows`});
    }

    /* -------------------------------------------------------------- scopes */

    /** A property takes a value; a scope after one has nothing to bind to. */
    private propScope(start: number, not: boolean, head: Head & {
        role: "prop"
    }, brace: number, limit: number): number {
        const end = this.skipBraces(brace, limit);
        this.push({start, end}, not, "invalid", this.incompleteAsk(head),
            [{severity: "error", message: `${this.headWord(head)}: takes a value, not a scope`}]);
        return end;
    }

    /** Consumes a balanced brace run, or the rest of the input when it never closes. */
    private skipBraces(open: number, limit: number): number {
        let depth = 0;
        let i = open;
        while (i < limit) {
            const c = this.text[i];
            if (c === GRAMMAR.phrase) {
                i = scanPhrase(this.text, i, limit).end;
                continue;
            }
            if (c === GRAMMAR.scope.open) depth++;
            if (c === GRAMMAR.scope.close && --depth === 0) return i + 1;
            i++;
        }
        return limit;
    }

    /** Parses `head:{…}`: finds the scope's extent, refuses nesting, then reads the body. */
    private scope(start: number, not: boolean, head: ScopeHead, brace: number, limit: number): number {
        let i = brace + 1;
        let innerBrace = -1;
        let close = -1;
        while (i < limit) {
            const c = this.text[i];
            if (c === GRAMMAR.phrase) {
                i = scanPhrase(this.text, i, limit).end;
                continue;
            }
            if (c === GRAMMAR.scope.open && innerBrace < 0) innerBrace = i;
            if (c === GRAMMAR.scope.close && innerBrace < 0) {
                close = i;
                break;
            }
            if (c === GRAMMAR.scope.close && innerBrace >= 0) break;
            i++;
        }

        if (innerBrace >= 0) {
            // Depth follows the data, and every property today is a scalar — so a second brace has no referent and
            // no suffix can give it one. Invalid immediately, even while typing.
            const end = this.skipBraces(brace, limit);
            const message = this.text[innerBrace - 1] === GRAMMAR.bind
                ? "an axis inside a scope takes a value, not a scope"
                : "a scope cannot hold another scope";
            this.push({start, end}, not, "invalid", this.incompleteAsk(head),
                [{severity: "error", message}]);
            return end;
        }

        const closed = close >= 0;
        const bodyEnd = closed ? close : limit;
        const after = closed ? close + 1 : limit;
        return this.scopeBody(start, not, head, brace + 1, bodyEnd, closed, after, limit);
    }

    /**
     * Parses a scope's inner clauses and assembles the clause.
     *
     * An unclosed scope is closed before the first inner bind that cannot belong to it — the only recovery that does
     * not absorb a correctly-written clause — and at the end of input when everything belongs.
     */
    private scopeBody(start: number, not: boolean, head: ScopeHead, bodyStart: number, bodyEnd: number,
                      closed: boolean, after: number, limit: number): number {
        const pend: Pending[] = [];
        const scopeRuns: ScopeTerm[][] = [];
        let run: ScopeTerm[] = [];
        let items = 0;
        let resumeAt = -1;
        let foreign: { span: Span; message: string } | null = null;

        let i = bodyStart;
        let guard = bodyEnd - bodyStart + 1;
        while (i < bodyEnd && guard-- > 0) {
            const c = this.text[i];
            if (isWs(c)) {
                i++;
                continue;
            }
            if (c === GRAMMAR.or) {
                scopeRuns.push(run);
                run = [];
                i++;
                continue;
            }
            const termStart = i;
            let termNot = false;
            if (c === GRAMMAR.negate) {
                const next = i + 1 < bodyEnd ? this.text[i + 1] : "";
                if (next === "" || isWs(next) || next === GRAMMAR.or) {
                    run.push({span: {start: termStart, end: i + 1}, not: true, state: "incomplete", ask: null});
                    i += 1;
                    items++;
                    continue;
                }
                termNot = true;
                i++;
            }

            const resolved = this.innerItem(head, termStart, termNot, i, bodyEnd, run, pend);
            items++;
            if (resolved.kind === "foreign") {
                if (closed) {
                    foreign = {span: resolved.span, message: resolved.message};
                    break;
                }
                resumeAt = termStart;
                break;
            }
            i = resolved.next > i ? resolved.next : i + 1;
        }
        scopeRuns.push(run);

        if (foreign !== null) {
            const fix = items === 1 ? this.foreignFix(start, not, head, foreign.span, after) : undefined;
            this.push({start, end: after}, not, "invalid", this.incompleteAsk(head),
                [...pend, {severity: "error", message: foreign.message, fix}]);
            return after;
        }

        const emptyBody = items === 0;
        const terms = this.applyAnchorRule(scopeRuns, pend);
        if (terms === null) {
            this.push({start, end: after}, not, "invalid", this.incompleteAsk(head), pend);
            return after;
        }

        // An unclosed empty brace mid-keystroke is on its way to holding something; the note waits until the
        // scope is really written as empty.
        if (emptyBody && (closed || this.mode === "final")) {
            const word = this.headWord(head);
            pend.push({severity: "note", message: `${word}:{} means any ${word} row — the same as ${word}:*`});
        }
        this.scopeWarnings(terms, pend);

        if (!closed && this.mode === "final") {
            const repaired = resumeAt >= 0
                ? this.splice(resumeAt, resumeAt, `${GRAMMAR.scope.close} `)
                : this.splice(after, after, GRAMMAR.scope.close);
            pend.push({
                severity: "warning",
                message: resumeAt >= 0
                    ? "the scope was not closed — closed it before the next clause"
                    : "the scope was not closed — closed it at the end",
                fix: {label: "close the scope", query: repaired},
            });
        }

        const test: RowTest = {is: "scope", terms};
        const ask: Ask = head.role === "column"
            ? {on: "column", column: head.column, test}
            : {on: "kind", kind: head.kind, test};
        const clauseEnd = resumeAt >= 0 ? resumeAt : after;
        this.push({start, end: clauseEnd}, not, "ok", ask, pend);

        if (closed) this.gluedAfterClose(after, limit);
        return resumeAt >= 0 ? resumeAt : after;
    }

    /** The documented fix for a one-bind foreign scope: the scope as existence, the bind as its own clause. */
    private foreignFix(start: number, not: boolean, head: Head, bindSpan: Span, after: number): Fix {
        const negate = not ? GRAMMAR.negate : "";
        const bind = this.text.slice(bindSpan.start, bindSpan.end);
        const replacement = `${negate}${this.headWord(head)}:${GRAMMAR.wildcard} ${bind}`;
        return {label: "make it its own clause", query: this.splice(start, after, replacement)};
    }

    /**
     * Enforces the positive anchor per alternation group: negation refines, it may not be the whole predicate.
     *
     * While typing the group is incomplete — one more term fixes it. In final text it is an error, and the clause is
     * refused whole. Returns null in that case.
     */
    private applyAnchorRule(scopeRuns: ScopeTerm[][], pend: Pending[]): ScopeTerm[][] | null {
        const out: ScopeTerm[][] = [];
        for (const run of scopeRuns) {
            const ok = run.filter((t) => t.state === "ok");
            const anchorless = ok.length > 0 && ok.every((t) => t.not);
            if (!anchorless) {
                out.push(run);
                continue;
            }
            if (this.mode === "final") {
                pend.push({severity: "error", message: "a scope needs a positive term — negation only refines"});
                return null;
            }
            out.push(run.map((t): ScopeTerm => ({span: t.span, not: t.not, state: "incomplete", ask: t.ask})));
        }
        return out;
    }

    /** The legal-but-misleading shapes: both warned, neither refused. */
    private scopeWarnings(terms: ScopeTerm[][], pend: Pending[]): void {
        for (const run of terms) {
            const ok = run.filter((t) => t.state === "ok" && t.ask !== null);
            const positives = ok.filter((t) => !t.not);
            if (positives.length === 0) continue;

            const negatedContent = ok.find((t) => t.not && t.ask?.on === "content");
            if (negatedContent !== undefined && positives.every((t) => t.ask?.on === "content")) {
                pend.push({
                    severity: "warning",
                    message: "both sides are content words, which rarely share one row — "
                        + "negate a kind word or a property instead",
                });
            }

            const allQualifier = positives.every((t) => t.ask?.on === "props"
                && t.ask.props.every((ref) => propOf(ref).qualifier));
            if (allQualifier) {
                const first = positives[0].ask;
                const name = first !== null && first.on === "props" ? first.props[0].prop : "";
                pend.push({
                    severity: "warning",
                    message: `a ${name} only says who a row plays on — add what the row is`,
                });
            }
        }
    }

    /** Text glued to a closing brace is a missing space: repaired always, announced in final text. */
    private gluedAfterClose(after: number, limit: number): void {
        const c = after < limit ? this.text[after] : "";
        if (c === "" || isWs(c) || c === GRAMMAR.or) return;
        if (this.mode === "final") {
            this.diagnostics.push({
                severity: "warning",
                clause: this.clauses.length - 1,
                message: `missing space after ${GRAMMAR.scope.close}`,
                fix: {label: "insert the space", query: this.splice(after, after, " ")},
            });
        }
    }

    /**
     * Parses one inner item — a bind or a term — and appends its scope terms to the current group.
     *
     * Returns `foreign` for a bind that cannot belong to this scope; the caller decides between an error and closing
     * the scope in front of it, depending on whether the brace was ever closed.
     */
    private innerItem(head: ScopeHead, termStart: number, termNot: boolean, i: number, bodyEnd: number,
                      run: ScopeTerm[], pend: Pending[]):
        { kind: "done"; next: number } | { kind: "foreign"; span: Span; message: string } {
        const j = this.wordEnd(i, bodyEnd);
        // In final text a comparison reads across whitespace inside the scope — `{count > 5}` — while a colon
        // binds only glued: whitespace tolerance does not extend to colons.
        let sepAt = j;
        if (this.mode === "final" && j > i && j < bodyEnd && isWs(this.text[j])) {
            const k = this.skipWs(j, bodyEnd);
            if (k < bodyEnd && COMPARISON_STARTS.has(this.text[k])) sepAt = k;
        }
        const sep = sepAt < bodyEnd ? this.text[sepAt] : "";
        if (j > i && (sep === GRAMMAR.bind || COMPARISON_STARTS.has(sep))) {
            const word = fold(this.text.slice(i, j));
            const bind = this.innerBind(head, word, pend);
            if (bind !== null) {
                // The implied colon works inside a scope too: `model:{count<=4}`.
                const vpos = sep === GRAMMAR.bind ? sepAt + 1 : sepAt;
                if (bind.kind === "foreign") {
                    const tokenEnd = this.scanToken(vpos, bodyEnd, {inScope: true, groups: true}).end;
                    return {kind: "foreign", span: {start: termStart, end: tokenEnd}, message: bind.message};
                }
                const {segs, end} = this.valueToken(vpos, bodyEnd, {inScope: true, groups: true});
                if (segs.length === 0) {
                    // An inner bind with no value: nothing to constrain the row with yet.
                    if (this.mode === "final") {
                        pend.push({severity: "warning", message: `${word}: names no value and was ignored`});
                    }
                    run.push({span: {start: termStart, end: vpos}, not: termNot, state: "incomplete", ask: null});
                    return {kind: "done", next: vpos};
                }
                const {main, extras} = this.interpretSegs(segs, bind.ctx, pend);
                this.pushScopeTerm(run, {start: termStart, end: segs[segs.length - 1].end}, termNot,
                    main, pend, word);
                this.scopeExtras(head, extras, run, pend);
                return {kind: "done", next: end};
            }
            // An unknown word before a colon is ordinary text inside a scope too.
        }

        const {segs, end} = this.scanToken(i, bodyEnd, {inScope: true, groups: false});
        if (segs.length === 0) return {kind: "done", next: i + 1};
        const {main, extras} = this.interpretSegs(segs, this.ctxFor(head, pend), pend);
        this.pushScopeTerm(run, {start: termStart, end: segs[segs.length - 1].end}, termNot, main, pend,
            this.text.slice(i, end));
        this.scopeExtras(head, extras, run, pend);
        return {kind: "done", next: end};
    }

    /** Segments split off a glued inner token become content terms of the same scope. */
    private scopeExtras(head: ScopeHead, extras: readonly Seg[], run: ScopeTerm[], pend: Pending[]): void {
        if (extras.length === 0) return;
        const ctx = this.ctxFor(head, pend);
        for (const seg of extras) {
            const {main} = this.interpretSegs([seg], ctx, pend);
            this.pushScopeTerm(run, {start: seg.start, end: seg.end}, false, main, pend, seg.text);
        }
    }

    /** Appends one interpreted scope term, downgrading failures to term-level findings. */
    private pushScopeTerm(run: ScopeTerm[], span: Span, not: boolean, interp: Interp, pend: Pending[],
                          word: string): void {
        if (interp.r === "fail") {
            if (interp.rescuable !== true || this.mode === "final") {
                pend.push({severity: "error", message: interp.message, fix: this.failFix(span, interp)});
            }
            run.push({span, not, state: "incomplete", ask: null});
            return;
        }
        if (interp.r === "empty") {
            // In final text nothing more is coming, so the unsayable term is an error, not a quiet drop.
            if (this.mode === "final") {
                pend.push({severity: "error", message: `"${word}" ${interp.why} and was ignored`});
            }
            run.push({span, not, state: "incomplete", ask: null});
            return;
        }
        run.push({span, not, state: "ok", ask: this.scopeAsk(interp)});
    }

    private scopeAsk(interp: Exclude<Interp, { r: "fail" } | { r: "empty" }>): ScopeAsk {
        if (interp.r === "content") return {on: "content", value: interp.value};
        if (interp.r === "props") return {on: "props", props: interp.props, value: interp.value};
        if (interp.r === "count") return {on: "count", value: interp.value};
        if (interp.r === "kindWord") return {on: "kindWord", kind: interp.kind};
        return {on: "content", value: {op: "present"}};
    }

    /**
     * Resolves an inner bind's word: the count axis, a kind of this column, a property, or a foreigner.
     *
     * Null means the word is unknown here and the token reads as ordinary text. Inside a kind scope there is no
     * unknown: only the kind's declared properties are legal, so anything else is a wrong property rather than text.
     */
    private innerBind(head: ScopeHead, word: string, pend: Pending[]):
        | { kind: "ctx"; ctx: ValueCtx }
        | { kind: "foreign"; message: string }
        | null {
        if (head.role === "kind") {
            const kind = head.kind;
            const prop = propIn(kind, word);
            if (prop !== undefined) {
                return {kind: "ctx", ctx: this.propCtx([{kind, prop}], word, pend)};
            }
            if (word === GRAMMAR.countWord) return {kind: "ctx", ctx: this.countCtx(pend)};
            const kindWord = wordOf(kind);
            return {kind: "foreign", message: `${kindWord} has no "${word}" property`};
        }

        const column = head.column;
        if (word === GRAMMAR.countWord) return {kind: "ctx", ctx: this.countCtx(pend)};

        const kindMatch = kindIn(column, word);
        if (kindMatch !== undefined) {
            return {kind: "ctx", ctx: this.kindCtx(kindMatch, false, pend)};
        }

        const refs = kindsOf(column).flatMap((k): PropRef[] => {
            const prop = propIn(k, word);
            return prop === undefined ? [] : [{kind: k, prop}];
        });
        if (refs.length > 0) return {kind: "ctx", ctx: this.propCtx(refs, word, pend)};

        if (HEADS.has(word)) {
            return {kind: "foreign", message: `a ${word} axis cannot read a ${column.key} row`};
        }
        return null;
    }

    /* -------------------------------------------------------------- token scanning */

    /**
     * Scans one value token: everything to the next whitespace at depth zero, or to the brace closing the scope.
     *
     * Quotes always open a phrase; parens open a group only where `groups` says a value is expected — in top-level
     * free text they are ordinary characters, which is what keeps every parenthesised spell name searchable.
     */
    private scanToken(from: number, limit: number, opts: { inScope: boolean; groups: boolean }):
        { segs: Seg[]; end: number } {
        const segs: Seg[] = [];
        let cur = "";
        let curStart = from;
        let i = from;
        const flush = (end: number): void => {
            if (cur !== "") segs.push({form: "bare", text: cur, start: curStart, end, closed: true});
            cur = "";
        };
        // A regex opens only in value position, and only where the token begins — in free text and mid-token a
        // slash is an ordinary character, which is what keeps pasted path fragments searchable.
        const regexHere = opts.inScope || opts.groups;
        while (i < limit) {
            const c = this.text[i];
            if (isWs(c)) break;
            if (opts.inScope && (c === GRAMMAR.scope.close || c === GRAMMAR.scope.open)) break;
            // …or straight after a lone operator symbol, so that `=/fire/` parses far enough to be refused
            // as the contradiction it is instead of reading as literal text.
            if (regexHere && c === GRAMMAR.regex && segs.length === 0
                && (cur === "" || PREFIX_OPERATORS.some((op) => op.symbol === cur))) {
                flush(i);
                const pattern = this.scanRegex(i, limit);
                segs.push(pattern);
                i = pattern.end;
                curStart = i;
                continue;
            }
            if (c === GRAMMAR.phrase) {
                flush(i);
                const phrase = scanPhrase(this.text, i, limit);
                segs.push(phrase);
                i = phrase.end;
                curStart = i;
                continue;
            }
            if (opts.groups && c === GRAMMAR.group.open) {
                flush(i);
                const group = this.scanGroup(i, limit);
                segs.push(group);
                i = group.end;
                curStart = i;
                continue;
            }
            cur += c;
            i++;
        }
        flush(i);
        return {segs, end: i};
    }

    /**
     * A regex is a leaf like a phrase, with one difference: the backslash survives, because the pattern needs it.
     * Only an escaped slash unwraps. The value still ends at whitespace — a pattern writes a space as `\s` — so tag
     * closure holds everywhere.
     */
    private scanRegex(at: number, limit: number): Seg {
        let out = "";
        let i = at + 1;
        let closed = false;
        while (i < limit) {
            const c = this.text[i];
            if (isWs(c)) break;
            if (c === GRAMMAR.escape && i + 1 < limit) {
                out += this.text[i + 1] === GRAMMAR.regex ? GRAMMAR.regex : c + this.raw[i + 1];
                i += 2;
                continue;
            }
            if (c === GRAMMAR.regex) {
                closed = true;
                i++;
                break;
            }
            out += this.raw[i];
            i++;
        }
        return {form: "regex", text: out, start: at, end: i, closed};
    }

    /** A group runs to its matching close; nested pairs and phrases inside are respected. */
    private scanGroup(at: number, limit: number): Seg {
        let depth = 1;
        let i = at + 1;
        const innerStart = i;
        while (i < limit) {
            const c = this.text[i];
            if (c === GRAMMAR.phrase) {
                i = scanPhrase(this.text, i, limit).end;
                continue;
            }
            if (c === GRAMMAR.group.open) depth++;
            if (c === GRAMMAR.group.close && --depth === 0) {
                return {form: "group", text: this.text.slice(innerStart, i), start: at, end: i + 1, closed: true};
            }
            i++;
        }
        return {form: "group", text: this.text.slice(innerStart, limit), start: at, end: limit, closed: false};
    }

    /** Whether a parenthesised value is really a scope: whitespace or a bind at its own depth zero says so. */
    private scopeShaped(inner: string): boolean {
        let depth = 0;
        let i = 0;
        while (i < inner.length) {
            const c = inner[i];
            if (c === GRAMMAR.phrase) {
                i = scanPhrase(inner, i, inner.length).end;
                continue;
            }
            if (c === GRAMMAR.group.open) depth++;
            if (c === GRAMMAR.group.close) depth--;
            if (depth === 0 && (isWs(c) || c === GRAMMAR.bind)) return true;
            i++;
        }
        return false;
    }

    /** Splits a group's inner text into alternatives at its own depth zero. */
    private splitAlternatives(inner: string): string[] {
        const parts: string[] = [];
        let cur = "";
        let depth = 0;
        let i = 0;
        while (i < inner.length) {
            const c = inner[i];
            if (c === GRAMMAR.phrase) {
                const end = scanPhrase(inner, i, inner.length).end;
                cur += inner.slice(i, end);
                i = end;
                continue;
            }
            if (c === GRAMMAR.group.open) depth++;
            if (c === GRAMMAR.group.close) depth--;
            if (c === GRAMMAR.or && depth === 0) {
                parts.push(cur);
                cur = "";
                i++;
                continue;
            }
            cur += c;
            i++;
        }
        parts.push(cur);
        return parts.map((p) => p.trim()).filter((p) => p !== "");
    }

    /* -------------------------------------------------------------- interpretation */

    /**
     * Interprets a token's segments as one value, splitting off what does not belong.
     *
     * A group holding alternatives distributes over glued text — shell brace expansion, so `(fire|frost)bolt` means
     * `firebolt` or `frostbolt`. A glued phrase or a glued single-value group can never mean anything, so the token
     * is repaired at the segment boundary: the first segment is the value and the rest return as `extras`, announced
     * in final text and silent per keystroke.
     */
    private interpretSegs(segs: readonly Seg[], ctx: ValueCtx, pend: Pending[]): { main: Interp; extras: Seg[] } {
        if (segs.length === 0) return {main: {r: "empty", why: "names no value"}, extras: []};

        const first = segs[0];
        if (segs.length >= 2 && first.form === "bare") {
            const op = PREFIX_OPERATORS.find((o) => o.symbol === first.text);
            const operand = segs[1];
            if (op !== undefined && operand.form === "regex") {
                // An anchor has nothing to anchor in a pattern, which carries its own anchors.
                const main: Interp = {
                    r: "fail",
                    message: `${op.symbol} and a pattern cannot combine`,
                    fixDrop: op.symbol ?? undefined,
                };
                return this.withGlueRepair(main, segs.slice(2), pend);
            }
            if (op !== undefined) {
                // A bare operand reaches here only through the whitespace bridge — adjacent bare segments never
                // come from one token — so it is the spaced spelling of the glued operator form, and its
                // alternatives split at the separator the glued form would have.
                const bareParts = operand.text.split(GRAMMAR.or).filter((part) => part !== "");
                const alternatives = operand.form === "phrase" ? null
                    : operand.form === "bare" ? (bareParts.length > 0 ? bareParts : [operand.text])
                        : this.splitAlternatives(operand.text);
                const main = alternatives === null
                    ? ctx.operator(op, operand.text, {whole: first.text + operand.text, phrase: true})
                    : combineAlternatives(alternatives.map((alt) => ctx.operator(op, alt, {whole: first.text + alt})));
                return this.withGlueRepair(main, segs.slice(2), pend);
            }
        }

        if (segs.length === 2) {
            const [a, b] = segs;
            if (a.form === "group" && a.closed && b.form === "bare" && b.text.startsWith(GRAMMAR.range)
                && b.text.length > 1) {
                const alts = this.splitAlternatives(a.text);
                if (alts.length === 1) {
                    const ranged = ctx.rangeParts(alts[0], b.text.slice(1));
                    if (ranged !== null) return {main: ranged, extras: []};
                }
            }
            if (a.form === "bare" && a.text.endsWith(GRAMMAR.range) && a.text.length > 1
                && b.form === "group" && b.closed) {
                const alts = this.splitAlternatives(b.text);
                if (alts.length === 1) {
                    const ranged = ctx.rangeParts(a.text.slice(0, -1), alts[0]);
                    if (ranged !== null) return {main: ranged, extras: []};
                }
            }
        }

        if (segs.length >= 2 && segs.every((s) => (s.form === "bare" || s.form === "group") && s.closed)) {
            const lists = segs.map((s) => s.form === "bare"
                ? s.text.split(GRAMMAR.or).filter((p) => p !== "")
                : this.splitAlternatives(s.text));
            const size = lists.reduce((n, list) => n * Math.max(list.length, 1), 1);
            if (segs.some((s, at) => s.form === "group" && lists[at].length >= 2)
                && lists.every((list) => list.length > 0) && size <= 64) {
                let combos = [""];
                for (const list of lists) combos = combos.flatMap((c) => list.map((part) => c + part));
                return {main: combineAlternatives(combos.map((c) => this.alternative(c, ctx, false))), extras: []};
            }
        }

        const main = this.singleSeg(first, ctx, pend);
        return this.withGlueRepair(main, segs.slice(1), pend);
    }

    private withGlueRepair(main: Interp, extras: readonly Seg[], pend: Pending[]): { main: Interp; extras: Seg[] } {
        if (extras.length > 0 && this.mode === "final") {
            const at = extras[0].start;
            pend.push({
                severity: "warning",
                message: "two values are glued together — a space is missing",
                fix: {label: "insert the space", query: this.splice(at, at, " ")},
            });
        }
        return {main, extras: [...extras]};
    }

    private singleSeg(seg: Seg, ctx: ValueCtx, pend: Pending[]): Interp {
        if (seg.form === "phrase") return ctx.phrase(seg.text);
        if (seg.form === "regex") {
            if (!seg.closed && this.mode === "final") {
                pend.push({
                    severity: "warning",
                    message: String.raw`the pattern was not closed — it ends at whitespace, so a space is written \s`,
                });
            }
            return ctx.regex(seg.text);
        }
        if (seg.form === "group") {
            if (!seg.closed && this.mode === "final") {
                pend.push({severity: "warning", message: "the group was not closed"});
            }
            const alts = this.splitAlternatives(seg.text);
            if (alts.length === 0) return {r: "empty", why: "is an empty group, which matches nothing"};
            const parts = alts.map((alt) => this.groupAlternative(alt, ctx, alts.length === 1));
            return combineAlternatives(parts);
        }
        return this.bareAlternatives(seg.text, ctx);
    }

    /** One alternative inside a group, which may itself be a phrase. */
    private groupAlternative(alt: string, ctx: ValueCtx, alone: boolean): Interp {
        if (alt.startsWith(GRAMMAR.phrase)) {
            const phrase = scanPhrase(alt, 0, alt.length);
            if (phrase.end >= alt.length) return ctx.phrase(phrase.text);
        }
        return this.alternative(alt, ctx, alone);
    }

    /** Splits glued alternation, then reads each alternative. */
    private bareAlternatives(t: string, ctx: ValueCtx): Interp {
        const real = t.split(GRAMMAR.or).filter((p) => p !== "");
        if (real.length === 0) return {r: "empty", why: "names no value"};
        if (real.length === 1) return this.alternative(real[0], ctx, true);
        return combineAlternatives(real.map((p) => this.alternative(p, ctx, false)));
    }

    /**
     * Reads one alternative: existence, a number list, a prefixed operator, a range, a pattern, or a plain word —
     * in that order, so that `<=` is an operator before `<` is and a comma list is numbers before it is text.
     */
    private alternative(t: string, ctx: ValueCtx, alone: boolean): Interp {
        if (t === "") return {r: "empty", why: "names no value"};
        if (t === GRAMMAR.wildcard) return ctx.star();
        if (NUMBER_LIST.test(t)) {
            return combineAlternatives(t.split(GRAMMAR.numberList).map((n) => ctx.bare(n, false)));
        }
        for (const op of PREFIX_OPERATORS) {
            const sym = op.symbol;
            if (sym === null || !t.startsWith(sym)) continue;
            const operand = t.slice(sym.length);
            if (operand === "") return {r: "empty", why: "compares against nothing"};
            if (op.name === "exact" && operand.includes(GRAMMAR.wildcard)) {
                return {r: "fail", message: "exact and a pattern cannot combine", fixDrop: sym};
            }
            return ctx.operator(op, operand, {whole: t});
        }
        const ranged = ctx.range(t);
        if (ranged !== null) return ranged;
        if (t.includes(GRAMMAR.wildcard)) return ctx.glob(t);
        return ctx.bare(t, alone);
    }

    /* -------------------------------------------------------------- value contexts */

    private ctxFor(head: Head, pend: Pending[]): ValueCtx {
        if (head.role === "column") return this.columnCtx(head.column, pend);
        if (head.role === "kind") return this.kindCtx(head.kind, true, pend);
        return this.propCtx([{kind: head.kind, prop: head.name}], this.headWord(head), pend);
    }

    /** An operand read against one property, or one word shared by several kinds' properties. */
    private propCtx(refs: readonly PropRef[], word: string, pend: Pending[]): ValueCtx {
        return this.typedCtx(propOf(refs[0]), word, pend, (value) => ({r: "props", props: refs, value}));
    }

    /** The count word: cardinality reads operands exactly as a numeric axis does. */
    private countCtx(pend: Pending[]): ValueCtx {
        return this.typedCtx(COUNT_PROP, GRAMMAR.countWord, pend, (value) => ({r: "count", value}));
    }

    /** The shared reader over a property's declared notations. */
    private typedCtx(prop: Prop, word: string, pend: Pending[], done: (value: ValueExpr) => Interp): ValueCtx {
        /** Whether the quoted text is one of the property's sentinel words, which are strings and stay reachable. */
        const isSentinel = (t: string): boolean => sentinelOf(prop, t) !== null;
        /** The string reading of a quoted operand: the first textual type answering `opName` that parses it. */
        const stringReading = (t: string, opName: string): ParsedValue | null => {
            for (const type of prop.types) {
                if (quantity(type) || !accepts(type, "contains") || !accepts(type, opName)) continue;
                const value = type.parse?.(t);
                if (value !== null && value !== undefined) return {type, value};
            }
            return null;
        };
        /**
         * The quote law's refusal: a quoted operand that is neither a sentinel word nor readable as anything but a
         * quantity is refused, because a quantity has no string reading.
         */
        const refusesQuote = (t: string): boolean => {
            if (isSentinel(t)) return false;
            const pv = parseValue(prop, t);
            return pv !== null ? quantity(pv.type) : prop.types.some(quantity);
        };
        const bareValue = (t: string): Interp => {
            const pv = parseValue(prop, t);
            if (pv === null) return illTyped(word, prop);
            const op = accepts(pv.type, "contains") ? "contains" as const : "exact" as const;
            return done({op, operand: {type: pv.type.name, value: pv.value, written: t}});
        };
        const openBound = (bound: string, op: "gte" | "lte"): Interp | null => {
            for (const type of prop.types) {
                if (!accepts(type, "range") || !accepts(type, op) || !type.parse) continue;
                const value = type.parse(bound);
                if (value !== null) return done({op, operand: {type: type.name, value, written: bound}});
            }
            return null;
        };
        const rangeParts = (lo: string, hi: string): Interp | null => {
            if (lo === GRAMMAR.wildcard && hi !== GRAMMAR.wildcard) return openBound(hi, "lte");
            if (hi === GRAMMAR.wildcard && lo !== GRAMMAR.wildcard) return openBound(lo, "gte");
            for (const type of prop.types) {
                if (!accepts(type, "range")) continue;
                // Bounds written without units read together, in one notation — never half factor, half proportion.
                const pair = type.parsePair?.(lo, hi);
                if (pair !== null && pair !== undefined) {
                    return done({
                        op: "range",
                        lo: {type: type.name, value: pair[0], written: lo},
                        hi: {type: type.name, value: pair[1], written: hi},
                    });
                }
                if (!type.parse) continue;
                const a = type.parse(lo);
                const b = type.parse(hi);
                if (a !== null && b !== null) {
                    return done({
                        op: "range",
                        lo: {type: type.name, value: a, written: lo},
                        hi: {type: type.name, value: b, written: hi},
                    });
                }
            }
            return null;
        };
        return {
            operator: (op, operand, opts): Interp => {
                if (opts.phrase === true) {
                    const read = stringReading(operand, op.name);
                    if (read !== null) {
                        return done(this.opExpr(op.name,
                            {type: read.type.name, value: read.value, written: operand}));
                    }
                    // A quoted operand is a string. Sentinel words are strings; a quantity is not, so an operator
                    // applied to a quoted number is refused rather than read as the number it looks like.
                    if (refusesQuote(operand)) return quotedQuantity(word, prop);
                }
                const pv = parseValue(prop, operand);
                if (pv === null) return illTyped(word, prop);
                if (!accepts(pv.type, op.name)) return declined(word, op);
                return done(this.opExpr(op.name, {type: pv.type.name, value: pv.value, written: operand}));
            },
            range: (t): Interp | null => {
                if (!prop.types.some((type) => accepts(type, "range"))) return null;
                if (t.endsWith(GRAMMAR.range) && t.length > 1) {
                    const open = openBound(t.slice(0, -1), "gte");
                    if (open !== null) {
                        // The trailing shorthand is the one open form whose reading is not on the page.
                        pend.push({
                            severity: "note",
                            message: `${t} reads as at least ${t.slice(0, -1)} — the same as ${GRAMMAR.wildcard} for the upper bound`,
                        });
                        return open;
                    }
                }
                for (let k = 1; k < t.length - 1; k++) {
                    if (t[k] !== GRAMMAR.range) continue;
                    const ranged = rangeParts(t.slice(0, k), t.slice(k + 1));
                    if (ranged !== null) return ranged;
                }
                return null;
            },
            rangeParts,
            glob: (pattern): Interp => {
                const globbing = prop.types.find((type) => accepts(type, "glob"));
                if (globbing === undefined) {
                    // Rescuable: `*-` is a keystroke away from the open range `*-10`, which is no pattern at all.
                    return {r: "fail", rescuable: true, message: `the ${word} axis has no patterns`};
                }
                if (pathTyped([globbing])) warnPathGlob(pend);
                return done({op: "glob", operand: {text: pattern}});
            },
            bare: bareValue,
            regex: (pattern): Interp => {
                if (!prop.types.some((type) => accepts(type, "regex"))) {
                    return {r: "fail", message: `the ${word} axis cannot run one — ${NO_REGEX}`};
                }
                return badPattern(pattern) ?? done({op: "regex", operand: {text: pattern}});
            },
            phrase: (t): Interp => {
                const read = stringReading(t, "contains");
                if (read !== null) {
                    return done({op: "contains", operand: {type: read.type.name, value: read.value, written: t}});
                }
                // A phrase is a string value. Word vocabularies — sentinels, roles, rungs — are strings, so
                // quoting one of their words is harmless; a quantity has no string reading, and refusing says
                // what the quotes did rather than silently reading the number they wrap.
                if (refusesQuote(t)) return quotedQuantity(word, prop);
                return bareValue(t);
            },
            star: (): Interp => done({op: "present"}),
        };
    }

    private opExpr(op: string, operand: ParsedOperand): ValueExpr {
        if (op === "exact") return {op: "exact", operand};
        if (op === "lt" || op === "lte" || op === "gt" || op === "gte") return {op, operand};
        // Unreachable: every prefix operator is checked against EXPRESSIBLE_PREFIX at import.
        throw new Error(`operator "${op}" has no expression shape`);
    }

    /**
     * An operand read against a kind: its properties claim it in declaration order — the subject first — and a
     * comparison no property claims falls back to counting the kind's rows, when the operand is a count and the
     * position allows one.
     */
    private kindCtx(kind: Kind, countFallback: boolean, pend: Pending[]): ValueCtx {
        const word = wordOf(kind);
        const refs = Object.keys(kind.props).map((prop): PropRef => ({kind, prop}));
        const subject = refs.length > 0 ? propOf(refs[0]) : COUNT_PROP;
        const countValue = (op: Operator, operand: string): Interp | null => {
            if (!countFallback || !COMPARABLE.has(op.name)) return null;
            const value = countType.parse?.(operand);
            if (value === null || value === undefined) return null;
            return {r: "count", value: this.opExpr(op.name, {type: countType.name, value, written: operand})};
        };
        return {
            operator: (op, operand, opts): Interp => {
                let claimed = false;
                for (const ref of refs) {
                    const pv = parseValue(propOf(ref), operand);
                    if (pv === null) continue;
                    claimed = true;
                    if (accepts(pv.type, op.name)) {
                        return this.propCtx([ref], word, pend).operator(op, operand, opts);
                    }
                }
                // A quoted operand is a string, which the count question refuses like any quantity.
                const counted = opts.phrase === true ? null : countValue(op, operand);
                if (counted !== null) return counted;
                if (claimed) return declined(word, op);
                return illTyped(word, subject);
            },
            range: (t): Interp | null => {
                for (const ref of refs) {
                    const ranged = this.propCtx([ref], word, pend).range(t);
                    if (ranged !== null) return ranged;
                }
                if (countFallback) return this.countCtx(pend).range(t);
                return null;
            },
            rangeParts: (lo, hi): Interp | null => {
                for (const ref of refs) {
                    const ranged = this.propCtx([ref], word, pend).rangeParts(lo, hi);
                    if (ranged !== null) return ranged;
                }
                if (countFallback) return this.countCtx(pend).rangeParts(lo, hi);
                return null;
            },
            glob: (pattern): Interp => {
                const globbing = refs.filter((ref) => propOf(ref).types.some((type) => accepts(type, "glob")));
                if (globbing.length === 0) {
                    return {r: "fail", rescuable: true, message: `the ${word} axis has no patterns`};
                }
                if (globbing.some((ref) => pathTyped(propOf(ref).types))) warnPathGlob(pend);
                return {r: "props", props: globbing, value: {op: "glob", operand: {text: pattern}}};
            },
            bare: (t): Interp => {
                const claimants = refs.filter((ref) => parseValue(propOf(ref), t) !== null);
                if (claimants.length === 0) return illTyped(word, subject);
                if (claimants.length === 1) {
                    return this.propCtx(claimants, word, pend).bare(t, false);
                }
                return {r: "props", props: claimants, value: {op: "contains", operand: {text: t}}};
            },
            regex: (pattern): Interp => {
                const takers = refs.filter((ref) => propOf(ref).types.some((type) => accepts(type, "regex")));
                if (takers.length === 0) {
                    return {r: "fail", message: `the ${word} axis cannot run one — ${NO_REGEX}`};
                }
                return badPattern(pattern)
                    ?? {r: "props", props: takers, value: {op: "regex", operand: {text: pattern}}};
            },
            phrase: (t): Interp => {
                const textual = refs.filter((ref) => propOf(ref).types.some((type) => {
                    if (quantity(type) || !accepts(type, "contains")) return false;
                    const value = type.parse?.(t);
                    return value !== null && value !== undefined;
                }));
                // A single claimant reads through its own property, so a typed operand — a colour, say — is
                // carried as its value; several claimants share one text operand, and are all textual.
                if (textual.length === 1) return this.propCtx(textual, word, pend).phrase(t);
                if (textual.length > 0) {
                    return {r: "props", props: textual, value: {op: "contains", operand: {text: t}}};
                }
                // No textual property reads it, so the string falls to the word vocabularies: sentinels and
                // word-valued properties take a quoted word; a quantity refuses a quoted number.
                const wordy = refs.filter((ref) => {
                    const prop = propOf(ref);
                    if (sentinelOf(prop, t) !== null) return true;
                    const pv = parseValue(prop, t);
                    return pv !== null && !quantity(pv.type);
                });
                if (wordy.length > 0) return this.propCtx(wordy, word, pend).phrase(t);
                const numeric = refs.some((ref) => parseValue(propOf(ref), t) !== null
                    || propOf(ref).types.some(quantity));
                if (numeric) return quotedQuantity(word, subject);
                return illTyped(word, subject);
            },
            star: (): Interp => ({r: "exists"}),
        };
    }

    /**
     * An operand read against a whole column.
     *
     * A comparison whose operand is a count is the count question — the desugar `model:>4` means `model:{count:>4}`,
     * whatever properties exist. Any other operator token is ordinary content, because spell and file names carry
     * operators of their own; the anchor `=` alone keeps its meaning on content. A lone word naming one of the
     * column's kinds tests the kind; a phrase never does, which is how content spelled like a kind word stays
     * reachable.
     */
    private columnCtx(column: Column, pend: Pending[]): ValueCtx {
        const kinds = kindsOf(column);
        return {
            operator: (op, operand, opts): Interp => {
                // A quoted operand is a string, so it can neither be the count question nor carry a live wildcard.
                const value = opts.phrase !== true && COMPARABLE.has(op.name) ? countType.parse?.(operand) : null;
                if (value !== null && value !== undefined) {
                    return {r: "count", value: this.opExpr(op.name, {type: countType.name, value, written: operand})};
                }
                if (op.name === "exact") {
                    if (opts.phrase !== true && operand.includes(GRAMMAR.wildcard)) {
                        return {
                            r: "fail",
                            message: "exact and a pattern cannot combine",
                            fixDrop: op.symbol ?? undefined
                        };
                    }
                    return content({op: "exact", operand: {text: operand}});
                }
                return content({op: "contains", operand: {text: opts.whole}});
            },
            range: (t): Interp | null => this.countCtx(pend).range(t),
            rangeParts: (lo, hi): Interp | null => this.countCtx(pend).rangeParts(lo, hi),
            glob: (pattern): Interp => {
                if (kinds.some((k) => Object.values(k.props).some((p) => pathTyped(p.types)))) {
                    warnPathGlob(pend);
                }
                return content({op: "glob", operand: {text: pattern}});
            },
            bare: (t, alone): Interp => {
                if (alone) {
                    const named = kindIn(column, fold(t));
                    if (named !== undefined) return {r: "kindWord", kind: named};
                }
                return content({op: "contains", operand: {text: t}});
            },
            phrase: (t): Interp => content({op: "contains", operand: {text: t}}),
            regex: (pattern): Interp => badPattern(pattern) ?? content({op: "regex", operand: {text: pattern}}),
            star: (): Interp => ({r: "exists"}),
        };
    }

    /**
     * A bare term at the top level: plain search.
     *
     * Operator characters are inert here — spell names carry lone operators as tokens, and there is no row set for a
     * count to measure — so everything except the lone wildcard and a pattern is content.
     */
    private topCtx(): ValueCtx {
        return {
            operator: (op, operand, opts): Interp => content({op: "contains", operand: {text: opts.whole}}),
            range: (): Interp | null => null,
            rangeParts: (): Interp | null => null,
            glob: (pattern): Interp => content({op: "glob", operand: {text: pattern}}),
            bare: (t): Interp => content({op: "contains", operand: {text: t}}),
            phrase: (t): Interp => content({op: "contains", operand: {text: t}}),
            // Unreachable by scanning — a slash in free text is data — and defensively literal if ever called.
            regex: (pattern): Interp => content({
                op: "contains",
                operand: {text: `${GRAMMAR.regex}${pattern}${GRAMMAR.regex}`},
            }),
            star: (): Interp => content({op: "present"}),
        };
    }

    /* -------------------------------------------------------------- assembly */

    /** Shapes an interpreted value into a clause under its head, and pushes it. */
    private pushInterp(span: Span, not: boolean, head: Head | null, interp: Interp, pend: Pending[],
                       firstSeg: Seg): void {
        if (interp.r === "fail") {
            const ask = head === null ? null : this.incompleteAsk(head);
            if (interp.rescuable === true && this.mode === "typing") {
                // The value did not parse, but the reader is mid-keystroke and the next character may complete
                // a word that does — the same silence an incomplete bind gets.
                this.push(span, not, "incomplete", ask, pend);
                return;
            }
            this.push(span, not, "invalid", ask,
                [...pend, {severity: "error", message: interp.message, fix: this.failFix(span, interp)}]);
            return;
        }
        if (interp.r === "empty") {
            const ask = head === null ? null : this.incompleteAsk(head);
            if (this.mode === "final") {
                const what = head === null ? "the value" : `${this.headWord(head)}:`;
                this.push(span, not, "invalid", ask,
                    [...pend, {severity: "error", message: `${what} ${interp.why}`}]);
            } else {
                this.push(span, not, "incomplete", ask, pend);
            }
            return;
        }

        this.push(span, not, "ok", this.askFor(head, interp, firstSeg), pend);
    }

    /** The structural fix a failed value offers, when it names one. */
    private failFix(span: Span, interp: Interp & { r: "fail" }): Fix | undefined {
        if (interp.fixQuotes === true) return this.dropQuotesFix(span);
        if (interp.fixDrop !== undefined) return this.dropFix(span, interp.fixDrop);
        return undefined;
    }

    /** The one structural fix a failed value can offer: the same clause without the offending symbol. */
    private dropFix(span: Span, symbol: string): Fix | undefined {
        const raw = this.text.slice(span.start, span.end);
        const at = raw.indexOf(symbol);
        if (at < 0) return undefined;
        const repaired = raw.slice(0, at) + raw.slice(at + symbol.length);
        return {label: `search for it without ${symbol}`, query: this.splice(span.start, span.end, repaired)};
    }

    /** The quoted-quantity fix: the same clause with the quotes removed, so the number reads as itself. */
    private dropQuotesFix(span: Span): Fix | undefined {
        const raw = this.text.slice(span.start, span.end);
        if (!raw.includes(GRAMMAR.phrase)) return undefined;
        const repaired = raw.replaceAll(GRAMMAR.phrase, "");
        return {label: "drop the quotes", query: this.splice(span.start, span.end, repaired)};
    }

    private askFor(head: Head | null, interp: Exclude<Interp, { r: "fail" } | { r: "empty" }>, firstSeg: Seg): Ask {
        if (head === null) {
            if (interp.r === "content") return {on: "plain", value: interp.value};
            return {on: "plain", value: {op: "present"}};
        }
        const countScope = (value: ValueExpr): RowTest => ({
            is: "scope",
            terms: [[{
                span: {start: firstSeg.start, end: firstSeg.end},
                not: false,
                state: "ok",
                ask: {on: "count", value},
            }]],
        });

        const testFor = (i: typeof interp): RowTest => {
            if (i.r === "content") return {is: "content", value: i.value};
            if (i.r === "props") return {is: "props", props: i.props, value: i.value};
            if (i.r === "count") return countScope(i.value);
            return {is: "exists"};
        };

        if (head.role === "column") {
            // A kind word answers as the kind it names, not as its column.
            if (interp.r === "kindWord") return {on: "kind", kind: interp.kind, test: {is: "exists"}};
            return {on: "column", column: head.column, test: testFor(interp)};
        }
        if (head.role === "kind") return {on: "kind", kind: head.kind, test: testFor(interp)};
        const ref: PropRef = {kind: head.kind, prop: head.name};
        if (interp.r === "kindWord" || interp.r === "exists") return {on: "prop", ref, value: {op: "present"}};
        return {on: "prop", ref, value: interp.value};
    }
}
