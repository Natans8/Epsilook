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
import {useTranslation} from "react-i18next";
import {GRAMMAR} from "../../search/index";
import {headCase} from "./chip";
import type {BarPlan, Keystroke} from "./plan";
import {backspaceAtStart, deleteAtEnd, pairDelimiter, slotStart, writeSlot} from "./plan";
import styles from "./bar.module.css";

/** Where the caret starts this session, in slot coordinates; an anchor makes it a selection. */
export interface CaretRequest {
    readonly at: number;
    readonly anchor?: number;
}

/**
 * The control surface as the slot sees it: what is on offer, and the four things a keyboard can do about it.
 *
 * The slot owns the keys because the caret never leaves it — a combobox steers its list from the field — so the
 * surface's own gestures have to be answered here, before the bar's traversal claims the same keys.
 */
export interface Assist {
    /** How many offers stand, whether or not the panel is drawn — what the arrows have to steer. */
    readonly count: number;
    /** Whether the panel is drawn. Escape puts it away without touching the offers behind it. */
    readonly open: boolean;
    /** The lit offer's index, or -1 when the reader has lit none. */
    readonly lit: number;
    /** The completion drawn dim after the caret, or empty. */
    readonly ghost: string;
    /** The panel's element id, which the field names in `aria-controls`. */
    readonly listId: string;
    /** The lit option's element id, which the field points at while the focus stays put. */
    readonly activeId?: string;
    /** Walks the light through the offers, wrapping at either end. */
    readonly move: (dir: -1 | 1) => void;
    /** Applies the lit offer. */
    readonly pick: () => void;
    /** Dismisses the surface until what is on offer changes. */
    readonly close: () => void;
    /** Takes the ghost into the slot. */
    readonly accept: () => void;
}

/**
 * The open segment. Remounted per session — the mount is what seeds the input and places the caret.
 */
export function OpenSegment({
                                at, mode, hidden, seize, highlight, caret, placeholder, label, assist, onFlip, onKeystroke,
                                onArrow, onEdge, onCommit, onCancel, onUndo, onRedo, onSelectAll, onSelectPast,
                                onCaret, onWake, onSettle
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
    /** The input's accessible name, which stands whether or not a placeholder is showing. */
    readonly label: string;
    /** The control surface, and what the keyboard may do with it. */
    readonly assist: Assist;
    /** Flips this segment's exclusion in place, without ending the editing session. */
    readonly onFlip: () => void;
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
    /**
     * A Shift+arrow whose moving end has reached the slot's edge: the selection leaves the slot and becomes
     * the bar's own, anchored where the slot's own selection was anchored.
     */
    readonly onSelectPast: (dir: -1 | 1, anchorInSlot: number) => void;
    /**
     * Where the caret now sits inside the slot.
     *
     * What the surface can offer depends on it — a caret before a term's bind is choosing a property, past it a
     * value — and the caret belongs to the input, which the bar deliberately does not control. So it is reported
     * from every gesture that can move it rather than derived, which would be a second copy of the browser's own
     * answer and would drift from it.
     */
    readonly onCaret: (at: number) => void;
    /** Focus arriving at the slot — the bar leaves its rest state. */
    readonly onWake: () => void;
    /** Focus leaving the bar entirely — the segment settles into its committed spelling. */
    readonly onSettle: () => void;
}): ReactElement {
    const {t} = useTranslation();
    const input = useRef<HTMLInputElement>(null);
    const backdrop = useRef<HTMLSpanElement>(null);
    // What the slot held when this session began — the boundary where Ctrl+Z stops being the platform's.
    const sessionStart = useRef(at.slot);

    useLayoutEffect(() => {
        const el = input.current;
        if (el === null) return;
        const to = caret?.at ?? el.value.length;
        if (seize) {
            el.focus();
            el.setSelectionRange(caret?.anchor ?? to, to);
        }
        onCaret(to);
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
        onCaret(caretInSlot);
        onKeystroke({text: writeSlot(at, value), caret: slotStart(at) + caretInSlot}, false, value);
    };

    /**
     * A delimiter pairing lands as an OPERATION through the ordinary rewrite pipeline: its own session, its
     * own undo step — one Ctrl+Z takes the whole pairing back. In a gap the insertion brings the separator
     * that keeps the following segment a segment, as any gap insertion does.
     */
    const onPair = (value: string, caretInSlot: number, anchorInSlot?: number): void => {
        const text = writeSlot(at, value, mode === "gap" ? " " : "");
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
        // The surface's own keys come first: while offers stand the arrows steer them, Enter takes what is lit,
        // and Escape puts the panel away before it means anything to the segment underneath. The arrows answer
        // even to a panel Escape has closed, which is the one keystroke that brings it back.
        if (assist.count > 0) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                assist.move(e.key === "ArrowDown" ? 1 : -1);
                return;
            }
            if (e.key === "Enter" && assist.lit >= 0) {
                e.preventDefault();
                assist.pick();
                return;
            }
            if (e.key === "Escape" && assist.open) {
                e.preventDefault();
                assist.close();
                return;
            }
        }
        // The right arrow takes the ghost, which is where it sits: at the very end of the slot, so the arrow
        // had nothing left to walk past anyway. Tab takes it too, and takes a lit offer where the reader has
        // steered to one — a Tab that walked out of the bar mid-choice would be the surprising answer.
        const bare = !e.shiftKey && !e.ctrlKey && !e.altKey;
        const takes = e.key === "Tab" ? assist.ghost !== "" || assist.lit >= 0
            : e.key === "ArrowRight" && assist.ghost !== "" && collapsed
            && (el.selectionStart ?? 0) === el.value.length;
        if (takes && bare) {
            e.preventDefault();
            assist.accept();
            return;
        }
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
        // The chip's own closer walks OUT of it: at a scoped slot's end the brace the chip consumed is already
        // there, so typing it steps over the chip rather than over a character.
        if (collapsed && typed === GRAMMAR.scope.close && a === el.value.length && at.suffix !== "") {
            e.preventDefault();
            onArrow(1);
            return;
        }
        if (e.key === "Backspace" && collapsed && a === 0) {
            const step = backspaceAtStart(at);
            if (step === null) return;
            e.preventDefault();
            onKeystroke(step, true, el.value);
            return;
        }
        // Every other pairing is the shared rule, delivered as one undoable operation.
        const paired = pairDelimiter(el.value, a, b, typed === "" ? e.key : typed);
        if (paired !== null) {
            e.preventDefault();
            if (paired.value === el.value) el.setSelectionRange(paired.caret, paired.caret);
            else onPair(paired.value, paired.caret, paired.anchor);
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
        // once the moving end has nothing left to take here, the bar takes over — by the character through
        // text and by the whole chip past a chip, the same escalation the caret makes when it walks. The
        // anchor goes with it, so a selection that grew inside the slot keeps everything it had.
        if (e.shiftKey) {
            const back = el.selectionDirection === "backward";
            const anchor = collapsed ? a : back ? b : a;
            const moving = collapsed ? a : back ? a : b;
            const atEdge = (e.key === "ArrowLeft" && moving === 0 && (collapsed || back))
                || (e.key === "ArrowRight" && moving === el.value.length && (collapsed || !back));
            if (atEdge) {
                e.preventDefault();
                onSelectPast(e.key === "ArrowLeft" ? -1 : 1, anchor);
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
        // Stamped as the open position: the bar's own press handling steps around this subtree, because the
        // editing form owns its presses — the head keeps the session, the slot keeps its native caret.
        <span className={hidden ? `${wrap} ${styles.hiddenOpen}` : wrap} data-open="">
            {at.head !== null && (
                <span
                    key="cell"
                    className={`${styles.headCell} ${at.head.negated ? styles.neg : ""}`}
                    onMouseDown={(e) => {
                        // The head means the same thing in both forms: it is the exclusion toggle, as it is on
                        // a settled chip and as the field label was in 1.0. Pressing it keeps the session alive
                        // — never a blur, never a settle — and Home is still how the caret reaches the start.
                        e.preventDefault();
                        input.current?.focus();
                        onFlip();
                    }}
                    title={t(at.head.negated ? "bar.include" : "bar.exclude")}
                >
                    {at.head.negated ? "−" : ""}{headCase(at.head.word)}
                </span>
            )}
            <span key="slot" className={styles.editwrap}>
                <span ref={backdrop} className={styles.qhl} aria-hidden="true">
                    {highlight}
                    {/* The ghost is APPENDED, never inserted: it lives past the last character the field holds,
                        so it can shift nothing the caret has to line up with. */}
                    {assist.ghost !== "" && <span className={styles.ghost}>{assist.ghost}</span>}
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
                    onKeyUp={(e) => {
                        onCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                    }}
                    onMouseUp={(e) => {
                        onCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                    }}
                    onFocus={(e) => {
                        onCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
                        onWake();
                    }}
                    onBlur={onSettle}
                    onScroll={syncScroll}
                    placeholder={placeholder}
                    autoComplete="off"
                    spellCheck={false}
                    // Always named: the placeholder only exists on an empty bar, and the input is the bar's
                    // one control whatever it happens to be holding.
                    aria-label={label}
                    // The combobox contract: the field keeps the focus and points at the option it has lit, so
                    // a screen reader follows the list without the caret ever leaving the query.
                    role="combobox"
                    aria-expanded={assist.open}
                    aria-controls={assist.open ? assist.listId : undefined}
                    aria-activedescendant={assist.activeId}
                    aria-autocomplete="both"
                />
            </span>
        </span>
    );
}
