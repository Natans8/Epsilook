/**
 * @file The open segment: raw text under the caret, eagerly transformed into a head cell plus a value slot.
 *
 * The moment a bind lands (`scale:`), the head leaves the text and becomes structure — a cell in the editor — while
 * the slot keeps the rest. The text underneath is unchanged: the editor's value is always the verbatim edit text,
 * and the cell is how part of it displays. Backspace at the slot's start dissolves the head back into raw text, so
 * the head word itself stays editable.
 *
 * The highlight is a mirror: a classed copy of the slot text sits under an input whose own text is transparent, so
 * the caret and selection stay native while every token shows its role. The one ghost candidate renders dim at the
 * end of the mirror; Tab or the right arrow accepts it.
 */
import type {KeyboardEvent, ReactElement} from "react";
import {useEffect, useLayoutEffect, useRef} from "react";
import {GRAMMAR} from "../../search/index";
import {balanced, openHead, tokenize} from "./highlight";
import {headCase} from "./segments";
import styles from "./editor.module.css";

/** The mirror's class per token kind. */
const TOKEN_CLASS: Record<string, string> = {
    head: styles.tHead, delim: styles.tDelim, op: styles.tOp,
    number: styles.tNumber, word: styles.tWord, phrase: styles.tPhrase, space: styles.tSpace,
};

/** The pairs that spawn together while typing, IDE-style. Structural braces included: they transform at commit. */
const PAIRS: Record<string, string> = {
    [GRAMMAR.phrase]: GRAMMAR.phrase,
    [GRAMMAR.group.open]: GRAMMAR.group.close,
    [GRAMMAR.scope.open]: GRAMMAR.scope.close,
};
const CLOSERS = new Set(Object.values(PAIRS));

/** What the editor tells the bar. */
export interface EditorEvents {
    readonly onChange: (value: string) => void;
    /** Enter or a committing space; `openNew` says a fresh slot should follow. */
    readonly onCommit: (openNew: boolean) => void;
    /** Escape — provisionally one press exits editing. */
    readonly onClose: () => void;
    /** The caret left the segment at its start or end. */
    readonly onLeaveLeft: () => void;
    readonly onLeaveRight: () => void;
    /** Backspace at the very start — the bar arms the previous chip. */
    readonly onBackspaceAtStart: () => void;
    /** The down arrow — the bar moves focus into the control surface. */
    readonly onArrowDown: () => void;
    readonly onUndo: () => void;
    readonly onRedo: () => void;
}

/**
 * The open segment.
 *
 * @returns The editor, focused on mount.
 */
export function Editor({value, ghost, events, placeholder}: {
    /** The verbatim edit text, head included. */
    readonly value: string;
    /** The one inline completion candidate — the text that Tab would append. */
    readonly ghost: string;
    readonly events: EditorEvents;
    readonly placeholder?: string;
}): ReactElement {
    const input = useRef<HTMLInputElement>(null);
    const caretTo = useRef<number | null>(null);

    const head = openHead(value);
    const prefix = head === null ? "" : value.slice(0, head.consumed);
    const rest = head === null ? value : head.rest;

    useEffect(() => { input.current?.focus(); }, []);
    useLayoutEffect(() => {
        if (caretTo.current !== null && input.current !== null) {
            input.current.setSelectionRange(caretTo.current, caretTo.current);
            caretTo.current = null;
        }
    });

    /** Replaces the slot text and pins the caret, for edits the component makes itself. */
    const setRest = (next: string, caret: number): void => {
        caretTo.current = caret;
        events.onChange(prefix + next);
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
        const el = e.currentTarget;
        const at = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? at;
        const collapsed = at === end;

        if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z") {
            e.preventDefault(); events.onUndo(); return;
        }
        if (e.ctrlKey && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
            e.preventDefault(); events.onRedo(); return;
        }
        if (e.key === "Enter") { e.preventDefault(); events.onCommit(false); return; }
        if (e.key === "Escape") { e.preventDefault(); events.onClose(); return; }
        if (e.key === "ArrowDown") { e.preventDefault(); events.onArrowDown(); return; }
        if (e.key === "Tab" && ghost !== "") {
            e.preventDefault();
            setRest(rest + ghost, rest.length + ghost.length);
            return;
        }
        if (e.key === " " && collapsed && rest.trim() !== "" && balanced(prefix + rest)) {
            e.preventDefault(); events.onCommit(true); return;
        }
        if (e.key === "ArrowLeft" && collapsed && at === 0) {
            e.preventDefault(); events.onLeaveLeft(); return;
        }
        if (e.key === "ArrowRight" && collapsed && at === rest.length) {
            e.preventDefault();
            if (ghost !== "") setRest(rest + ghost, rest.length + ghost.length);
            else events.onLeaveRight();
            return;
        }
        if (e.key === "Backspace" && collapsed && at === 0) {
            e.preventDefault();
            if (head !== null && head.bound) {
                // Dissolve the head back into raw text, caret after the word, so the head stays editable.
                caretTo.current = prefix.length - 1;
                events.onChange(prefix.slice(0, -1) + rest);
            } else if (head !== null) {
                caretTo.current = prefix.length;
                events.onChange(prefix + rest);
            } else {
                events.onBackspaceAtStart();
            }
            return;
        }
        // Pair-spawning: an opener writes its closer too; typing a closer that is already next steps over it.
        if (PAIRS[e.key] !== undefined && collapsed && !(e.key === GRAMMAR.phrase && rest[at] === GRAMMAR.phrase)) {
            e.preventDefault();
            setRest(rest.slice(0, at) + e.key + PAIRS[e.key] + rest.slice(at), at + 1);
            return;
        }
        if (CLOSERS.has(e.key) && collapsed && rest[at] === e.key) {
            e.preventDefault();
            caretTo.current = at + 1;
            input.current?.setSelectionRange(at + 1, at + 1);
        }
    };

    const tokens = tokenize(rest);
    return (
        <span className={styles.editor}>
            {head !== null && (
                <span className={`${styles.headCell} ${head.negated ? styles.neg : ""}`}>
                    {head.negated ? "−" : ""}{headCase(head.word)}
                </span>
            )}
            <span className={styles.slot}>
                <span className={styles.mirror} aria-hidden="true">
                    {tokens.map((token, i) => (
                        <span key={i} className={TOKEN_CLASS[token.kind]}>{token.text}</span>
                    ))}
                    {ghost !== "" && <span className={styles.ghost}>{ghost}</span>}
                    {ghost === "" && rest === "" && head === null && placeholder !== undefined
                        && <span className={styles.ghost}>{placeholder}</span>}
                </span>
                <input
                    ref={input}
                    className={styles.input}
                    value={rest}
                    onChange={(e) => { events.onChange(prefix + e.target.value); }}
                    onKeyDown={onKeyDown}
                    spellCheck={false}
                    autoComplete="off"
                />
            </span>
        </span>
    );
}
