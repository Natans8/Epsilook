/**
 * @file The open segment — the EDITING form of a chip, one of the design's two visual modes.
 *
 * The committed chip is a different component with a different look, arriving with its own increment; this one
 * is the segment under the caret: a head cell once the bind lands, and the value slot — the bar's only input —
 * with the highlight backdrop under it.
 *
 * The input is UNCONTROLLED within one editing session, so the browser's own undo works natively inside the
 * chip — a controlled input is what kills it. The bar remounts this component (a new session key) at every
 * boundary that rewrites the slot from outside: opening, the bind gesture, commit, cancel, traversal. Plain
 * Ctrl+Z is therefore the platform's; it escalates to the bar's operation undo only when the slot is back at
 * the state this session started from — the beginning of the chip's stack undoes the chip.
 */
import type {KeyboardEvent, ReactElement, ReactNode} from "react";
import {useLayoutEffect, useRef} from "react";
import type {BarPlan, Keystroke} from "./plan";
import {backspaceAtStart, slotStart} from "./plan";
import styles from "./bar.module.css";

/** Heads are capitalised everywhere: `Scale`, never `scale`. */
const headCase = (word: string): string => (word === "" ? word : word[0].toUpperCase() + word.slice(1));

/** Where the caret starts this session, in slot coordinates. */
export interface CaretRequest {
    readonly at: number;
}

/**
 * The open segment. Remounted per session — the mount is what seeds the input and places the caret.
 */
export function OpenSegment({
                                at, mode, highlight, caret, placeholder, onKeystroke, onArrow, onCommit, onCancel,
                                onUndo, onRedo
                            }: {
    readonly at: BarPlan;
    /** Whether the slot fills the bar (the true tail) or hugs its content (a chip, a mid-bar word, a gap). */
    readonly mode: "fill" | "hug";
    /** The classed rendering of the slot text — the bar supplies its one highlighter. */
    readonly highlight: ReactNode;
    /** Where the caret starts this session. */
    readonly caret: CaretRequest | null;
    readonly placeholder?: string;
    /**
     * Every text mutation leaves as a keystroke: the new text and the caret as a text offset. `reset` marks the
     * mutations that rewrite the slot from outside the input; `held` is what the input shows, so the bar can
     * also reset wherever its derived slot no longer matches — a committing space moving the boundary, say.
     */
    readonly onKeystroke: (step: Keystroke, reset: boolean, held: string) => void;
    /** The caret walking out of the slot at either end. */
    readonly onArrow: (dir: -1 | 1) => void;
    /** Enter — commit the chip, simplified. */
    readonly onCommit: () => void;
    /** Escape — cancel back to what the segment held when it opened. */
    readonly onCancel: () => void;
    /** Operation-level undo — reached only from the session's own start state. */
    readonly onUndo: () => void;
    readonly onRedo: () => void;
}): ReactElement {
    const input = useRef<HTMLInputElement>(null);
    const backdrop = useRef<HTMLSpanElement>(null);
    // What the slot held when this session began — the boundary where Ctrl+Z stops being the platform's.
    const sessionStart = useRef(at.slot);

    useLayoutEffect(() => {
        const el = input.current;
        if (el === null) return;
        el.focus();
        const to = caret?.at ?? el.value.length;
        el.setSelectionRange(to, to);
        // Mount-only on purpose: this seeds the session; afterwards the caret is the browser's.
    }, []);
    useLayoutEffect(() => {
        if (backdrop.current !== null && input.current !== null) {
            backdrop.current.scrollLeft = input.current.scrollLeft;
        }
    });

    const onChange = (value: string, caretInSlot: number): void => {
        // The slot edits only its slice: head prefix and closing suffix are structure and survive verbatim.
        const text = at.before + at.open.slice(0, at.head?.consumed ?? 0) + value + at.suffix + at.after;
        onKeystroke({text, caret: slotStart(at) + caretInSlot}, false, value);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        const el = e.currentTarget;
        const collapsed = el.selectionStart === el.selectionEnd;
        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
            // The platform undoes inside the chip; the beginning of the chip's stack undoes the chip.
            if (el.value === sessionStart.current) {
                e.preventDefault();
                onUndo();
            }
            return;
        }
        if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
            if (el.value === sessionStart.current) {
                e.preventDefault();
                onRedo();
            }
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
        }
        if (e.key === "Backspace" && collapsed && el.selectionStart === 0) {
            const step = backspaceAtStart(at);
            if (step === null) return;
            e.preventDefault();
            onKeystroke(step, true, el.value);
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

    return (
        <span className={mode === "fill" ? styles.tail : styles.openChip}>
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
                    defaultValue={at.slot}
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
