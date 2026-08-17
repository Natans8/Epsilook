/**
 * @file The bar's display plan: where the open segment begins, and what of it is a transformed head.
 *
 * The query text is the single source of truth and the plan is a PURE READ of it — nothing here is state. The
 * open segment is the text after the last separator space at balanced depth (a space inside a phrase or a scope
 * separates nothing), so committing on space is emergent: the keystroke moves the boundary, and there is no
 * second copy of "committed" to fall out of sync.
 *
 * The eager transformation is the same read: the open segment starting with a known head and its bind is
 * displayed as a head cell plus a value slot, the bind consumed as a gesture. The text underneath never changes —
 * {@link BarPlan} reconstructs it verbatim, which the tests pin — so the round trip is unconditional.
 */
import {fold, GRAMMAR, HEADS} from "../../search/index";

/** The transformed head of the open segment, when it has one. */
export interface OpenHead {
    /** The head word as typed, negation excluded. */
    readonly word: string;
    /** Whether a negation glyph precedes the word. */
    readonly negated: boolean;
    /** The characters the head cell consumes: negation, word, and the bind where the glue is one. */
    readonly consumed: number;
    /** Whether the glue was the bind character; an operator glue stays in the slot by design. */
    readonly bound: boolean;
}

/** What the bar draws: settled text, then the open segment as an optional head cell and the slot. */
export interface BarPlan {
    /** Everything before the open segment, verbatim, its trailing separator included. */
    readonly settled: string;
    /** The whole open segment, verbatim — `settled + open` is the text. */
    readonly open: string;
    /** The transformed head, or null while the segment is plain text. */
    readonly head: OpenHead | null;
    /** What the input holds: the open segment after the consumed head characters. */
    readonly slot: string;
}

/**
 * Where the open segment begins: after the last separator space at balanced depth.
 *
 * A space inside a phrase is content and a space inside a scope or group separates terms of one clause, so
 * neither ends the segment being typed — only a space with every quote closed and every bracket depth at zero
 * does.
 *
 * @param text The query text.
 * @returns The index the open segment starts at.
 */
export function splitAt(text: string): number {
    let quote = false;
    let depth = 0;
    let start = 0;
    for (let at = 0; at < text.length; at++) {
        const ch = text[at];
        if (ch === GRAMMAR.escape && quote) {
            at += 1;
            continue;
        }
        if (ch === GRAMMAR.phrase) {
            quote = !quote;
            continue;
        }
        if (quote) continue;
        if (ch === GRAMMAR.scope.open || ch === GRAMMAR.group.open) depth += 1;
        else if (ch === GRAMMAR.scope.close || ch === GRAMMAR.group.close) depth -= 1;
        else if (ch === " " && depth <= 0) start = at + 1;
    }
    return start;
}

/** A head opener: optional negation, a word, then the bind or a comparison glued to it. */
const OPENER = /^(-?)([\p{L}\p{N}_]+)(:|>=|<=|>|<|=)/u;

/**
 * The head the open segment starts with, or null while it is plain text.
 *
 * A word is a head exactly when the schema resolves it AND a glue follows — `scale` alone is text on its way to
 * being something, `scale:` is the transformation's moment. The bind is consumed into the cell; a comparison
 * glue stays in the slot, where it reads as the value's own operator.
 *
 * @param open The open segment.
 * @returns The head, or null.
 */
export function openHead(open: string): OpenHead | null {
    const match = OPENER.exec(open);
    if (match === null) return null;
    if (!HEADS.has(fold(match[2]))) return null;
    const bound = match[3] === GRAMMAR.bind;
    return {
        word: match[2],
        negated: match[1] === GRAMMAR.negate,
        consumed: match[1].length + match[2].length + (bound ? 1 : 0),
        bound,
    };
}

/**
 * The display plan of one query text.
 *
 * @param text The query text, exactly as typed.
 * @returns The plan; `settled + open` reconstructs the text, and `slot` is `open` less the consumed head.
 */
export function plan(text: string): BarPlan {
    const start = splitAt(text);
    const settled = text.slice(0, start);
    const open = text.slice(start);
    const head = openHead(open);
    return {settled, open, head, slot: head === null ? open : open.slice(head.consumed)};
}

/** One keystroke's outcome on the text, with where the caret lands in the NEW plan's slot. */
export interface Keystroke {
    readonly text: string;
    readonly caret: number;
}

/**
 * Backspace at the slot's start — the one keystroke the input cannot mean on its own.
 *
 * One rule for all three cases: the deletion happens on the character just left of the caret in the UNDERLYING
 * text. Left of a bound head's slot sits the consumed bind, so the head dissolves back into editable raw text;
 * left of an operator-glued head's slot sits the word's last letter, which shrinks — and stops transforming the
 * moment the schema no longer knows it; left of a headless slot sits the settled tail's separator, so the
 * previous segment merges back into the open one.
 *
 * @param at The current plan.
 * @returns The new text and slot caret, or null when there is nothing left of the caret to delete.
 */
export function backspaceAtStart(at: BarPlan): Keystroke | null {
    // The text index of the character to delete: just left of where the slot begins.
    const cut = at.head === null
        ? (at.settled === "" ? -1 : at.settled.length - 1)
        : at.settled.length + at.head.consumed - 1;
    if (cut < 0) return null;
    const text = at.settled + at.open;
    return keystroke(text.slice(0, cut) + text.slice(cut + 1), cut);
}

/** The keystroke's outcome, the caret translated into the NEW plan's slot coordinates. */
function keystroke(text: string, caret: number): Keystroke {
    const next = plan(text);
    const slotStart = next.settled.length + (next.head?.consumed ?? 0);
    return {text, caret: Math.max(0, caret - slotStart)};
}
