/**
 * @file The typing-time classifier: raw query text split into classed runs for the bar's highlight backdrop.
 *
 * The bar highlights, it does not re-render — colour goes over the exact characters, so every run is a span of
 * the input and concatenating the runs restores it verbatim. The classification reads the grammar's own tables
 * ({@link GRAMMAR}, {@link PREFIX_OPERATORS}, {@link HEADS}), never a private token list, so a symbol the parser
 * learns is one the highlight knows the same day.
 *
 * This is a lexical pass, deliberately coarser than the parse: it says what role a character PLAYS, not whether
 * the query is valid — validity is the parser's answer, drawn elsewhere. It folds typography exactly as the
 * parser does, which is length-preserving, so every span indexes the reader's own text.
 */
import type {Span, ValueExpr} from "./ast";
import {GRAMMAR, PREFIX_OPERATORS, spellingsOf} from "./grammar";
import {parse} from "./parse";
import {HEADS} from "../schema/schema";
import {fold, foldTypography} from "../text/normalize";

/** The role one run of query text plays. */
export type RunKind = "head" | "meta" | "op" | "delim" | "quote" | "number" | "word" | "space";

/**
 * One classed run. Runs abut: each starts where the previous ended, and together they cover the text.
 *
 * The lexical `kind` is what {@link classify} answers on its own. The rest is what {@link paint} adds by
 * reading the parse, so a surface showing whole query text can colour it by what the engine UNDERSTOOD rather
 * than by what the characters look like.
 */
export interface Run {
    readonly start: number;
    readonly end: number;
    readonly kind: RunKind;
    /** The column key whose tone a head wears, where the head resolves to one. */
    readonly tone?: string;
    /** A clause-level finding covering this run. */
    readonly state?: "error" | "warning";
    /** Whether the run is a word from a closed vocabulary rather than corpus text. */
    readonly vocab?: boolean;
    /** Whether the run is part of what a clause EXCLUDES — the minus and the head it binds to. */
    readonly negated?: boolean;
    /** Whether the run names a PROPERTY — a word about the thing asked about, which a chip draws loud. */
    readonly door?: boolean;
}

/** The structural single characters beyond the operators: scopes, groups, alternation. */
const DELIMS = new Set<string>([
    GRAMMAR.scope.open, GRAMMAR.scope.close, GRAMMAR.group.open, GRAMMAR.group.close, GRAMMAR.or,
]);

/** Single characters that play an operator role wherever they stand, alias spellings included. */
const OPS = new Set<string>([
    GRAMMAR.bind, GRAMMAR.wildcard, GRAMMAR.negate,
    ...PREFIX_OPERATORS.flatMap((op) => spellingsOf(op).flatMap((s) => s.split(""))),
]);

/** A word run: letters, digits and the joiners a value word may carry. */
const WORD = /^[\p{L}\p{N}_.']+/u;

/**
 * Classifies one query text into runs.
 *
 * @param text The raw text, exactly as typed.
 * @returns The runs, in order, covering the text exactly.
 */
export function classify(text: string): Run[] {
    const folded = foldTypography(text);
    const runs: Run[] = [];
    const push = (start: number, end: number, kind: RunKind): void => {
        const last = runs.at(-1);
        if (last !== undefined && last.kind === kind && last.end === start) {
            runs[runs.length - 1] = {start: last.start, end, kind};
        } else {
            runs.push({start, end, kind});
        }
    };

    let at = 0;
    while (at < folded.length) {
        const ch = folded[at];
        if (ch === GRAMMAR.phrase) {
            // A phrase is a leaf: nothing inside is structure. The quotes class apart from their content, and an
            // unclosed phrase runs to the end — the next keystroke may close it.
            push(at, at + 1, "quote");
            let end = at + 1;
            while (end < folded.length && folded[end] !== GRAMMAR.phrase) {
                end += folded[end] === GRAMMAR.escape ? 2 : 1;
            }
            end = Math.min(end, folded.length);
            if (end > at + 1) push(at + 1, end, "word");
            if (folded[end] === GRAMMAR.phrase) {
                push(end, end + 1, "quote");
                at = end + 1;
            } else {
                at = end;
            }
            continue;
        }
        if (DELIMS.has(ch)) {
            push(at, at + 1, "delim");
            at += 1;
            continue;
        }
        // The any-word's symbol is a word ABOUT the query rather than one of the data, which is what a chip
        // draws loud; the two surfaces say it the same way.
        if (ch === GRAMMAR.wildcard) {
            push(at, at + 1, "meta");
            at += 1;
            continue;
        }
        if (OPS.has(ch)) {
            push(at, at + 1, "op");
            at += 1;
            continue;
        }
        if (/\s/.test(ch)) {
            push(at, at + 1, "space");
            at += 1;
            continue;
        }
        const word = WORD.exec(folded.slice(at));
        if (word !== null) {
            const end = at + word[0].length;
            const known = HEADS.has(fold(word[0]));
            const isHead = folded[end] === GRAMMAR.bind && known;
            // A word about the query rather than of the data: the any-word, and a property door standing in a
            // value where its own comparison follows it (`sound:count>2`). Both are what a chip draws loud.
            const meta = fold(word[0]) === GRAMMAR.anyWord
                || (known && !isHead && OPS.has(folded[end] ?? ""));
            // The bind belongs to the head: `model:` is one token. The word alone is text on its way to being
            // something and the colon is what makes it a door, so the two are read — and coloured — as one.
            push(at, isHead ? end + 1 : end,
                isHead ? "head" : meta ? "meta" : /^\d/.test(word[0]) ? "number" : "word");
            at = isHead ? end + 1 : end;
            continue;
        }
        push(at, at + 1, "word");
        at += 1;
    }
    return runs;
}


/**
 * Classifies one whole query, layering what the parse understood over the lexical runs.
 *
 * The difference from {@link classify} is the difference between spelling and meaning: the lexer can say a
 * character is a head or a delimiter, and only the parse can say which column that head reached, whether the
 * clause it opens is valid, and whether a word came from a closed vocabulary. Both are needed — the lexer
 * covers the text exactly, including the parts no clause claims — so this reads the lexer's runs and annotates
 * them rather than replacing them.
 *
 * Requires a whole query: a fragment such as one slot's contents has no clauses of its own, and
 * {@link classify} is what those surfaces use.
 *
 * @param text The raw query text.
 * @returns The runs, in order, covering the text exactly.
 */
export function paint(text: string): Run[] {
    const runs: Run[] = classify(text);
    const parsed = parse(text);

    /** Rewrites every run overlapping a span. */
    const over = (span: Span, mark: (run: Run) => Run): void => {
        for (const [i, run] of runs.entries()) {
            if (run.end > span.start && run.start < span.end) runs[i] = mark(run);
        }
    };

    /**
     * Marks what a negated clause or term excludes: the minus, and the word it binds to.
     *
     * The same unit a chip draws in one red — the minus and its head, or the minus and the word it excludes —
     * because a reader looking at the raw text is reading the same query.
     */
    /**
     * Marks the door a PROPERTY opens: `attach:` inside a model scope, `count` before its comparison.
     *
     * A property is not a head — it is a word about the thing being asked about, which a chip draws loud — and
     * it is the same word wherever it stands, so the raw text says it the same way and in the column's tone.
     */
    const door = (span: Span, tone: string | null): void => {
        const word = runs.find((run) => run.start >= span.start && run.start < span.end && run.kind === "word");
        if (word === undefined) return;
        runs[runs.indexOf(word)] = {...word, door: true, tone: tone ?? word.tone};
    };

    const negate = (span: Span): void => {
        over({start: span.start, end: span.start + 1}, (run) => ({...run, negated: true}));
        const word = runs.find((run) => run.start >= span.start && run.start < span.end
            && (run.kind === "head" || run.kind === "word" || run.kind === "meta"));
        if (word !== undefined) runs[runs.indexOf(word)] = {...word, negated: true};
    };

    for (const [index, clause] of parsed.clauses.entries()) {
        const worst = parsed.diagnostics
            .filter((d) => d.clause === index)
            .reduce<"error" | "warning" | null>(
                (held, d) => (d.severity === "error" ? "error" : d.severity === "warning" ? held ?? "warning" : held),
                null);
        const state = clause.state === "invalid" ? "error" : worst;
        if (state !== null) over(clause.span, (run) => ({...run, state}));

        const ask = clause.ask;
        if (ask === null) continue;
        const column = ask.on === "plain" ? null
            : ask.on === "column" ? ask.column
                : ask.on === "kind" ? ask.kind.column : ask.ref.kind.column;
        if (column !== null) {
            // The delimiters go with the head: a brace or a group belongs to the clause it encloses, so it
            // wears that clause's colour rather than the neutral one every structural character shares.
            over(clause.span, (run) => (run.kind === "head" || run.kind === "delim"
                ? {...run, tone: column.key} : run));
        }
        if (clause.not) negate(clause.span);
        // A kind word IS the vocabulary — `model:missile` names a kind rather than searching for the letters.
        if (ask.on === "kind" && ask.test?.is === "exists") {
            over(clause.span, (run) => (run.kind === "word" ? {...run, vocab: true} : run));
        }
        // A property standing at the head of its own comparison — `sound:count>2`, `model:{seat>=2}` — is a
        // door like any other: the word is followed by the operator it opens, which is what tells it from a
        // value word beside it.
        if (column !== null) {
            for (const [i, run] of runs.entries()) {
                const next = runs[i + 1];
                if (run.kind !== "word" || run.door === true) continue;
                if (run.start < clause.span.start || run.end > clause.span.end) continue;
                if (next?.kind === "op" && next.start === run.end) door(run, column.key);
            }
        }
        const test = ask.on === "column" || ask.on === "kind" ? ask.test : null;
        if (test?.is !== "scope") continue;
        for (const term of test.terms.flat()) {
            if (term.not) negate(term.span);
            const inner = term.ask;
            if (inner === null) continue;
            if (inner.on === "kindWord" || (inner.on === "props" && wordValued(inner.value))) {
                over(term.span, (run) => (run.kind === "word" ? {...run, vocab: true} : run));
            }
        }
    }
    return runs;
}

/** Whether every operand of a value came from a closed vocabulary rather than from the corpus. */
function wordValued(value: ValueExpr): boolean {
    if (value.op === "anyOf") return value.alternatives.every(wordValued);
    if (!("operand" in value)) return false;
    const operand = value.operand;
    return !("text" in operand) && WORDED.has(operand.type);
}

/** The value types whose values are words from a closed set. */
const WORDED: ReadonlySet<string> = new Set(["enum", "ordinal", "bitmask"]);
