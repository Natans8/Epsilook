/**
 * @file What the URL says the page is showing, and what the page considers written.
 *
 * Read by the page and by the simplify button alike, which is why it is neither's. The two must not answer
 * differently: what the URL carries and what a rewrite is compared against are the same question, and once they
 * were two functions in one file they were one edit away from disagreeing.
 */
import {settledQuery} from "../bar/index";

/** The query the URL carries, or nothing. */
export const urlQuery = (): string => new URLSearchParams(location.search).get("q") ?? "";

/** Whether the URL asks for the plaintext view — a view choice worth surviving a reload. A bare flag. */
export const urlPlain = (): boolean => new URLSearchParams(location.search).has("plain");

/** Rewrites one URL parameter and reloads — the knob transitions that need a refetch. */
export function reloadWith(param: string, value: string): void {
    const url = new URL(location.href);
    url.searchParams.set(param, value);
    location.href = url.toString();
}

/** The interface languages a catalog is bundled for. */

/**
 * The query the page considers written, as against the one the bar is holding mid-edit.
 *
 * Two things ask this and they must not answer differently: what the URL carries, and what the simplify button
 * compares against. In the chip view an open chip's editing braces and a commit's trailing separator are
 * editing state rather than query content, so the settled spelling is the query. The plain view settles
 * nothing — a reader who asked to see their own text is shown exactly it — so there the query is what stands.
 *
 * @param text The bar's text, editing structure and all.
 * @param plain Whether the plaintext view is the one standing.
 * @returns The query, trimmed.
 */
export function carriedQuery(text: string, plain: boolean): string {
    return (plain ? text : settledQuery(text)).trim();
}
