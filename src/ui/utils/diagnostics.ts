/**
 * @file The diagnostics strip's model: what the engine said about the query, read as the rows a strip draws.
 *
 * React-free, like the bar's own model. The strip and the chips render the same parse diagnostics, so this reads
 * them and adds nothing: the offending text is cut from the query by the clause's own span, and the order is the
 * order the clauses were written in, so the strip reads left to right as the bar does.
 */
import type {Diagnostic, Fix, Parsed, Severity} from "../../search/index";

/** One row of the strip: what was written, what the reader said about it, and the corrections on offer. */
export interface StripRow {
    readonly severity: Severity;
    /** The offending clause's text, exactly as typed. Empty where the finding is about the query as a whole. */
    readonly verbatim: string;
    readonly message: string;
    /**
     * Every correction the reader offers, in the order it ranks them. A diagnostic carries at most one today, so
     * this is a list of one or none; a refusal that names several readings it declined between lands here as
     * one entry each, and the strip draws them as it draws the one.
     */
    readonly fixes: readonly Fix[];
}

/** The severities in the order a row's weight ranks them, heaviest first. */
const WEIGHT: Readonly<Record<Severity, number>> = {error: 0, warning: 1, note: 2};

/**
 * The strip's rows for one parse: every diagnostic, in the order its clause was written, an error before a warning
 * before a note where one clause drew several.
 *
 * @param parsed The query as the reader read it.
 * @param text The query text the parse was read from, which the clause spans index into.
 * @returns The rows, empty for a query the reader had nothing to say about.
 */
export function stripRows(parsed: Parsed, text: string): readonly StripRow[] {
    const placed = parsed.diagnostics.map((d: Diagnostic, order: number) => {
        const clause = parsed.clauses[d.clause];
        const start = clause === undefined ? text.length : clause.span.start;
        const verbatim = clause === undefined ? "" : text.slice(clause.span.start, clause.span.end).trim();
        const fixes = d.fix === undefined ? [] : [d.fix];
        return {row: {severity: d.severity, verbatim, message: d.message, fixes}, start, order};
    });
    placed.sort((a, b) =>
        a.start - b.start || WEIGHT[a.row.severity] - WEIGHT[b.row.severity] || a.order - b.order);
    return placed.map((p) => p.row);
}
