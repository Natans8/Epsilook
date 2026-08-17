/**
 * @file The bar: the query's segments in a row, one open as the editing form, the rest settled.
 *
 * The frame for everything here, the user's own: think in terms of what is actually typed and how it is
 * evaluated on commit. The query text is the single source of truth; each gesture is a REWRITE of it — the bind
 * gesture inserts a scope, commit simplifies one, Escape restores the segment's opening text, undo steps whole
 * text states — and the bar's own state is only WHICH segment is open, plus those stacks.
 *
 * Settled segments render as classed raw text this increment; the committed-chip component replaces them next.
 */
import type {MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {useMemo, useRef, useState} from "react";
import {classify} from "../../search/index";
import type {Keystroke} from "./plan";
import {commitSegment, planAt, scopedForm, scopeGesture, segmentAt, segmentStarts, slotStart} from "./plan";
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
    // The open segment, as an offset into the text; the tail on first load. Clamped on every render because the
    // text can change under it.
    const [openAt, setOpenAt] = useState(Number.MAX_SAFE_INTEGER);
    const [caret, setCaret] = useState<CaretRequest | null>(null);
    // The editing session: bumping it remounts the slot, seeding the input and starting a fresh native undo
    // stack. Bumped exactly where the slot is rewritten from outside the input.
    const [session, setSession] = useState(0);
    // What the open segment's text was when it opened — Escape's restore point.
    const opened = useRef(text);
    const undos = useRef<string[]>([]);
    const redos = useRef<string[]>([]);

    const clamped = Math.min(openAt, text.length);
    const at = useMemo(() => planAt(text, clamped), [text, clamped]);

    /** One operation boundary: the state before it becomes an undo step. */
    const pushUndo = (before: string): void => {
        if (undos.current.at(-1) === before) return;
        undos.current = [...undos.current.slice(-49), before];
        redos.current = [];
    };

    /** Moves the open segment to `start` in `next`, normalising a simplified chip into its scoped editing form. */
    const openSegment = (next: string, start: number, side: "start" | "end"): void => {
        const wrapped = scopedForm(next, start);
        const settled = wrapped?.text ?? next;
        const plan = planAt(settled, start);
        setOpenAt(segmentAt(settled, start).start);
        setCaret({at: side === "end" ? plan.slot.length : 0});
        setSession((s) => s + 1);
        opened.current = settled;
        if (settled !== text) onText(settled);
    };

    /**
     * Applies one keystroke. Plain typing flows through without touching the session — the input owns its text
     * and its native undo; a resetting keystroke (the bind gesture, a boundary backspace) rewrites the slot from
     * outside, so it seeds a fresh session.
     */
    const onKeystroke = (step: Keystroke, reset: boolean, held: string): void => {
        const grown = scopeGesture(at, step);
        if (grown !== step) pushUndo(text);
        // A fresh session wherever the derived slot stops matching the input: an external rewrite, the gesture,
        // or a committing space having moved the segment boundary under the caret.
        const rewrites = reset || grown !== step
            || planAt(grown.text, grown.caret).slot !== held;
        if (rewrites) {
            const seg = segmentAt(grown.text, grown.caret);
            const next = planAt(grown.text, seg.start);
            setOpenAt(seg.start);
            setCaret({at: Math.max(0, grown.caret - slotStart(next))});
            setSession((s) => s + 1);
        }
        onText(grown.text);
    };

    /** Commits the open segment — the simplifying rewrite — pushing an undo step when it changed anything. */
    const commitOpen = (): Keystroke => {
        const step = commitSegment(text, clamped);
        if (step.text !== text) pushUndo(text);
        return step;
    };

    /** The caret walking out at either end: commit what it leaves, open the neighbour on the entering side. */
    const onArrow = (dir: -1 | 1): void => {
        const seg = segmentAt(text, clamped);
        const step = commitOpen();
        if (dir === -1) {
            if (seg.start === 0) {
                if (step.text !== text) openSegment(step.text, Math.max(0, seg.start), "start");
                return;
            }
            openSegment(step.text, Math.max(0, seg.start - 2), "end");
        } else {
            const after = step.caret + 1;
            if (after > step.text.length) {
                if (step.text !== text) openSegment(step.text, step.text.length, "end");
                return;
            }
            openSegment(step.text, after, "start");
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
        setOpenAt(opened.current.length);
        setCaret({at: planAt(opened.current, opened.current.length).slot.length});
    };

    const onUndo = (): void => {
        const prev = undos.current.at(-1);
        if (prev === undefined) return;
        undos.current = undos.current.slice(0, -1);
        redos.current = [...redos.current, text];
        onText(prev);
        setOpenAt(prev.length);
        setCaret({at: planAt(prev, prev.length).slot.length});
        opened.current = prev;
    };

    const onRedo = (): void => {
        const next = redos.current.at(-1);
        if (next === undefined) return;
        redos.current = redos.current.slice(0, -1);
        undos.current = [...undos.current, text];
        onText(next);
        setOpenAt(next.length);
        setCaret({at: planAt(next, next.length).slot.length});
        opened.current = next;
    };

    /** A press on a settled segment commits the open one and opens the pressed one, caret at its end. */
    const pressSegment = (start: number) => (e: ReactMouseEvent): void => {
        e.preventDefault();
        const seg = segmentAt(text, clamped);
        const step = commitOpen();
        const shifted = start > seg.start ? start + (step.text.length - text.length) : start;
        openSegment(step.text, Math.min(shifted, step.text.length), "end");
    };

    const onBarPress = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.target === e.currentTarget) pressSegment(text.length)(e);
    };

    const starts = segmentStarts(text);
    const openStart = segmentAt(text, clamped).start;

    return (
        <div className={styles.qbar} onMouseDown={onBarPress}>
            {starts.map((start) => {
                const seg = segmentAt(text, start);
                if (seg.start === openStart) {
                    return (
                        <OpenSegment
                            key={`open-${String(session)}`}
                            at={at}
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
                }
                return (
                    <span
                        key={start}
                        className={styles.settled}
                        onMouseDown={pressSegment(seg.start)}
                    >
                        <Classed text={text.slice(seg.start, seg.end)}/>
                    </span>
                );
            })}
        </div>
    );
}
