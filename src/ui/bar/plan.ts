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
    /** The characters the head cell consumes: negation, word, the bind, and the opening brace where one follows. */
    readonly consumed: number;
    /** Whether the glue was the bind character; an operator glue stays in the slot by design. */
    readonly bound: boolean;
    /** Whether a scope brace follows the bind — the editing form, its braces consumed as structure. */
    readonly scoped: boolean;
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
    /** What the input holds: the scope's interior on a scoped head, the remainder otherwise. */
    readonly slot: string;
    /** The consumed closing brace of a scoped head, when the segment carries one — display structure, not slot. */
    readonly suffix: string;
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
    let consumed = match[1].length + match[2].length + (bound ? 1 : 0);
    const scoped = bound && open[consumed] === GRAMMAR.scope.open;
    if (scoped) consumed += 1;
    return {
        word: match[2],
        negated: match[1] === GRAMMAR.negate,
        consumed,
        bound,
        scoped,
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
    let slot = head === null ? open : open.slice(head.consumed);
    let suffix = "";
    // A scoped head consumes its closing brace too — when the one that opened it is the one the segment ends
    // with. The interior between them is the slot, spaces and all.
    if (head?.scoped === true && closesAtEnd(slot)) {
        suffix = slot.slice(-1);
        slot = slot.slice(0, -1);
    }
    return {before, open, after, head, slot, suffix};
}

/** Whether the interior's final character is the closer of the scope that was opened before it. */
function closesAtEnd(interior: string): boolean {
    if (!interior.endsWith(GRAMMAR.scope.close)) return false;
    let quote = false;
    let depth = 1;
    for (let at = 0; at < interior.length; at++) {
        const ch = interior[at];
        if (ch === GRAMMAR.escape && quote) {
            at += 1;
            continue;
        }
        if (ch === GRAMMAR.phrase) {
            quote = !quote;
            continue;
        }
        if (quote) continue;
        if (ch === GRAMMAR.scope.open) depth += 1;
        else if (ch === GRAMMAR.scope.close) {
            depth -= 1;
            if (depth === 0) return at === interior.length - 1;
        }
    }
    return false;
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
/**
 * Types the first characters into a GAP — the empty caret position between two chips.
 *
 * A gap holds no text of its own, so the first insertion writes the value AND the separator that keeps the
 * following segment a segment: typing `x` between `model:fire` and `scale:5` yields `model:fire x scale:5`,
 * caret after the x, from where ordinary keystrokes continue.
 *
 * @param text The query text.
 * @param gapAt The gap's offset — a segment start, meaning "insert before this segment".
 * @param value What was typed into the gap.
 * @returns The new text with the caret after the inserted value.
 */
export function insertAtGap(text: string, gapAt: number, value: string): Keystroke {
    return {
        text: text.slice(0, gapAt) + value + " " + text.slice(gapAt),
        caret: gapAt + value.length,
    };
}

/**
 * The first offset where two texts disagree — where an undo or redo landed its change, and so where the caret
 * belongs after one.
 *
 * @param a One text.
 * @param b The other.
 * @returns The first differing offset, clamped into both; equal texts answer their length.
 */
export function firstDiff(a: string, b: string): number {
    const shorter = Math.min(a.length, b.length);
    for (let at = 0; at < shorter; at++) {
        if (a[at] !== b[at]) return at;
    }
    return shorter;
}

export function backspaceAtStart(at: BarPlan): Keystroke | null {
    const text = at.before + at.open + at.after;
    // Left of a scoped slot sits the opening brace; deleting an opener deletes its pair, the IDE convention —
    // removing one side alone would leave the text unbalanced and the display lying about it.
    if (at.head?.scoped === true) {
        const cut = slotStart(at) - 1;
        const open = at.open.slice(0, at.head.consumed - 1) + at.slot;
        return {text: at.before + open + at.after, caret: cut};
    }
    const cut = slotStart(at) - 1;
    if (cut < 0) return null;
    return {text: text.slice(0, cut) + text.slice(cut + 1), caret: cut};
}

/**
 * The creation gesture: a bind that JUST landed opens a scope, the caret inside — `model:` becomes `model:{}`.
 *
 * The scope is the editing form: a space inside it is a character, never a commit, so `model:{fire frost}`
 * composes naturally and the simplification back to a single word happens at commit. The gesture fires only on
 * the transition — a segment that already had its bound head (deleting backwards through a value, say) is left
 * alone, or the brace pair would resurrect itself against every deletion.
 *
 * @param was The plan the keystroke started from.
 * @param step The keystroke as applied.
 * @returns The step with the scope inserted, or the step untouched.
 */
export function scopeGesture(was: BarPlan, step: Keystroke): Keystroke {
    const next = planAt(step.text, step.caret);
    const landed = next.head !== null && next.head.bound && !next.head.scoped && next.slot === ""
        && step.caret === slotStart(next);
    const already = was.head !== null && was.head.bound;
    if (!landed || already) return step;
    const open = GRAMMAR.scope.open + GRAMMAR.scope.close;
    return {
        text: step.text.slice(0, step.caret) + open + step.text.slice(step.caret),
        caret: step.caret + 1,
    };
}

/**
 * The editing form of an already-simplified segment: `model:fire` re-wraps to `model:{fire}` when it opens.
 *
 * The symmetric half of the commit simplification — while a chip is open its braces are there, so a space typed
 * into a reopened chip behaves exactly as it did when the chip was first composed.
 *
 * @param text The query text.
 * @param at Any offset inside the segment being opened.
 * @returns The rewrapped text with the caret at the interior's end, or null when the segment is not a bound,
 *   unscoped head with a value.
 */
export function scopedForm(text: string, at: number): Keystroke | null {
    const plan = planAt(text, at);
    if (plan.head === null || !plan.head.bound || plan.head.scoped || plan.slot === "") return null;
    const open = plan.open.slice(0, plan.head.consumed)
        + GRAMMAR.scope.open + plan.slot + GRAMMAR.scope.close;
    return {
        text: plan.before + open + plan.after,
        caret: plan.before.length + open.length - 1,
    };
}

/**
 * Commits one segment: the scope simplifies to its interior where a single term remains.
 *
 * A scoped chip with one interior term drops its braces (`model:{fire}` → `model:fire` — the kernel law
 * `{x} ≡ x` spelled the preferred way); several terms keep them, trimmed; an empty scope removes the segment
 * whole, separator included, because an empty ask is not a chip. A segment with no scope commits as it stands.
 *
 * @param text The query text.
 * @param at Any offset inside the segment to commit.
 * @returns The new text with the caret at the committed segment's end.
 */
export function commitSegment(text: string, at: number): Keystroke {
    const plan = planAt(text, at);
    if (plan.head === null || !plan.head.scoped) {
        return {text, caret: plan.before.length + plan.open.length};
    }
    const interior = plan.slot.trim();
    const prefix = plan.open.slice(0, plan.head.consumed - 1);
    if (interior === "") {
        // The segment goes whole; one adjacent separator goes with it so no double gap remains.
        let from = plan.before.length;
        let to = from + plan.open.length;
        if (text[to] === " ") to += 1;
        else if (from > 0 && text[from - 1] === " ") from -= 1;
        return {text: text.slice(0, from) + text.slice(to), caret: from};
    }
    const single = segmentStarts(interior).length === 1;
    const open = single ? prefix + interior
        : prefix + GRAMMAR.scope.open + interior + GRAMMAR.scope.close;
    return {
        text: plan.before + open + plan.after,
        caret: plan.before.length + open.length,
    };
}
