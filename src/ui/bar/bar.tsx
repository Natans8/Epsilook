/**
 * @file The bar: the query's segments in a row, one open as the editing form, the rest settled.
 *
 * The bar's one piece of state is WHICH segment is open, held as a text offset; everything else is a read of the
 * query text through {@link planAt}. Arrows walk the open segment across its neighbours, a press on a settled
 * segment opens it, and every text mutation arrives as a {@link Keystroke} whose caret offset decides both the
 * next open segment and where the caret lands inside it — one rule for typing, committing, dissolving and
 * merging alike.
 *
 * Settled segments render as classed raw text this increment; the committed-chip component replaces them next.
 */
import type {MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {useMemo, useRef, useState} from "react";
import {classify} from "../../search/index";
import type {Keystroke} from "./plan";
import {planAt, segmentAt, segmentStarts, slotStart} from "./plan";
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
    const wrap = useRef<HTMLDivElement>(null);

    const clamped = Math.min(openAt, text.length);
    const at = useMemo(() => planAt(text, clamped), [text, clamped]);

    /** Applies one keystroke: the caret's text offset picks the open segment and the slot position at once. */
    const onKeystroke = (step: Keystroke): void => {
        const seg = segmentAt(step.text, step.caret);
        const next = planAt(step.text, seg.start);
        setOpenAt(seg.start);
        setCaret({at: Math.max(0, step.caret - slotStart(next))});
        onText(step.text);
    };

    /** The caret walking out at either end: the neighbouring segment opens with the caret on the entering side. */
    const onArrow = (dir: -1 | 1): void => {
        const starts = segmentStarts(text);
        const here = starts.indexOf(segmentAt(text, clamped).start);
        const target = starts[here + dir];
        if (target === undefined) return;
        setOpenAt(target);
        setCaret({at: dir === -1 ? planAt(text, target).slot.length : 0});
    };

    /** A press on a settled segment opens it, caret at its end; a press on the ground opens the tail. */
    const openSegmentAt = (offset: number) => (e: ReactMouseEvent): void => {
        e.preventDefault();
        setOpenAt(offset);
        setCaret({at: planAt(text, offset).slot.length});
    };

    const onBarPress = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.target === e.currentTarget) openSegmentAt(text.length)(e);
    };

    const starts = segmentStarts(text);
    const openStart = segmentAt(text, clamped).start;

    return (
        <div ref={wrap} className={styles.qbar} onMouseDown={onBarPress}>
            {starts.map((start) => {
                const seg = segmentAt(text, start);
                if (seg.start === openStart) {
                    return (
                        <OpenSegment
                            key="open"
                            at={at}
                            highlight={<Classed text={at.slot}/>}
                            caret={caret}
                            placeholder={text === "" ? placeholder : undefined}
                            onKeystroke={onKeystroke}
                            onArrow={onArrow}
                        />
                    );
                }
                return (
                    <span
                        key={start}
                        className={styles.settled}
                        onMouseDown={openSegmentAt(seg.start)}
                    >
                        <Classed text={text.slice(seg.start, seg.end)}/>
                    </span>
                );
            })}
        </div>
    );
}
