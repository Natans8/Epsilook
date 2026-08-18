/**
 * @file The bar: the query's segments in a row, one position open — a segment being edited, or a GAP between
 * segments where the caret can rest and type a new term.
 *
 * The frame for everything here, the user's own: think in terms of what is actually typed and how it is
 * evaluated on commit. The query text is the single source of truth; each gesture is a REWRITE of it, and the
 * bar's own state is only WHICH position is open plus the operation stacks. Arrows walk the full line:
 * chip — gap — chip — gap — tail, committing whatever they leave. Undo and redo land the caret where the change
 * happened, not at the end.
 *
 * Settled segments render at rest through the committed-chip component: chips and lanes for structured asks,
 * classed raw text for freeform terms and errors. Their affordances — open, ×, per-term ×, + — come back here
 * as rewrites of the text, each an undoable operation.
 */
import type {KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {Fragment, useId, useMemo, useRef, useState} from "react";
import type {Span} from "../../search/index";
import {describe, paint, parse, runsWithin} from "../../search/index";
import type {BarPlan, BarSegment, BarSelection, Commit, Keystroke} from "./plan";
import {
    commitSegment, firstDiff, grownSegment, insertAtGap, planAt, removeSegment, removeSelection, removeTerm,
    scopedForm, scopeGesture, segmentAt, segmentsOf, selectionOver, selectionStep, slotStart, toggleNegation,
    writeSlot,
} from "./plan";
import type {Aim} from "./aim";
import {groundAim, offsetAtPoint} from "./aim";
import type {Assist, CaretRequest} from "./open";
import {OpenSegment} from "./open";
import type {SegmentActions} from "./chip";
import {SettledSegment} from "./chip";
import {Classed} from "./classed";
import type {Offer, Vocabulary} from "./offers";
import {flatOffers, NO_OFFERS, NO_VOCABULARY, offerSlot, offersAt} from "./offers";
import {optionId, Surface} from "./surface";
import {recentQueries, rememberQuery} from "../history";
import styles from "./bar.module.css";

/**
 * One lane item of a settled segment, re-read from that segment's own text.
 *
 * @param segment The segment's text.
 * @param index Which of the lane's items to find.
 * @returns The item's span and whether it stands alone in its run, or null when the segment no longer draws
 *   a lane with that item — a settle can collapse one, and a press that raced it must then do nothing.
 */
function laneItemAt(segment: string, index: number): { span: Span; lone: boolean } | null {
    const view = describe(parse(segment)).find((held) => held.form === "lane");
    const item = view?.form === "lane" ? view.lane.items[index] : undefined;
    if (item === undefined || item.is === "or" || item.is === "dead") return null;
    return {span: item.span, lone: item.lone};
}

/**
 * The bar.
 */
export function Bar({text, onText, placeholder, vocab = NO_VOCABULARY}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    /** The closed vocabularies the loaded pack carries — what the surface can offer beyond the language. */
    readonly vocab?: Vocabulary;
}): ReactElement {
    // The open position: a segment (by any offset inside it), or a gap (by the start of the segment it sits
    // before). The tail on first load; clamped per render because the text can change underneath.
    const [openAt, setOpenAt] = useState(Number.MAX_SAFE_INTEGER);
    const [gapAt, setGapAt] = useState<number | null>(null);
    const [caret, setCaret] = useState<CaretRequest | null>(null);
    // The editing session: bumping it remounts the slot, seeding the input and starting a fresh native undo
    // stack. Bumped exactly where the slot is rewritten from outside the input.
    const [session, setSession] = useState(0);
    // What the open segment's text was when it opened — Escape's restore point.
    const opened = useRef(text);
    const undos = useRef<string[]>([]);
    const redos = useRef<string[]>([]);

    // Whether the bar holds the focus. At rest every segment renders committed — the editing form exists only
    // under the caret — while the input stays mounted, hidden, so the bar keeps its place in the tab order and
    // focus returning to it re-opens the remembered position.
    const [focused, setFocused] = useState(false);

    // The bar-wide selection, kept as the two OFFSETS the gesture moves: an anchor that stays put and a focus
    // that walks. Offsets, because text selects by the character and the space between two words is a
    // character of the query like any other; `selectionOver` is what snaps the range over the chips it
    // touches, which are the only things in the bar that cannot be half-selected.
    const [range, setRange] = useState<{ anchor: number; focus: number } | null>(null);
    // Where a drag began, while the button is down, and whether it has moved off that offset yet.
    const dragFrom = useRef<number | null>(null);
    const dragged = useRef(false);

    // Where the caret sits inside the slot, as the input reports it — what the surface can offer depends on it.
    const [caretInSlot, setCaretInSlot] = useState(0);
    // The lit offer, and the surface put away, each stamped with the situation they were decided in: both are
    // answers about one arrangement of query, position and caret, and they lapse the moment that arrangement
    // changes. Stamping is what keeps them out of the effects that would otherwise have to clear them.
    const [litAt, setLitAt] = useState({stamp: "", index: -1});
    const [dismissed, setDismissed] = useState("");
    const [history, setHistory] = useState(recentQueries);
    const listId = useId();

    const clamped = Math.min(openAt, text.length);
    const sel: BarSelection | null = range === null ? null : selectionOver(text, range.anchor, range.focus);
    const at: BarPlan = useMemo(() => {
        if (gapAt === null) return planAt(text, clamped);
        return {before: text.slice(0, gapAt), open: "", after: text.slice(gapAt), head: null, slot: "", suffix: ""};
    }, [text, clamped, gapAt]);

    /** One operation boundary: the state before it becomes an undo step. */
    const pushUndo = (before: string): void => {
        if (undos.current.at(-1) === before) return;
        undos.current = [...undos.current.slice(-49), before];
        redos.current = [];
    };

    /**
     * The one way the open position moves: a fresh editing session at `openAt`, with the caret placed inside
     * whatever that position's slot turns out to be.
     *
     * Every path below is this call plus its own arithmetic, so a new piece of session state is added here once
     * rather than in each of them.
     *
     * @param next The text the session opens on.
     * @param where The open position, as a text offset.
     * @param caretAt Where the caret goes within the slot.
     * @param gap The gap's offset when the position is a gap, or null for a segment.
     * @param restore What Escape restores — the text this session started from, which a grow sets to the state
     *   before the growth so abandoning takes the whole gesture back.
     */
    const openSession = (next: string, where: number, caretAt: number, gap: number | null, restore: string): void => {
        setFocused(true);
        setRange(null);
        setGapAt(gap);
        setOpenAt(where);
        setCaret({at: caretAt});
        setSession((s) => s + 1);
        opened.current = restore;
        if (next !== text) onText(next);
    };

    /**
     * Moves the open position to the segment at `start`, normalising a simplified chip into its editing form.
     * The side is an edge, or an aimed offset into the segment's raw spelling — the rewrap only inserts braces
     * around the value, so an interior offset carries over by subtracting what the head consumed.
     */
    const openSegment = (next: string, start: number, side: "start" | "end" | number): void => {
        const settled = scopedForm(next, start)?.text ?? next;
        const plan = planAt(settled, start);
        const aim = side === "start" ? 0
            : side === "end" ? plan.slot.length
                : Math.min(Math.max(0, side - (planAt(next, start).head?.consumed ?? 0)), plan.slot.length);
        openSession(settled, plan.before.length, aim, null, settled);
    };

    /** Moves the open position to the gap before the segment nearest `start` — a gap sits at a segment start. */
    const openGap = (next: string, start: number): void => {
        const where = segmentAt(next, start).start;
        openSession(next, where, 0, where, next);
    };

    /** Runs one text state through the open-position bookkeeping — the shared tail of every keystroke path. */
    const applyStep = (step: Keystroke, reset: boolean, held: string): void => {
        const grown = scopeGesture(at, step);
        if (grown !== step || step.operation === true) pushUndo(text);
        // A fresh session wherever the derived slot stops matching the input: an external rewrite, the gesture,
        // or a committing space having moved the segment boundary under the caret.
        const rewrites = reset || grown !== step
            || planAt(grown.text, grown.caret).slot !== held;
        const seg = segmentAt(grown.text, grown.caret);
        setOpenAt(seg.start);
        if (rewrites) {
            const base = slotStart(planAt(grown.text, seg.start));
            const anchor = grown === step ? step.anchor : undefined;
            setCaret({
                at: Math.max(0, grown.caret - base),
                anchor: anchor === undefined ? undefined : Math.max(0, anchor - base),
            });
            setSession((s) => s + 1);
        }
        onText(grown.text);
    };

    /** Every mutation from the slot: gap insertions get their separator, everything else applies as it came. */
    const onKeystroke = (step: Keystroke, reset: boolean, held: string): void => {
        if (gapAt !== null && !reset) {
            if (held === "") return;
            const step2 = insertAtGap(text, gapAt, held);
            if (step2 === null) {
                // Nothing was written; the remount clears the swallowed separator back out of the input.
                setSession((s) => s + 1);
                return;
            }
            setGapAt(null);
            applyStep(step2, false, held);
            return;
        }
        setGapAt(null);
        applyStep(step, reset, held);
    };

    /**
     * Ctrl+A past the slot: the whole query selected, in the bar's own selection.
     *
     * Not a flattening — the query stays the chips it is, and the reader gets a selection they can copy, cut or
     * delete. Reading the raw text is a view they choose, not something a keystroke does to them.
     */
    const onSelectAll = (): void => {
        const step = commitOpen();
        if (step.text.trim() === "") {
            // Nothing to select — but the commit may just have evaporated a lone empty chip, and that
            // rewrite must still land or the undo stack holds a step the bar never showed.
            if (text !== "") openEnd("");
            return;
        }
        if (step.text !== text) onText(step.text);
        setRange({anchor: 0, focus: step.text.trimEnd().length});
    };

    /** Commits the open segment — the simplifying rewrite — pushing an undo step when it changed anything. */
    const commitOpen = (): Commit => {
        if (gapAt !== null) return {text, caret: gapAt, removed: false};
        const step = commitSegment(text, clamped);
        if (step.text !== text) pushUndo(text);
        return step;
    };

    /** Opens the one filling tail, growing a separator where the text does not already end in one. */
    const openTail = (next: string): void => {
        const grown = next === "" || next.endsWith(" ") ? next : `${next} `;
        openSegment(grown, grown.length, "end");
    };

    /** Opens the very end of the text as it stands — the last content's end, no separator grown. */
    const openEnd = (next: string): void => {
        openSegment(next, next.length, "end");
    };

    /** The caret walking out at either end: chip — gap — chip — gap — tail, committing whatever it leaves. */
    const onArrow = (dir: -1 | 1): void => {
        if (gapAt !== null) {
            if (dir === 1) {
                openSegment(text, gapAt, "start");
            } else if (gapAt > 0) {
                openSegment(text, gapAt - 2, "end");
            }
            return;
        }
        const seg = segmentAt(text, clamped);
        const step = commitOpen();
        if (step.removed) {
            // The empty chip evaporated, so both arrows land where it stood: the gap there when segments
            // follow, otherwise the text's own end.
            if (step.caret < step.text.length) openGap(step.text, step.caret);
            else if (dir === -1) openEnd(step.text);
            else openTail(step.text);
            return;
        }
        if (dir === -1) {
            if (seg.start !== seg.end) {
                // The gap before the FIRST chip exists too — a term can be typed ahead of everything.
                openGap(step.text, seg.start);
            } else if (seg.start > 0) {
                // An empty segment — the tail after a trailing separator — has no gap of its own: straight
                // into the previous segment's end, or left and right would offer two rests in one spot.
                openSegment(step.text, seg.start - 2, "end");
            }
        } else {
            // The last chip, or only an empty tail beyond, folds into the one filling tail — never a gap AND an
            // empty segment offering two identical rests, and never a loop back into the chip just left.
            restAfter(step.text, step.caret);
        }
    };

    /** Enter: commit and open a FRESH tail — with a separator appended where the committed chip is the last. */
    const onCommit = (): void => {
        const step = commitOpen();
        setHistory(rememberQuery(step.text));
        openTail(step.text);
    };

    /** Escape: the segment goes back to what it held when it opened, the caret staying with it. */
    const onCancel = (): void => {
        if (opened.current === text) return;
        pushUndo(text);
        // The edited segment's start is stable across the restore — everything before it is verbatim.
        const start = at.before.length;
        onText(opened.current);
        setGapAt(null);
        setOpenAt(start);
        setCaret({at: planAt(opened.current, start).slot.length});
        setSession((s) => s + 1);
    };

    /** Home and End: the bar's own ends — the front gap, or the last content's end. */
    const onEdge = (side: -1 | 1): void => {
        const step = commitOpen();
        if (side === 1) {
            openEnd(step.text);
        } else if (step.text === "") {
            // An empty bar has no front gap; the commit's rewrite (a lone empty chip evaporating) still lands.
            if (text !== "") openEnd("");
        } else {
            openGap(step.text, 0);
        }
    };

    /** Undo and redo land where the change happened — the first differing offset — as an open segment. */
    const restoreTo = (to: string): void => {
        openSegment(to, firstDiff(text, to), "end");
    };

    const onUndo = (): void => {
        const prev = undos.current.at(-1);
        if (prev === undefined) return;
        undos.current = undos.current.slice(0, -1);
        redos.current = [...redos.current, text];
        restoreTo(prev);
    };

    const onRedo = (): void => {
        const next = redos.current.at(-1);
        if (next === undefined) return;
        redos.current = redos.current.slice(0, -1);
        undos.current = [...undos.current, text];
        restoreTo(next);
    };

    /** The selected segments' own text — the query they spell, which is what a copy puts on the clipboard. */
    const selectedText = (): string => (sel === null ? "" : text.slice(sel.from, sel.to));

    /** Removes the selection as one operation, resting the caret where it stood. */
    const deleteSelection = (): void => {
        if (sel === null) return;
        pushUndo(text);
        const gone = removeSelection(text, sel);
        setRange(null);
        restAt(gone);
    };

    /**
     * Extends the selection past the slot's own edge — one character through text, one whole chip past a chip.
     *
     * With no selection yet the anchor is the caret's own offset, so the first press takes what the caret was
     * about to leave — including from the empty tail, which has no segment of its own to grow from.
     */
    const onSelectPast = (dir: -1 | 1, anchorInSlot: number): void => {
        const step = commitOpen();
        if (step.text !== text) onText(step.text);
        const held = Math.min(slotStart(at) + anchorInSlot, step.text.length);
        const anchor = range?.anchor ?? held;
        const edge = Math.min(slotStart(at) + (dir === -1 ? 0 : at.slot.length), step.text.length);
        setRange({anchor, focus: selectionStep(step.text, range?.focus ?? edge, dir)});
    };

    /** The shared front half of every press: commit the open position, shifting a later target by the change. */
    const pressCommit = (start: number): { step: Commit; shifted: number } => {
        const from = at.before.length;
        const step = commitOpen();
        const shifted = start > from ? start + (step.text.length - text.length) : start;
        return {step, shifted};
    };

    /** The rest after a rewrite that leaves a segment settled: the gap after it, or the one filling tail. */
    const restAfter = (next: string, from: number): void => {
        const after = from + 1;
        const seg = segmentAt(next, Math.min(after, next.length));
        if (after > next.length || (seg.start === seg.end && seg.end === next.length)) openTail(next);
        else openGap(next, after);
    };

    /** The rest after a removal: the gap where it stood when segments follow, otherwise the filling tail. */
    const restAt = (gone: Commit): void => {
        if (gone.caret < gone.text.length) openGap(gone.text, gone.caret);
        else openTail(gone.text);
    };

    /** What a settled segment's chips can ask of the bar; every rewrite is one undoable operation. */
    const actionsFor = (start: number): SegmentActions => ({
        open: (side): void => {
            const {step, shifted} = pressCommit(start);
            openSegment(step.text, shifted, side);
        },
        remove: (): void => {
            const {step, shifted} = pressCommit(start);
            pushUndo(step.text);
            restAt(removeSegment(step.text, shifted));
        },
        removeTerm: (index: number): void => {
            const {step, shifted} = pressCommit(start);
            const seg = segmentAt(step.text, shifted);
            // The term is re-found in the COMMITTED text: the commit above may have rewritten this very
            // segment, and a span read from the render would then point at the wrong characters.
            const item = laneItemAt(step.text.slice(seg.start, seg.end), index);
            if (item === null) return;
            pushUndo(step.text);
            const done = removeTerm(step.text, seg.start, item.span, item.lone);
            if (done.removed) restAt(done);
            else restAfter(done.text, done.caret);
        },
        negateOpen: (): void => {
            // The open form's own flip: the head means the same thing in both forms, and while a chip is being
            // edited is exactly when a reader reaches for it. Committing first — which every settled action
            // does — would end the session the reader is still in, so this rewrites in place and the caret
            // rides the minus.
            const seg = segmentAt(text, clamped);
            const flipped = toggleNegation(text, seg.start);
            const shift = flipped.text.length - text.length;
            applyStep({text: flipped.text, caret: clamped + shift, operation: true}, true,
                planAt(flipped.text, clamped + shift).slot);
        },
        negate: (): void => {
            const {step, shifted} = pressCommit(start);
            pushUndo(step.text);
            const flipped = toggleNegation(step.text, segmentAt(step.text, shifted).start);
            setRange(null);
            restAfter(flipped.text, segmentAt(flipped.text, flipped.caret).end);
        },
        negateTerm: (index): void => {
            const {step, shifted} = pressCommit(start);
            const seg = segmentAt(step.text, shifted);
            const item = laneItemAt(step.text.slice(seg.start, seg.end), index);
            if (item === null) return;
            pushUndo(step.text);
            const flipped = toggleNegation(step.text, seg.start + item.span.start);
            setRange(null);
            restAfter(flipped.text, segmentAt(flipped.text, seg.start).end);
        },
        grow: (flavour): void => {
            const {step, shifted} = pressCommit(start);
            pushUndo(step.text);
            const grown = grownSegment(step.text, shifted, flavour);
            const plan = planAt(grown.text, grown.caret);
            // Escape abandons the grow whole, so the restore point is the settled text it started from.
            openSession(grown.text, plan.before.length, Math.max(0, grown.caret - slotStart(plan)), null, step.text);
        },
    });

    /**
     * Where a press landed in the query.
     *
     * A press ON the bar rather than on any of its children is read by line, because the platform's own caret
     * hit test answers with the nearest text wherever it is.
     */
    const aimOf = (e: ReactMouseEvent<HTMLDivElement>): Aim => {
        const ground = e.target === e.currentTarget;
        const inside = ground ? null : offsetAtPoint(e.currentTarget, e.clientX, e.clientY);
        return inside ?? {at: groundAim(e.currentTarget, e.clientX, e.clientY, text), exact: false};
    };

    const segments = useMemo(() => segmentsOf(text), [text]);
    // The slot holds a FRAGMENT, so it cannot paint itself: the whole query is painted once and each surface
    // takes its own slice, which is what makes an open chip read exactly as the plain view reads.
    const painted = useMemo(() => paint(text), [text]);
    const slotRuns = useMemo(
        () => runsWithin(painted, {start: slotStart(at), end: slotStart(at) + at.slot.length})
            // Stripped of their state: a value half typed is not a value that failed, and `scale:x` on its way
            // to `scale:x5` was being squiggled as though the reader had finished and got it wrong. Diagnostics
            // belong to a committed query — which is the law's silent-while-typing half, drawn.
            .map((run) => (run.state === undefined ? run : {...run, state: undefined})),
        [painted, at]);
    // At rest — no focus, or a bar-wide selection standing — the open position renders settled like every
    // other segment. A selection is a stretch of the settled query, so nothing inside it is in its editing form.
    const rest = (!focused && text !== "") || sel !== null;
    const openStart = gapAt === null && !rest ? at.before.length : -1;
    // The slot fills the bar only as the true tail; anywhere else — a mid-bar word, a gap — it hugs, or it
    // would shove every chip after it to the far edge.
    const mode: "fill" | "hug" | "gap" = gapAt !== null ? "gap"
        : at.head === null && at.after.trim() === "" ? "fill" : "hug";

    // What the caret can be handed. A bar at rest holds no caret, so there is nothing to offer and nothing to
    // compute; everywhere else the offers are a pure read of the open position.
    const offers = useMemo(
        () => (rest ? NO_OFFERS : offersAt(at, caretInSlot, history, vocab)),
        [rest, at, caretInSlot, history, vocab]);
    const flat = useMemo(() => flatOffers(offers), [offers]);
    // One arrangement of query, position and caret — what the light and the dismissal were decided about.
    //
    // NUMBERED, because an arrangement returned to is not the arrangement that was left. A light steered
    // to at `xpac:6` was decided about those characters under that caret; type them again later and a
    // plain comparison hands back the light that was already spent, so Enter applies an offer the reader
    // never chose instead of running their query. The count only has to DIFFER between visits, never to
    // be sequential, so a render thrown away costs nothing.
    const arrangement = JSON.stringify([text, clamped, gapAt ?? -1, caretInSlot]);
    const visit = useRef({arrangement: "", count: 0});
    if (visit.current.arrangement !== arrangement) {
        visit.current = {arrangement, count: visit.current.count + 1};
    }
    const stamp = `${arrangement}#${String(visit.current.count)}`;
    const shown = (offers.groups.length > 0 || offers.takes !== null) && dismissed !== stamp;
    const lit = shown && litAt.stamp === stamp ? litAt.index : -1;

    /**
     * Takes one offer into the query, exactly as the keystrokes that would have written it: the stub the offers
     * were computed against gives way to what the offer spells, and the ordinary rewrite path does the rest —
     * so a picked door opens its scope by the same gesture a typed colon does, in one undoable step.
     */
    const applyOffer = (offer: Offer): void => {
        if (offer.shape === "query") {
            pushUndo(text);
            openTail(offer.insert);
            return;
        }
        const {value, caret: within} = offerSlot(at, offers, offer);
        if (gapAt !== null) {
            const step = insertAtGap(text, gapAt, value);
            if (step === null) return;
            setGapAt(null);
            applyStep({...step, operation: true}, true, value);
            return;
        }
        applyStep({text: writeSlot(at, value), caret: slotStart(at) + within, operation: true}, true, value);
    };

    const assist: Assist = {
        count: flat.length,
        open: shown,
        lit,
        // The ghost and the light say the same thing in two places, so only one of them is ever drawn: the
        // ghost while the reader types, the light once they have started steering the list.
        ghost: shown && lit < 0 ? offers.ghost : "",
        listId,
        activeId: lit >= 0 ? optionId(listId, lit) : undefined,
        move: (dir): void => {
            if (flat.length === 0) return;
            const next = lit < 0 ? (dir === 1 ? 0 : flat.length - 1) : (lit + dir + flat.length) % flat.length;
            setDismissed("");
            setLitAt({stamp, index: next});
        },
        pick: (): void => {
            if (lit >= 0) applyOffer(flat[lit]);
        },
        close: (): void => {
            setDismissed(stamp);
            setLitAt({stamp: "", index: -1});
        },
        /**
         * Takes the completion the slot is showing.
         *
         * A ghost is an offer's own remainder, a UNIT the number is missing, or the CLOSERS an enclosure
         * wants; only the first has a row to pick, and the others are written straight into the slot as the
         * keystrokes they stand for.
         */
        accept: (): void => {
            if (lit < 0 && offers.ghostIs !== null && offers.ghostIs !== "offer") {
                const value = at.slot.slice(0, caretInSlot) + offers.ghost + at.slot.slice(caretInSlot);
                applyStep({
                    text: writeSlot(at, value),
                    caret: slotStart(at) + caretInSlot + offers.ghost.length,
                    operation: true,
                }, true, value);
                return;
            }
            const best = lit >= 0 ? flat[lit] : flat[0];
            if (best !== undefined) applyOffer(best);
        },
    };

    const open = (
        <OpenSegment
            key={`open-${String(session)}`}
            at={at}
            mode={mode}
            hidden={rest}
            seize={focused || text === ""}
            highlight={<Classed text={at.slot} runs={slotRuns} mirrored/>}
            caret={caret}
            placeholder={text === "" ? placeholder : undefined}
            label={placeholder}
            assist={assist}
            onFlip={actionsFor(at.before.length).negateOpen}
            onCaret={setCaretInSlot}
            onKeystroke={onKeystroke}
            onArrow={onArrow}
            onEdge={onEdge}
            onCommit={onCommit}
            onCancel={onCancel}
            onUndo={onUndo}
            onRedo={onRedo}
            onSelectAll={onSelectAll}
            onSelectPast={onSelectPast}
            onWake={() => {
                setFocused(true);
            }}
            onSettle={() => {
                setFocused(false);
                // Focus left the bar: the segment settles into its committed spelling — the editing form's
                // braces must never outlive the editing. The slot text is unchanged by a simplify, so no
                // session reset and no focus theft.
                const step = commitOpen();
                if (step.text !== text) onText(step.text);
                // A search the reader has finished with is one they may want back, and its committed spelling
                // is the one worth keeping — never the half-typed shape it passed through on the way.
                setHistory(rememberQuery(step.text));
            }}
        />
    );

    /**
     * One stretch of query text that no segment claims — the separator between two chips.
     *
     * It is drawn rather than implied, because it is a character of the query: it can be selected, it can be
     * deleted, and the space a reader sees between two chips is the one they typed. A gap between chips wide
     * enough to read but not made of the query's own characters is what made words look like objects.
     */
    const between = (from: number, to: number): ReactElement => {
        const covered = sel !== null && sel.from <= from && sel.to >= to;
        return (
            <span
                key={`sep-${String(from)}`}
                className={covered ? `${styles.sep} ${styles.selected}` : styles.sep}
                data-at={from}
                data-plain=""
            >
                {text.slice(from, to)}
            </span>
        );
    };

    /** One settled segment: a chip, or a stretch of the query's own text. */
    const settled = (seg: BarSegment): ReactElement => {
        const covered = sel !== null && sel.from <= seg.start && sel.to >= seg.end;
        // Text paints its own selection character by character; a chip is atomic, so the whole of it paints.
        const inside = sel === null || !seg.plain ? undefined
            : {start: Math.max(sel.from, seg.start) - seg.start, end: Math.min(sel.to, seg.end) - seg.start};
        const cls = [styles.settled, seg.plain ? "" : styles.chipHost,
            covered && !seg.plain ? styles.selected : ""].filter((held) => held !== "").join(" ");
        return (
            <span
                key={seg.start}
                className={cls}
                data-at={seg.start}
                data-end={seg.end}
                // Plain text draws its own characters, so a point inside it resolves to one of them; a chip
                // draws its parse instead and can only answer with an edge.
                data-plain={seg.plain ? "" : undefined}
                // A chip draws its parse, so its rendered text reads as one run of glued words. The label is
                // the segment's own query text, which says what it asks and is what a reader would type to
                // say it again. Text needs none: it reads as itself.
                role={seg.plain ? undefined : "group"}
                aria-label={seg.plain ? undefined : text.slice(seg.start, seg.end)}
            >
                <SettledSegment
                    text={text.slice(seg.start, seg.end)}
                    at={seg.start}
                    act={actionsFor(seg.start)}
                    selected={inside}
                />
            </span>
        );
    };

    // Every child is a keyed SIBLING of the bar — the open fragment included, wherever it sits. Nesting it
    // inside a per-segment fragment made a gap's first keystroke a REMOUNT (the subtree changed parents, the
    // key could not save it), which killed the input's caret mid-session. Together the children cover the
    // query text exactly once, which is what lets a point resolve to an offset and back.
    const children: ReactElement[] = [];
    let drawn = 0;
    for (const seg of segments) {
        if (seg.start > drawn) children.push(between(drawn, seg.start));
        drawn = seg.end;
        if (!rest && (gapAt === seg.start || (gapAt === null && seg.start === openStart))) {
            children.push(<Fragment key="open">{open}</Fragment>);
            if (gapAt === null) continue;
        }
        // An empty settled segment — a doubled separator's residue — draws nothing and takes no press:
        // opening a zero-width nothing is how phantom chiplets appear.
        if (seg.start !== seg.end) children.push(settled(seg));
    }
    if (drawn < text.length) children.push(between(drawn, text.length));
    // At rest the input stays mounted out of sight — same keyed sibling, so waking never remounts it —
    // holding the bar's place in the tab order until focus brings the editing form back.
    if (rest) children.push(<Fragment key="open">{open}</Fragment>);

    /**
     * A press anchors a selection and settles whatever was open, so every offset the drag goes on to measure
     * is one the query will still have when the button comes up.
     *
     * Taken in capture, before a chip sees its own press: which of the two a press was — placing a caret or
     * beginning a selection — is only known once the pointer has moved, so the press itself does neither.
     */
    const onBarDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        // The control surface is part of this editing session, not a place in the query: a press on it settles
        // nothing, anchors nothing, and the row itself keeps the focus in the slot.
        if (e.target instanceof Element && e.target.closest("[data-surface]") !== null) {
            dragFrom.current = null;
            return;
        }
        // The editing form owns its own presses — its caret, its native selection, and a head that keeps the
        // session alive — so nothing here is prevented while the press is inside it. The anchor is still
        // recorded: a drag that LEAVES the slot is a bar selection, and it must know where it began.
        if (e.target instanceof Element && e.target.closest("[data-open]") !== null) {
            dragFrom.current = slotStart(at) + at.slot.length;
        } else {
            e.preventDefault();
            const {step, shifted} = pressCommit(aimOf(e).at);
            if (step.text !== text) onText(step.text);
            dragFrom.current = shifted;
        }
        dragged.current = false;
        setRange(null);
    };

    const onBarMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
        const from = dragFrom.current;
        if (from === null || e.buttons !== 1) return;
        // A drag still inside the slot is the platform's own, character by character; only one that has left
        // it becomes the bar's.
        if (!dragged.current && e.target instanceof Element && e.target.closest("[data-open]") !== null) return;
        const aim = aimOf(e);
        // Reaching a chip takes it whole from its first pixel: the far edge is the one the gesture means.
        const to = aim.span === undefined ? aim.at
            : aim.span.start >= from ? aim.span.end : aim.span.start;
        if (to === from && !dragged.current) return;
        e.preventDefault();
        dragged.current = true;
        setRange({anchor: from, focus: to});
        // While a selection stands the keys are the bar's, so it takes the focus the press denied it.
        if (!e.currentTarget.contains(document.activeElement)) e.currentTarget.focus({preventScroll: true});
    };

    /**
     * A press that did not drag places the caret where it aimed: inside text at that character, at a gap
     * between chips, or at the query's end when it landed past everything.
     *
     * On the click rather than the press, because a press that turns into a drag must not open anything —
     * and a chip's own click stops before this, so pressing a chip still opens the chip.
     */
    const onBarClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (dragged.current) {
            dragged.current = false;
            return;
        }
        if (e.target instanceof Element && e.target.closest("[data-open],[data-surface],button") !== null) return;
        const {at: aim, exact} = aimOf(e);
        const seg = segmentAt(text, aim);
        if (aim >= text.length) openEnd(text);
        // Past a segment's own end sits the separator: the caret rests in the gap before what follows it.
        else if (aim >= seg.end) openGap(text, aim + 1);
            // Anything drawing its own characters — text, an erred clause, the glue between two of them — takes
        // the caret at the character pressed. A chip's edge is not a character, so it takes the gap.
        else if (exact) openSegment(text, seg.start, aim - seg.start);
        else openGap(text, seg.start);
    };

    /**
     * The selection's own keys, taken in CAPTURE so they never reach the input underneath: while a stretch of
     * the query is selected, Escape, Delete and the clipboard belong to the bar rather than to any one slot.
     *
     * The bar also holds the focus when a press made a selection and no slot is open, so Ctrl+A answers there
     * too — the slot's own Ctrl+A takes the slot's contents first, and only the bar can mean the whole query.
     */
    const onBarKeys = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
        const key = e.key.toLowerCase();
        if (sel === null) {
            if (e.ctrlKey && key === "a" && !(e.target instanceof HTMLInputElement)) {
                e.preventDefault();
                onSelectAll();
            }
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            // The caret goes back where the selection began: dropping a selection and leaving the bar with no
            // caret at all is a dead end, and the next keystroke would have nowhere to land.
            setRange(null);
            openGap(text, sel.from);
            return;
        }
        if (e.key === "Backspace" || e.key === "Delete") {
            e.preventDefault();
            e.stopPropagation();
            deleteSelection();
            return;
        }
        if (e.ctrlKey && (key === "c" || key === "x")) {
            e.preventDefault();
            e.stopPropagation();
            void navigator.clipboard?.writeText(selectedText());
            if (key === "x") deleteSelection();
            return;
        }
        if (e.ctrlKey && key === "a") {
            e.preventDefault();
            e.stopPropagation();
            onSelectAll();
            return;
        }
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            e.stopPropagation();
            // A selection already stands, so its own anchor is what holds; the slot's is not consulted.
            onSelectPast(e.key === "ArrowLeft" ? -1 : 1, 0);
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            // A plain arrow collapses the selection to the side it points at, as it does for selected text.
            e.preventDefault();
            e.stopPropagation();
            setRange(null);
            if (e.key === "ArrowLeft") openGap(text, sel.from);
            else restAfter(text, sel.to);
            return;
        }
        // A printable character replaces the selection, exactly as typing over selected text does. One
        // operation: the removal and the character land together, so one undo takes both back.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            pushUndo(text);
            const gone = removeSelection(text, sel);
            setRange(null);
            // The character lands where the selection stood, keeping the separator that a following segment
            // needs — and growing none at the query's end, where the word is still being typed.
            const after = gone.text.slice(gone.caret);
            const glue = after.trim() === "" ? "" : " ";
            const typed = gone.text.slice(0, gone.caret) + e.key + glue + after;
            openSegment(typed, gone.caret + e.key.length, e.key.length);
        }
    };

    return (
        <div
            className={styles.qbar}
            // Focusable but never tabbed to: while a selection stands its keys are the bar's own, and the
            // press that made it deliberately moved focus nowhere. Tab still reaches the slot, which is the
            // one control a keyboard is looking for.
            tabIndex={-1}
            onMouseDownCapture={onBarDown}
            onMouseMove={onBarMove}
            onMouseUp={() => {
                dragFrom.current = null;
            }}
            onClick={onBarClick}
            onKeyDownCapture={onBarKeys}
            data-selection={sel === null ? undefined : selectedText()}
        >
            {children}
            {shown && (
                <Surface
                    offers={offers}
                    lit={lit}
                    listId={listId}
                    onPick={applyOffer}
                    onLight={(index) => {
                        // The pointer reports every move over a row; only a move to another row is news.
                        setLitAt((was) => (was.index === index && was.stamp === stamp ? was : {stamp, index}));
                    }}
                />
            )}
        </div>
    );
}
