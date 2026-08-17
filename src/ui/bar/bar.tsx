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
 * Settled segments render as classed raw text this increment; the committed-chip component replaces them next.
 */
import type {MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {Fragment, useMemo, useRef, useState} from "react";
import {classify} from "../../search/index";
import type {BarPlan, Keystroke} from "./plan";
import {
    commitSegment, firstDiff, insertAtGap, planAt, scopedForm, scopeGesture, segmentAt, segmentStarts, slotStart,
} from "./plan";
import type {CaretRequest} from "./open";
import {OpenSegment} from "./open";
import styles from "./bar.module.css";

/** The backdrop colour class per run kind; a plain word paints nothing and inherits the text colour. */
const RUN_CLASS: Record<string, string | undefined> = {
    head: styles.runHead, op: styles.runOp, delim: styles.runOp, quote: styles.runOp, number: styles.runNumber,
};

/** One stretch of text as classed spans — the highlight, wherever raw text shows. */
function Classed({text}: { readonly text: string }): ReactElement {
    const runs = useMemo(() => classify(text), [text]);
    return (
        <>
            {runs.map((run, i) => (
                <span key={i} className={RUN_CLASS[run.kind]}>{text.slice(run.start, run.end)}</span>
            ))}
        </>
    );
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

    /** Moves the open position to the segment at `start`, normalising a simplified chip into its editing form. */
    const openSegment = (next: string, start: number, side: "start" | "end"): void => {
        const wrapped = scopedForm(next, start);
        const settled = wrapped?.text ?? next;
        const plan = planAt(settled, start);
        setGapAt(null);
        setOpenAt(segmentAt(settled, start).start);
        setCaret({at: side === "end" ? plan.slot.length : 0});
        setSession((s) => s + 1);
        opened.current = settled;
        if (settled !== text) onText(settled);
    };

    /** Moves the open position to the gap before the segment starting at `start`. */
    const openGap = (next: string, start: number): void => {
        setGapAt(start);
        setOpenAt(start);
        setCaret({at: 0});
        setSession((s) => s + 1);
        opened.current = next;
        if (next !== text) onText(next);
    };

    /** Runs one text state through the open-position bookkeeping — the shared tail of every keystroke path. */
    const applyStep = (step: Keystroke, reset: boolean, held: string): void => {
        const grown = scopeGesture(at, step);
        if (grown !== step) pushUndo(text);
        // A fresh session wherever the derived slot stops matching the input: an external rewrite, the gesture,
        // or a committing space having moved the segment boundary under the caret.
        const rewrites = reset || grown !== step
            || planAt(grown.text, grown.caret).slot !== held;
        const seg = segmentAt(grown.text, grown.caret);
        setOpenAt(seg.start);
        if (rewrites) {
            const next = planAt(grown.text, seg.start);
            setCaret({at: Math.max(0, grown.caret - slotStart(next))});
            setSession((s) => s + 1);
        }
        onText(grown.text);
    };

    /** Every mutation from the slot: gap insertions get their separator, everything else applies as it came. */
    const onKeystroke = (step: Keystroke, reset: boolean, held: string): void => {
        if (gapAt !== null && !reset) {
            if (held === "") return;
            setGapAt(null);
            applyStep(insertAtGap(text, gapAt, held), false, held);
            return;
        }
        setGapAt(null);
        applyStep(step, reset, held);
    };

    /** Commits the open segment — the simplifying rewrite — pushing an undo step when it changed anything. */
    const commitOpen = (): Keystroke => {
        if (gapAt !== null) return {text, caret: gapAt};
        const step = commitSegment(text, clamped);
        if (step.text !== text) pushUndo(text);
        return step;
    };

    /** The caret walking out at either end: chip — gap — chip — gap — tail, committing whatever it leaves. */
    const onArrow = (dir: -1 | 1): void => {
        if (gapAt !== null) {
            if (dir === 1) {
                openSegment(text, gapAt, "start");
            } else if (gapAt > 0) {
                openSegment(text, Math.max(0, gapAt - 2), "end");
            }
            return;
        }
        const seg = segmentAt(text, clamped);
        const step = commitOpen();
        if (dir === -1) {
            if (seg.start === 0) return;
            openGap(step.text, seg.start);
        } else {
            const after = step.caret + 1;
            const next = segmentAt(step.text, Math.min(after, step.text.length));
            if (after > step.text.length || next.start === next.end) {
                // The last chip, or only an empty tail beyond: one stop, the filling tail — never a gap AND an
                // empty segment offering two identical rests, and never a loop back into the chip just left.
                const grown = step.text === "" || step.text.endsWith(" ") ? step.text : `${step.text} `;
                openSegment(grown, grown.length, "end");
                return;
            }
            openGap(step.text, after);
        }
    };

    /** Enter: commit and open a FRESH tail — with a separator appended where the committed chip is the last. */
    const onCommit = (): void => {
        const step = commitOpen();
        const next = step.text === "" || step.text.endsWith(" ") ? step.text : `${step.text} `;
        openSegment(next, next.length, "end");
    };

    /** Escape: the segment goes back to what it held when it opened. */
    const onCancel = (): void => {
        if (opened.current === text) return;
        pushUndo(text);
        onText(opened.current);
        setGapAt(null);
        setOpenAt(opened.current.length);
        setCaret({at: planAt(opened.current, opened.current.length).slot.length});
        setSession((s) => s + 1);
    };

    /** Undo and redo land where the change happened — the first differing offset — as an open segment. */
    const restore = (to: string): void => {
        const t = Math.min(firstDiff(text, to), to.length);
        openSegment(to, t, "end");
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

    /** A press on a settled segment commits the open one and opens the pressed one, caret at its end. */
    const pressSegment = (start: number) => (e: ReactMouseEvent): void => {
        e.preventDefault();
        const from = gapAt ?? segmentAt(text, clamped).start;
        const step = commitOpen();
        const shifted = start > from ? start + (step.text.length - text.length) : start;
        openSegment(step.text, Math.min(shifted, step.text.length), "end");
    };

    const onBarPress = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.target === e.currentTarget) pressSegment(text.length)(e);
    };

    const starts = segmentStarts(text);
    const openStart = gapAt === null ? segmentAt(text, clamped).start : -1;
    // The slot fills the bar only as the true tail; anywhere else — a mid-bar word, a gap — it hugs, or it
    // would shove every chip after it to the far edge.
    const mode: "fill" | "hug" = at.head === null && gapAt === null && at.after.trim() === "" ? "fill" : "hug";

    const open = (
        <OpenSegment
            key={`open-${String(session)}`}
            at={at}
            mode={mode}
            highlight={<Classed text={at.slot}/>}
            caret={caret}
            placeholder={text === "" ? placeholder : undefined}
            onKeystroke={onKeystroke}
            onArrow={onArrow}
            onCommit={onCommit}
            onCancel={onCancel}
            onUndo={onUndo}
            onRedo={onRedo}
        />
    );

    return (
        <div className={styles.qbar} onMouseDown={onBarPress}>
            {starts.map((start) => {
                const seg = segmentAt(text, start);
                if (gapAt === null && seg.start === openStart) return <Fragment key="open">{open}</Fragment>;
                return (
                    <Fragment key={start}>
                        {gapAt === start && <Fragment key="open">{open}</Fragment>}
                        <span
                            className={styles.settled}
                            onMouseDown={pressSegment(seg.start)}
                        >
                            <Classed text={text.slice(seg.start, seg.end)}/>
                        </span>
                    </Fragment>
                );
            })}
        </div>
    );
}
