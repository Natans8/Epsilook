/**
 * @file The diagnostics strip's model: what the engine said about the query, read as the rows a strip draws.
 *
 * React-free, like the bar's own model. The strip and the chips render the same parse diagnostics, so this reads
 * them and adds nothing: the offending text is cut from the query by the clause's own span, and the order is the
 * order the clauses were written in, so the strip reads left to right as the bar does.
 */
import type {Diagnostic, Fix, Parsed, Severity, Span, Sublanguage} from "../../search/index";
import {overlaps, parse} from "../../search/index";
import {i18n} from "../../i18n";
import {firstDiff, openHead, spliceOut} from "../bar/model";

/** One row of the strip: what was written, what the reader said about it, and the corrections on offer. */
export interface StripRow {
    readonly severity: Severity;
    /** Where the offending clause stands in the query, so a surface can point at it; null for the query as a whole. */
    readonly span: Span | null;
    /** The offending clause's text, exactly as typed. Empty where the finding is about the query as a whole. */
    readonly verbatim: string;
    readonly message: string;
    /** The sublanguage at fault, named on the row so the reader knows which grammar the reason is about. */
    readonly about: Sublanguage | null;
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
    const start = firstDiff(before, after);
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
    const placed = parsed.diagnostics.map((d: Diagnostic) => {
        const clause = parsed.clauses[d.clause];
        const shared = {severity: d.severity, message: d.message, about: d.about ?? null};
        if (clause === undefined) {
            return {row: {...shared, span: null, verbatim: "", fixes: d.fixes ?? []}, start: text.length};
        }
        const {span} = clause;
        const verbatim = text.slice(span.start, span.end).trim();
        // A note reports a reading and asks for nothing. A flawed clause can always be taken out whole, so
        // removal closes every error's and warning's offers; where the finding is about the value alone, the
        // softer way out comes first: the field stays, open and empty, for the reader to retype into.
        const offers: Fix[] = [...(d.fixes ?? [])];
        if (d.severity !== "note") {
            const head = d.at === "value" ? openHead(verbatim) : null;
            if (head !== null && head.bound) {
                // The head and its bind alone, never the editing form's brace: an empty scope would read as
                // any row, where an empty slot reads as nothing yet. The caret lands right after the bind.
                const kept = span.start + head.consumed - (head.scoped ? 1 : 0);
                offers.push({
                    label: i18n.t("diagnostics:fix.clear"),
                    query: text.slice(0, kept) + text.slice(span.end),
                    caret: kept,
                });
            }
            offers.push({label: i18n.t("diagnostics:fix.remove"), query: spliceOut(text, span.start, span.end).text});
        }
        return {row: {...shared, span, verbatim, fixes: offers}, start: span.start};
    });
    // Written order, an error before a warning before a note on one clause; the sort is stable, so two of a
    // weight keep the order the reader raised them in.
    return placed.toSorted((a, b) => a.start - b.start || WEIGHT[a.row.severity] - WEIGHT[b.row.severity])
        .map((p) => p.row);
}

/**
 * The rows to draw: the final reading everywhere, except over a stretch being edited, which takes the typing
 * reading.
 *
 * What is being typed is not yet what was said. A final reading of an open slot reports the value it does not
 * have yet, and a typing reading holds that quiet until the edit is done, exactly as the bar squiggles nothing
 * in an open slot. Rows are told apart by the clause they are about, so a row about a clause that overlaps the
 * stretch is taken from the typing reading and every other row from the final one.
 *
 * @param parsed The final reading.
 * @param text The text it was read from.
 * @param editing The stretch being edited, or null.
 * @returns The rows to draw, in written order.
 */
export function mergeEditing(parsed: Parsed, text: string, editing: Span | null): readonly StripRow[] {
    const settled = stripRows(parsed, text);
    if (editing === null) return settled;
    const typing = stripRows(parse(text, {mode: "typing"}), text);
    const touched = (row: StripRow): boolean => row.span !== null && overlaps(row.span, editing);
    const merged = [...settled.filter((row) => !touched(row)), ...typing.filter(touched)];
    return merged.toSorted((a, b) => (a.span?.start ?? Infinity) - (b.span?.start ?? Infinity));
}
