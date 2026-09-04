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
import type {Span} from "../../../search/index";
import {useLayoutEffect, useMemo, useRef, useState} from "react";
import {pairDelimiter, planAt, slotStart, writeSlot} from "../utils/plan";
import type {Offer, Vocabulary} from "../utils/offers";
import {NO_VOCABULARY, offerSlot, offersAt} from "../utils/offers";
import {optionId, useOfferPanel} from "../hooks/panel";
import {Surface} from "./surface";
import {Classed} from "./classed";
// Two sheets, two jobs: the bar's own frame is shared with the chip view, the rest is this view's alone.
import frame from "./bar.module.css";
import styles from "./plain.module.css";

/** The default for a bar told of no remembered searches — one array, so the default never changes identity. */
const NO_HISTORY: readonly string[] = [];

/**
 * The plaintext editor.
 */
export function PlainBar({
    text, onText, placeholder, label, history = NO_HISTORY, vocab = NO_VOCABULARY, aim = null, preview = null,
    onHover,
}: {
    readonly text: string;
    readonly onText: (text: string) => void;
    readonly placeholder: string;
    /** The field's accessible name, which stands whether or not a placeholder is showing. */
    readonly label: string;
    /** The remembered searches, newest first. */
    readonly history?: readonly string[];
    /** The closed vocabularies the loaded pack carries. */
    readonly vocab?: Vocabulary;
    /** A stretch of the query something outside the bar is pointing at — a diagnostic's clause — drawn marked. */
    readonly aim?: Span | null;
    /**
     * A query to show in place of the text while an offer outside the bar is being considered — the picture of
     * what the press would write, lifted without a trace when the pointer leaves.
     */
    readonly preview?: string | null;
    /**
     * Says where in the text the pointer is — the character under it, as an empty span — or none, so whatever
     * speaks about that stretch outside the bar can light up. Silent while a preview is drawn.
     */
    readonly onHover?: (span: Span | null) => void;
}): ReactElement {
    const field = useRef<HTMLTextAreaElement>(null);
    /** The last point reported, so a pointer resting on one character does not report it on every move. */
    const pointed = useRef<number | null>(null);
    const report = (at: number | null): void => {
        if (at === pointed.current) return;
        pointed.current = at;
        onHover?.(at === null ? null : {start: at, end: at});
    };
    /** What the field held before a preview replaced it, so the lift restores the caret with the characters. */
    const before = useRef<{ value: string; start: number; end: number } | null>(null);
    const drawnText = preview ?? text;
    // As the chip bar does: the bar keeps the height it had when a preview began, so a shorter picture cannot
    // move the pointer off the offer that asked for it.
    const box = useRef<HTMLDivElement>(null);
    const kept = useRef<number | null>(null);
    useLayoutEffect(() => {
        const el = box.current;
        if (el === null) return;
        if (preview === null) kept.current = el.offsetHeight;
        el.style.minHeight = preview !== null && kept.current !== null ? `${String(kept.current)}px` : "";
    });
    useLayoutEffect(() => {
        const el = field.current;
        if (el === null) return;
        if (preview !== null) {
            // The field shows the preview too, or the mirror and the field would disagree under the caret.
            before.current ??= {value: el.value, start: el.selectionStart, end: el.selectionEnd};
            el.value = preview;
        } else if (before.current !== null) {
            el.value = before.current.value;
            el.setSelectionRange(before.current.start, before.current.end);
            before.current = null;
        }
    }, [preview]);
    // The same offers the chip view gets, read from the same plan, and the same panel state around them: this
    // view shows the query differently, it does not know less about it. What it does NOT take is the chip
    // view's conveniences — no commit, no scope gesture, no rewrap — so a picked offer lands as the characters
    // it spells and nothing else moves.
    const [caret, setCaret] = useState(0);
    const at = Math.min(caret, text.length);
    const plan = useMemo(() => planAt(text, at), [text, at]);
    const offers = useMemo(
        () => offersAt(plan, at - slotStart(plan), history, vocab), [plan, at, history, vocab]);
    const {flat, shown, lit: here, ghost, ghosted, listId, move, close, light, reset} =
        useOfferPanel(offers, `${text} ${String(at)}`);
    // The ghost may only be APPENDED, or it would shift the mirrored text out from under the field's caret --
    // so it draws only with the caret at the very end of the text.
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
        if (now !== at) reset();
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
        reset();
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
            reset();
            return;
        }
        const written = offerSlot(plan, offers, offer);
        // A VALUE ends its term, so the caret leaves it ready for the next one. A door does not -- it opens an
        // axis and the value follows it immediately. The chip view gets this from its commit; this view has no
        // commit, so the separator is written here or not at all.
        const ends = offer.shape === "word" && !plan.slot.slice(offers.stub.end).startsWith(" ");
        const landed = ends ? {value: `${written.value} `, caret: written.caret + 1} : written;
        const next = writeSlot(plan, landed.value);
        const to = slotStart(plan) + landed.caret;
        el.value = next;
        onText(next);
        el.setSelectionRange(to, to);
        setCaret(to);
        reset();
    };

    useLayoutEffect(() => {
        const el = field.current;
        // The field is uncontrolled, so the platform's own undo survives a session; text arriving from
        // anywhere else — the URL, a language switch — is written in only while the reader is elsewhere.
        if (el !== null && preview === null && document.activeElement !== el && el.value !== text) el.value = text;
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
            move(step);
            return;
        }
        // A MODIFIED Tab is the platform's own: Shift+Tab walks the focus backwards, and taking an offer on it
        // would trap a keyboard reader in the field for as long as the panel stands. The chip view's slot has
        // always guarded this and this surface had not — the divergence the shared panel state was split out to
        // stop, in the one half that stayed written twice.
        const bareTab = e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.altKey;
        if (shown && here >= 0 && (e.key === "Enter" || bareTab)) {
            e.preventDefault();
            apply(flat[here]);
            return;
        }
        // Tab with nothing lit takes the GHOST, exactly as the chip view's slot does. Without this it reached
        // the platform, which moved the focus to the next control -- the view switch, which is the one thing a
        // reader mid-query does not want. An offer's ghost is that offer; a unit or a closer has no row and is
        // written straight in.
        if (shown && bareTab && ghosting) {
            e.preventDefault();
            // Whatever the field DREW: the ghost names its own offer, so the word previewed and the word
            // delivered cannot come apart.
            if (offers.ghostIs === "offer" && ghosted !== undefined) apply(ghosted);
            else writeGhost();
            return;
        }
        if (shown && e.key === "Escape") {
            e.preventDefault();
            close();
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
            ref={box}
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
                    {/* The pointed-at clause wears the aim band under the field, cut by the character as a
                        selection is: the text is the reader's own and the band says which stretch is meant. */}
                    <Classed text={drawnText} rich mirrored selected={aim ?? undefined} band={frame.aimed}/>
                    {ghosting && <span className={frame.ghost}>{ghost}</span>}
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
                    // The character under the pointer, read off the field's own layout: the mirror underneath
                    // wraps identically, so the field's caret geometry is the text's.
                    onMouseMove={(e) => {
                        if (preview !== null) return;
                        const hit = document.caretPositionFromPoint(e.clientX, e.clientY);
                        report(hit === null || hit.offsetNode !== e.currentTarget ? null : hit.offset);
                    }}
                    onMouseLeave={() => {
                        report(null);
                    }}
                    onFocus={(e) => {
                        track(e.currentTarget);
                    }}
                    onBlur={() => {
                        reset();
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
                    onLight={light}
                />
            )}
        </div>
    );
}
