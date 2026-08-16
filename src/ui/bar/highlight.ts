/**
 * @file The typing-time tokenizer: raw edit text split into classed runs for the editing highlight.
 *
 * The editing state carries the syntax highlighter by ruling — a selected chip's raw text is never flat monospace.
 * This is a lexical pass, not a parse: it classes characters by role (delimiters, operators, numbers, head words)
 * so the highlight can never disagree with what the reader typed, only with what the parser later says it means.
 */
import {fold, GRAMMAR, HEADS} from "../../search/index";

/** How one run of edit text is classed. */
export type TokenKind = "head" | "delim" | "op" | "number" | "word" | "space" | "phrase";

/** One classed run of the edit text. Concatenated in order, the runs are the text verbatim. */
export interface Token {
    readonly kind: TokenKind;
    readonly text: string;
}

const DELIMS = new Set<string>([
    GRAMMAR.scope.open, GRAMMAR.scope.close, GRAMMAR.group.open, GRAMMAR.group.close, GRAMMAR.or,
]);
const OPS = new Set<string>(["<", ">", "=", GRAMMAR.bind, GRAMMAR.negate, GRAMMAR.wildcard]);
const WORD = /^[\p{L}\p{N}_.']+/u;

/**
 * Tokenizes one stretch of edit text.
 *
 * @param text The raw text being edited.
 * @returns Classed runs, concatenating to the text verbatim.
 */
export function tokenize(text: string): Token[] {
    const out: Token[] = [];
    let at = 0;
    const push = (kind: TokenKind, run: string): void => {
        const last = out.at(-1);
        if (last !== undefined && last.kind === kind) out[out.length - 1] = {kind, text: last.text + run};
        else out.push({kind, text: run});
    };

    while (at < text.length) {
        const ch = text[at];
        if (ch === GRAMMAR.phrase) {
            // A phrase is a leaf: everything to the closing quote, escapes included, is one run.
            let end = at + 1;
            while (end < text.length && text[end] !== GRAMMAR.phrase) {
                end += text[end] === GRAMMAR.escape ? 2 : 1;
            }
            const closed = end < text.length;
            push("phrase", text.slice(at, closed ? end + 1 : end));
            at = closed ? end + 1 : end;
            continue;
        }
        if (DELIMS.has(ch)) { push("delim", ch); at += 1; continue; }
        if (OPS.has(ch)) { push("op", ch); at += 1; continue; }
        if (/\s/.test(ch)) { push("space", ch); at += 1; continue; }
        const word = WORD.exec(text.slice(at));
        if (word !== null) {
            const run = word[0];
            const isHead = HEADS.has(fold(run)) && text[at + run.length] === GRAMMAR.bind;
            push(isHead ? "head" : /^\d/.test(run) ? "number" : "word", run);
            at += run.length;
            continue;
        }
        push("word", ch);
        at += 1;
    }
    return out;
}

/**
 * Whether the text is balanced enough for a space to mean "commit": no open phrase, scope or group.
 *
 * @param text The raw edit text.
 * @returns True when every quote is closed and every bracket depth is zero.
 */
export function balanced(text: string): boolean {
    let quote = false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === GRAMMAR.escape && quote) { i += 1; continue; }
        if (ch === GRAMMAR.phrase) { quote = !quote; continue; }
        if (quote) continue;
        if (ch === GRAMMAR.scope.open || ch === GRAMMAR.group.open) depth += 1;
        if (ch === GRAMMAR.scope.close || ch === GRAMMAR.group.close) depth -= 1;
    }
    return !quote && depth <= 0;
}

/** What the eager transformation found at the front of the edit text. */
export interface OpenHead {
    /** The word as typed, negation excluded. */
    readonly word: string;
    /** The `-` prefix, when the ask is negated. */
    readonly negated: boolean;
    /** Everything after the binding character — what the input holds while the head sits in its cell. */
    readonly rest: string;
    /** The characters the head cell consumes: negation, word and the bind or operator glue. */
    readonly consumed: number;
    /** Whether the glue was the bind character; an operator stays in the rest by design. */
    readonly bound: boolean;
}

/**
 * The head the edit text opens with, for the eager transformation: `scale:` becomes a head cell the moment the
 * colon lands. An operator glue (`scale>2`) opens the head too, with the operator staying in the value slot.
 *
 * @param text The raw edit text.
 * @returns The head split, or null when the text opens with no known head.
 */
export function openHead(text: string): OpenHead | null {
    const match = /^(-?)([\p{L}\p{N}_]+)(:|>=|<=|>|<|=)/u.exec(text);
    if (match === null) return null;
    if (!HEADS.has(fold(match[2]))) return null;
    const bound = match[3] === GRAMMAR.bind;
    const consumed = match[1].length + match[2].length + (bound ? 1 : 0);
    return {
        word: match[2], negated: match[1] === GRAMMAR.negate,
        rest: text.slice(consumed), consumed, bound,
    };
}
