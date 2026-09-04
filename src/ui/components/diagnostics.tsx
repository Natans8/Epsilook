/**
 * @file The diagnostics strip: what the engine said about the query, one row each, under the bar.
 *
 * The chips squiggle the offending text; this says why, in the reader's words, and offers the correction where
 * there is one. Both read the same parse, so the page hands the parse it already has rather than reading again.
 * A row stands until its diagnostic leaves — by the fix, or by the reader editing the clause — and there is no
 * memory of a row closed, because the engine never re-reads the page and a memory of what it said could drift
 * from what it says.
 */
import type {ReactElement} from "react";
import {useMemo} from "react";
import {useTranslation} from "react-i18next";
import type {Fix, Parsed, Span} from "../../search/index";
import {overlaps} from "../../search/index";
import {QueryText} from "../bar/index";
import {changedSpan, mergeEditing} from "../utils/diagnostics";
import styles from "./diagnostics.module.css";

/**
 * One correction on offer: the button, which shows what it would write while it is pointed at.
 *
 * A rewrite the reader cannot see before taking it is a gamble, so hovering or focusing the button asks the
 * page to draw the query as it would stand afterwards — in the bar itself, where the query is always drawn,
 * rather than in a second picture beside the button — with what the rewrite changes marked, so the eye lands
 * on the difference. Leaving hands the mark back to the row's own clause.
 */
function Offer({fix, text, clause, apply, onPreview, onAim}: {
    readonly fix: Fix;
    /** The query the fix rewrites. */
    readonly text: string;
    /** The row's clause, which the mark returns to when the pointer leaves the button. */
    readonly clause: Span | null;
    readonly apply: (next: string, caret?: number) => void;
    /** Says which rewrite is being considered, or none. */
    readonly onPreview: (query: string | null) => void;
    /** Says which stretch of the drawn query is meant, or none. */
    readonly onAim: (span: Span | null) => void;
}): ReactElement {
    const consider = (): void => {
        onPreview(fix.query);
        onAim(changedSpan(text, fix.query));
    };
    const drop = (): void => {
        onPreview(null);
        onAim(clause);
    };
    return (
        <button
            type="button"
            className={styles.fix}
            onMouseEnter={consider}
            onMouseLeave={drop}
            onFocus={consider}
            onBlur={drop}
            onClick={() => {
                onPreview(null);
                apply(fix.query, fix.caret);
            }}
        >
            {fix.label}
        </button>
    );
}

/** The label a row wears for the sublanguage its finding is about, by catalog key. */
const ABOUT = {regex: "strip.about.regex"} as const;

/**
 * The strip. Draws nothing at all for a query the reader accepted, so the count sits directly under the bar.
 */
export function Diagnostics({parsed, text, apply, onAim, onPreview, lit, editing}: {
    /** The query as read in final mode — the same parse the count refuses on. */
    readonly parsed: Parsed;
    /** The text that parse was read from. */
    readonly text: string;
    /** Applies a fix's whole-query rewrite, through the bar's own undo where the bar stands, landing where it says. */
    readonly apply: (next: string, caret?: number) => void;
    /**
     * Says which clause the reader is pointing at, or none: the row under the pointer, or the row whose button
     * holds the focus, names its clause so the bar can mark it.
     */
    readonly onAim: (span: Span | null) => void;
    /** Says which offered rewrite the reader is considering, or none, so the bar can draw it. */
    readonly onPreview: (query: string | null) => void;
    /**
     * The stretch of the query the pointer is over in the bar, or none: every row about a clause it touches
     * lights up, the link between a squiggle and its reason running both ways.
     */
    readonly lit: Span | null;
    /**
     * The stretch of the query being edited, or none. What is being typed is not yet what was said, so the
     * rows about that stretch come from a typing-mode reading, where an unfinished value is silent and a
     * further keystroke can still rescue anything — exactly as the bar squiggles nothing in an open slot.
     */
    readonly editing: Span | null;
}): ReactElement | null {
    const {t} = useTranslation();
    // A note says how a spelling was read and asks for nothing; it is the chip's own to tell, in its tooltip,
    // and the strip lists what can be acted on. Read once per text, not per render: the model parses.
    const rows = useMemo(
        () => mergeEditing(parsed, text, editing).filter((row) => row.severity !== "note"),
        [parsed, text, editing]);
    if (rows.length === 0) return null;
    const touches = (span: Span | null): boolean => lit !== null && span !== null && overlaps(lit, span);
    return (
        <ul className={styles.strip} aria-label={t("strip.label")}>
            {rows.map((row, i) => (
                <li
                    key={`${String(i)}:${row.message}`}
                    className={`${styles.row} ${styles[row.severity]}${touches(row.span) ? ` ${styles.litRow}` : ""}`}
                    onMouseEnter={() => {
                        onAim(row.span);
                    }}
                    onMouseLeave={() => {
                        onAim(null);
                    }}
                    onFocus={() => {
                        onAim(row.span);
                    }}
                    onBlur={() => {
                        onAim(null);
                    }}
                >
                    {/* One inline run, so a copy of the row reads as one line: the text, a space, the reason. */}
                    <span className={styles.text}>
                        {row.verbatim !== "" && (
                            // Painted as the bar paints it, so a field, a value and a kind word keep the colours
                            // the reader knows them by; the row's own underline says how the clause fared.
                            <>
                                <code className={styles.verbatim}><QueryText text={row.verbatim}/></code>
                                {" "}
                            </>
                        )}
                        {row.about !== null && (
                            <>
                                <span className={styles.about}>{t(ABOUT[row.about])}</span>
                                {" "}
                            </>
                        )}
                        <span className={styles.message}>{row.message}</span>
                    </span>
                    {row.fixes.length > 0 && (
                        // One button per correction, in the reader's own order: a refusal between several
                        // readings offers each, and the group wraps rather than the row when they run long.
                        <span className={styles.fixes}>
                            {row.fixes.map((fix) => (
                                <Offer key={fix.query} fix={fix} text={text} clause={row.span} apply={apply}
                                       onPreview={onPreview} onAim={onAim}/>
                            ))}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}
