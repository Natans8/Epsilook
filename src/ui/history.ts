/**
 * @file The searches this browser remembers — what an empty bar offers before anything is typed.
 *
 * Local to the machine, because a query is the reader's own working note and there is no server to keep it on.
 * Storage can be refused (a private window, a locked-down profile), and a refusal is not an error worth showing:
 * the menu simply opens on the axis list instead.
 */

/** Where the list lives. Namespaced, because the harness and the site share an origin while both exist. */
const KEY = "epsilook.search2.history";

/** How many searches are kept. Enough to reach yesterday's work, few enough to read without scrolling. */
const LIMIT = 8;

/** The remembered searches, newest first. */
export function recentQueries(): readonly string[] {
    try {
        const held: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
        return Array.isArray(held) ? held.filter((query): query is string => typeof query === "string") : [];
    } catch {
        return [];
    }
}

/**
 * Remembers one search, moving a repeat back to the front rather than doubling it.
 *
 * @param query The query text as it stands.
 * @returns The list as it now reads, newest first.
 */
export function rememberQuery(query: string): readonly string[] {
    const trimmed = query.trim();
    if (trimmed === "") return recentQueries();
    const held = [trimmed, ...recentQueries().filter((past) => past !== trimmed)].slice(0, LIMIT);
    try {
        localStorage.setItem(KEY, JSON.stringify(held));
    } catch {
        // Storage refused; the list stands for this session and is forgotten with the tab.
    }
    return held;
}
