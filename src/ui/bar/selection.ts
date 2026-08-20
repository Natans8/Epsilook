/**
 * @file The bar's own selection, and the presses that make one.
 *
 * A range of the query TEXT, kept as the two offsets the gesture moves: an anchor that stays put and a focus
 * that walks. Offsets rather than segments, because text selects by the character and the space between two
 * words is a character of the query like any other — `selectionOver` is what snaps the range whole over the
 * chips it touches, which are the only things in the bar that cannot be half-selected.
 *
 * Split out of the bar because it is orthogonal to the editing session: it reads the session's plan and calls
 * its rewrites, while the session's only knowledge of it is the one hand-off that clears it.
 */
import type {
    ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent,
} from "react";
import {useRef, useState} from "react";
import type {BarSelection} from "./plan";
import {removeSelection, replaceSelection, segmentAt, selectionOver, selectionStep, slotStart} from "./plan";
import type {Aim} from "./aim";
import {groundAim, offsetAtPoint} from "./aim";
import type {EditingSession} from "./session";

/** The bar's selection and every gesture that moves it. */
export interface BarSelectionState {
    /** The selection as a range of the query, snapped whole over the chips it touches, or null for none. */
    readonly sel: BarSelection | null;
    /** Drops it — what a fresh session and every settled rewrite do. */
    readonly clear: () => void;
    /** The selected text: the query those segments spell, which is what a copy puts on the clipboard. */
    readonly selectedText: () => string;
    /** Removes the selection as one operation, resting the caret where it stood. */
    readonly deleteSelection: () => void;
    /** Ctrl+A past the slot: the whole query, in the bar's own selection. */
    readonly onSelectAll: () => void;
    /** Extends past the slot's own edge — one character through text, one whole chip past a chip. */
    readonly onSelectPast: (dir: -1 | 1, anchorInSlot: number) => void;
    readonly onBarDown: (e: ReactMouseEvent<HTMLDivElement>) => void;
    readonly onBarMove: (e: ReactMouseEvent<HTMLDivElement>) => void;
    readonly onBarClick: (e: ReactMouseEvent<HTMLDivElement>) => void;
    /** Ends a drag, on the button coming up. */
    readonly onBarUp: () => void;
    /**
     * The selection's own keys, taken in CAPTURE so they never reach the input underneath: while a stretch of
     * the query is selected, Escape, Delete and the clipboard belong to the bar rather than to any one slot.
     */
    readonly onBarKeys: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
    /** Paste replaces the selection, exactly as typing over it does. */
    readonly onBarPaste: (e: ReactClipboardEvent<HTMLDivElement>) => void;
}

/**
 * The bar's selection.
 *
 * @param text The query text.
 * @param onText Where a rewrite goes.
 * @param session The editing session: every gesture here commits through it before it measures anything.
 * @returns The selection and its gestures.
 */
export function useBarSelection(
    text: string,
    onText: (next: string) => void,
    session: EditingSession,
): BarSelectionState {
    // The bar-wide selection, kept as the two OFFSETS the gesture moves: an anchor that stays put and a focus
    // that walks. Offsets, because text selects by the character and the space between two words is a
    // character of the query like any other; `selectionOver` is what snaps the range over the chips it
    // touches, which are the only things in the bar that cannot be half-selected.
    const [range, setRange] = useState<{ anchor: number; focus: number } | null>(null);
    // Where a drag began, while the button is down, and whether it has moved off that offset yet.
    const dragFrom = useRef<number | null>(null);
    const dragged = useRef(false);

    const sel: BarSelection | null = range === null ? null : selectionOver(text, range.anchor, range.focus);


    /**
     * Ctrl+A past the slot: the whole query selected, in the bar's own selection.
     *
     * Not a flattening — the query stays the chips it is, and the reader gets a selection they can copy, cut or
     * delete. Reading the raw text is a view they choose, not something a keystroke does to them.
     */
    const onSelectAll = (): void => {
        const step = session.commitOpen();
        if (step.text.trim() === "") {
            // Nothing to select — but the commit may just have evaporated a lone empty chip, and that
            // rewrite must still land or the undo stack holds a step the bar never showed.
            if (text !== "") session.openEnd("");
            return;
        }
        if (step.text !== text) onText(step.text);
        setRange({anchor: 0, focus: step.text.trimEnd().length});
    };


    /** The selected segments' own text — the query they spell, which is what a copy puts on the clipboard. */
    const selectedText = (): string => (sel === null ? "" : text.slice(sel.from, sel.to));

    /** Removes the selection as one operation, resting the caret where it stood. */
    const deleteSelection = (): void => {
        if (sel === null) return;
        session.pushUndo(text);
        const gone = removeSelection(text, sel);
        setRange(null);
        session.restAt(gone);
    };

    /**
     * Extends the selection past the slot's own edge — one character through text, one whole chip past a chip.
     *
     * With no selection yet the anchor is the caret's own offset, so the first press takes what the caret was
     * about to leave — including from the empty tail, which has no segment of its own to grow from.
     */
    const onSelectPast = (dir: -1 | 1, anchorInSlot: number): void => {
        const step = session.commitOpen();
        if (step.text !== text) onText(step.text);
        const held = Math.min(slotStart(session.at) + anchorInSlot, step.text.length);
        const anchor = range?.anchor ?? held;
        const edge = Math.min(slotStart(session.at) + (dir === -1 ? 0 : session.at.slot.length), step.text.length);
        setRange({anchor, focus: selectionStep(step.text, range?.focus ?? edge, dir)});
    };


    /**
     * Where a press landed in the query.
     *
     * A press ON the bar rather than on any of its children is read by line, because the platform's own caret
     * hit test answers with the nearest text wherever it is.
     */
    const aimOf = (e: ReactMouseEvent<HTMLDivElement>): Aim => {
        const ground = e.target === e.currentTarget;
        const inside = ground ? null : offsetAtPoint(e.currentTarget, e.clientX, e.clientY);
        return inside ?? {at: groundAim(e.currentTarget, e.clientX, e.clientY, text), exact: false};
    };

    /**
     * A press anchors a selection and settles whatever was open, so every offset the drag goes on to measure
     * is one the query will still have when the button comes up.
     *
     * Taken in capture, before a chip sees its own press: which of the two a press was — placing a caret or
     * beginning a selection — is only known once the pointer has moved, so the press itself does neither.
     */
    const onBarDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        // The control surface is part of this editing session, not a place in the query: a press on it settles
        // nothing, anchors nothing, and the row itself keeps the focus in the slot.
        if (e.target instanceof Element && e.target.closest("[data-surface]") !== null) {
            dragFrom.current = null;
            return;
        }
        // The editing form owns its own presses — its caret, its native selection, and a head that keeps the
        // session alive — so nothing here is prevented while the press is inside it. The anchor is still
        // recorded: a drag that LEAVES the slot is a bar selection, and it must know where it began.
        if (e.target instanceof Element && e.target.closest("[data-open]") !== null) {
            dragFrom.current = slotStart(session.at) + session.at.slot.length;
        } else {
            e.preventDefault();
            const {step, shifted} = session.pressCommit(aimOf(e).at);
            if (step.text !== text) onText(step.text);
            dragFrom.current = shifted;
        }
        dragged.current = false;
        setRange(null);
    };

    const onBarMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
        const from = dragFrom.current;
        if (from === null || e.buttons !== 1) return;
        // A drag still inside the slot is the platform's own, character by character; only one that has left
        // it becomes the bar's.
        if (!dragged.current && e.target instanceof Element && e.target.closest("[data-open]") !== null) return;
        const aim = aimOf(e);
        // Reaching a chip takes it whole from its first pixel: the far edge is the one the gesture means.
        const to = aim.span === undefined ? aim.at
            : aim.span.start >= from ? aim.span.end : aim.span.start;
        if (to === from && !dragged.current) return;
        e.preventDefault();
        dragged.current = true;
        setRange({anchor: from, focus: to});
        // While a selection stands the keys are the bar's, so it takes the focus the press denied it.
        if (!e.currentTarget.contains(document.activeElement)) e.currentTarget.focus({preventScroll: true});
    };

    /**
     * A press that did not drag places the caret where it aimed: inside text at that character, at a gap
     * between chips, or at the query's end when it landed past everything.
     *
     * On the click rather than the press, because a press that turns into a drag must not open anything —
     * and a chip's own click stops before this, so pressing a chip still opens the chip.
     */
    const onBarClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
        if (dragged.current) {
            dragged.current = false;
            return;
        }
        if (e.target instanceof Element && e.target.closest("[data-open],[data-surface],button") !== null) return;
        const {at: aim, exact} = aimOf(e);
        const seg = segmentAt(text, aim);
        // Past everything, the ground means "after the query": a fresh tail. Only plain text keeps the caret
        // at its own end — landing INSIDE the last chip from the empty ground was the annoying answer.
        if (aim >= text.length) {
            if (seg.plain) session.openEnd(text);
            else session.openTail(text);
        }
        // Past a segment's own end sits the separator: the caret rests in the gap before what follows it.
        else if (aim >= seg.end) session.openGap(text, aim + 1);
            // Anything drawing its own characters — text, an erred clause, the glue between two of them — takes
        // the caret at the character pressed. A chip's edge is not a character, so it takes the gap.
        else if (exact) session.openSegment(text, seg.start, aim - seg.start);
        else session.openGap(text, seg.start);
    };


    /**
     * The selection's own keys, taken in CAPTURE so they never reach the input underneath: while a stretch of
     * the query is selected, Escape, Delete and the clipboard belong to the bar rather than to any one slot.
     *
     * The bar also holds the focus when a press made a selection and no slot is open, so Ctrl+A answers there
     * too — the slot's own Ctrl+A takes the slot's contents first, and only the bar can mean the whole query.
     */
    const onBarKeys = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
        const key = e.key.toLowerCase();
        if (sel === null) {
            if (e.ctrlKey && key === "a" && !(e.target instanceof HTMLInputElement)) {
                e.preventDefault();
                onSelectAll();
            }
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            // The caret goes back where the selection began: dropping a selection and leaving the bar with no
            // caret at all is a dead end, and the next keystroke would have nowhere to land.
            setRange(null);
            session.openGap(text, sel.from);
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
            onSelectAll();
            return;
        }
        if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            e.stopPropagation();
            // A selection already stands, so its own anchor is what holds; the slot's is not consulted.
            onSelectPast(e.key === "ArrowLeft" ? -1 : 1, 0);
            return;
        }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            // A plain arrow collapses the selection to the side it points at, as it does for selected text.
            e.preventDefault();
            e.stopPropagation();
            setRange(null);
            if (e.key === "ArrowLeft") session.openGap(text, sel.from);
            else session.restAfter(text, sel.to);
            return;
        }
        // A printable character replaces the selection, exactly as typing over selected text does. One
        // operation: the removal and the character land together, so one undo takes both back.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            session.pushUndo(text);
            const gone = removeSelection(text, sel);
            setRange(null);
            // The character lands where the selection stood, keeping the separator that a following segment
            // needs — and growing none at the query's end, where the word is still being typed.
            const after = gone.text.slice(gone.caret);
            const glue = after.trim() === "" ? "" : " ";
            const typed = gone.text.slice(0, gone.caret) + e.key + glue + after;
            session.openSegment(typed, gone.caret + e.key.length, e.key.length);
        }
    };

    /**
     * Paste replaces the selection, exactly as typing over it does: the removal and the pasted text land as
     * ONE operation, so one undo takes both back. The result settles rather than opening a slot — a pasted
     * `model:fire` arrives as the chip it spells — with the caret resting after it, and newlines become the
     * separator they stand for, as the plain view reads them.
     */
    const onBarPaste = (e: ReactClipboardEvent<HTMLDivElement>): void => {
        if (sel === null) return;
        e.preventDefault();
        e.stopPropagation();
        session.pushUndo(text);
        const step = replaceSelection(text, sel, e.clipboardData.getData("text/plain"));
        setRange(null);
        if (step.caret === sel.from) {
            // Nothing pasteable arrived, so what lands is the removal alone.
            session.restAt(step);
            return;
        }
        session.restAfter(step.text, step.caret - 1);
    };

    /** Ends a drag: the button is up, so no further move extends anything. */
    const onBarUp = (): void => {
        dragFrom.current = null;
    };

    /** Drops the selection — what a fresh session and every settled rewrite do. */
    const clear = (): void => {
        setRange(null);
    };

    return {
        sel, clear, selectedText, deleteSelection, onSelectAll, onSelectPast,
        onBarDown, onBarMove, onBarUp, onBarClick, onBarKeys, onBarPaste,
    };
}
