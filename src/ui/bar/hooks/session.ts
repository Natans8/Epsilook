/**
 * @file The editing session: which position of the query is open, and every rewrite that moves it.
 *
 * The bar's own state is small, and this is nearly all of it. The query TEXT is the single source of truth and
 * the caller holds it; what lives here is where the caret sits in that text, what a fresh session restores, and
 * the two operation stacks. Every gesture the bar offers comes back through one of these calls, so a rewrite
 * can only reach the text one way.
 *
 * Split out of the bar because it is the one concern nothing else owns: the selection and the control surface
 * both CALL into it, and the renderer only reads what it returns.
 */
import {useMemo, useRef, useState} from "react";
import type {BarPlan, Commit, Keystroke} from "../utils/plan";
import {
    commitSegment, firstDiff, grownSegment, insertAtGap, planAt, removeSegment, removeTerm, scopedForm, shiftScope,
    scopeGesture, segmentAt, slotStart, toggleNegation, toggleSort,
} from "../utils/plan";
import {laneItemAt} from "../utils/lane";

/** Where the caret starts this session, in slot coordinates; an anchor makes it a selection. */
export interface CaretRequest {
    readonly at: number;
    readonly anchor?: number;
}

/** What a settled segment can ask of the bar. Offsets are into the segment's own raw spelling. */
export interface SegmentActions {
    /** Opens the segment for editing: at the slot's start or end, or at a raw offset. */
    readonly open: (side: "start" | "end" | number) => void;
    /** Removes the segment whole. */
    readonly remove: () => void;
    /**
     * Removes one term from inside the segment's scope, by its index among the lane's items.
     *
     * An INDEX rather than a span: a press settles whatever segment was open first, and that commit can rewrite
     * the very segment being acted on (trimming a scope's interior shifts every span inside it). The index
     * survives that, because a commit never adds or removes a term.
     */
    readonly removeTerm: (index: number) => void;
    /**
     * Grows the segment: a fresh term slot, or a fresh value alternative.
     *
     * TODO: no caller until the control surface lands the `+` affordance that presses it. The rewrite and its
     *   tests are in place, so what is missing is the button, not the behaviour.
     */
    readonly grow: (flavour: "term" | "alternative") => void;
    /** Flips the whole segment between asking for and excluding what it names. */
    readonly negate: () => void;
    /**
     * The same flip on the segment currently being EDITED, in place.
     *
     * Apart from {@link negate} because every settled action commits the open segment before it acts, which
     * would end the session the reader is still inside — and editing is when a reader most wants to invert.
     */
    readonly negateOpen: () => void;
    /** Flips one of a lane's terms, by its index among the items. */
    readonly negateTerm: (index: number) => void;
    /** Turns one door of a sort directive round, by its position among the directive's sorts. */
    readonly toggleSort: (door: number) => void;
}

/** The open position, the plan it implies, and every operation that moves it. */
export interface EditingSession {
    /** The plan the open position implies — what the renderer draws and every gesture measures against. */
    readonly at: BarPlan;
    /** The open position, clamped into the text as it now stands. */
    readonly clamped: number;
    /** The gap's offset when the open position is a gap rather than a segment. */
    readonly gapAt: number | null;
    /** The caret a fresh mount seeds, or null where the input keeps its own. */
    readonly caret: CaretRequest | null;
    /** Bumped wherever the slot is rewritten from outside the input; the remount seeds it afresh. */
    readonly session: number;
    /** Whether the bar holds the focus — what decides the rest state. */
    readonly focused: boolean;
    readonly setFocused: (held: boolean) => void;

    readonly pushUndo: (before: string) => void;
    readonly openSegment: (next: string, start: number, side: "start" | "end" | number) => void;
    readonly openGap: (next: string, start: number) => void;
    readonly openTail: (next: string) => void;
    readonly openEnd: (next: string) => void;
    readonly applyStep: (step: Keystroke, reset: boolean, held: string) => void;
    readonly onKeystroke: (step: Keystroke, reset: boolean, held: string) => void;
    readonly commitOpen: () => Commit;
    /**
     * Writes one value at the open GAP, as one undoable operation.
     *
     * The gap belongs to the session, so what to do with it does too — this is what keeps the setter private
     * where the surface would otherwise have to clear it by hand.
     *
     * @param value What to write.
     * @returns True where the open position was a gap and the write is handled; false where it was a segment
     *   and the caller must write through the slot instead.
     */
    readonly writeAtGap: (value: string) => boolean;
    readonly onArrow: (dir: -1 | 1) => void;
    /** Ctrl+] and Ctrl+[: the scope's boundary on that side adjusts at the caret — barf out, or slurp in. */
    readonly onScopeShift: (caretInSlot: number, dir: 1 | -1) => void;
    readonly onCommit: () => void;
    readonly onCancel: () => void;
    readonly onEdge: (side: -1 | 1) => void;
    readonly onUndo: () => void;
    readonly onRedo: () => void;
    readonly restAfter: (next: string, from: number) => void;
    readonly restAt: (gone: Commit) => void;
    readonly pressCommit: (start: number) => { step: Commit; shifted: number };
    readonly actionsFor: (start: number) => SegmentActions;
}

/**
 * The bar's editing session.
 *
 * @param text The query text, as the caller holds it.
 * @param onText Where a rewrite goes.
 * @param clearSelection Drops the bar's selection: a fresh session ends one, and so does a settled rewrite.
 * @param onRan A query the reader has finished with. The session knows WHEN one was finished; what to do with
 *   it belongs to the surface, which owns the history.
 * @returns The session.
 */
export function useEditingSession(
    text: string,
    onText: (next: string) => void,
    clearSelection: () => void,
    onRan: (query: string) => void,
): EditingSession {
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
    // under the caret — while the input stays mounted, hidden, so the bar keeps its place in the tab order.
    const [focused, setFocused] = useState(false);

    const clamped = Math.min(openAt, text.length);
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
        clearSelection();
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
            const written = insertAtGap(text, gapAt, held);
            if (written === null) {
                // Nothing was written; the remount clears the swallowed separator back out of the input.
                setSession((s) => s + 1);
                return;
            }
            setGapAt(null);
            applyStep(written, false, held);
            return;
        }
        setGapAt(null);
        applyStep(step, reset, held);
    };
    /** Writes one value at the open gap, as one undoable operation; false where no gap is open. */
    const writeAtGap = (value: string): boolean => {
        if (gapAt === null) return false;
        const step = insertAtGap(text, gapAt, value);
        if (step !== null) {
            setGapAt(null);
            applyStep({...step, operation: true}, true, value);
        }
        return true;
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

    /**
     * Ctrl+] and Ctrl+[: the scope's boundary on that side adjusts at the caret — text between them barfs
     * out of the enclosure, nothing between them slurps the neighbouring term in. The session stays open on
     * the interior, one undoable operation either way.
     */
    const onScopeShift = (caretInSlot: number, dir: 1 | -1): void => {
        if (gapAt !== null) return;
        const step = shiftScope(text, at.before.length, caretInSlot, dir);
        if (step === null) return;
        applyStep(step, true, planAt(step.text, step.caret).slot);
    };

    /** Enter: commit and open a FRESH tail — with a separator appended where the committed chip is the last. */
    const onCommit = (): void => {
        const step = commitOpen();
        onRan(step.text);
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
            clearSelection();
            restAfter(flipped.text, segmentAt(flipped.text, flipped.caret).end);
        },
        negateTerm: (index): void => {
            const {step, shifted} = pressCommit(start);
            const seg = segmentAt(step.text, shifted);
            const item = laneItemAt(step.text.slice(seg.start, seg.end), index);
            if (item === null) return;
            pushUndo(step.text);
            const flipped = toggleNegation(step.text, seg.start + item.span.start);
            clearSelection();
            restAfter(flipped.text, segmentAt(flipped.text, seg.start).end);
        },
        toggleSort: (door): void => {
            const {step, shifted} = pressCommit(start);
            const turned = toggleSort(step.text, shifted, door);
            if (turned === null) return;
            pushUndo(step.text);
            clearSelection();
            restAfter(turned.text, turned.caret);
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
    return {
        at, clamped, gapAt, caret, session, focused, setFocused,
        pushUndo, openSegment, openGap, openTail, openEnd,
        applyStep, onKeystroke, commitOpen, writeAtGap, onArrow, onScopeShift, onCommit, onCancel, onEdge, onUndo,
        onRedo,
        restAfter, restAt, pressCommit, actionsFor,
    };
}
