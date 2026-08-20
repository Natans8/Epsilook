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
import {useId, useLayoutEffect, useMemo, useRef, useState} from "react";
import {pairDelimiter, planAt, slotStart, writeSlot} from "./plan";
import type {Offer, Vocabulary} from "./offers";
import {flatOffers, NO_VOCABULARY, offerGhost, offerSlot, offersAt} from "./offers";
import {optionId, Surface} from "./surface";
import {Classed} from "./classed";
// Two sheets, two jobs: the bar's own frame is shared with the chip view, the rest is this view's alone.
import frame from "./bar.module.css";
import styles from "./plain.module.css";

/** The default for a bar told of no remembered searches — one array, so the default never changes identity. */
const NO_HISTORY: readonly string[] = [];

/**
 * The plaintext editor.
 */
export function PlainBar({text, onText, placeholder, label, history = NO_HISTORY, vocab = NO_VOCABULARY}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    /** The field's accessible name, which stands whether or not a placeholder is showing. */
    readonly label: string;
    /** The remembered searches, newest first. */
    readonly history?: readonly string[];
    /** The closed vocabularies the loaded pack carries. */
    readonly vocab?: Vocabulary;
}): ReactElement {
    const field = useRef<HTMLTextAreaElement>(null);
    // The same offers the chip view gets, read from the same plan: this view shows the query differently, it
    // does not know less about it. What it does NOT take is the chip view's conveniences — no commit, no scope
    // gesture, no rewrap — so a picked offer lands as the characters it spells and nothing else moves.
    const [caret, setCaret] = useState(0);
    const [lit, setLit] = useState(-1);
    const [dismissed, setDismissed] = useState("");
    const listId = useId();
    const at = Math.min(caret, text.length);
    const plan = useMemo(() => planAt(text, at), [text, at]);
    const offers = useMemo(
        () => offersAt(plan, at - slotStart(plan), history, vocab), [plan, at, history, vocab]);
    const stamp = `${text} ${String(at)}`;
    const shown = (offers.groups.length > 0 || offers.takes !== null) && dismissed !== stamp;
    const flat = useMemo(() => flatOffers(offers), [offers]);
    const here = shown && lit >= 0 && lit < flat.length ? lit : -1;
    // The ghost may only be APPENDED, or it would shift the mirrored text out from under the field's caret --
    // so it draws only with the caret at the very end of the text. While the reader types it is the best
    // completion; once they steer the list, the lit row previews instead.
    const ghost = here < 0 ? offers.ghost : offerGhost(offers, flat[here]);
    const ghosting = shown && ghost !== "" && at === text.length;

    /**
     * Reports where the caret now sits, which is what decides what can be offered.
     *
     * A MOVE puts the light out, because what is offered has changed under it. Standing still does not: the
     * arrows that steer the list are preventDefault'd, so their own keyup arrives with the caret exactly where
     * it was -- and extinguishing it there put the light out before the reader could take it.
     */
    const track = (el: HTMLTextAreaElement): void => {
        const now = el.selectionStart;
        setCaret(now);
        if (now !== at) setLit(-1);
    };

    /**
     * Writes the ghost's own characters at the caret -- the unit a number is missing, or the closers an
     * enclosure still wants. Neither has a row to pick, so neither goes through {@link apply}.
     */
    const writeGhost = (): void => {
        const el = field.current;
        if (el === null) return;
        // A unit finishes a number and so ends its term, exactly as a picked value does; a closer only closes
        // an enclosure the value may continue past.
        const ends = offers.ghostIs === "unit" && !text.slice(at).startsWith(" ");
        const written = ends ? `${offers.ghost} ` : offers.ghost;
        const next = text.slice(0, at) + written + text.slice(at);
        const to = at + written.length;
        el.value = next;
        onText(next);
        el.setSelectionRange(to, to);
        setCaret(to);
        setLit(-1);
    };

    /** Writes one offer into the text, leaving the caret after what it spelled. */
    const apply = (offer: Offer): void => {
        const el = field.current;
        if (el === null) return;
        if (offer.shape === "query") {
            el.value = offer.insert;
            onText(offer.insert);
            el.setSelectionRange(offer.insert.length, offer.insert.length);
            setCaret(offer.insert.length);
            setLit(-1);
            return;
        }
        const written = offerSlot(plan, offers, offer);
        // A VALUE ends its term, so the caret leaves it ready for the next one. A door does not -- it opens an
        // axis and the value follows it immediately. The chip view gets this from its commit; this view has no
        // commit, so the separator is written here or not at all.
        const ends = offer.shape === "word" && !plan.slot.slice(offers.stub.end).startsWith(" ");
        const written2 = ends ? {value: `${written.value} `, caret: written.caret + 1} : written;
        const next = writeSlot(plan, written2.value);
        const to = slotStart(plan) + written2.caret;
        el.value = next;
        onText(next);
        el.setSelectionRange(to, to);
        setCaret(to);
        setLit(-1);
    };

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
        // The surface's own keys, while it stands: the arrows steer it, Enter and Tab take what is lit, and
        // Escape puts it away — the same contract the chip view's slot answers to.
        if (flat.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            const step = e.key === "ArrowDown" ? 1 : -1;
            setDismissed("");
            setLit(here < 0 ? (step === 1 ? 0 : flat.length - 1) : (here + step + flat.length) % flat.length);
            return;
        }
        if (shown && here >= 0 && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            apply(flat[here]);
            return;
        }
        // Tab with nothing lit takes the GHOST, exactly as the chip view's slot does. Without this it reached
        // the platform, which moved the focus to the next control -- the view switch, which is the one thing a
        // reader mid-query does not want. An offer's ghost is that offer; a unit or a closer has no row and is
        // written straight in.
        if (shown && e.key === "Tab" && ghosting) {
            e.preventDefault();
            if (offers.ghostIs === "offer" && flat.length > 0) apply(flat[0]);
            else writeGhost();
            return;
        }
        if (shown && e.key === "Escape") {
            e.preventDefault();
            setDismissed(stamp);
            setLit(-1);
            return;
        }
        // The search is live, so Enter has nothing to submit; it must not open a second line either.
        if (e.key === "Enter") {
            e.preventDefault();
            return;
        }
        const typed = !e.metaKey && e.ctrlKey === e.altKey ? e.key : "";
        const paired = pairDelimiter(el.value, el.selectionStart, el.selectionEnd, typed);
        if (paired === null) return;
        e.preventDefault();
        // An unchanged value is the step-over: only the caret moves, so nothing is written.
        if (paired.value !== el.value) {
            el.value = paired.value;
            onText(paired.value);
        }
        el.setSelectionRange(paired.anchor ?? paired.caret, paired.caret);
        setCaret(paired.caret);
    };

    const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
        const el = e.currentTarget;
        // A query is one line. Pasted text can carry newlines; they become the separator they stand for,
        // rather than characters the parser would have to have an opinion about.
        if (el.value.includes("\n")) {
            const start = el.selectionStart;
            el.value = el.value.replaceAll(/\n+/gu, " ");
            el.setSelectionRange(start, start);
        }
        onText(el.value);
        track(el);
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
                    {ghosting && <span className={styles.ghost}>{ghost}</span>}
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
                    onKeyUp={(e) => {
                        track(e.currentTarget);
                    }}
                    onMouseUp={(e) => {
                        track(e.currentTarget);
                    }}
                    onFocus={(e) => {
                        track(e.currentTarget);
                    }}
                    onBlur={() => {
                        setLit(-1);
                    }}
                    // A drawn ghost stands where the placeholder would, so the two may never draw together.
                    placeholder={text === "" && !ghosting ? placeholder : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    aria-label={label}
                    role="combobox"
                    aria-expanded={shown}
                    aria-controls={shown ? listId : undefined}
                    aria-activedescendant={here >= 0 ? optionId(listId, here) : undefined}
                    aria-autocomplete="list"
                />
            </span>
            {shown && (
                <Surface
                    offers={offers}
                    lit={here}
                    listId={listId}
                    onPick={apply}
                    onLight={setLit}
                />
            )}
        </div>
    );
}
