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
import type {Span} from "../../search/index";
import {
    classify, convergeDisplay, describe, directiveTexts, equivalent, escapedAt, fold, formatQuery, GRAMMAR, HEADS,
    parse, PREFIX_OPERATORS, spellingsOf,
} from "../../search/index";

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
 * The start offset of every TERM: zero, then after each space at balanced depth.
 *
 * A term is what a space separates, which is the grain the query language itself works in — a scope's interior
 * counts its terms this way, and so does everything that asks how many things a spelling holds. What the BAR
 * draws is coarser: see {@link segmentsOf}, which merges runs of plain text back into one.
 *
 * A trailing balanced space therefore yields a final empty term at the text's end — the fresh slot a commit
 * leaves the caret in.
 *
 * @param text The query text.
 * @returns The starts, ascending, always beginning with zero.
 */
export function termStarts(text: string): number[] {
    const starts = [0];
    let quote = false;
    let depth = 0;
    for (let at = 0; at < text.length; at++) {
        const ch = text[at];
        // The escape shields the next character everywhere outside a regex, not only inside a phrase.
        if (ch === GRAMMAR.escape) {
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

/** The words that open a DIRECTIVE, which draws as its own capsule rather than as text. */
const DIRECTIVE_WORDS = new Set<string>([GRAMMAR.sortWord, GRAMMAR.limitWord, ...GRAMMAR.limitReads]);

/** The limit directive's spellings: a count slot, so its editing form never grows a scope. */
const LIMIT_WORDS = new Set<string>([GRAMMAR.limitWord, ...GRAMMAR.limitReads]);

/** Whether a term is a directive: its first word, negation aside, is one of the directive words. */
function directiveTerm(term: string): boolean {
    const match = /^-?([\p{L}\p{N}_]+)/u.exec(term);
    return match !== null && DIRECTIVE_WORDS.has(fold(match[1]));
}

/** The characters that make a term structure rather than text — anything a chip could be drawn from. */
const STRUCTURE = new Set<string>([
    GRAMMAR.scope.open, GRAMMAR.scope.close, GRAMMAR.group.open, GRAMMAR.group.close,
    GRAMMAR.or, GRAMMAR.phrase,
]);

/** Whether the display model draws a chip for one term, remembered per spelling — the answer is pure. */
const DRAWN = new Map<string, boolean>();

/**
 * Whether a term is plain text — something the bar draws as the characters themselves rather than as a chip.
 *
 * Two questions, cheapest first. A resolved head with its glue is a chip on sight, which is what lets the
 * transformation fire on the keystroke that lands it, before anything parses. Everything without a delimiter is
 * text by construction. What is left — a bare phrase, an alternation of words — is the display model's own call
 * and nothing else can answer it: a split that disagreed with the drawing would chip a stretch of text, or
 * merge a chip into one.
 *
 * @param term One term's text.
 * @returns True when the term draws as text.
 */
function plainTerm(term: string): boolean {
    if (openHead(term) !== null) return false;
    if (directiveTerm(term)) return false;
    let structural = false;
    for (const ch of term) {
        if (STRUCTURE.has(ch)) {
            structural = true;
            break;
        }
    }
    if (!structural) return true;
    const held = DRAWN.get(term);
    if (held !== undefined) return held;
    const plain = !describe(parse(term)).some((view) => view.form === "chip" || view.form === "lane");
    // A bar holds few spellings; the cap is there so a long editing session cannot grow the map without end.
    if (DRAWN.size > 500) DRAWN.clear();
    DRAWN.set(term, plain);
    return plain;
}

/** One segment's bounds — its start, its end at the next boundary's space or the text's end — and how it draws. */
export interface BarSegment {
    readonly start: number;
    readonly end: number;
    /** True where the segment is plain text; false where it draws as a chip or a lane. */
    readonly plain: boolean;
}

/**
 * Every segment of the query, in order, covering it exactly.
 *
 * A segment is one term that draws as a chip, or a maximal run of neighbouring PLAIN terms — one piece of text,
 * drawn, selected and edited as one. Words are not objects: the space between two of them is an ordinary
 * character of the query, and a run split into a chiplet per word makes that character neither selectable nor
 * deletable.
 *
 * @param text The query text.
 * @returns The segments, ascending, always beginning at zero.
 */
export function segmentsOf(text: string): BarSegment[] {
    const terms = termStarts(text);
    const out: BarSegment[] = [];
    for (const [i, start] of terms.entries()) {
        const end = i + 1 < terms.length ? terms[i + 1] - 1 : text.length;
        const plain = plainTerm(text.slice(start, end));
        const last = out.at(-1);
        // A plain term following a plain one extends it; the separator between them stays inside the segment.
        if (plain && last?.plain === true) out[out.length - 1] = {start: last.start, end, plain};
        else out.push({start, end, plain});
    }
    return out;
}

/**
 * The segment containing one text offset.
 *
 * @param text The query text.
 * @param at Any offset into it; past the end clamps to the last segment.
 * @returns The segment's bounds.
 */
export function segmentAt(text: string, at: number): BarSegment {
    const segments = segmentsOf(text);
    return segments.findLast((seg) => seg.start <= at) ?? segments[0];
}

/**
 * A head opener: optional negation, a word, then the bind or a comparison glued to it.
 *
 * The glues come off the operator registry, longest spelling first, so a comparison's alias — the very glyph a
 * committed chip draws — opens a head exactly as its symbol does.
 */
const OPENER = new RegExp(
    `^(-?)([\\p{L}\\p{N}_]+)(${[GRAMMAR.bind, ...PREFIX_OPERATORS.flatMap(spellingsOf)]
        .toSorted((a, b) => b.length - a.length)
        .map((glue) => glue.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`))
        .join("|")})`,
    "u");

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
    // A directive word opens exactly as a schema head does — the control chips edit like every other chip —
    // but only on the bind: a comparison glued to one is not a spelling the language gives a meaning.
    const directive = DIRECTIVE_WORDS.has(fold(match[2])) && match[3] === GRAMMAR.bind;
    if (!HEADS.has(fold(match[2])) && !directive) return null;
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
    let open = text.slice(seg.start, seg.end);
    let after = text.slice(seg.end);
    const head = openHead(open);
    let slot = head === null ? open : open.slice(head.consumed);
    let suffix = "";
    // A scoped head consumes its closing brace too. The interior between them is the slot, spaces and all.
    //
    // The closer need not be the segment's FINAL character, because an unclosed phrase hides the separator from
    // the term split: `name:{"} ` arrives as one term, trailing space included, and a rule that required the
    // brace to be last left it inside the slot — where the next commit saw no closer and wrote another, one
    // more per reopen. Only WHITESPACE may follow it, though. A closer with content glued after it
    // (`model:{a}x`) is not an interior at all, and stays raw in the slot by ruling: re-wrapping it would be
    // the second brace this is here to prevent.
    if (head?.scoped === true) {
        const closes = closerAt(slot);
        const tail = closes < 0 ? "" : slot.slice(closes + 1);
        if (closes >= 0 && tail.trim() === "") {
            suffix = slot.slice(closes, closes + 1);
            slot = slot.slice(0, closes);
            // `before + open + after` still reconstructs the text verbatim, which the plan's contract is.
            open = open.slice(0, open.length - tail.length);
            after = tail + after;
        }
    }
    return {before, open, after, head, slot, suffix};
}

/**
 * One interior with its phrase closed, where the reader left one open.
 *
 * A phrase runs to the end of the input by the language's own rule, so an unclosed one swallows everything
 * after it — the scope's closing brace, the separator a commit appends, and every term that follows. Closing it
 * is the repair the auto-apply boundary licenses: the ask does not run as it stands, and what was meant is
 * mechanically derivable rather than guessed. Nothing typed is discarded.
 *
 * @param interior The scope's interior, or a segment's value.
 * @returns The interior, with a closing quote where one was missing.
 */
function closePhrase(interior: string): string {
    let quote = false;
    for (let at = 0; at < interior.length; at++) {
        if (interior[at] === GRAMMAR.escape) at += 1;
        else if (interior[at] === GRAMMAR.phrase) quote = !quote;
    }
    return quote ? interior + GRAMMAR.phrase : interior;
}

/** Whether the interior's final character is the closer of the scope that was opened before it. */
function closesAtEnd(interior: string): boolean {
    return closerAt(interior) === interior.length - 1;
}

/**
 * Where the scope opened before an interior closes, or -1 when nothing in it does.
 *
 * @param interior The text after a scope's opening brace.
 * @returns The closing brace's offset, or -1.
 */
function closerAt(interior: string): number {
    let quote = false;
    let depth = 1;
    for (let at = 0; at < interior.length; at++) {
        const ch = interior[at];
        // The escape shields the next character everywhere outside a regex, not only inside a phrase.
        if (ch === GRAMMAR.escape) {
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
            if (depth === 0) return at;
        }
    }
    // An UNCLOSED phrase swallows everything after it, the scope's own closing brace included — so a chip whose
    // value is mid-quote would have that brace read as part of the value, and the commit, seeing no closer,
    // would write a second one. It compounds: every reopen wraps again.
    //
    // The brace is the LAST one in the interior, not necessarily its final character: an unclosed phrase also
    // swallows the separator that follows the segment, so the interior reads `"} ` rather than `"}`, and a rule
    // that only looked at the final character stopped firing the moment a committed segment had a neighbour.
    // Everything after the opening quote is literal, so the last brace the reader typed is the one that closed
    // the scope.
    if (quote) return interior.lastIndexOf(GRAMMAR.scope.close);
    return -1;
}

/** Where a plan's slot begins in text coordinates — what turns an input caret into a text offset and back. */
export const slotStart = (at: BarPlan): number => at.before.length + (at.head?.consumed ?? 0);

/**
 * The whole query with the open slot rewritten.
 *
 * The slot edits only its own slice: the head prefix and the closing brace are structure and survive verbatim,
 * whichever gesture did the writing — a typed character, a picked offer, a spawned delimiter pair.
 *
 * @param at The open position's plan.
 * @param value What the slot now holds.
 * @param glue What to put after the segment, for an insertion at a gap that needs a separator behind it.
 * @returns The query text.
 */
export function writeSlot(at: BarPlan, value: string, glue = ""): string {
    return at.before + at.open.slice(0, at.head?.consumed ?? 0) + value + at.suffix + glue + at.after;
}

/**
 * Delete at the slot's end — the boundary backspace's mirror.
 *
 * On a scoped head the character to the right is the closing brace, and deleting a brace deletes its pair, so
 * the scope dissolves with its interior kept as raw text. On anything else it is the separator (or the next
 * segment's first character), which deletes plainly, merging what follows.
 *
 * @param at The current plan.
 * @returns The new text with the caret where it stood, or null at the text's very end.
 */
export function deleteAtEnd(at: BarPlan): Keystroke | null {
    if (at.head?.scoped === true && at.suffix !== "") {
        const open = at.open.slice(0, at.head.consumed - 1) + at.slot;
        return {text: at.before + open + at.after, caret: slotStart(at) - 1 + at.slot.length};
    }
    const cut = slotStart(at) + at.slot.length;
    const text = at.before + at.open + at.after;
    if (cut >= text.length) return null;
    return {text: text.slice(0, cut) + text.slice(cut + 1), caret: cut};
}

/** One keystroke's outcome: the new text and the caret as a TEXT offset — the component re-plans around it. */
export interface Keystroke {
    readonly text: string;
    readonly caret: number;
    /** A selection's other end, as a text offset — the step lands selected between anchor and caret. */
    readonly anchor?: number;
    /** Marks an operation boundary: the step pushes an undo state, so one Ctrl+Z takes it back whole. */
    readonly operation?: boolean;
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
    const text = at.before + at.open + at.after;
    // An EMPTY chip goes whole, in one press. Every other case here deletes one character, and on an empty chip
    // that meant three presses to be rid of a thing holding nothing — the brace pair, then the bind, then the
    // word. One press is what a chip in any other field does, and there is nothing inside this one to lose.
    if (at.head !== null && at.slot === "") {
        const after = at.after.replace(/^ /, "");
        const before = after === "" ? at.before.replace(/ $/, "") : at.before;
        return {text: before + after, caret: before.length, operation: true};
    }
    // Left of a scoped slot sits the opening brace; deleting an opener deletes its pair, the IDE convention —
    // removing one side alone would leave the text unbalanced and the display lying about it.
    if (at.head?.scoped === true) {
        const cut = slotStart(at) - 1;
        const open = at.open.slice(0, at.head.consumed - 1) + at.slot;
        return {text: at.before + open + at.after, caret: cut};
    }
    // Left of a BOUND head's slot sits its bind, and one press takes the whole keyword with it — the ruled
    // reading: backspace straight after a head erases the head, never one character of it.
    if (at.head !== null && at.head.bound) {
        return {text: at.before + at.slot + at.after, caret: at.before.length, operation: true};
    }
    const cut = slotStart(at) - 1;
    if (cut < 0) return null;
    return {text: text.slice(0, cut) + text.slice(cut + 1), caret: cut};
}

/**
 * The keyword ending at `caret`: the run of word characters and the unescaped bind closing it — what one
 * Backspace takes whole. The ruled reading holds at any depth, so `fx:{scale:|}` steps to `fx:{|}` in one press
 * exactly as the head cell's own bind does.
 *
 * @param slot The slot's text.
 * @param caret The caret's offset in it.
 * @returns The keyword's start offset, or null where no keyword ends just left of the caret.
 */
export function keywordBehind(slot: string, caret: number): number | null {
    if (caret <= 0 || slot[caret - 1] !== GRAMMAR.bind) return null;
    if (escapedAt(slot, caret - 1)) return null;
    let start = caret - 1;
    while (start > 0 && /[\p{L}\p{N}_]/u.test(slot[start - 1])) start--;
    return start;
}

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
 * @returns The new text with the caret after the inserted value — or null for a blank value, because a bare
 *   separator has no term to separate and writes nothing.
 */
export function insertAtGap(text: string, gapAt: number, value: string): Keystroke | null {
    if (value.trim() === "") return null;
    return {
        text: text.slice(0, gapAt) + value + " " + text.slice(gapAt),
        caret: gapAt + value.length,
    };
}

/** Each opening delimiter and the closer it spawns — the enclosures a slot pairs like an IDE. */
const PAIRS: Record<string, string | undefined> = {
    [GRAMMAR.phrase]: GRAMMAR.phrase,
    [GRAMMAR.regex]: GRAMMAR.regex,
    [GRAMMAR.scope.open]: GRAMMAR.scope.close,
    [GRAMMAR.group.open]: GRAMMAR.group.close,
};

/**
 * Whether the character at `at` is one the language reads as a delimiter, rather than as ordinary text.
 *
 * Two of these characters are only sometimes delimiters. A slash opens a pattern in value position and is an
 * ordinary character everywhere else, which is what keeps a pasted path typeable; and either leaf delimiter
 * preceded by the escape is the literal character, not a half of anything. Both readings already exist in the
 * lexer, so this asks it rather than restating them — a pairing that disagreed with the highlight about what
 * is a delimiter would be two answers to one question.
 */
function delimits(before: string, value: string, at: number): boolean {
    // The run COVERING the character, not one starting on it: neighbouring runs of a kind are merged, so a
    // brace beside its partner shares one run and starting-there would answer no for the second of any pair.
    const run = classify(before + value).find((held) =>
        held.start <= before.length + at && before.length + at < held.end);
    return run !== undefined && (run.kind === "quote" || run.kind === "delim");
}

/** The closing halves — what a keystroke steps over instead of doubling. */
const CLOSERS = new Set<string>(Object.values(PAIRS).filter((close) => close !== undefined));

/** One pairing's outcome: the value the keystroke leaves, and where the caret and its anchor land in it. */
export interface Pairing {
    readonly value: string;
    readonly caret: number;
    /** The other end of a surviving selection, where the pairing enclosed one. */
    readonly anchor?: number;
}

/**
 * The delimiter pairing an editable value answers a keystroke with, as an IDE's does.
 *
 * Four rules, and they are the same wherever text is edited: typed over a selection the pair ENCLOSES it, the
 * selection surviving inside; typed alone the closer spawns with the caret in the middle; a closer typed
 * against its own next character STEPS OVER instead of doubling; and a Backspace between two halves of an
 * empty pair takes both. Stated once here because the two surfaces that use it — the chip's slot and the plain
 * view — differ only in how they DELIVER the result, one as an undoable operation and one as a plain write.
 *
 * @param value What the field holds.
 * @param from The selection's start.
 * @param to Its end; equal to `from` for a caret.
 * @param key The key pressed, or `Backspace`.
 * @param before What stands before this value in the query — the head cell's own characters, where a surface
 *   has taken them out of the field. Whether a slash is a delimiter depends on the position it sits in, and a
 *   slot holding only `fire` cannot tell that on its own; it is read for context and never written back.
 * @returns The pairing, or null where the keystroke pairs nothing. A result whose value is unchanged is the
 *   step-over: only the caret moves.
 */
export function pairDelimiter(
    value: string, from: number, to: number, key: string, before = "",
): Pairing | null {
    const close = PAIRS[key];
    if (close !== undefined && from !== to) {
        const enclosed = value.slice(0, from) + key + value.slice(from, to) + close + value.slice(to);
        if (!delimits(before, enclosed, from)) return null;
        return {value: enclosed, caret: to + 1, anchor: from + 1};
    }
    // The step-over reads the CURRENT value: the character already there has to be a closer, or a typed
    // character would be swallowed by a slash that was only ever text.
    if (from === to && CLOSERS.has(key) && value[from] === key && delimits(before, value, from)) {
        return {value, caret: from + 1};
    }
    if (close !== undefined) {
        const spawned = value.slice(0, from) + key + close + value.slice(from);
        if (!delimits(before, spawned, from)) return null;
        return {value: spawned, caret: from + 1};
    }
    if (key === "Backspace" && from === to && from > 0) {
        // An opener must actually be there: at the value's end both sides read `undefined`, and comparing them
        // made an ordinary Backspace look like a pair-delete.
        const opener = PAIRS[value[from - 1]];
        if (opener !== undefined && opener === value[from] && delimits(before, value, from - 1)) {
            return {value: value.slice(0, from - 1) + value.slice(from + 1), caret: from - 1};
        }
    }
    return null;
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

/**
 * The creation gesture: a bind that JUST landed opens a scope, the caret inside — `model:` becomes `model:{}`.
 *
 * The scope is the editing form: a space inside it is a character, never a commit, so `model:{fire frost}`
 * composes naturally and the simplification back to a single word happens at commit. The gesture fires only on
 * the transition — a segment that already had its bound head (deleting backwards through a value, say) is left
 * alone, or the brace pair would resurrect itself against every deletion — and only for a head a scope is legal
 * after: a property door takes a value, so its slot stays braceless and a space commits, as a value's grammar
 * says it should.
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
    if (next.head !== null && HEADS.get(fold(next.head.word))?.role === "prop") return step;
    // The limit takes one count, never a scope; the sort takes a sequence, so its braces spawn like a kind's.
    if (next.head !== null && LIMIT_WORDS.has(fold(next.head.word))) return step;
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
 * into a reopened chip behaves exactly as it did when the chip was first composed. The wrap happens only where
 * it preserves the ask, which the engine itself answers: a property door takes a value and never a scope, so
 * `cast:2s` opens raw, and a segment that does not parse opens as the raw text it failed as.
 *
 * @param text The query text.
 * @param at Any offset inside the segment being opened.
 * @returns The rewrapped text with the caret at the interior's end, or null when the segment is not a bound,
 *   unscoped head with a value, or the braces would change what it asks.
 */
export function scopedForm(text: string, at: number): Keystroke | null {
    const plan = planAt(text, at);
    if (plan.head === null || plan.head.scoped || plan.slot === "") return null;
    // An operator glue stays in the slot, so its segment carries no bind to wrap after — the scoped spelling
    // grows the colon as well, which is the same desugar the parser reads `model>=4` through.
    const bind = plan.head.bound ? "" : GRAMMAR.bind;
    const open = plan.open.slice(0, plan.head.consumed) + bind
        + GRAMMAR.scope.open + plan.slot + GRAMMAR.scope.close;
    if (!sameAsk(plan.open, open)) return null;
    return {
        text: plan.before + open + plan.after,
        caret: plan.before.length + open.length - 1,
    };
}

/** A commit's outcome: a keystroke, plus whether the committed segment was removed outright. */
export interface Commit extends Keystroke {
    /** True when an empty scope took its segment with it — the caret then sits where the segment stood. */
    readonly removed: boolean;
}

/**
 * Whether two spellings of one segment ask the same question.
 *
 * The engine's own equivalence, which is the only thing that can answer it: a textual comparison cannot,
 * because one question has more than one canonical spelling (`model:{fire|frost}` writes its alternation
 * parenthesised in one position and glued in the other), while two different questions can spell alike
 * (`model:{attach:chest}` against `model:attach:chest`, where the braceless form reads as content).
 *
 * @param a One spelling.
 * @param b The other.
 * @returns True when both ask the same thing — including when both ask nothing at all.
 */
function sameAsk(a: string, b: string): boolean {
    return equivalent(parse(a), parse(b));
}

/**
 * The committed spelling of one settled segment: its own written-tier respell, taken only when it provably
 * asks the same question.
 *
 * A chip draws its PARSE, so two spellings one chip cannot tell apart — `model:fire|frost` against the
 * parenthesised alternation, an operator's colon, a directive synonym — converge the moment the segment
 * settles, and the plain view and the URL stop disagreeing with what the chip shows. Broken text keeps its
 * characters: the formatter writes only the evaluable query, and a respell that dropped a reader's typing
 * would be loss, not normalisation.
 */
function settledSpelling(open: string): string {
    if (open.trim() === "") return open;
    const parsed = parse(open, {mode: "final"});
    // An error or a warning leaves the characters alone — an error because the formatter writes only the
    // evaluable query, a warning because rewriting warned text would silently apply the fix the warning is
    // offering. A NOTE is information and blocks nothing: the counts-rows note rides every count spelling.
    if (parsed.diagnostics.some((d) => d.severity !== "note")) return open;
    // The chip-invisible rewrites converge too: the chip already draws `spell:{desc:hello}` as the desc door,
    // so the settled text says what the chip shows.
    const respelled = formatQuery(convergeDisplay(parsed), "written");
    if (respelled === "" || respelled === open) return open;
    return sameAsk(open, respelled) ? respelled : open;
}

/**
 * Removes the character range `[from, to)` and one adjacent separator, so no double gap remains.
 *
 * @returns The new text with the caret where the removal stood, flagged as a removal.
 */
function spliceOut(text: string, from: number, to: number): Commit {
    let a = from;
    let b = to;
    if (text[b] === " ") b += 1;
    else if (a > 0 && text[a - 1] === " ") a -= 1;
    return {text: text.slice(0, a) + text.slice(b), caret: a, removed: true};
}

/**
 * Commits one segment: the scope simplifies to its interior where a single term remains.
 *
 * A scoped chip with one interior term drops its braces (`model:{fire}` → `model:fire` — the kernel law
 * `{x} ≡ x` spelled the preferred way) — but only where the shed spelling still asks the same question, which
 * the engine itself answers: `model:{attach:chest}` keeps its braces, because the colon-glued spelling reads as
 * content. Several terms keep them, trimmed; an empty scope removes the segment whole, separator included,
 * because an empty ask is not a chip. A segment with no scope commits as it stands, shedding only a dangling
 * alternation separator the grow gesture may have left.
 *
 * @param text The query text.
 * @param at Any offset inside the segment to commit.
 * @returns The new text with the caret at the committed segment's end — or, on a removal, where it stood.
 */
export function commitSegment(text: string, at: number): Commit {
    const plan = planAt(text, at);
    // A scope that closes BEFORE its segment ends (`model:{a b}c`) has text past the closer, so the slot is
    // not an interior and re-wrapping it would write a second closing brace. A scope that never closes still
    // commits as one — the missing brace is what the commit supplies.
    const early = plan.head?.scoped === true && plan.suffix === "" && closerAt(plan.slot) >= 0;
    if (plan.head === null || !plan.head.scoped || early) {
        // A plain segment is TEXT and settles verbatim; a headed one converges on its committed spelling.
        if (plan.head === null) return {text, caret: plan.before.length + plan.open.length, removed: false};
        const end = plan.open.length > 0 ? plan.open[plan.open.length - 1] : "";
        let open = plan.open;
        if (end === GRAMMAR.or || end === GRAMMAR.numberList) {
            const trimmed = plan.open.slice(0, -1);
            if (sameAsk(trimmed, plan.open)) open = trimmed;
        }
        open = settledSpelling(open);
        return {
            text: plan.before + open + plan.after,
            caret: plan.before.length + open.length,
            removed: false,
        };
    }
    let interior = closePhrase(plan.slot.trim());
    // The simplification runs to its FIXPOINT: an interior that is itself one whole scope sheds that scope
    // too, or `model:{{fire}}` would commit to the editing form's own spelling and lose a brace pair per
    // pass instead of settling once.
    while (interior.startsWith(GRAMMAR.scope.open) && closesAtEnd(interior.slice(1))) {
        interior = interior.slice(1, -1).trim();
    }
    const prefix = plan.open.slice(0, plan.head.consumed - 1);
    if (interior === "") {
        // The segment goes whole; one adjacent separator goes with it so no double gap remains.
        return spliceOut(text, plan.before.length, plan.before.length + plan.open.length);
    }
    const shed = prefix + interior;
    const kept = prefix + GRAMMAR.scope.open + interior + GRAMMAR.scope.close;
    // The braces go exactly when the bare spelling asks the same question — the kernel law `{x} = x` read
    // through the engine rather than guessed from the text. Two spellings that both ask nothing count as
    // agreeing, which returns a broken segment to the raw text it was typed as instead of stranding it in an
    // editing form it can never leave.
    const single = termStarts(interior).length === 1 && sameAsk(shed, kept);
    const open = settledSpelling(single ? shed : kept);
    return {
        text: plan.before + open + plan.after,
        caret: plan.before.length + open.length,
        removed: false,
    };
}

/**
 * The query with every segment committed — the text as it would stand once nothing is being edited.
 *
 * What the panel's settled-query controls compare against: an OPEN chip's editing braces are not a difference
 * worth offering to fix, since the commit converges them on its own. Right to left, so a commit that changes a
 * segment's length never moves the offsets of the segments still to come.
 *
 * @param text The query text, editing structure and all.
 * @returns The text with every segment settled.
 */
export function settledQuery(text: string): string {
    let out = text;
    for (const seg of segmentsOf(text).toReversed()) {
        out = commitSegment(out, seg.start).text;
    }
    return out;
}

/**
 * A bar-wide selection: a range of the query TEXT.
 *
 * The text is the truth here as everywhere, which is what makes the copy trivial — the selected range IS the
 * query it spells, so nothing has to be serialised back out of a rendering.
 */
export interface BarSelection {
    /** The first selected character's offset. */
    readonly from: number;
    /** The offset just past the last selected character. */
    readonly to: number;
}

/**
 * The selection covering everything between two offsets, snapped outwards over every chip it touches.
 *
 * Text selects by the character, because text IS characters — the space between two words included. A chip
 * draws its parse rather than its characters, so half of one could neither be shown selected nor copied as
 * anything typeable: a range reaching into a chip takes the whole chip.
 *
 * @param text The query text.
 * @param anchor Where the gesture began.
 * @param focus Where it has reached.
 * @returns The snapped range, or null when the two ends meet.
 */
export function selectionOver(text: string, anchor: number, focus: number): BarSelection | null {
    // The separator a commit leaves at the end belongs to the tail's caret rest, not to the query: a selection
    // stops at the last thing the reader actually wrote.
    const content = text.trimEnd().length;
    let from = Math.max(0, Math.min(anchor, focus, content));
    let to = Math.min(content, Math.max(anchor, focus));
    if (to <= from) return null;
    const segments = segmentsOf(text);
    // The separator between two chips is the join the language needs, not something the reader wrote there: a
    // range covering nothing but that selects nothing, so it cannot be lifted out and glue two asks together.
    if (segments.every((seg) => seg.end <= from || seg.start >= to)) return null;
    for (const seg of segments) {
        if (seg.plain || seg.start >= to || seg.end <= from) continue;
        from = Math.min(from, seg.start);
        to = Math.max(to, seg.end);
    }
    return {from, to};
}

/**
 * The offset one step of a selection gesture reaches, from a caret at `at` moving one place in `dir`.
 *
 * One character through text, one whole chip past a chip — the same escalation the caret itself makes when it
 * walks, said for a growing selection.
 *
 * @param text The query text.
 * @param at The moving end's current offset.
 * @param dir Which way it moves.
 * @returns The next offset, clamped to the text.
 */
export function selectionStep(text: string, at: number, dir: -1 | 1): number {
    // Stepping starts from the last thing written, so the first press out of the tail takes what stands there
    // rather than the separator the tail rests on.
    const content = text.trimEnd().length;
    const from = Math.min(at, content);
    const probe = dir === -1 ? from - 1 : from;
    if (probe < 0 || probe >= content) return Math.max(0, Math.min(content, from + dir));
    const segments = segmentsOf(text);
    /** The far side of a chip the step goes over, its own separator included. */
    const past = (seg: BarSegment): number =>
        dir === -1 ? seg.start : Math.min(text[seg.end] === " " ? seg.end + 1 : seg.end, content);
    // The segment the probe falls in, or — when it falls on the separator between two — the one beyond it.
    // A separator that joins a chip goes with the chip: the language put it there, not the reader.
    const seg = segments.find((held) => held.start <= probe && probe < held.end)
        ?? segments.find((held) => (dir === -1 ? held.end === probe : held.start === probe + 1));
    return seg === undefined || seg.plain ? from + dir : past(seg);
}

/**
 * Removes a bar selection, tidying the separator it leaves behind.
 *
 * Exactly the selected characters go, because a selection over text is a selection of characters. The one
 * tidy-up is a doubled separator: a whole segment lifted from between two others leaves a space on each side of
 * the hole, and the query language reads the pair as an empty term.
 *
 * @param text The query text.
 * @param sel The selection.
 * @returns The new text with the caret where the selection stood.
 */
export function removeSelection(text: string, sel: BarSelection): Commit {
    const before = text.slice(0, sel.from);
    const after = text.slice(sel.to);
    // Whole segments taken from a row of them leave a separator on each side of the hole, and a query opening
    // with one would draw a space before its first chip; one of the pair goes. Inside text nothing is tidied,
    // because there the separator is a character the reader put there and chose not to select — except at the
    // very end, where what follows is only the tail's own rest.
    const inText = segmentsOf(text).some((seg) => seg.plain && seg.start <= sel.from && sel.to <= seg.end);
    const strand = (!inText || after.trim() === "")
        && (before.endsWith(" ") || before === "") && after.startsWith(" ");
    return {text: before + (strand ? after.slice(1) : after), caret: sel.from, removed: true};
}

/**
 * Replaces a bar selection with new text, as typing or pasting over it does.
 *
 * The removal and the insertion are one operation: the inserted text lands where the selection stood, keeping
 * the separator a following segment needs — and growing none at the query's end, where the reader may keep
 * typing. Newlines in the insertion become the separator they stand for, because a query is one line.
 *
 * @param text The query text.
 * @param sel The selection.
 * @param inserted The replacement text, as typed or pasted.
 * @returns The new text with the caret after the insertion.
 */
export function replaceSelection(text: string, sel: BarSelection, inserted: string): Commit {
    const flat = inserted.replaceAll(/\s*\n\s*/g, " ").trim();
    const gone = removeSelection(text, sel);
    if (flat === "") return gone;
    const after = gone.text.slice(gone.caret);
    const glue = after.trim() === "" ? "" : " ";
    return {
        text: gone.text.slice(0, gone.caret) + flat + glue + after,
        caret: gone.caret + flat.length,
        removed: true,
    };
}


/**
 * Flips exclusion at one offset: the `-` a clause or a scope term carries before its head.
 *
 * One helper for both levels, because it is one gesture — the minus sits in the same place and means the same
 * thing whether it opens a clause or a term inside a scope.
 *
 * @param text The query text.
 * @param at The offset the clause or term begins at.
 * @returns The new text with the caret where the minus went, as one undoable operation.
 */
export function toggleNegation(text: string, at: number): Keystroke {
    const negated = text[at] === GRAMMAR.negate;
    const next = negated
        ? text.slice(0, at) + text.slice(at + 1)
        : text.slice(0, at) + GRAMMAR.negate + text.slice(at);
    return {text: next, caret: at, operation: true};
}

/**
 * The arrow affordance on a sort chip: ONE door of the directive turned the other way round, respelled through
 * the parser and the formatter rather than by touching characters. Every door carries its own arrow, so the
 * flip is per door whether the directive is a single sort or a scoped sequence.
 *
 * @param text The query text.
 * @param at Any offset inside the sort directive's segment.
 * @param door Which door to turn, by its position among the directive's sorts.
 * @returns The new text with the caret after the respelled directive, or null where the segment is no sort or
 *   names no such door.
 */
export function toggleSort(text: string, at: number, door: number): Commit | null {
    const seg = segmentAt(text, at);
    const parsed = parse(text.slice(seg.start, seg.end), {mode: "final"});
    if (door < 0 || door >= parsed.sorts.length || parsed.limit !== null) return null;
    const flipped = directiveTexts({
        ...parsed,
        sorts: parsed.sorts.map((sort, i) =>
            ({head: sort.head, descending: i === door ? !sort.descending : sort.descending, span: sort.span})),
    }).join(" ");
    const next = text.slice(0, seg.start) + flipped + text.slice(seg.end);
    return {text: next, caret: seg.start + flipped.length, removed: false};
}

/**
 * The delete affordance: removes the segment at `at` whole, one adjacent separator with it.
 *
 * @param text The query text.
 * @param at Any offset inside the segment to remove.
 * @returns The new text with the caret where the segment stood.
 */
export function removeSegment(text: string, at: number): Commit {
    const seg = segmentAt(text, at);
    return spliceOut(text, seg.start, seg.end);
}

/**
 * The per-term delete affordance: removes one term from inside a scoped segment.
 *
 * A term alone in its alternation run takes the stranded or-separator with it; a term with run siblings takes
 * only its own space, so the alternation between the survivors stands. What remains re-commits, so a scope down
 * to one term collapses back to the compact spelling and an emptied scope removes the segment whole.
 *
 * @param text The query text.
 * @param segStart The segment's start offset.
 * @param span The term's span, in segment coordinates.
 * @param lone Whether the term is alone in its alternation run — the display model knows, the text alone cannot.
 * @returns The new text with the caret at the re-committed segment's end — or, on a removal, where it stood.
 */
export function removeTerm(text: string, segStart: number, span: Span, lone: boolean): Commit {
    let a = segStart + span.start;
    let b = segStart + span.end;
    if (lone) {
        // Swallow the alternation edge the removal strands, spaces included — the following one first, so
        // removing a leading run keeps the caret's frame of reference simple.
        let right = b;
        while (text[right] === " ") right += 1;
        let left = a;
        while (left > segStart && text[left - 1] === " ") left -= 1;
        if (text[right] === GRAMMAR.or) {
            b = right + 1;
            while (text[b] === " ") b += 1;
        } else if (left > segStart && text[left - 1] === GRAMMAR.or) {
            a = left - 1;
            while (a > segStart && text[a - 1] === " ") a -= 1;
        }
    }
    if (!lone) {
        if (text[b] === " ") b += 1;
        else if (text[a - 1] === " ") a -= 1;
    }
    return commitSegment(text.slice(0, a) + text.slice(b), segStart);
}

/**
 * The grow affordance: the segment's editing form with a fresh slot appended, as one operation.
 *
 * A `term` growth is the ruled lane gesture — the scoped form with a new term slot before the closing brace, so
 * a chip grows into a lane the moment something is typed and collapses back if nothing is. An `alternative`
 * growth appends the alternation separator instead, offering another value; abandoned, the commit trim takes the
 * dangling separator back out.
 *
 * @param text The query text.
 * @param at Any offset inside the segment to grow.
 * @param flavour Which growth the chip offers — the display model declares it.
 * @returns The new text with the caret in the fresh slot.
 */
export function grownSegment(text: string, at: number, flavour: "term" | "alternative"): Keystroke {
    const seg = segmentAt(text, at);
    if (flavour === "alternative") {
        return {
            text: text.slice(0, seg.end) + GRAMMAR.or + text.slice(seg.end),
            caret: seg.end + 1,
            operation: true,
        };
    }
    const wrapped = scopedForm(text, at)?.text ?? text;
    const plan = planAt(wrapped, seg.start);
    if (plan.head === null || !plan.head.scoped) {
        // A headless or unscoped segment has no term slot to offer; the caret lands at its end unchanged.
        return {text, caret: seg.end, operation: true};
    }
    const cut = slotStart(plan) + plan.slot.length;
    const grown = plan.slot === "" ? wrapped : wrapped.slice(0, cut) + " " + wrapped.slice(cut);
    return {text: grown, caret: plan.slot === "" ? cut : cut + 1, operation: true};
}
