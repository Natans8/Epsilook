/**
 * @file The plaintext view: the query as the text it is, richly coloured and otherwise untouched.
 *
 * A view the reader chooses, so nothing here rewrites what they typed — no commit, no simplification, no
 * rewrapping a chip into its editing form, no segments. The chip view's every convenience is a correction, and
 * a reader who asked to see the text asked to see it exactly.
 *
 * That makes this an ordinary text field with a coloured backdrop, which is the point: selection, the caret,
 * word-by-word double presses, undo and the clipboard are all the platform's own here, and none of them has to
 * be reimplemented. What the parse understood shows through {@link paint} — the head a column reaches, the
 * delimiters that belong to it, a broken clause's squiggle — because reading the raw text is the reason for
 * looking at it.
 */
import type {ChangeEvent, KeyboardEvent, ReactElement} from "react";
import {useLayoutEffect, useRef} from "react";
import {GRAMMAR} from "../../search/index";
import {Classed} from "./classed";
// Two sheets, two jobs: the bar's own frame is shared with the chip view, the rest is this view's alone.
import frame from "./bar.module.css";
import styles from "./plain.module.css";

/** Each opening delimiter and the closer it spawns — the enclosures this view pairs as the chip bar does. */
const PAIRS: Record<string, string | undefined> = {
    [GRAMMAR.phrase]: GRAMMAR.phrase,
    [GRAMMAR.scope.open]: GRAMMAR.scope.close,
    [GRAMMAR.group.open]: GRAMMAR.group.close,
};

/** The closing halves — what a keystroke steps over instead of doubling. */
const CLOSERS = new Set<string>([GRAMMAR.phrase, GRAMMAR.scope.close, GRAMMAR.group.close]);

/**
 * The plaintext editor.
 */
export function PlainBar({text, onText, placeholder, label}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    /** The field's accessible name, which stands whether or not a placeholder is showing. */
    readonly label: string;
}): ReactElement {
    const field = useRef<HTMLTextAreaElement>(null);

    useLayoutEffect(() => {
        const el = field.current;
        // The field is uncontrolled, so the platform's own undo survives a session; text arriving from
        // anywhere else — the URL, a language switch — is written in only while the reader is elsewhere.
        if (el !== null && document.activeElement !== el && el.value !== text) el.value = text;
    });

    /**
     * The delimiters pair as they do in the chip bar: typed over a selection the pair encloses it, typed alone
     * the closer spawns with the caret in the middle, a closer against its own next character steps over, and
     * Backspace inside an empty pair takes both halves.
     *
     * This is not a correction — nothing here rewrites what was typed into something else; it is the same
     * enclosure the reader was going to type, written for them, and one Backspace undoes it.
     */
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
        const el = e.currentTarget;
        // The search is live, so Enter has nothing to submit; it must not open a second line either.
        if (e.key === "Enter") {
            e.preventDefault();
            return;
        }
        const typed = !e.metaKey && e.ctrlKey === e.altKey ? e.key : "";
        const close = PAIRS[typed];
        const from = el.selectionStart;
        const to = el.selectionEnd;
        const wrote = (): void => {
            onText(el.value);
        };
        if (close !== undefined && from !== to) {
            e.preventDefault();
            el.setRangeText(typed + el.value.slice(from, to) + close, from, to, "end");
            el.setSelectionRange(from + 1, to + 1);
            wrote();
            return;
        }
        if (typed !== "" && from === to && CLOSERS.has(typed) && el.value[from] === typed) {
            e.preventDefault();
            el.setSelectionRange(from + 1, from + 1);
            return;
        }
        if (close !== undefined) {
            e.preventDefault();
            el.setRangeText(typed + close, from, from, "end");
            el.setSelectionRange(from + 1, from + 1);
            wrote();
            return;
        }
        if (e.key === "Backspace" && from === to && from > 0 && PAIRS[el.value[from - 1]] === el.value[from]) {
            e.preventDefault();
            el.setRangeText("", from - 1, from + 1, "end");
            wrote();
        }
    };

    const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
        const el = e.currentTarget;
        // A query is one line. Pasted text can carry newlines; they become the separator they stand for,
        // rather than characters the parser would have to have an opinion about.
        if (el.value.includes("\n")) {
            const caret = el.selectionStart;
            el.value = el.value.replaceAll(/\n+/gu, " ");
            el.setSelectionRange(caret, caret);
        }
        onText(el.value);
    };

    return (
        <div
            className={`${frame.qbar} ${styles.plainBar}`}
            onMouseDown={(e) => {
                // The ground either side of the text belongs to the field, as it does in any text box.
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                field.current?.focus();
            }}
        >
            <span className={styles.plainWrap}>
                {/* The backdrop sits in FLOW and sizes the wrap; the field rides above it, so the two wrap
                    identically and the text can never reach past the bar it is drawn in. */}
                <span className={styles.plainInk} aria-hidden="true">
                    <Classed text={text} rich mirrored/>
                    {/* A trailing newline keeps a text ending in a space from collapsing the last line. */}
                    {"\n"}
                </span>
                <textarea
                    ref={field}
                    className={styles.plainField}
                    defaultValue={text}
                    rows={1}
                    onChange={onChange}
                    onKeyDown={onKeyDown}
                    placeholder={text === "" ? placeholder : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={label}
                />
            </span>
        </div>
    );
}
