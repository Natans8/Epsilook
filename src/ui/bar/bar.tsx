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
import {Fragment, useMemo, useRef, useState} from "react";
import type {Span} from "../../search/index";
import {describe, parse} from "../../search/index";
import type {BarPlan, BarSelection, Commit, Keystroke} from "./plan";
import {
    commitSegment, firstDiff, grownSegment, insertAtGap, planAt, removeSegment, removeSelection, removeTerm,
    scopedForm, scopeGesture, segmentAt, segmentIndex, segmentStarts, selectionOfSegments, slotStart,
} from "./plan";
import type {CaretRequest} from "./open";
import {OpenSegment} from "./open";
import type {SegmentActions} from "./chip";
import {SettledSegment} from "./chip";
import {Classed} from "./classed";
import styles from "./bar.module.css";

/**
 * The character offset inside a settled span at a client point — what lets a press land the caret on the
 * character it aimed at, from the DOM's own caret hit test.
 *
 * @param span The settled segment's element.
 * @param x The press's client x.
 * @param y The press's client y.
 * @returns The offset into the span's text, or null where the platform cannot say.
 */
function caretOffset(span: Element, x: number, y: number): number | null {
    const at = document.caretPositionFromPoint?.(x, y);
    if (at == null || !span.contains(at.offsetNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(span);
    range.setEnd(at.offsetNode, at.offset);
    return range.toString().length;
}

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
export function Bar({text, onText, placeholder, plain = false}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    /**
     * The plaintext view: the query exactly as it is, with no chips and no corrections.
     *
     * A view the reader chooses, so nothing here rewrites what they typed — the commit simplification, the
     * editing rewrap and the bind's scope gesture are all chip-view behaviour. The highlighting still reads
     * the parse, which is the point of looking at the raw text at all.
     */
    readonly plain?: boolean;
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

    // The whole query as one flat raw-text session — what Ctrl+A escalates to. No transformation, no
    // segments: the truth of the text, natively selected.
    const [allMode, setAllMode] = useState(false);

    // Whether the bar holds the focus. At rest every segment renders committed — the editing form exists only
    // under the caret — while the input stays mounted, hidden, so the bar keeps its place in the tab order and
    // focus returning to it re-opens the remembered position.
    const [focused, setFocused] = useState(false);

    // The bar-wide selection, kept as the two SEGMENT NUMBERS the gesture moves: an anchor that stays put and
    // a focus that walks. Numbers rather than offsets, because the end of one segment and the start of the
    // next are the same offset and a selection that cannot tell them apart stops growing. Character-level work
    // inside one segment stays the platform's, in the open slot; this covers only what crosses a boundary.
    const [range, setRange] = useState<{ anchor: number; focus: number } | null>(null);
    // Which segment a drag began in, while the button is down.
    const dragFrom = useRef<number | null>(null);

    const clamped = Math.min(openAt, text.length);
    const sel: BarSelection | null = range === null ? null
        : selectionOfSegments(text, range.anchor, range.focus);
    const flat = allMode || plain;
    const at: BarPlan = useMemo(() => {
        if (flat) return {before: "", open: text, after: "", head: null, slot: text, suffix: ""};
        if (gapAt === null) return planAt(text, clamped);
        return {before: text.slice(0, gapAt), open: "", after: text.slice(gapAt), head: null, slot: "", suffix: ""};
    }, [text, clamped, gapAt, flat]);

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
     * @param at Where the open position sits, as a text offset.
     * @param caretAt Where the caret goes within the slot.
     * @param gap The gap's offset when the position is a gap, or null for a segment.
     * @param restore What Escape restores — the text this session started from, which a grow sets to the state
     *   before the growth so abandoning takes the whole gesture back.
     */
    const openSession = (next: string, at: number, caretAt: number, gap: number | null, restore: string): void => {
        setFocused(true);
        setRange(null);
        setAllMode(false);
        setGapAt(gap);
        setOpenAt(at);
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
        const at = segmentAt(next, start).start;
        openSession(next, at, 0, at, next);
    };

    /** Runs one text state through the open-position bookkeeping — the shared tail of every keystroke path. */
    const applyStep = (step: Keystroke, reset: boolean, held: string): void => {
        if (flat) {
            // The whole query IS the slot here, so there are no segment boundaries to re-plan around and
            // nothing to reset against: the input holds the truth until something outside it writes.
            if (reset) {
                setCaret({at: step.caret});
                setSession((n) => n + 1);
            }
            onText(step.text);
            return;
        }
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
        setAllMode(false);
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
     * Ctrl+A past the slot: every chip selected, in the bar's own selection.
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
        setAllMode(false);
        setRange({anchor: 0, focus: segmentStarts(step.text).length - 1});
    };

    /** Commits the open segment — the simplifying rewrite — pushing an undo step when it changed anything. */
    const commitOpen = (): Commit => {
        if (flat) return {text, caret: text.length, removed: false};
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
        openTail(commitOpen().text);
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
    const restore = (to: string): void => {
        openSegment(to, firstDiff(text, to), "end");
    };

    const onUndo = (): void => {
        const prev = undos.current.at(-1);
        if (prev === undefined) return;
        undos.current = undos.current.slice(0, -1);
        redos.current = [...redos.current, text];
        restore(prev);
    };

    const onRedo = (): void => {
        const next = redos.current.at(-1);
        if (next === undefined) return;
        redos.current = redos.current.slice(0, -1);
        undos.current = [...undos.current, text];
        restore(next);
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
     * Extends the selection by one segment.
     *
     * With no selection yet the anchor is the open position, so the first press takes the segment the caret was
     * about to leave — including from the empty tail, which has no segment of its own to grow from.
     */
    const onSelectSegment = (dir: -1 | 1): void => {
        const step = commitOpen();
        if (step.text !== text) onText(step.text);
        const last = segmentStarts(step.text).length - 1;
        const anchor = range?.anchor ?? segmentIndex(step.text, at.before.length);
        const from = range?.focus ?? anchor;
        setRange({anchor, focus: Math.max(0, Math.min(last, from + dir))});
    };

    /** The shared front half of every press: commit the open position, shifting a later target by the change. */
    const pressCommit = (start: number): { step: Commit; shifted: number } => {
        const from = at.before.length;
        const step = commitOpen();
        const shifted = start > from ? start + (step.text.length - text.length) : start;
        return {step, shifted};
    };

    /** A press on a settled segment opens it with the caret on the character it aimed at. */
    const pressSegment = (start: number) => (e: ReactMouseEvent): void => {
        e.preventDefault();
        const aim = caretOffset(e.currentTarget, e.clientX, e.clientY);
        const {step, shifted} = pressCommit(start);
        openSegment(step.text, shifted, aim ?? "end");
    };

    /** The rest after a rewrite that leaves a segment settled: the gap after it, or the one filling tail. */
    const restAfter = (next: string, caret: number): void => {
        const after = caret + 1;
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
        grow: (flavour): void => {
            const {step, shifted} = pressCommit(start);
            pushUndo(step.text);
            const grown = grownSegment(step.text, shifted, flavour);
            const plan = planAt(grown.text, grown.caret);
            // Escape abandons the grow whole, so the restore point is the settled text it started from.
            openSession(grown.text, plan.before.length, Math.max(0, grown.caret - slotStart(plan)), null, step.text);
        },
    });

    /** The query position a bar child stands at — its stamped segment start, or the open position itself. */
    const startOf = (child: Element): number => {
        const held = (child as HTMLElement).dataset["start"];
        return held === undefined ? at.before.length : Number(held);
    };

    /**
     * A press on the bar's own ground goes where it was aimed: the gap left of the child past the aim point —
     * line by line, the way a caret lands in wrapped text — or the content's end when nothing is past it.
     */
    const onBarPress = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        let target: Element | null = null;
        let row: DOMRect | null = null;
        for (const child of text === "" ? [] : Array.from(e.currentTarget.children)) {
            const box = child.getBoundingClientRect();
            if (row === null && e.clientY >= box.bottom) continue;
            // The child is past the aim when it starts a line below the aim's, or sits right of it on the
            // aim's own line.
            if (row !== null && box.top >= row.bottom) {
                target = child;
                break;
            }
            if (e.clientX < box.left) {
                target = child;
                break;
            }
            row = box;
        }
        if (target === null) {
            openEnd(commitOpen().text);
            return;
        }
        const {step, shifted} = pressCommit(startOf(target));
        openGap(step.text, shifted);
    };

    const starts = segmentStarts(text);
    // At rest — no focus, or a bar-wide selection standing — the open position renders settled like every
    // other segment. A selection spans whole segments, so no one of them can be in its editing form.
    const rest = !plain && ((!focused && text !== "") || sel !== null);
    const openStart = gapAt === null && !flat && !rest ? at.before.length : -1;
    // The slot fills the bar only as the true tail; anywhere else — a mid-bar word, a gap — it hugs, or it
    // would shove every chip after it to the far edge.
    const mode: "fill" | "hug" | "gap" = gapAt !== null ? "gap"
        : at.head === null && at.after.trim() === "" ? "fill" : "hug";

    const open = (
        <OpenSegment
            key={`open-${String(session)}`}
            at={at}
            mode={mode}
            hidden={rest}
            seize={focused || text === ""}
            highlight={<Classed text={at.slot} rich={flat}/>}
            caret={caret}
            placeholder={text === "" ? placeholder : undefined}
            onKeystroke={onKeystroke}
            onArrow={onArrow}
            onEdge={onEdge}
            onCommit={onCommit}
            onCancel={onCancel}
            onUndo={onUndo}
            onRedo={onRedo}
            onSelectAll={onSelectAll}
            onSelectSegment={onSelectSegment}
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
            }}
        />
    );

    // Every child is a keyed SIBLING of the bar — the open fragment included, wherever it sits. Nesting it
    // inside a per-segment fragment made a gap's first keystroke a REMOUNT (the subtree changed parents, the
    // key could not save it), which killed the input's caret mid-session.
    const children: ReactElement[] = [];
    if (flat && !rest) {
        children.push(<Fragment key="open">{open}</Fragment>);
    } else {
        starts.forEach((start, i) => {
            // The next boundary bounds this segment — no rescan; `starts` already encodes every split.
            const end = i + 1 < starts.length ? starts[i + 1] - 1 : text.length;
            if (!rest && (gapAt === start || (gapAt === null && start === openStart))) {
                children.push(<Fragment key="open">{open}</Fragment>);
                if (gapAt === null) return;
            }
            // An empty settled segment — a doubled separator's residue — draws nothing and takes no press:
            // opening a zero-width nothing is how phantom chiplets appear.
            if (start === end) return;
            const inSel = sel !== null && start >= sel.from && end <= sel.to;
            children.push(
                <span
                    key={start}
                    className={inSel ? `${styles.settled} ${styles.selected}` : styles.settled}
                    data-start={start}
                    onMouseDown={pressSegment(start)}
                >
                    <SettledSegment text={text.slice(start, end)} act={actionsFor(start)}/>
                </span>,
            );
        });
        // At rest the input stays mounted out of sight — same keyed sibling, so waking never remounts it —
        // holding the bar's place in the tab order until focus brings the editing form back.
        if (rest) children.push(<Fragment key="open">{open}</Fragment>);
    }
    /**
     * The segment number under a point, for a drag's two ends; null when the point is over none.
     *
     * Only settled segments answer — the open one carries no stamp, and it is the anchor the drag began in
     * anyway. The number is read against the text the stamps were rendered from, and a segment keeps its
     * number through a settle, so it stays valid once the open segment commits.
     */
    const segmentUnder = (e: ReactMouseEvent): number | null => {
        const bar = e.currentTarget as HTMLElement;
        let best: number | null = null;
        for (const child of Array.from(bar.children)) {
            const stamp = (child as HTMLElement).dataset["start"];
            if (stamp === undefined) continue;
            const box = child.getBoundingClientRect();
            if (e.clientY < box.top || e.clientY > box.bottom) continue;
            if (e.clientX >= box.left - 4) best = Number(stamp);
        }
        return best === null ? null : segmentIndex(text, best);
    };

    /**
     * A drag across the bar selects whole segments.
     *
     * The anchor is taken in capture, before a chip handles its own press, because the press that opens a chip
     * and the press that begins a selection are the same event — which of the two it was is only known once
     * the pointer has moved past the segment it started in.
     */
    const onBarDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        dragFrom.current = segmentUnder(e);
        setRange(null);
    };

    const onBarMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
        const from = dragFrom.current;
        if (from === null || e.buttons !== 1) return;
        // The point is read against the DOM as it stands, before anything is asked to change: a settle is a
        // state update the layout has not applied yet, so measuring after asking for one measures the old
        // boxes. The segment NUMBER survives it either way.
        const to = segmentUnder(e);
        if (to === null || to === from) return;
        e.preventDefault();
        // The press that began the drag also opened a chip, which wears its editing braces. Settling it is
        // what keeps those braces out of the selection — and out of whatever the reader copies.
        const step = commitOpen();
        if (step.text !== text) onText(step.text);
        setRange({anchor: from, focus: to});
    };

    /**
     * The selection's own keys, taken in CAPTURE so they never reach the input underneath: while several
     * segments are selected, Escape, Delete and the clipboard belong to the bar rather than to any one slot.
     */
    const onBarKeys = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (sel === null) return;
        const key = e.key.toLowerCase();
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setRange(null);
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
            setRange({anchor: 0, focus: segmentStarts(text).length - 1});
            return;
        }
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            e.stopPropagation();
            onSelectSegment(e.key === "ArrowLeft" ? -1 : 1);
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
            const rest = gone.text.slice(gone.caret);
            const glue = rest.trim() === "" ? "" : " ";
            const typed = gone.text.slice(0, gone.caret) + e.key + glue + rest;
            openSegment(typed, gone.caret + e.key.length, e.key.length);
        }
    };

    return (
        <div
            className={styles.qbar}
            onMouseDown={onBarPress}
            onMouseDownCapture={onBarDown}
            onMouseMove={onBarMove}
            onMouseUp={() => {
                dragFrom.current = null;
            }}
            onKeyDownCapture={onBarKeys}
            data-selection={sel === null ? undefined : selectedText()}
        >
            {children}
        </div>
    );
}
