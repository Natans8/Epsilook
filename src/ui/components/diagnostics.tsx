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
import {useTranslation} from "react-i18next";
import type {Fix, Parsed, Run, Span} from "../../search/index";
import {paint, parse} from "../../search/index";
import {Classed} from "../bar/index";
import {mergeEditing, stripRows} from "../utils/diagnostics";
import styles from "./diagnostics.module.css";

/** One painted run with its diagnostic state dropped: colour stays, the squiggle is the row's to draw. */
function quiet(run: Run): Run {
    return run.state === undefined ? run : {...run, state: undefined};
}

/**
 * One correction on offer: the button, which shows what it would write while it is pointed at.
 *
 * A rewrite the reader cannot see before taking it is a gamble, so hovering or focusing the button asks the
 * page to draw the query as it would stand afterwards — in the bar itself, where the query is always drawn,
 * rather than in a second picture beside the button.
 */
function Offer({fix, apply, onPreview}: {
    readonly fix: Fix;
    readonly apply: (next: string, caret?: number) => void;
    /** Says which rewrite is being considered, or none. */
    readonly onPreview: (query: string | null) => void;
}): ReactElement {
    return (
        <button
            type="button"
            className={styles.fix}
            onMouseEnter={() => {
                onPreview(fix.query);
            }}
            onMouseLeave={() => {
                onPreview(null);
            }}
            onFocus={() => {
                onPreview(fix.query);
            }}
            onBlur={() => {
                onPreview(null);
            }}
            onClick={() => {
                onPreview(null);
                apply(fix.query, fix.caret);
            }}
        >
            {fix.label}
        </button>
    );
}

/**
 * The strip. Draws nothing at all for a query the reader accepted, so the count sits directly under the bar.
 */
export function Diagnostics({parsed, text, plain, apply, onAim, onPreview, lit, editing}: {
    /** The query as read in final mode — the same parse the count refuses on. */
    readonly parsed: Parsed;
    /** The text that parse was read from. */
    readonly text: string;
    /**
     * Whether the plain view stands. A note says how a spelling was read, and the chips already draw that
     * reading, so it is shown only where the reader is looking at their own text.
     */
    readonly plain: boolean;
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
    const rows = mergeEditing(stripRows(parsed, text),
        editing === null ? [] : stripRows(parse(text, {mode: "typing"}), text), editing)
        .filter((row) => plain || row.severity !== "note");
    if (rows.length === 0) return null;
    // A point — the plain view's character under the pointer — touches the clause it stands in; a stretch — a
    // settled segment — touches every clause it overlaps.
    const touches = (span: Span | null): boolean => {
        if (lit === null || span === null) return false;
        if (lit.start === lit.end) return span.start <= lit.start && lit.start < span.end;
        return lit.start < span.end && lit.end > span.start;
    };
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
                            // the reader knows them by. The runs are quieted: the row's own underline already
                            // says how the clause fared, and a squiggle under a squiggle says nothing more.
                            <code className={styles.verbatim}>
                                <Classed text={row.verbatim} runs={paint(row.verbatim).map(quiet)}/>
                            </code>
                        )}
                        {row.verbatim !== "" && " "}
                        {row.about === "regex" && <span className={styles.about}>{t("strip.about.regex")}</span>}
                        {row.about !== null && " "}
                        <span className={styles.message}>{row.message}</span>
                    </span>
                    {row.fixes.length > 0 && (
                        // One button per correction, in the reader's own order: a refusal between several
                        // readings offers each, and the group wraps rather than the row when they run long.
                        <span className={styles.fixes}>
                            {row.fixes.map((fix) => (
                                <Offer key={fix.query} fix={fix} apply={apply} onPreview={onPreview}/>
                            ))}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}
