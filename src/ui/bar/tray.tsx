/**
 * @file The diagnostics tray: the one engine-speaks channel, flush under the bar.
 *
 * Every row is the ruled template — the offending text verbatim, a one-line reason, then its fix buttons
 * immediately after the text, never pushed to the far edge. Errors carry a red edge, warnings amber. The
 * simplify button's offers render here too, as actionable rows of the same shape. Hovering a row highlights its
 * chip and the other way round — one diagnostic, two views.
 */
import type {ReactElement} from "react";
import {useTranslation} from "react-i18next";
import type {Diagnostic, Parsed, Suggestion} from "../../search/index";
import {formatQuery} from "../../search/index";
import styles from "./tray.module.css";

/** What one tray row needs to know about its diagnostic. */
export interface TrayDiagnostic {
    readonly diagnostic: Diagnostic;
    /** The offending clause's verbatim text. */
    readonly verbatim: string;
}

/**
 * The tray.
 *
 * @returns The rows, or null when there is nothing to say.
 */
export function Tray({diagnostics, offers, linked, onLink, onApply, onApplyOffer}: {
    readonly diagnostics: readonly TrayDiagnostic[];
    /** The simplify button's offers, present after a press. Empty array means "pressed, nothing to offer". */
    readonly offers: readonly Suggestion[] | null;
    /** The clause index highlighted from either side of the linkage. */
    readonly linked: number | null;
    readonly onLink: (clause: number | null) => void;
    /** A fix button: replaces the query with the fix's spelling. */
    readonly onApply: (query: string) => void;
    readonly onApplyOffer: (offer: Suggestion) => void;
}): ReactElement | null {
    const {t} = useTranslation();
    if (diagnostics.length === 0 && offers === null) return null;

    return (
        <div className={styles.tray}>
            {diagnostics.map((row, i) => (
                <div
                    key={i}
                    className={[
                        styles.row,
                        row.diagnostic.severity === "warning" ? styles.warn : "",
                        row.diagnostic.severity === "note" ? styles.note : "",
                        linked === row.diagnostic.clause ? styles.linked : "",
                    ].filter(Boolean).join(" ")}
                    onMouseEnter={() => { onLink(row.diagnostic.clause); }}
                    onMouseLeave={() => { onLink(null); }}
                >
                    {row.verbatim !== "" && <span className={styles.code}>{row.verbatim}</span>}
                    <span className={styles.text}>{row.diagnostic.message}</span>
                    {row.diagnostic.fix !== undefined && (
                        <button
                            type="button" className={styles.fix}
                            onClick={() => { onApply(row.diagnostic.fix?.query ?? ""); }}
                        >
                            {row.diagnostic.fix.label}
                        </button>
                    )}
                </div>
            ))}
            {offers !== null && offers.length === 0 && (
                <div className={`${styles.row} ${styles.note}`}>
                    <span className={styles.text}>{t("tray.simplifyNone")}</span>
                </div>
            )}
            {offers?.map((offer, i) => {
                const query = formatQuery(offer.parsed, "written");
                return (
                    <div key={i} className={`${styles.row} ${styles.note}`}>
                        <span className={styles.text}>{t("tray.simplified", {query})}</span>
                        <button
                            type="button" className={styles.fix}
                            onClick={() => { onApplyOffer(offer); }}
                        >
                            {t("tray.apply")}
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

/**
 * The tray rows for one parse: committed diagnostics only — the edited clause's hints live in the control surface.
 *
 * @param parsed The parse.
 * @param text The query text its spans index.
 * @param editedClause The clause under the caret, or null when nothing is open.
 * @returns The rows.
 */
export function trayRows(parsed: Parsed, text: string, editedClause: number | null): TrayDiagnostic[] {
    return parsed.diagnostics
        .filter((diagnostic) => diagnostic.clause !== editedClause)
        .map((diagnostic) => {
            const clause = parsed.clauses[diagnostic.clause] as { span?: {start: number; end: number} } | undefined;
            const span = clause?.span;
            return {diagnostic, verbatim: span === undefined ? "" : text.slice(span.start, span.end)};
        });
}
