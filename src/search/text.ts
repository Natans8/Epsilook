/* SEARCH 2.0 — L2 vocabulary. FOLDING: the one definition of "the same text".
 *
 * Two callers, and they must agree or the fold loses data:
 *
 *   the PARSER      folds what the user typed or pasted (SEARCH.md §4.9.9a)
 *   a BACKEND       folds the corpus it matches against
 *
 * ⭐ THE LAW IS "FOLD THE CORPUS AS WELL AS THE QUERY, EXACTLY AS CASE IS
 * FOLDED" (SEARCH.md §4.9.9a). A fold applied to one side only is a fold that
 * strands data: three spell names on 9.2.7 carry an em dash, and folding just
 * the query would make them unreachable by a typed hyphen rather than more
 * reachable. So this lives above both consumers and neither owns it.
 *
 * ⛔ IT IS NOT A NORMALISER FOR EVERYTHING TYPOGRAPHIC — it is the MEASURED
 * list and nothing else. Every substitution below was checked against 276,332
 * spell names on 9.2.7: zero curly double quotes, zero curly single quotes,
 * zero non-breaking spaces, three en/em dashes. A character that appears in
 * the data cannot be folded away without losing the ability to search for it,
 * so adding a row here is a measurement, not a preference.
 */

/**
 * Characters that mean the same thing as a plainer character, and do not
 * otherwise occur. Discord, browsers and word processors substitute these
 * silently, so a query copied out of a chat window arrives carrying them.
 *
 * ONE ROW PER TARGET, so the list reads as the rule it is. Written as `\u`
 * escapes rather than literals: several of these are invisible or
 * indistinguishable from the character they fold to, and a literal one cannot
 * be reviewed in a diff.
 */
const SUBSTITUTIONS: readonly [RegExp, string][] = [
    /* smart double quotes -> the phrase delimiter */
    [/[\u201C\u201D\u201E\u201F]/g, '"'],
    /* smart single quotes and the acute accent -> an apostrophe */
    [/[\u2018\u2019\u201B\u00B4]/g, "'"],
    /* en dash, em dash, figure dash, MINUS SIGN -> the negation/range hyphen.
     * U+2212 is the one nobody expects: macOS and many editors produce it. */
    [/[\u2013\u2014\u2012\u2212]/g, "-"],
    /* every exotic space -> a plain space, including the zero-width ones,
     * which are invisible and so are the worst kind of parse failure */
    [/[\u00A0\u2000-\u200D\u202F\u205F\u3000\uFEFF]/g, " "],
    /* full-width colon -> the axis separator */
    [/\uFF1A/g, ":"],
];

/**
 * The canonical form of a piece of text for MATCHING and for COMPARING.
 *
 * Case-folded and typographically folded, in that order, after Unicode
 * composition. Nothing else: it does not trim, does not collapse runs of
 * spaces and does not strip punctuation — each of those would silently change
 * what a phrase means, and a phrase is a leaf (SEARCH.md §2.4.0).
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: a locale-aware fold makes the
 * SAME query return different spells for a Turkish user (dotless ı), which is
 * L10 — no display state, and no browser state, may reach a result set.
 */
export function fold(text: string): string {
    let out = text.normalize("NFC").toLowerCase();
    for (const [pattern, to] of SUBSTITUTIONS) out = out.replace(pattern, to);
    return out;
}
