/**
 * @file The bar's display plan: the query split into segments, one of them open, its head transformed.
 *
 * The query text is the single source of truth and everything here is a PURE READ of it — the only state the bar
 * keeps is WHICH segment is open, as a character offset. Segments are separated by spaces at balanced depth (a
 * space inside a phrase or a scope separates nothing), so committing on space is emergent: the keystroke moves a
 * boundary, and there is no second copy of "committed" to fall out of sync.
 *
 * The eager transformation is the same read: an open segment starting with a known head and its bind displays as
 * a head cell plus a value slot, the bind consumed as a gesture. The text underneath never changes — a plan
 * reconstructs it verbatim, which the tests pin — so the round trip is unconditional.
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

/** What the bar draws: text before the open segment, the segment itself, text after, and the transformation. */
export interface BarPlan {
    /** Everything before the open segment, verbatim, trailing separator included. */
    readonly before: string;
    /** The whole open segment, verbatim — `before + open + after` is the text. */
    readonly open: string;
    /** Everything after the open segment, verbatim, leading separator included. */
    readonly after: string;
    /** The transformed head, or null while the segment is plain text. */
    readonly head: OpenHead | null;
    /** What the input holds: the open segment after the consumed head characters. */
    readonly slot: string;
}

/**
 * The start offset of every segment: zero, then after each space at balanced depth.
 *
 * A trailing balanced space therefore yields a final empty segment at the text's end — the fresh slot a commit
 * leaves the caret in.
 *
 * @param text The query text.
 * @returns The starts, ascending, always beginning with zero.
 */
export function segmentStarts(text: string): number[] {
    const starts = [0];
    let quote = false;
    let depth = 0;
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
        else if (ch === " " && depth <= 0) starts.push(at + 1);
    }
    return starts;
}

/** One segment's bounds: its start, and its end at the next boundary's space or the text's end. */
export interface Segment {
    readonly start: number;
    readonly end: number;
}

/**
 * The segment containing one text offset.
 *
 * @param text The query text.
 * @param at Any offset into it; past the end clamps to the last segment.
 * @returns The segment's bounds.
 */
export function segmentAt(text: string, at: number): Segment {
    const starts = segmentStarts(text);
    let start = starts[0];
    for (const held of starts) {
        if (held <= at) start = held;
        else break;
    }
    const next = starts.find((held) => held > start);
    return {start, end: next === undefined ? text.length : next - 1};
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
 * The display plan with the segment at `openAt` open.
 *
 * @param text The query text, exactly as typed.
 * @param openAt Any offset inside the segment to open; the text's end opens the tail.
 * @returns The plan; `before + open + after` reconstructs the text.
 */
export function planAt(text: string, openAt: number): BarPlan {
    const seg = segmentAt(text, openAt);
    const before = text.slice(0, seg.start);
    const open = text.slice(seg.start, seg.end);
    const after = text.slice(seg.end);
    const head = openHead(open);
    return {before, open, after, head, slot: head === null ? open : open.slice(head.consumed)};
}

/** Where a plan's slot begins in text coordinates — what turns an input caret into a text offset and back. */
export const slotStart = (at: BarPlan): number => at.before.length + (at.head?.consumed ?? 0);

/** One keystroke's outcome: the new text and the caret as a TEXT offset — the component re-plans around it. */
export interface Keystroke {
    readonly text: string;
    readonly caret: number;
}

/**
 * Backspace at the slot's start — the one keystroke the input cannot mean on its own.
 *
 * One rule for every case: delete the character just left of the caret in the underlying text. Left of a bound
 * head's slot sits the consumed bind, so the head dissolves back into editable raw text; left of an
 * operator-glued head's slot sits the word's last letter, which shrinks — and stops transforming the moment the
 * schema no longer knows it; left of a headless slot sits the previous segment's separator, so the segments
 * merge.
 *
 * @param at The current plan.
 * @returns The new text with the caret where the deleted character was, or null at the text's very start.
 */
export function backspaceAtStart(at: BarPlan): Keystroke | null {
    const cut = slotStart(at) - 1;
    if (cut < 0) return null;
    const text = at.before + at.open + at.after;
    return {text: text.slice(0, cut) + text.slice(cut + 1), caret: cut};
}
