/**
 * @file The bar's editing model: the query text as the source of truth, with one open region being edited.
 *
 * The bar is one continuous text. At any moment at most one region of it is OPEN — raw text under the caret — and
 * everything outside that region is committed, rendered as chips from the parse. The state is therefore three
 * strings: what sits before the open region, the open region itself, and what sits after. Every gesture is a
 * transition over those pieces, and the full text they concatenate to is what gets parsed, run and put in the URL.
 *
 * The concatenation is verbatim — no transition ever inserts characters the reader did not ask for, except the one
 * separator space `openEnd` and a committing `commit(true)` append so the next term does not glue onto the last.
 * That is what keeps parse spans valid across transitions: a span taken over the text before a transition still
 * indexes the same characters after it.
 *
 * Undo is OPERATION-level by ruling: deleting a chip, committing an edit, applying a fix or a simplification each
 * push one snapshot, so Ctrl+Z steps whole operations back — a killed chip returns whole, never letter by letter.
 * Keystrokes inside the open region are not operations; they ride on the current snapshot.
 */
import {useCallback, useMemo, useState} from "react";

/** The three pieces of the bar's text. Concatenated verbatim they are the query. */
export interface Pieces {
    readonly before: string;
    readonly edit: string;
    readonly after: string;
}

/** A chip marked by Backspace at a boundary: the next Backspace deletes it whole. */
export interface Armed {
    readonly start: number;
    readonly end: number;
}

/** The full text the pieces carry, verbatim. */
const textOf = (pieces: Pieces): string => pieces.before + pieces.edit + pieces.after;

/** Removes the span from the text along with one adjacent separator space, so a deletion never leaves a double gap. */
function cutSpan(text: string, start: number, end: number): string {
    let from = start;
    let to = end;
    if (text[to] === " ") to += 1;
    else if (from > 0 && text[from - 1] === " ") from -= 1;
    return text.slice(0, from) + text.slice(to);
}

/** What the query state exposes to the bar. */
export interface QueryState {
    readonly pieces: Pieces;
    /** The whole query text, exactly `before + edit + after`. */
    readonly text: string;
    /** Whether an open region exists — an empty open region at the end still counts. */
    readonly editing: boolean;
    readonly armed: Armed | null;

    /** Replaces the open region's text as the reader types. Not an undo operation. */
    readonly type: (edit: string) => void;
    /** Opens the span as the edit region, committing whatever was open. */
    readonly openSpan: (start: number, end: number) => void;
    /** Opens an empty region at the end of the text, committing whatever was open. */
    readonly openEnd: () => void;
    /** Commits the open region; `openNew` reopens an empty region right after it. */
    readonly commit: (openNew?: boolean) => void;
    /** Commits and closes the open region without reopening. */
    readonly close: () => void;
    /** Deletes a committed span, as one undoable operation. */
    readonly deleteSpan: (start: number, end: number) => void;
    /** Replaces the whole query, as one undoable operation — fixes, simplify, history. */
    readonly replaceAll: (text: string) => void;
    /** Arms a chip for deletion, or disarms with null. */
    readonly arm: (span: Armed | null) => void;
    readonly undo: () => void;
    readonly redo: () => void;
}

/** The full internal state, snapshots included. */
interface Held {
    readonly pieces: Pieces;
    readonly editing: boolean;
    readonly armed: Armed | null;
    readonly undos: readonly string[];
    readonly redos: readonly string[];
}

/**
 * The query editing state, as one hook the bar owns.
 *
 * @param initial The query text to start from — what the URL carried.
 * @returns The state and its transitions.
 */
export function useQueryState(initial: string): QueryState {
    const [held, setHeld] = useState<Held>({
        pieces: {before: initial, edit: "", after: ""},
        editing: false, armed: null, undos: [], redos: [],
    });

    /** The next state with one undo snapshot pushed — the boundary of one operation. */
    const pushed = (from: Held, pieces: Pieces, editing: boolean): Held => ({
        pieces, editing, armed: null,
        undos: [...from.undos, textOf(from.pieces)].slice(-50), redos: [],
    });

    const type = useCallback((edit: string) => {
        setHeld((from) => ({...from, pieces: {...from.pieces, edit}, armed: null}));
    }, []);

    const openSpan = useCallback((start: number, end: number) => {
        setHeld((from) => {
            const text = textOf(from.pieces);
            return {
                ...from, armed: null, editing: true,
                pieces: {before: text.slice(0, start), edit: text.slice(start, end), after: text.slice(end)},
            };
        });
    }, []);

    const openEnd = useCallback(() => {
        setHeld((from) => {
            const text = textOf(from.pieces);
            return {
                ...from, armed: null, editing: true,
                pieces: {before: text === "" || text.endsWith(" ") ? text : `${text} `, edit: "", after: ""},
            };
        });
    }, []);

    const commit = useCallback((openNew = false) => {
        setHeld((from) => {
            let committed = from.pieces.before + from.pieces.edit;
            if (openNew && committed !== "" && !committed.endsWith(" ")) committed += " ";
            const pieces: Pieces = {before: committed, edit: "", after: from.pieces.after};
            // An empty commit moves nothing, so it stays off the undo stack — Ctrl+Z after it should still
            // step back the previous real operation, not a no-op.
            if (from.pieces.edit.trim() === "") return {...from, pieces, editing: openNew, armed: null};
            return pushed(from, pieces, openNew);
        });
    }, []);

    const close = useCallback(() => { commit(false); }, [commit]);

    const deleteSpan = useCallback((start: number, end: number) => {
        setHeld((from) => {
            const cut = cutSpan(textOf(from.pieces), start, end);
            return pushed(from, {before: cut, edit: "", after: ""}, false);
        });
    }, []);

    const replaceAll = useCallback((text: string) => {
        setHeld((from) => pushed(from, {before: text, edit: "", after: ""}, false));
    }, []);

    const arm = useCallback((armed: Armed | null) => {
        setHeld((from) => (from.armed === armed ? from : {...from, armed}));
    }, []);

    const undo = useCallback(() => {
        setHeld((from) => {
            const last = from.undos.at(-1);
            if (last === undefined) return from;
            return {
                pieces: {before: last, edit: "", after: ""}, editing: false, armed: null,
                undos: from.undos.slice(0, -1), redos: [...from.redos, textOf(from.pieces)],
            };
        });
    }, []);

    const redo = useCallback(() => {
        setHeld((from) => {
            const next = from.redos.at(-1);
            if (next === undefined) return from;
            return {
                pieces: {before: next, edit: "", after: ""}, editing: false, armed: null,
                undos: [...from.undos, textOf(from.pieces)], redos: from.redos.slice(0, -1),
            };
        });
    }, []);

    const text = textOf(held.pieces);
    return useMemo(() => ({
        pieces: held.pieces, text, editing: held.editing, armed: held.armed,
        type, openSpan, openEnd, commit, close, deleteSpan, replaceAll, arm, undo, redo,
    }), [held, text, type, openSpan, openEnd, commit, close, deleteSpan, replaceAll, arm, undo, redo]);
}
