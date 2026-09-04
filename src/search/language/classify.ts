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
import {COMPARISON_STARTS, GRAMMAR, PREFIX_OPERATORS, spellingsOf} from "./grammar";
import {parse} from "./parse";
import {HEADS} from "../schema/schema";
import {fold, foldTypography} from "../text/normalize";
import {escapeRegExp} from "../text/patterns";

/** The role one run of query text plays. */
export type RunKind = "head" | "meta" | "op" | "delim" | "quote" | "regex" | "number" | "word" | "space";

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

/** The delimiters that ENCLOSE — the pair a clause opens and closes, as against the universal alternation. */
const ENCLOSURES = new Set<string>([
    GRAMMAR.scope.open, GRAMMAR.scope.close, GRAMMAR.group.open, GRAMMAR.group.close,
]);

/** The halves that OPEN one, which is what deepens the nesting. */
const OPENERS = new Set<string>([GRAMMAR.scope.open, GRAMMAR.group.open]);

/** The structural single characters beyond the operators: the enclosures, and alternation. */
const DELIMS = new Set<string>([...ENCLOSURES, GRAMMAR.or]);

/** Single characters that play an operator role wherever they stand, alias spellings included. */
const OPS = new Set<string>([
    GRAMMAR.bind, GRAMMAR.wildcard, GRAMMAR.negate,
    ...PREFIX_OPERATORS.flatMap((op) => spellingsOf(op).flatMap((s) => s.split(""))),
]);

/** What a property opens: the bind, or the comparison it is being measured by. */
const DOOR_GLUES = new Set<string>([GRAMMAR.bind, ...COMPARISON_STARTS]);

/** A run made of nothing but the bind — the colon a doorless clause's value carries as plain text. */
const BIND_ONLY = new RegExp(`^${escapeRegExp(GRAMMAR.bind)}+$`);

/**
 * Whether a slash standing at `at` opens a pattern rather than being an ordinary character.
 *
 * The parser's rule, read off the same three facts it reads: a pattern is a value, so it opens where a VALUE
 * does — straight after the glue that binds one, or, inside a row scope, wherever a term opens. Never inside a
 * group, where a slash stays literal. Everywhere else a slash is a character like any other, which is what
 * keeps a pasted path fragment searchable.
 */
function opensPattern(folded: string, at: number, scopes: number, groups: number): boolean {
    if (groups > 0) return false;
    const before = folded[at - 1] ?? "";
    if (DOOR_GLUES.has(before)) return true;
    return scopes > 0 && (/\s/.test(before) || before === GRAMMAR.scope.open);
}

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
    // Where a TERM opens, and how deep in enclosures it sits: a known word glued to its operator is the door
    // of a clause when it opens one at the top level (`model>=4`), and a property of the thing being asked
    // about anywhere else (`sound:count>2`, `model:{attach:chest}`). They read the same and mean differently.
    let opening = true;
    let depth = 0;
    // A scope and a group nest alike but admit different things: only a scope opens a place where a pattern may
    // stand, so the two are counted apart rather than read back off the text.
    let scopes = 0;
    let groups = 0;
    while (at < folded.length) {
        const ch = folded[at];
        // The escape shields the next character from every structural reading, so the pair is plain text —
        // and what follows it cannot open a head, because the term it sits in is inert.
        if (ch === GRAMMAR.escape && at + 1 < folded.length && !/\s/.test(folded[at + 1])) {
            push(at, at + 2, "word");
            at += 2;
            opening = false;
            continue;
        }
        if (ch === GRAMMAR.regex && opensPattern(folded, at, scopes, groups)) {
            // A pattern is a leaf like a phrase, with the phrase's own two differences: a backslash escapes
            // whatever follows it, and the value ends at whitespace, so an unclosed pattern runs no further
            // than the term it opened in.
            push(at, at + 1, "quote");
            let end = at + 1;
            while (end < folded.length && folded[end] !== GRAMMAR.regex && !/\s/.test(folded[end])) {
                end += folded[end] === GRAMMAR.escape ? 2 : 1;
            }
            end = Math.min(end, folded.length);
            if (end > at + 1) push(at + 1, end, "regex");
            if (folded[end] === GRAMMAR.regex) {
                push(end, end + 1, "quote");
                at = end + 1;
            } else {
                at = end;
            }
            opening = false;
            continue;
        }
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
            // Clamped: a stray closer would otherwise take the depth negative, and every head after it would
            // stop reading as one.
            if (ENCLOSURES.has(ch)) {
                const step = OPENERS.has(ch) ? 1 : -1;
                depth = Math.max(0, depth + step);
                if (ch === GRAMMAR.scope.open || ch === GRAMMAR.scope.close) scopes = Math.max(0, scopes + step);
                else groups = Math.max(0, groups + step);
            }
            opening = true;
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
            // A negation opens the term it excludes; every other operator stands after something.
            opening = ch === GRAMMAR.negate;
            at += 1;
            continue;
        }
        if (/\s/.test(ch)) {
            push(at, at + 1, "space");
            opening = true;
            at += 1;
            continue;
        }
        const word = WORD.exec(folded.slice(at));
        if (word !== null) {
            const end = at + word[0].length;
            // The or-word standing alone IS the alternation, at either level, so it wears the symbol's own
            // class rather than reading as data.
            if (fold(word[0]) === GRAMMAR.orWord && !OPS.has(folded[end] ?? "")) {
                push(at, end, "delim");
                at = end;
                opening = true;
                continue;
            }
            // The bind is one of the operators, so a glue of any kind is one test.
            const known = HEADS.has(fold(word[0])) && OPS.has(folded[end] ?? "");
            // A head opens its clause at the top level, whichever glue it takes: `model:fire` and `model>=4`
            // are the same door said two ways. The same word inside an enclosure, or standing after a value,
            // is a property of what is being asked about — a word ABOUT the query, which a chip draws loud.
            const isHead = known && opening && depth === 0;
            // The bind belongs to the head: `model:` is one token, because the word alone is text on its way
            // to being something and the colon is what makes it a door. A comparison is the question rather
            // than the door, and stays its own operator.
            const takesBind = isHead && folded[end] === GRAMMAR.bind;
            const meta = fold(word[0]) === GRAMMAR.anyWord || (known && !isHead);
            push(at, takesBind ? end + 1 : end,
                isHead ? "head" : meta ? "meta" : /^\d/.test(word[0]) ? "number" : "word");
            at = takesBind ? end + 1 : end;
            opening = false;
            continue;
        }
        push(at, at + 1, "word");
        opening = false;
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
        // A word the lexer drew loud — a known head glued to a colon, say — is only a property where the
        // PARSE resolved one: `model:mount:horse` is one content ask, its colon meaningless, and a foreign
        // `sound:` inside a model scope binds nothing. Every such word demotes to plain text here, and the
        // term walk below re-marks exactly the binds that resolved. The wildcard and the any-word stay loud:
        // they are about the query wherever they stand. The bare colon inside a DOORLESS clause goes quiet
        // with its word; in a scope a colon is real glue and keeps its role.
        const scoped = (ask.on === "column" || ask.on === "kind") && ask.test?.is === "scope";
        over(clause.span, (run) => {
            const held = fold(text.slice(run.start, run.end));
            if (run.kind === "meta" && held !== GRAMMAR.anyWord && held !== GRAMMAR.wildcard) {
                return {...run, kind: "word"};
            }
            if (!scoped && run.kind === "op" && run.start > clause.span.start && BIND_ONLY.test(held)) {
                return {...run, kind: "word"};
            }
            return run;
        });
        if (column !== null) {
            // An ENCLOSURE goes with the head: a brace or a group belongs to the clause it encloses, so it
            // wears that clause's colour. The alternation does not — `|` means the same thing wherever it
            // stands, and a universal token that changed colour by neighbourhood would be saying otherwise.
            over(clause.span, (run) => (run.kind === "head" || run.kind === "meta"
            || (run.kind === "delim" && ENCLOSURES.has(text[run.start]))
                ? {...run, tone: column.key} : run));
        }
        if (clause.not) negate(clause.span);
        // A PROPERTY of the thing being asked about — `sound:count>2`, `model:{attach:chest}` — is a word
        // about the query rather than one of the data. Only the binds the parse RESOLVED mark one: a foreign
        // bind marks nothing, because painting it as a door claims a reading the parse refused.
        if (column !== null && scoped && (ask.on === "column" || ask.on === "kind")
            && ask.test?.is === "scope") {
            for (const term of ask.test.terms.flat()) {
                // A door the reader has opened is a door before its value arrives. A term whose value is
                // missing keeps the word it resolved, so the three keystrokes of `model:{attach:chest}` do not
                // paint that word three ways — the missing value is drawn as the term's state, which is what
                // the clause level has always done for `model:`.
                if (term.state !== "ok") {
                    if (term.door === undefined) continue;
                } else if (term.ask === null) {
                    continue;
                    // A kind word takes the same door when a value follows its glue: `attach:*` asks the kind
                    // for any value of its subject, the same door `attach:chest` opens. Reading the ask alone
                    // would paint the two apart, though the reader typed one word in one place.
                } else if (term.ask.on !== "props" && term.ask.on !== "count" && term.ask.on !== "kindWord") {
                    continue;
                }
                const word = runs.find((run) => run.start >= term.span.start && run.start < term.span.end
                    && run.kind === "word");
                const next = word === undefined ? undefined : runs[runs.indexOf(word) + 1];
                // The word only reads as the door where its glue follows it: the subject's bare value —
                // `model:{fire}` typed onto a props ask — is a value, not a property naming itself.
                if (word !== undefined && next?.kind === "op" && next.start === word.end
                    && DOOR_GLUES.has(text[next.start])) {
                    runs[runs.indexOf(word)] = {...word, door: true, tone: column.key};
                }
            }
        }
        // A kind word IS the vocabulary — `model:missile` names a kind rather than searching for the letters.
        // It keeps its column's tone doing it: the same word opens a door one keystroke later, and a word of
        // the LANGUAGE reads as one in both roles. The dot is what says it is standing as a value here.
        if (ask.on === "kind" && ask.test?.is === "exists" && column !== null) {
            over(clause.span, (run) => (run.kind === "word"
                ? {...run, vocab: true, tone: column.key} : run));
        }
        const test = ask.on === "column" || ask.on === "kind" ? ask.test : null;
        if (test?.is !== "scope") continue;
        for (const term of test.terms.flat()) {
            if (term.not) negate(term.span);
            const inner = term.ask;
            if (inner === null) continue;
            if (inner.on === "kindWord" || (inner.on === "props" && wordValued(inner.value))) {
                // The term's VALUE is what came from the vocabulary; the door that opened it did not. A word
                // wearing both marks draws two underlines at once and says it is a value and a property in the
                // same breath, so the door keeps its own mark and the blanket passes over it.
                //
                // A KIND word marked here is a word of the language stood in a value's place, so it keeps its
                // column's tone the way the same word does when it opens a door. A vocabulary VALUE — an
                // attachment point, an expansion — is data, and data wears no tone in any position.
                const tone = inner.on === "kindWord" ? column?.key : undefined;
                over(term.span, (run) => (run.kind === "word" && run.door !== true
                    ? {...run, vocab: true, ...(tone === undefined ? {} : {tone})} : run));
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

/**
 * The runs covering one stretch of a painted query, rebased onto that stretch's own coordinates.
 *
 * A surface showing part of a query — an editing slot, say — cannot paint itself: {@link paint} needs the whole
 * text to know which column a head reached or whether a clause is broken. It reads the whole and takes its own
 * slice, so the two surfaces cannot disagree about the same characters.
 *
 * @param runs The whole query's runs.
 * @param span The stretch to take, in the query's coordinates.
 * @returns The runs covering that stretch exactly, starting at zero.
 */
export function runsWithin(runs: readonly Run[], span: Span): Run[] {
    const out: Run[] = [];
    for (const run of runs) {
        const start = Math.max(run.start, span.start);
        const end = Math.min(run.end, span.end);
        if (end > start) out.push({...run, start: start - span.start, end: end - span.start});
    }
    return out;
}

/**
 * One painted run with its diagnostic state dropped.
 *
 * A run drawn outside the clause that raised the state — a slot still being typed, a quotation of the clause
 * beside its own reason — keeps its colour and loses the squiggle: the state belongs to a committed clause, and
 * a mark repeated where the finding is already said adds nothing.
 *
 * @param run The run as painted.
 * @returns The run without its state, or the run itself where it carried none.
 */
export function quieted(run: Run): Run {
    return run.state === undefined ? run : {...run, state: undefined};
}
