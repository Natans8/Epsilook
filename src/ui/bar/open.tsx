/**
 * @file The open segment — the EDITING form of a chip, one of the design's two visual modes.
 *
 * The committed chip is a different component with a different look, arriving with its own increment; this one
 * is the segment under the caret: a head cell once the bind lands, and the value slot — the bar's only input —
 * over the same transparent-input-and-backdrop pair the whole bar used before it. The element tree keeps one
 * shape whether or not a head is present, so the input is never remounted mid-keystroke and the caret survives
 * the transformation.
 */
import type {KeyboardEvent, ReactElement, ReactNode} from "react";
import {useLayoutEffect, useRef} from "react";
import type {BarPlan, Keystroke} from "./plan";
import {backspaceAtStart, slotStart} from "./plan";
import styles from "./bar.module.css";

/** Heads are capitalised everywhere: `Scale`, never `scale`. */
const headCase = (word: string): string => (word === "" ? word : word[0].toUpperCase() + word.slice(1));

/** A caret request: slot coordinates, fresh object per request so an equal position still reapplies. */
export interface CaretRequest {
    readonly at: number;
}

/**
 * The open segment.
 */
export function OpenSegment({at, highlight, caret, placeholder, onKeystroke, onArrow}: {
    readonly at: BarPlan;
    /** The classed rendering of the slot text — the bar supplies its one highlighter. */
    readonly highlight: ReactNode;
    /** Where to put the caret, applied and focused whenever the request object changes. */
    readonly caret: CaretRequest | null;
    readonly placeholder?: string;
    /** Every text mutation leaves as a keystroke: the new text and the caret as a text offset. */
    readonly onKeystroke: (step: Keystroke) => void;
    /** The caret walking out of the slot at either end. */
    readonly onArrow: (dir: -1 | 1) => void;
}): ReactElement {
    const input = useRef<HTMLInputElement>(null);
    const backdrop = useRef<HTMLSpanElement>(null);

    useLayoutEffect(() => {
        if (caret !== null && input.current !== null) {
            input.current.focus();
            input.current.setSelectionRange(caret.at, caret.at);
        }
    }, [caret]);
    useLayoutEffect(() => {
        if (backdrop.current !== null && input.current !== null) {
            backdrop.current.scrollLeft = input.current.scrollLeft;
        }
    });

    const onChange = (value: string, caretInSlot: number): void => {
        const text = at.before + at.open.slice(0, at.head?.consumed ?? 0) + value + at.after;
        onKeystroke({text, caret: slotStart(at) + caretInSlot});
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        const el = e.currentTarget;
        const collapsed = el.selectionStart === el.selectionEnd;
        if (e.key === "Backspace" && collapsed && el.selectionStart === 0) {
            const step = backspaceAtStart(at);
            if (step === null) return;
            e.preventDefault();
            onKeystroke(step);
            return;
        }
        if (e.key === "ArrowLeft" && collapsed && el.selectionStart === 0) {
            e.preventDefault();
            onArrow(-1);
            return;
        }
        if (e.key === "ArrowRight" && collapsed && el.selectionStart === el.value.length) {
            e.preventDefault();
            onArrow(1);
        }
    };

    const syncScroll = (): void => {
        if (backdrop.current !== null && input.current !== null) {
            backdrop.current.scrollLeft = input.current.scrollLeft;
        }
    };

    // One tree shape for both states: the cell comes and goes, the slot keeps its key and its element. The
    // hugging class makes a transformed chip size to its content; the plain tail fills the bar instead.
    return (
        <span className={at.head === null ? styles.tail : styles.openChip}>
            {at.head !== null && (
                <span key="cell" className={`${styles.headCell} ${at.head.negated ? styles.neg : ""}`}>
                    {at.head.negated ? "−" : ""}{headCase(at.head.word)}
                </span>
            )}
            <span key="slot" className={styles.editwrap}>
                <span ref={backdrop} className={styles.qhl} aria-hidden="true">
                    {highlight}
                </span>
                <input
                    ref={input}
                    className={`${styles.q} ${at.slot === "" ? "" : styles.hl}`}
                    type="text"
                    value={at.slot}
                    onChange={(e) => {
                        onChange(e.target.value, e.target.selectionStart ?? e.target.value.length);
                    }}
                    onKeyDown={onKeyDown}
                    onScroll={syncScroll}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={placeholder}
                />
            </span>
        </span>
    );
}
