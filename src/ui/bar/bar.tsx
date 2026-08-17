/**
 * @file The bar: settled text, then the open segment — eagerly transformed into a head cell and value slot the
 * moment its bind lands.
 *
 * Everything drawn here is a read of {@link plan} over the one query text; the component owns no state beyond
 * a pending caret. The slot is the bar's only input, carrying exactly the open segment's editable remainder; the
 * settled text is inert this increment and becomes chips in the next.
 */
import type {KeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement} from "react";
import {useLayoutEffect, useMemo, useRef} from "react";
import {classify} from "../../search/index";
import type {BarPlan} from "./plan";
import {backspaceAtStart, plan} from "./plan";
import styles from "./bar.module.css";

/** The backdrop colour class per run kind; a plain word paints nothing and inherits the text colour. */
const RUN_CLASS: Record<string, string | undefined> = {
    head: styles.runHead, op: styles.runOp, delim: styles.runOp, quote: styles.runOp, number: styles.runNumber,
};

/** Heads are capitalised everywhere: `Scale`, never `scale`. */
const headCase = (word: string): string => (word === "" ? word : word[0].toUpperCase() + word.slice(1));

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
    const input = useRef<HTMLInputElement>(null);
    const backdrop = useRef<HTMLSpanElement>(null);
    const caretTo = useRef<number | null>(null);

    const at: BarPlan = useMemo(() => plan(text), [text]);

    useLayoutEffect(() => {
        if (caretTo.current !== null && input.current !== null) {
            input.current.setSelectionRange(caretTo.current, caretTo.current);
            caretTo.current = null;
        }
        if (backdrop.current !== null && input.current !== null) {
            backdrop.current.scrollLeft = input.current.scrollLeft;
        }
    });

    /** Rewrites the text around the slot's own value — the slot edits only its slice of the text. */
    const onSlot = (value: string): void => {
        onText(at.settled + at.open.slice(0, at.head?.consumed ?? 0) + value);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        const el = e.currentTarget;
        if (e.key !== "Backspace" || el.selectionStart !== 0 || el.selectionEnd !== 0) return;
        const step = backspaceAtStart(at);
        if (step === null) return;
        e.preventDefault();
        caretTo.current = step.caret;
        onText(step.text);
    };

    /** The whole bar is the slot's click target — a press on its ground focuses without stealing the caret. */
    const onBarPress = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.target !== input.current) {
            e.preventDefault();
            input.current?.focus();
        }
    };

    const syncScroll = (): void => {
        if (backdrop.current !== null && input.current !== null) {
            backdrop.current.scrollLeft = input.current.scrollLeft;
        }
    };

    const slot = (
        <span className={styles.editwrap}>
            <span ref={backdrop} className={styles.qhl} aria-hidden="true">
                <Classed text={at.slot}/>
            </span>
            <input
                ref={input}
                className={`${styles.q} ${at.slot === "" ? "" : styles.hl}`}
                type="text"
                value={at.slot}
                onChange={(e) => {
                    onSlot(e.target.value);
                }}
                onKeyDown={onKeyDown}
                onScroll={syncScroll}
                placeholder={text === "" ? placeholder : undefined}
                autoComplete="off"
                spellCheck={false}
                aria-label={placeholder}
            />
        </span>
    );

    return (
        <div className={styles.qbar} onMouseDown={onBarPress}>
            {at.settled !== "" && (
                <span className={styles.settled}>
                    <Classed text={at.settled.trimEnd()}/>
                </span>
            )}
            {at.head === null ? slot : (
                <span className={styles.openChip}>
                    <span className={`${styles.headCell} ${at.head.negated ? styles.neg : ""}`}>
                        {at.head.negated ? "−" : ""}{headCase(at.head.word)}
                    </span>
                    {slot}
                </span>
            )}
        </div>
    );
}
