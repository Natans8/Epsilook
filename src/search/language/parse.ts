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
import {i18n} from "../../i18n";
import type {
    Ask, Clause, ClauseState, Diagnostic, Fix, Parsed, ParseMode, PropRef, RowTest, ScopeAsk, ScopeTerm,
    SortDirective, Span, ValueExpr,
} from "./ast";
import {propOf} from "./ast";
import {COMPARISON_STARTS, GRAMMAR, PREFIX_OPERATORS, spellingsOf} from "./grammar";
import type {Kind as KindDecl} from "../schema/kinds";
import {isFlag, wordOf} from "../schema/kinds";
import {path as pathType, text as textType} from "../vocabulary/value-types";
import type {Interp, Pending, ValueCtx} from "./operand";
import {combineAlternatives, countCtx, ctxFor, kindCtx, propCtx, topCtx} from "./operand";
import {escapeRegExp} from "../text/patterns";
import type {Seg} from "./scan";
import {isWs, scanPhrase, Scanner, scopeShaped, splitAlternatives, splitBare} from "./scan";
import type {Head} from "../schema/schema";
import {HEADS, headWord, kindIn, kindsOf, propIn} from "../schema/schema";
import {fold, foldTypography} from "../text/normalize";

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

/** A run of numbers separated by the list character: the one shape a comma is structural in. */
const NUMBER_LIST = new RegExp(String.raw`^\d+(${escapeRegExp(GRAMMAR.numberList)}\d+)+$`);

/** A number list whose last separator dangles — `133,` — which the lenient reading takes as the numbers alone. */
const NUMBER_LIST_DANGLING =
    new RegExp(String.raw`^\d+(${escapeRegExp(GRAMMAR.numberList)}\d+)*${escapeRegExp(GRAMMAR.numberList)}$`);

/**
 * What makes a leading minus a SIGN rather than a negation: a digit, or a decimal point before one.
 *
 * Position decides where a minus negates — anywhere a clause may begin — and inside a scope every term begins
 * one. That reading breaks the kernel law for signed values: `scale:-50%` is a value after its bind, so
 * `scale:{-50%}` has to mean the same thing, or `{x}` and `x` are two different questions. A sign binds tighter
 * than negation, which is how every language reads a signed literal; negating a bare number stays available by
 * quoting it, where a phrase is a string and no sign can be read.
 */
const SIGNED = /^[\d.]/;

/**
 * Whether a scope term states a bare value of the row -- no negation, no operator.
 *
 * Content dispatches over the kind's own properties, so it states a bare value of that row exactly as a bound
 * property does. A comparison is not one: two of those bound a single value from opposite sides. Neither is a flag
 * word, which asserts a presence rather than a value.
 *
 * @param t One scope term.
 * @returns True when the term is a plain positive value.
 */
function statesBareValue(t: ScopeTerm): boolean {
    const ask = t.ask;
    if (t.not || ask === null) return false;
    if (ask.on !== "content" && ask.on !== "props") return false;
    // A flag word states no value: it says one of the row's properties is set, which holds alongside whatever the
    // row's other properties say. Two of those are satisfiable together, so they conjoin like any other pair.
    if (ask.on === "props" && ask.props.every((ref) => isFlag(propOf(ref)))) return false;
    return ask.value.op === "exact" || ask.value.op === "contains";
}

/** A head that can open a row scope: a column or a kind. A property door takes a value, never a scope. */
type ScopeHead = Exclude<Head, { role: "prop" }>;


/* ------------------------------------------------------------------ the parser */

/** One sort door resolved: the head its word names, and whether its own minus reads as descending. */
function sortMember(text: string): { head: Head; minus: boolean } | null {
    const minus = text.startsWith(GRAMMAR.negate);
    const word = minus ? text.slice(GRAMMAR.negate.length) : text;
    const head = word !== "" ? HEADS.get(fold(word)) : undefined;
    return head === undefined ? null : {head, minus};
}

class Parser {
    private readonly clauses: Clause[] = [];
    private readonly diagnostics: Diagnostic[] = [];
    private readonly runs: number[][] = [];
    private readonly sorts: SortDirective[] = [];
    private limit: Parsed["limit"] = null;
    private current: number[] = [];

    /** Every read of characters and positions goes through here; the parser itself only reads structure. */
    private readonly scan: Scanner;

    /**
     * @param text The query, typography folded — what every structural decision reads.
     * @param mode Keystroke state or final text.
     * @param raw The query as typed, for the one value that must not fold: a regex pattern matches stored text
     *   as written, so its characters are taken from here. Folding is one-to-one, so positions line up.
     */
    constructor(private readonly text: string, private readonly mode: ParseMode, raw: string = text) {
        this.scan = new Scanner({text, raw});
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
            const word = this.orWordEnd(i, n);
            if (word > i) {
                this.closeRun();
                i = word;
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
            sorts: this.sorts,
            limit: this.limit,
            diagnostics: this.diagnostics,
        };
    }

    private closeRun(): void {
        this.runs.push(this.current);
        this.current = [];
    }

    /**
     * The end of an or-word standing alone at `i`, or `i` where none stands.
     *
     * The word is the alternation symbol's typed synonym, so it reads exactly where the symbol would: whole,
     * between terms. A word with anything glued to it — a bind, a comparison, more letters — is ordinary text.
     */
    private orWordEnd(i: number, limit: number): number {
        const j = this.wordEnd(i, limit);
        if (j <= i || fold(this.text.slice(i, j)) !== GRAMMAR.orWord) return i;
        const next = j < limit ? this.text[j] : "";
        const alone = next === "" || isWs(next) || next === GRAMMAR.or || next === GRAMMAR.scope.close;
        return alone ? j : i;
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
                    ? [{
                        severity: "error",
                        message: i18n.t("diagnostics:clause.negatesNothing", {symbol: GRAMMAR.negate})
                    }]
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
            const word = fold(this.text.slice(i, j));
            if (word === GRAMMAR.sortWord) {
                const after = j < limit ? this.text[j] : "";
                if (after === GRAMMAR.bind) return this.sorted(start, not, j + 1, limit);
                if (after === "" || isWs(after)) return this.sorted(start, not, null, limit);
            }
            if ((word === GRAMMAR.limitWord || (GRAMMAR.limitReads as readonly string[]).includes(word))
                && this.text[j] === GRAMMAR.bind) {
                return this.limited(start, not, j + 1, limit);
            }
            const head = HEADS.get(word);
            if (head !== undefined) {
                if (this.text[j] === GRAMMAR.bind) return this.bound(start, not, head, j + 1, limit);
                if (COMPARISON_STARTS.has(this.text[j])) return this.bound(start, not, head, j, limit);
            }
            // An unknown word before a colon stays ordinary text — 12,477 spell names carry one, so pasting a
            // name must never be a syntax error. The control surface is what says the word opens no door.
        }
        return this.term(start, not, i, limit);
    }

    /**
     * An ordering directive: `sort:` and a door word, which must resolve to a head. The exclusion before the
     * word INVERTS the door's own direction — `-sort:cast` is `sort:-cast`, and `-sort:-cast` turns back to
     * `sort:cast`. The directive is kept apart from the clauses, since it selects nothing.
     * A bare `sort` orders by the default door, the spell's id. A scope holds a SEQUENCE of doors, each with
     * its own direction — `sort:{name -cast}` is `sort:name sort:-cast` said once — and the exclusion before
     * the sort word INVERTS each member's own direction: `-sort:{name -cast}` is `sort:{-name cast}`.
     *
     * @param start Where the directive's text began, negation included.
     * @param not Whether the sort word itself was negated.
     * @param vpos Where the door word starts, or null for a bare sort.
     * @param limit The end of the text.
     * @returns The position to continue from.
     */
    private sorted(start: number, not: boolean, vpos: number | null, limit: number): number {
        if (vpos !== null && this.text[vpos] === GRAMMAR.scope.open) return this.sortScope(start, not, vpos, limit);
        let text: string = GRAMMAR.sortDefault;
        let stop = start + GRAMMAR.sortWord.length + (not ? GRAMMAR.negate.length : 0);
        if (vpos !== null) {
            const token = this.scan.token(vpos, limit, {inScope: false, groups: false});
            const [only] = token.segs;
            text = only !== undefined && only.form === "bare" ? only.text : "";
            stop = token.end;
        }
        const span: Span = {start, end: stop};
        const member = sortMember(text);
        if (member === null) {
            this.refuseSort(span, not);
            return stop;
        }
        // The exclusion before the sort word inverts the door's own direction, here as in the scope.
        this.sorts.push({head: member.head, descending: not !== member.minus, span});
        return stop;
    }

    /** The refusal every unreadable sort shares: an error in final text, quiet while typing. */
    private refuseSort(span: Span, not: boolean): void {
        const state: ClauseState = this.mode === "final" ? "invalid" : "incomplete";
        const pend: Pending[] = this.mode === "final"
            ? [{
                severity: "error",
                message: i18n.t("diagnostics:sort.takesDoor",
                    {word: GRAMMAR.sortWord, bind: GRAMMAR.bind, negate: GRAMMAR.negate}),
            }]
            : [];
        this.push(span, not, state, null, pend);
    }

    /**
     * A scoped sort: the doors between the braces become directives in written order. A member nothing resolves,
     * an empty scope, or one that never closes refuses the whole directive — a sequence half of which orders is
     * worse than one that says so.
     *
     * @param start Where the directive's text began, negation included.
     * @param not Whether the sort word itself was negated, which INVERTS each member's own direction.
     * @param vpos The opening brace.
     * @param limit The end of the text.
     * @returns The position to continue from.
     */
    private sortScope(start: number, not: boolean, vpos: number, limit: number): number {
        const members: { head: Head; minus: boolean }[] = [];
        let i = vpos + 1;
        let closed = false;
        let sound = true;
        while (i < limit) {
            const c = this.text[i];
            if (isWs(c)) {
                i++;
                continue;
            }
            if (c === GRAMMAR.scope.close) {
                closed = true;
                i++;
                break;
            }
            let j = i;
            while (j < limit && !isWs(this.text[j]) && this.text[j] !== GRAMMAR.scope.close) j++;
            const member = sortMember(this.text.slice(i, j));
            if (member === null) sound = false;
            else members.push(member);
            i = j;
        }
        const span: Span = {start, end: i};
        if (!closed || !sound || members.length === 0) {
            this.refuseSort(span, not);
            return i;
        }
        for (const member of members) this.sorts.push({head: member.head, descending: not !== member.minus, span});
        return i;
    }

    /**
     * The results-limiting directive: `first:` and a whole number. A display directive like the sort — it
     * selects nothing, the count stays the query's truth, and only what is listed trims. A minus takes the
     * count from the END of the ordered answer instead — `first:-5` lists the last five — and the exclusion
     * before the word means the same, as it does on the sort. Where several limits are written the smallest
     * count consumes the larger, whichever end each takes from; a numberless one is refused.
     *
     * @param start Where the directive's text began, negation included.
     * @param not Whether the directive was negated, which takes the count from the end.
     * @param vpos Where the number starts.
     * @param limit The end of the text.
     * @returns The position to continue from.
     */
    private limited(start: number, not: boolean, vpos: number, limit: number): number {
        const token = this.scan.token(vpos, limit, {inScope: false, groups: false});
        const [only] = token.segs;
        let text = only !== undefined && only.form === "bare" ? only.text : "";
        let last = not;
        if (text.startsWith(GRAMMAR.negate)) {
            last = true;
            text = text.slice(GRAMMAR.negate.length);
        }
        const count = /^\d+$/.test(text) ? Number(text) : null;
        const span: Span = {start, end: token.end};
        if (count === null || count < 1) {
            const state: ClauseState = this.mode === "final" ? "invalid" : "incomplete";
            const pend: Pending[] = this.mode === "final"
                ? [{
                    severity: "error",
                    message: i18n.t("diagnostics:sort.takesCount",
                        {word: GRAMMAR.limitWord, bind: GRAMMAR.bind}),
                }]
                : [];
            this.push(span, not, state, null, pend);
            return token.end;
        }
        const value = last ? -count : count;
        if (this.limit === null || count < Math.abs(this.limit.value)) this.limit = {value, span};
        return token.end;
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
        const {segs, end} = this.scan.token(i, limit, {inScope: false, groups: false});
        if (segs.length === 0) return end;
        const pend: Pending[] = [];
        const {main, extras} = this.interpretSegs(segs, topCtx(), pend);
        this.pushInterp({start, end: segs[0].end}, not, null, main, pend, segs[0]);
        this.emitExtras(extras);
        return end;
    }

    /** Re-emits segments split off a glued token as terms of their own. A single segment sheds no extras. */
    private emitExtras(extras: readonly Seg[]): void {
        const ctx = topCtx();
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
        const first = this.scan.token(vpos, limit, opts);
        if (this.mode !== "final" || !opts.inScope || first.segs.length !== 1) return first;
        const [only] = first.segs;
        if (only.form !== "bare" || !PREFIX_OPERATORS.some((op) => spellingsOf(op).includes(only.text))) {
            return first;
        }
        const k = this.skipWs(first.end, limit);
        if (k === first.end || k >= limit) return first;
        const c = this.text[k];
        if (c === GRAMMAR.or || c === GRAMMAR.negate || c === GRAMMAR.scope.close || c === GRAMMAR.scope.open) {
            return first;
        }
        const operand = this.scan.token(k, limit, opts);
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

        const {segs, end} = this.scan.token(vpos, limit, {inScope: false, groups: true});
        const only = segs.length === 1 ? segs[0] : undefined;
        if (only !== undefined && only.form === "group" && head.role !== "prop" && scopeShaped(only.text)) {
            // Lenient input: a parenthesised scope is accepted and read as one, since the two readings never both
            // parse into different meanings.
            return this.scopeBody(start, not, head, only.start + 1, only.start + 1 + only.text.length,
                only.closed, end, limit);
        }

        const pend: Pending[] = [];
        const {main, extras} = this.interpretSegs(segs, ctxFor(head, pend), pend);
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
        const {segs, end} = this.scan.token(j, limit, {inScope: false, groups: true});
        if (segs.length === 0) return null;
        const {main, extras} = this.interpretSegs(segs, bind.ctx, pend);
        if (main.r === "fail" || main.r === "empty") {
            this.pushInterp({start, end: segs[segs.length - 1 - extras.length].end}, not, head, main, pend, segs[0]);
            this.emitExtras(extras);
            return end;
        }
        const last = segs[segs.length - 1 - extras.length].end;
        // The glued spelling takes the row-count desugar too: `model:worn>2` reads as the same
        // kind-word-plus-count pair the braced form desugars to.
        const terms: ScopeTerm[] = main.r === "count" && bind.of !== undefined
            ? [
                {span: {start: vpos, end: j}, not: false, state: "ok", ask: {on: "kindWord", kind: bind.of}},
                {span: {start: j, end: last}, not: false, state: "ok", ask: this.scopeAsk(main)},
            ]
            : [{span: {start: vpos, end: last}, not: false, state: "ok", ask: this.scopeAsk(main)}];
        if (terms.length === 2 && bind.of !== undefined) {
            pend.push({
                severity: "note",
                message: i18n.t("diagnostics:bind.countsRows", {
                    head: fold(this.text.slice(vpos, j)), value: this.text.slice(j, last),
                    label: wordOf(bind.of),
                }),
            });
        }
        const test: RowTest = {is: "scope", terms: [terms]};
        const ask: Ask = head.role === "column"
            ? {on: "column", column: head.column, test}
            : {on: "kind", kind: head.kind, test};
        this.push({start, end: last}, not, "ok", ask, pend);
        this.emitExtras(extras);
        return end;
    }

    /** A bind with no value: incomplete while typing, a broken chip in final text. */
    private emptyBind(start: number, not: boolean, head: Head, vpos: number): number {
        const word = headWord(head);
        const ask = this.incompleteAsk(head);
        if (this.mode === "final") {
            this.push({start, end: vpos}, not, "invalid", ask,
                [{severity: "error", message: i18n.t("diagnostics:bind.noValue", {word})}]);
        } else {
            this.push({start, end: vpos}, not, "incomplete", ask, []);
        }
        return vpos;
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
        pend.push({
            severity: "note",
            message: i18n.t("diagnostics:bind.countsRows", {head: headWord(head), value: raw, label}),
        });
    }

    /* -------------------------------------------------------------- scopes */

    /** A property takes a value; a scope after one has nothing to bind to. */
    private propScope(start: number, not: boolean, head: Head & {
        role: "prop"
    }, brace: number, limit: number): number {
        const end = this.skipBraces(brace, limit);
        this.push({start, end}, not, "invalid", this.incompleteAsk(head),
            [{severity: "error", message: i18n.t("diagnostics:bind.valueNotScope", {word: headWord(head)})}]);
        return end;
    }

    /** Consumes a balanced brace run, or the rest of the input when it never closes. */
    private skipBraces(open: number, limit: number): number {
        let depth = 0;
        let i = open;
        while (i < limit) {
            const c = this.text[i];
            if (c === GRAMMAR.escape && i + 1 < limit) {
                i += 2;
                continue;
            }
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
            if (c === GRAMMAR.escape && i + 1 < limit) {
                i += 2;
                continue;
            }
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
                ? i18n.t("diagnostics:scope.innerBindScope")
                : i18n.t("diagnostics:scope.nested");
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
            const word = this.orWordEnd(i, bodyEnd);
            if (word > i) {
                scopeRuns.push(run);
                run = [];
                i = word;
                continue;
            }
            const termStart = i;
            let termNot = false;
            if (c === GRAMMAR.negate && !SIGNED.test(this.text[i + 1] ?? "")) {
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
        const terms = this.applyAnchorRule(this.alternateWhereSingle(head, scopeRuns), pend);
        if (terms === null) {
            this.push({start, end: after}, not, "invalid", this.incompleteAsk(head), pend);
            return after;
        }

        // An unclosed empty brace mid-keystroke is on its way to holding something; the note waits until the
        // scope is really written as empty.
        if (emptyBody && (closed || this.mode === "final")) {
            const word = headWord(head);
            pend.push({severity: "note", message: i18n.t("diagnostics:scope.emptyMeansAny", {word})});
        }
        this.scopeWarnings(terms, pend);

        if (!closed && this.mode === "final") {
            const repaired = resumeAt >= 0
                ? this.splice(resumeAt, resumeAt, `${GRAMMAR.scope.close} `)
                : this.splice(after, after, GRAMMAR.scope.close);
            pend.push({
                severity: "warning",
                message: resumeAt >= 0
                    ? i18n.t("diagnostics:scope.unclosedBeforeNext")
                    : i18n.t("diagnostics:scope.unclosedAtEnd"),
                fix: {label: i18n.t("diagnostics:fix.closeScope"), query: repaired},
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
        const replacement = `${negate}${headWord(head)}:${GRAMMAR.wildcard} ${bind}`;
        return {label: i18n.t("diagnostics:fix.ownClause"), query: this.splice(start, after, replacement)};
    }

    /**
     * Reads juxtaposition as ALTERNATION where the kind cannot repeat.
     *
     * A scope binds its conditions to one row, so `model:{fire missile}` asks for a row that is both. A kind
     * declared {@link Kind.single} has exactly one row, and two plain values of one property can never both
     * describe it -- `xpac:{SL wod}` conjoined is unsatisfiable, and the reader plainly means either.
     *
     * An OPERATOR is the exception, because two comparisons bound one value from opposite sides:
     * `xpac:{>wotlk <legion}` is satisfiable and stays a conjunction. So the split is by whether a term states a
     * bare value, which is the same line the reader sees.
     *
     * A TEXT subject is the exception the rationale itself draws: two bare values there are substring claims,
     * and two substrings can both describe the one row -- `name:{fire ball}` is satisfiable and the reader
     * plainly means both. Only a subject read whole -- a rank, a quantity, an id -- makes two bare values
     * exclusive.
     *
     * @param head The scope's own head, which is what says whether its rows may repeat.
     * @param runs The scope's alternation groups, each a conjunction of terms.
     * @returns The groups, with a single kind's bare values moved into groups of their own.
     */
    private alternateWhereSingle(head: ScopeHead, runs: ScopeTerm[][]): ScopeTerm[][] {
        // A kind door reads its own declaration; a COLUMN door alternates exactly when every kind it holds is
        // single — the id column's are, so `id:{133 134}` is either id — while a column with any repeating
        // kind keeps the conjunction, and a TEXT subject anywhere keeps it too: two substrings can both
        // describe one name, whichever door reached it.
        const kinds = head.role === "kind" ? [head.kind] : kindsOf(head.column);
        if (kinds.some((kind) => kind.single !== true)) return runs;
        const textual = kinds.some((kind) => {
            const subject = Object.values(kind.props)[0];
            return subject !== undefined
                && subject.types.some((type) => type === textType || type === pathType);
        });
        if (textual) return runs;
        return runs.flatMap((run) => {
            const loose = run.filter(statesBareValue);
            if (loose.length < 2) return [run];
            const rest = run.filter((t) => !statesBareValue(t));
            // Each bare value becomes its own alternative; anything else the run stated keeps every one of them
            // company, because it still has to hold whichever value the row turns out to carry.
            return loose.map((t) => [t].concat(rest));
        });
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
                pend.push({severity: "error", message: i18n.t("diagnostics:scope.needsPositive")});
                return null;
            }
            out.push(run.map((t): ScopeTerm => ({span: t.span, not: t.not, state: "incomplete", ask: t.ask})));
        }
        return out;
    }

    /** The legal-but-misleading shapes: all warned, none refused. */
    private scopeWarnings(terms: ScopeTerm[][], pend: Pending[]): void {
        for (const run of terms) {
            const ok = run.filter((t) => t.state === "ok" && t.ask !== null);
            const positives = ok.filter((t) => !t.not);
            if (positives.length === 0) continue;

            // A row is exactly one kind, so two POSITIVE kind words on one row are an empty meet — the scope
            // still runs, to nothing, and the warning says why. A negated kind refines and collides with none.
            const kinds: KindDecl[] = [];
            for (const positive of positives) {
                if (positive.ask?.on === "kindWord") kinds.push(positive.ask.kind);
            }
            if (new Set(kinds).size > 1) {
                pend.push({
                    severity: "warning",
                    message: i18n.t("diagnostics:scope.twoKinds",
                        {a: wordOf(kinds[0]), b: wordOf(kinds[1])}),
                });
            }

            const negatedContent = ok.find((t) => t.not && t.ask?.on === "content");
            if (negatedContent !== undefined && positives.every((t) => t.ask?.on === "content")) {
                pend.push({severity: "warning", message: i18n.t("diagnostics:scope.contentNegation")});
            }

            const allQualifier = positives.every((t) => t.ask?.on === "props"
                && t.ask.props.every((ref) => propOf(ref).qualifier));
            if (allQualifier) {
                const first = positives[0].ask;
                const name = first !== null && first.on === "props" ? first.props[0].prop : "";
                pend.push({severity: "warning", message: i18n.t("diagnostics:scope.qualifierAlone", {name})});
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
                message: i18n.t("diagnostics:scope.spaceAfterClose", {symbol: GRAMMAR.scope.close}),
                fix: {label: i18n.t("diagnostics:fix.insertSpace"), query: this.splice(after, after, " ")},
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
                    const tokenEnd = this.scan.token(vpos, bodyEnd, {inScope: true, groups: true}).end;
                    return {kind: "foreign", span: {start: termStart, end: tokenEnd}, message: bind.message};
                }
                const {segs, end} = this.valueToken(vpos, bodyEnd, {inScope: true, groups: true});
                if (segs.length === 0) {
                    // An inner bind with no value: nothing to constrain the row with yet.
                    if (this.mode === "final") {
                        pend.push({severity: "warning", message: i18n.t("diagnostics:bind.noValueIgnored", {word})});
                    }
                    run.push({
                        span: {start: termStart, end: vpos}, not: termNot, state: "incomplete",
                        ask: null, door: word,
                    });
                    return {kind: "done", next: vpos};
                }
                const {main, extras} = this.interpretSegs(segs, bind.ctx, pend);
                const spanEnd = segs[segs.length - 1].end;
                // A comparison on a ROW-WORD is that row's count: `worn>2` reads as the pair `worn count>2`,
                // the column desugar one level down. The pair cannot carry the term's own minus — negating a
                // conjunction is not negating its halves — so a negated one keeps the refusal.
                if (main.r === "count" && bind.of !== undefined && !termNot) {
                    run.push({
                        span: {start: termStart, end: sepAt}, not: false, state: "ok",
                        ask: {on: "kindWord", kind: bind.of},
                    });
                    this.pushScopeTerm(run, {start: vpos, end: spanEnd}, false, main, pend, word);
                    pend.push({
                        severity: "note",
                        message: i18n.t("diagnostics:bind.countsRows",
                            {head: word, value: this.text.slice(vpos, spanEnd), label: word}),
                    });
                    this.scopeExtras(head, extras, run, pend);
                    return {kind: "done", next: end};
                }
                const counted: Interp = main.r === "count" && bind.of !== undefined && termNot
                    ? {r: "fail", message: i18n.t("diagnostics:bind.negatedRowCount", {word})}
                    : main;
                this.pushScopeTerm(run, {start: termStart, end: spanEnd}, termNot, counted, pend, word);
                this.scopeExtras(head, extras, run, pend);
                return {kind: "done", next: end};
            }
            // An unknown word before a colon is ordinary text inside a scope too.
        }

        const {segs, end} = this.scan.token(i, bodyEnd, {inScope: true, groups: false});
        if (segs.length === 0) return {kind: "done", next: i + 1};
        const {main, extras} = this.interpretSegs(segs, ctxFor(head, pend), pend);
        this.pushScopeTerm(run, {start: termStart, end: segs[segs.length - 1].end}, termNot, main, pend,
            this.text.slice(i, end));
        this.scopeExtras(head, extras, run, pend);
        return {kind: "done", next: end};
    }

    /** Segments split off a glued inner token become content terms of the same scope. */
    private scopeExtras(head: ScopeHead, extras: readonly Seg[], run: ScopeTerm[], pend: Pending[]): void {
        if (extras.length === 0) return;
        const ctx = ctxFor(head, pend);
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
                pend.push({
                    severity: "error",
                    message: i18n.t("diagnostics:clause.emptyIgnored", {word, why: interp.why})
                });
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
        | { kind: "ctx"; ctx: ValueCtx; of?: KindDecl }
        | { kind: "foreign"; message: string }
        | null {
        if (head.role === "kind") {
            const kind = head.kind;
            const prop = propIn(kind, word);
            if (prop !== undefined) {
                return {kind: "ctx", ctx: propCtx([{kind, prop}], word, pend)};
            }
            if (word === GRAMMAR.countWord) return {kind: "ctx", ctx: countCtx(pend)};
            const kindWord = wordOf(kind);
            return {kind: "foreign", message: i18n.t("diagnostics:scope.foreignProperty", {kind: kindWord, word})};
        }

        const column = head.column;
        if (word === GRAMMAR.countWord) return {kind: "ctx", ctx: countCtx(pend)};

        const kindMatch = kindIn(column, word);
        if (kindMatch !== undefined) {
            // The count fallback rides along: a comparison no property of the kind can answer reads as that
            // row's COUNT — the column desugar one level down — and the caller expands it into the
            // kind-word-plus-count pair, which is why the kind itself travels back too.
            return {kind: "ctx", ctx: kindCtx(kindMatch, true, pend), of: kindMatch};
        }

        const refs = kindsOf(column).flatMap((k): PropRef[] => {
            const prop = propIn(k, word);
            return prop === undefined ? [] : [{kind: k, prop}];
        });
        if (refs.length > 0) return {kind: "ctx", ctx: propCtx(refs, word, pend)};

        if (HEADS.has(word)) {
            return {kind: "foreign", message: i18n.t("diagnostics:scope.foreignAxis", {word, column: column.key})};
        }
        return null;
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
        if (segs.length === 0) return {main: {r: "empty", why: i18n.t("diagnostics:why.noValue")}, extras: []};

        const first = segs[0];
        if (segs.length >= 2 && first.form === "bare") {
            const op = PREFIX_OPERATORS.find((o) => spellingsOf(o).includes(first.text));
            const operand = segs[1];
            if (op !== undefined && operand.form === "regex") {
                // An anchor has nothing to anchor in a pattern, which carries its own anchors.
                const main: Interp = {
                    r: "fail",
                    message: i18n.t("diagnostics:value.anchorPattern", {symbol: op.symbol}),
                    fixDrop: op.symbol ?? undefined,
                };
                return this.withGlueRepair(main, segs.slice(2), pend);
            }
            if (op !== undefined) {
                // A bare operand reaches here only through the whitespace bridge — adjacent bare segments never
                // come from one token — so it is the spaced spelling of the glued operator form, and its
                // alternatives split at the separator the glued form would have.
                const bareParts = splitBare(operand.text);
                const alternatives = operand.form === "phrase" ? null
                    : operand.form === "bare" ? (bareParts.length > 0 ? bareParts : [operand.text])
                        : splitAlternatives(operand.text);
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
                const alts = splitAlternatives(a.text);
                if (alts.length === 1) {
                    const ranged = ctx.rangeParts(alts[0], b.text.slice(1));
                    if (ranged !== null) return {main: ranged, extras: []};
                }
            }
            if (a.form === "bare" && a.text.endsWith(GRAMMAR.range) && a.text.length > 1
                && b.form === "group" && b.closed) {
                const alts = splitAlternatives(b.text);
                if (alts.length === 1) {
                    const ranged = ctx.rangeParts(a.text.slice(0, -1), alts[0]);
                    if (ranged !== null) return {main: ranged, extras: []};
                }
            }
        }

        if (segs.length >= 2 && segs.every((s) => (s.form === "bare" || s.form === "group") && s.closed)) {
            const lists = segs.map((s) => s.form === "bare"
                ? splitBare(s.text)
                : splitAlternatives(s.text));
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
                message: i18n.t("diagnostics:value.glued"),
                fix: {label: i18n.t("diagnostics:fix.insertSpace"), query: this.splice(at, at, " ")},
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
                    message: i18n.t("diagnostics:pattern.unclosed"),
                });
            }
            return ctx.regex(seg.text);
        }
        if (seg.form === "group") {
            if (!seg.closed && this.mode === "final") {
                pend.push({severity: "warning", message: i18n.t("diagnostics:value.groupUnclosed")});
            }
            const alts = splitAlternatives(seg.text);
            if (alts.length === 0) return {r: "empty", why: i18n.t("diagnostics:why.emptyGroup")};
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
        const real = splitBare(t);
        if (real.length === 0) return {r: "empty", why: i18n.t("diagnostics:why.noValue")};
        if (real.length === 1) return this.alternative(real[0], ctx, true);
        // A unit written on ONE alternative is the value's own: `200|500ms` is two readings in milliseconds,
        // never one of each. The same rule a range's bounds follow.
        const parts = ctx.unify(real);
        return combineAlternatives(parts.map((p) => this.alternative(p, ctx, false)));
    }

    /**
     * Reads one alternative: existence, a number list, a prefixed operator, a range, a pattern, or a plain word —
     * in that order, so that `<=` is an operator before `<` is and a comma list is numbers before it is text.
     */
    private alternative(t: string, ctx: ValueCtx, alone: boolean): Interp {
        if (t === "") return {r: "empty", why: i18n.t("diagnostics:why.noValue")};
        if (t === GRAMMAR.wildcard) return ctx.star();
        // The wildcard's word synonym — the spelling chips display for existence. Only where a bound value is
        // being read: a bare top-level word is plain search content, whatever it spells.
        if (ctx.wordStar && fold(t) === GRAMMAR.anyWord) return ctx.star();
        // A number token ending in a dangling list separator reads as its numbers — `id:{133, 134}` arrives
        // as the token `133,` beside `134`, and the comma separates nothing within its own token.
        if (NUMBER_LIST_DANGLING.test(t)) t = t.slice(0, -GRAMMAR.numberList.length);
        if (NUMBER_LIST.test(t)) {
            return combineAlternatives(t.split(GRAMMAR.numberList).map((n) => ctx.bare(n, false)));
        }
        for (const op of PREFIX_OPERATORS) {
            const sym = spellingsOf(op).find((s) => t.startsWith(s));
            if (sym === undefined) continue;
            const operand = t.slice(sym.length);
            if (operand === "") return {r: "empty", why: i18n.t("diagnostics:why.nothingToCompare")};
            if (op.name === "exact" && operand.includes(GRAMMAR.wildcard)) {
                return {r: "fail", message: i18n.t("diagnostics:value.exactPattern"), fixDrop: sym};
            }
            return ctx.operator(op, operand, {whole: t});
        }
        const ranged = ctx.range(t);
        if (ranged !== null) return ranged;
        if (t.includes(GRAMMAR.wildcard)) return ctx.glob(t);
        return ctx.bare(t, alone);
    }

    /* -------------------------------------------------------------- value contexts */


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
                const what = head === null ? i18n.t("diagnostics:clause.emptySubject") : `${headWord(head)}:`;
                this.push(span, not, "invalid", ask,
                    [...pend, {
                        severity: "error",
                        message: i18n.t("diagnostics:clause.empty", {what, why: interp.why})
                    }]);
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
        return {
            label: i18n.t("diagnostics:fix.withoutSymbol", {symbol}),
            query: this.splice(span.start, span.end, repaired)
        };
    }

    /** The quoted-quantity fix: the same clause with the quotes removed, so the number reads as itself. */
    private dropQuotesFix(span: Span): Fix | undefined {
        const raw = this.text.slice(span.start, span.end);
        if (!raw.includes(GRAMMAR.phrase)) return undefined;
        const repaired = raw.replaceAll(GRAMMAR.phrase, "");
        return {label: i18n.t("diagnostics:fix.dropQuotes"), query: this.splice(span.start, span.end, repaired)};
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
