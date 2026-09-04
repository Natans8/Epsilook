/**
 * @file The diagnostics strip's model: what the engine said about the query, read as the rows a strip draws.
 *
 * React-free, like the bar's own model. The strip and the chips render the same parse diagnostics, so this reads
 * them and adds nothing: the offending text is cut from the query by the clause's own span, and the order is the
 * order the clauses were written in, so the strip reads left to right as the bar does.
 */
import type {Diagnostic, Fix, Parsed, Severity, Span} from "../../search/index";
import {i18n} from "../../i18n";
// The model directly rather than the bar's door: the door also hands out components, which a Node test of
// this React-free model cannot compile, and the splice is the model's own.
import {spliceOut} from "../bar/utils/plan";

/** One row of the strip: what was written, what the reader said about it, and the corrections on offer. */
export interface StripRow {
    readonly severity: Severity;
    /** Where the offending clause stands in the query, so a surface can point at it; null for the query as a whole. */
    readonly span: Span | null;
    /** The offending clause's text, exactly as typed. Empty where the finding is about the query as a whole. */
    readonly verbatim: string;
    readonly message: string;
    /** The sublanguage at fault, named on the row so the reader knows which grammar the reason is about. */
    readonly about: "regex" | null;
    /** Every correction the reader offers, in the order it ranks them; the strip draws one button each. */
    readonly fixes: readonly Fix[];
}

/**
 * Where a rewrite differs from the text it rewrites, in the rewrite's own coordinates.
 *
 * The common prefix and suffix are what the reader already had; what lies between is what the offer changes,
 * and marking exactly that is what lets a one-character fix — a space, a brace — be seen in a bar that
 * otherwise looks unchanged. A pure removal leaves nothing to mark.
 *
 * @param before The text as it stands.
 * @param after The text the rewrite would leave.
 * @returns The changed stretch of `after`, or null where the rewrite only takes away.
 */
export function changedSpan(before: string, after: string): Span | null {
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    let tail = 0;
    while (tail < before.length - start && tail < after.length - start
    && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
    const end = after.length - tail;
    return end > start ? {start, end} : null;
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
        // A flawed clause can always be taken out whole, so removal closes every error's and warning's offers;
        // a note reports a reading and asks for nothing.
        const remove = clause === undefined || d.severity === "note" ? [] : [{
            label: i18n.t("ui:strip.remove"),
            query: spliceOut(text, clause.span.start, clause.span.end).text,
        }];
        const fixes = [...(d.fixes ?? []), ...remove];
        const span = clause === undefined ? null : clause.span;
        const about = d.about ?? null;
        return {row: {severity: d.severity, span, verbatim, message: d.message, about, fixes}, start, order};
    });
    placed.sort((a, b) =>
        a.start - b.start || WEIGHT[a.row.severity] - WEIGHT[b.row.severity] || a.order - b.order);
    return placed.map((p) => p.row);
}
