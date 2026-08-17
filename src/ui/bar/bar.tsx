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
import type {MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {Fragment, useMemo, useRef, useState} from "react";
import type {Span} from "../../search/index";
import {describe, parse} from "../../search/index";
import type {BarPlan, Commit, Keystroke} from "./plan";
import {
    commitSegment, firstDiff, grownSegment, insertAtGap, planAt, removeSegment, removeTerm, scopedForm,
    scopeGesture, segmentAt, segmentStarts, slotStart,
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
export function Bar({text, onText, placeholder}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
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

    const clamped = Math.min(openAt, text.length);
    const at: BarPlan = useMemo(() => {
        if (allMode) return {before: "", open: text, after: "", head: null, slot: text, suffix: ""};
        if (gapAt === null) return planAt(text, clamped);
        return {before: text.slice(0, gapAt), open: "", after: text.slice(gapAt), head: null, slot: "", suffix: ""};
    }, [text, clamped, gapAt, allMode]);

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

    /** Ctrl+A past the slot: the whole query, flat and selected — in its COMMITTED spelling, never a segment's
     * editing form, so a lone rewrapped chip flattens to `model:fire` and not to its braces. */
    const onSelectAll = (): void => {
        const step = commitOpen();
        if (step.text === "") {
            // Nothing to select — but the commit may just have evaporated a lone empty chip, and that
            // rewrite must still land or the undo stack holds a step the bar never showed.
            if (text !== "") openEnd("");
            return;
        }
        setFocused(true);
        setAllMode(true);
        setGapAt(null);
        setOpenAt(0);
        setCaret({at: step.text.length, anchor: 0});
        setSession((s) => s + 1);
        opened.current = step.text;
        if (step.text !== text) onText(step.text);
    };

    /** Commits the open segment — the simplifying rewrite — pushing an undo step when it changed anything. */
    const commitOpen = (): Commit => {
        if (allMode) return {text, caret: text.length, removed: false};
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
    // At rest — no focus, text to show — the open position renders settled like every other segment.
    const rest = !focused && text !== "";
    const openStart = gapAt === null && !allMode && !rest ? at.before.length : -1;
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
            highlight={<Classed text={at.slot}/>}
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
    if (allMode && !rest) {
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
            children.push(
                <span
                    key={start}
                    className={styles.settled}
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
    return (
        <div className={styles.qbar} onMouseDown={onBarPress}>
            {children}
        </div>
    );
}
