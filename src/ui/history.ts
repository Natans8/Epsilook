/**
 * @file The searches this browser remembers — what an empty bar offers before anything is typed.
 *
 * Only searches that RUN are kept: a query the parser refuses is a half-finished thought the reader abandoned,
 * and offering it back squiggled is offering them their own mistake.
 *
 * Local to the machine, because a query is the reader's own working note and there is no server to keep it on.
 * Storage can be refused (a private window, a locked-down profile), and a refusal is not an error worth showing:
 * the menu simply opens on the axis list instead.
 */
import {parse} from "../search/index";

/** Where the list lives. Namespaced, because the harness and the site share an origin while both exist. */
const KEY = "epsilook.search2.history";

/** How many searches are kept — few enough that the menu opens on a list, not on a history page. */
const LIMIT = 5;

/** Whether a query is one worth keeping: it parses, and it asks something. */
function runnable(query: string): boolean {
    if (query.trim() === "") return false;
    return !parse(query).diagnostics.some((d) => d.severity === "error");
}

/** The remembered searches, newest first. */
export function recentQueries(): readonly string[] {
    try {
        const held: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
        if (!Array.isArray(held)) return [];
        // Filtered on the way out as well as in: what a browser stored under an older rule is still in there.
        return held.filter((query): query is string => typeof query === "string" && runnable(query));
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
    if (!runnable(trimmed)) return recentQueries();
    const held = [trimmed, ...recentQueries().filter((past) => past !== trimmed)].slice(0, LIMIT);
    try {
        localStorage.setItem(KEY, JSON.stringify(held));
    } catch {
        // Storage refused; the list stands for this session and is forgotten with the tab.
    }
    return held;
}
