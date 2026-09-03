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
import type {Parsed} from "../../search/index";
import {stripRows} from "../utils/diagnostics";
import styles from "./diagnostics.module.css";

/**
 * The strip. Draws nothing at all for a query the reader accepted, so the count sits directly under the bar.
 */
export function Diagnostics({parsed, text, apply}: {
    /** The query as read in final mode — the same parse the count refuses on. */
    readonly parsed: Parsed;
    /** The text that parse was read from. */
    readonly text: string;
    /** Applies a fix's whole-query rewrite, through the bar's own undo where the bar stands. */
    readonly apply: (next: string) => void;
}): ReactElement | null {
    const {t} = useTranslation();
    const rows = stripRows(parsed, text);
    if (rows.length === 0) return null;
    return (
        <ul className={styles.strip} aria-label={t("strip.label")}>
            {rows.map((row, i) => (
                <li key={`${String(i)}:${row.message}`} className={`${styles.row} ${styles[row.severity]}`}>
                    {row.verbatim !== "" && <code className={styles.verbatim}>{row.verbatim}</code>}
                    <span className={styles.message}>{row.message}</span>
                    {row.fixes.length > 0 && (
                        // One button per correction, in the reader's own order: a refusal between several
                        // readings offers each, and the group wraps rather than the row when they run long.
                        <span className={styles.fixes}>
                            {row.fixes.map((fix) => (
                                <button
                                    key={fix.query}
                                    type="button"
                                    className={styles.fix}
                                    onClick={() => {
                                        apply(fix.query);
                                    }}
                                >
                                    {fix.label}
                                </button>
                            ))}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}
