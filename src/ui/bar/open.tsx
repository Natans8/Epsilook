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
import {GRAMMAR} from "../../search/index";
import {headCase} from "./chip";
import type {BarPlan, Keystroke} from "./plan";
import {backspaceAtStart, deleteAtEnd, slotStart} from "./plan";
import styles from "./bar.module.css";

/** Each opening delimiter and the closer it spawns — the enclosures the slot pairs like an IDE. */
const PAIRS: Record<string, string | undefined> = {
    [GRAMMAR.phrase]: GRAMMAR.phrase,
    [GRAMMAR.scope.open]: GRAMMAR.scope.close,
    [GRAMMAR.group.open]: GRAMMAR.group.close,
};

/** The closing halves — what a keystroke steps over instead of doubling. */
const CLOSERS = new Set<string>([GRAMMAR.phrase, GRAMMAR.scope.close, GRAMMAR.group.close]);

/** Where the caret starts this session, in slot coordinates; an anchor makes it a selection. */
export interface CaretRequest {
    readonly at: number;
    readonly anchor?: number;
}

/**
 * The open segment. Remounted per session — the mount is what seeds the input and places the caret.
 */
export function OpenSegment({
                                at, mode, hidden, seize, highlight, caret, placeholder, onKeystroke, onArrow,
                                onEdge, onCommit, onCancel, onUndo, onRedo, onSelectAll, onSelectSegment,
                                onWake, onSettle
                            }: {
    readonly at: BarPlan;
    /** How the slot sits: filling the bar (the true tail), hugging content (chip, mid-bar word), or the
     * zero-displacement caret rest between chips. */
    readonly mode: "fill" | "hug" | "gap";
    /**
     * Whether the bar is at rest: the segment renders committed elsewhere, and this input hides — still
     * mounted, still in the tab order, so focus can come back to the remembered place.
     */
    readonly hidden: boolean;
    /** Whether this session's mount takes the focus. False for the mount a page load creates at rest. */
    readonly seize: boolean;
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
    /** Home and End: the jump to the bar's own ends. */
    readonly onEdge: (side: -1 | 1) => void;
    /** Enter — commit the chip, simplified. */
    readonly onCommit: () => void;
    /** Escape — cancel back to what the segment held when it opened. */
    readonly onCancel: () => void;
    /** Operation-level undo — reached only from the session's own start state. */
    readonly onUndo: () => void;
    readonly onRedo: () => void;
    /** Ctrl+A past the slot: every chip joins the bar's own selection. */
    readonly onSelectAll: () => void;
    /** A Shift+arrow at the slot's edge: the selection leaves the slot and takes whole segments. */
    readonly onSelectSegment: (dir: -1 | 1) => void;
    /** Focus arriving at the slot — the bar leaves its rest state. */
    readonly onWake: () => void;
    /** Focus leaving the bar entirely — the segment settles into its committed spelling. */
    readonly onSettle: () => void;
}): ReactElement {
    const input = useRef<HTMLInputElement>(null);
    const backdrop = useRef<HTMLSpanElement>(null);
    // What the slot held when this session began — the boundary where Ctrl+Z stops being the platform's.
    const sessionStart = useRef(at.slot);

    useLayoutEffect(() => {
        const el = input.current;
        if (el === null || !seize) return;
        el.focus();
        const to = caret?.at ?? el.value.length;
        el.setSelectionRange(caret?.anchor ?? to, to);
        // Mount-only on purpose: this seeds the session; afterwards the caret is the browser's.
    }, []);
    useLayoutEffect(() => {
        const el = input.current;
        if (el === null) return;
        if (backdrop.current !== null) backdrop.current.scrollLeft = el.scrollLeft;
        // A settle can tidy the text under an UNFOCUSED slot (a blur commit trimming a multi-term scope): an
        // input the user is not in follows the plan; a focused one is the session's own truth.
        if (document.activeElement !== el && el.value !== at.slot) el.value = at.slot;
    });

    const onChange = (value: string, caretInSlot: number): void => {
        // The slot edits only its slice: head prefix and closing suffix are structure and survive verbatim.
        const text = at.before + at.open.slice(0, at.head?.consumed ?? 0) + value + at.suffix + at.after;
        onKeystroke({text, caret: slotStart(at) + caretInSlot}, false, value);
    };

    /**
     * A delimiter pairing lands as an OPERATION through the ordinary rewrite pipeline: its own session, its
     * own undo step — one Ctrl+Z takes the whole pairing back. In a gap the insertion brings the separator
     * that keeps the following segment a segment, as any gap insertion does.
     */
    const onPair = (value: string, caretInSlot: number, anchorInSlot?: number): void => {
        const glue = mode === "gap" ? " " : "";
        const text = at.before + at.open.slice(0, at.head?.consumed ?? 0) + value + at.suffix + glue + at.after;
        const base = slotStart(at);
        onKeystroke({
            text,
            caret: base + caretInSlot,
            anchor: anchorInSlot === undefined ? undefined : base + anchorInSlot,
            operation: true,
        }, true, value);
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
        if (e.ctrlKey && e.key.toLowerCase() === "a") {
            // Inside a chip the first press selects the chip's own contents; from a full selection it escalates
            // to the whole query. Plain text has no interior to claim — one press is the whole query.
            const fully = el.selectionStart === 0 && el.selectionEnd === el.value.length;
            if (at.head === null || fully) {
                e.preventDefault();
                onSelectAll();
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
        const a = el.selectionStart ?? 0;
        const b = el.selectionEnd ?? a;
        // The delimiters pair like an IDE's: typed over a selection the pair ENCLOSES it, the selection
        // surviving inside; typed alone the closer spawns with the caret in the middle; a closer typed
        // against its own next character steps over instead of doubling; and the closing brace at a scoped
        // slot's end steps over the chip's consumed closer — out of the chip.
        const typed = !e.metaKey && e.ctrlKey === e.altKey ? e.key : "";
        const close = PAIRS[typed];
        if (close !== undefined && !collapsed) {
            e.preventDefault();
            onPair(el.value.slice(0, a) + typed + el.value.slice(a, b) + close + el.value.slice(b),
                b + 1, a + 1);
            return;
        }
        if (collapsed && typed !== "" && CLOSERS.has(typed) && el.value[a] === typed) {
            e.preventDefault();
            el.setSelectionRange(a + 1, a + 1);
            return;
        }
        if (collapsed && typed === GRAMMAR.scope.close && a === el.value.length && at.suffix !== "") {
            e.preventDefault();
            onArrow(1);
            return;
        }
        if (close !== undefined && collapsed) {
            e.preventDefault();
            onPair(el.value.slice(0, a) + typed + close + el.value.slice(a), a + 1);
            return;
        }
        if (e.key === "Backspace" && collapsed && a === 0) {
            const step = backspaceAtStart(at);
            if (step === null) return;
            e.preventDefault();
            onKeystroke(step, true, el.value);
            return;
        }
        if (e.key === "Backspace" && collapsed && a > 0 && PAIRS[el.value[a - 1]] === el.value[a]) {
            // Inside an empty pair the Backspace takes both halves — the other side of the spawn.
            e.preventDefault();
            onPair(el.value.slice(0, a - 1) + el.value.slice(a + 1), a - 1);
            return;
        }
        if (e.key === "Delete" && collapsed && a === el.value.length) {
            const step = deleteAtEnd(at);
            if (step === null) return;
            e.preventDefault();
            onKeystroke(step, true, el.value);
            return;
        }
        // A held Shift means selection. Inside the slot that is the platform's own, character by character;
        // at the slot's edge there is nothing left to select here, so the bar takes over by whole segments —
        // the same escalation the caret itself makes when it walks out.
        if (e.shiftKey) {
            const atEdge = collapsed && ((e.key === "ArrowLeft" && a === 0)
                || (e.key === "ArrowRight" && a === el.value.length));
            if (atEdge) {
                e.preventDefault();
                onSelectSegment(e.key === "ArrowLeft" ? -1 : 1);
            }
            return;
        }
        if (e.key === "ArrowLeft" && collapsed && a === 0) {
            e.preventDefault();
            onArrow(-1);
            return;
        }
        if (e.key === "ArrowRight" && collapsed && a === el.value.length) {
            e.preventDefault();
            onArrow(1);
            return;
        }
        if (e.key === "Home") {
            e.preventDefault();
            onEdge(-1);
            return;
        }
        if (e.key === "End") {
            e.preventDefault();
            onEdge(1);
        }
    };

    const syncScroll = (): void => {
        if (backdrop.current !== null && input.current !== null) {
            backdrop.current.scrollLeft = input.current.scrollLeft;
        }
    };

    // Layout apart from chrome: hug or fill is geometry; the ring is the head's alone — a bare word or a gap
    // is text with a caret, because freeform terms are text by ruling.
    const wrap = mode === "fill" ? styles.tail
        : mode === "gap" ? `${styles.hug} ${styles.gapRest}`
            : at.head === null ? styles.hug : `${styles.hug} ${styles.openChip}`;
    return (
        <span className={hidden ? `${wrap} ${styles.hiddenOpen}` : wrap}>
            {at.head !== null && (
                <span
                    key="cell"
                    className={`${styles.headCell} ${at.head.negated ? styles.neg : ""}`}
                    onMouseDown={(e) => {
                        // The head is the chip's own chrome: pressing it keeps the session alive and puts the
                        // caret at the value's start — never a blur, never a settle.
                        e.preventDefault();
                        input.current?.focus();
                        input.current?.setSelectionRange(0, 0);
                    }}
                >
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
                    onFocus={onWake}
                    onBlur={onSettle}
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
