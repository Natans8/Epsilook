/**
 * @file Recent searches, persisted locally: what the empty-focus menu offers first.
 */

const KEY = "epsilook2.history";
const LIMIT = 8;

/** The recent queries, newest first. */
export function recentQueries(): string[] {
    try {
        const held = localStorage.getItem(KEY);
        if (held === null) return [];
        const parsed = JSON.parse(held) as unknown;
        return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Records one run query, deduplicated to the front of the list.
 *
 * @param query The committed query text.
 */
export function rememberQuery(query: string): void {
    const trimmed = query.trim();
    if (trimmed === "") return;
    try {
        const held = [trimmed, ...recentQueries().filter((q) => q !== trimmed)].slice(0, LIMIT);
        localStorage.setItem(KEY, JSON.stringify(held));
    } catch {
        // Storage may be unavailable; the menu just stays empty.
    }
}
