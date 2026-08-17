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
import {GRAMMAR, PREFIX_OPERATORS, spellingsOf} from "./grammar";
import {HEADS} from "../schema/schema";
import {fold, foldTypography} from "../text/normalize";

/** The role one run of query text plays. */
export type RunKind = "head" | "op" | "delim" | "quote" | "number" | "word" | "space";

/** One classed run. Runs abut: each starts where the previous ended, and together they cover the text. */
export interface Run {
    readonly start: number;
    readonly end: number;
    readonly kind: RunKind;
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
            const isHead = folded[end] === GRAMMAR.bind && HEADS.has(fold(word[0]));
            push(at, end, isHead ? "head" : /^\d/.test(word[0]) ? "number" : "word");
            at = end;
            continue;
        }
        push(at, at + 1, "word");
        at += 1;
    }
    return runs;
}
