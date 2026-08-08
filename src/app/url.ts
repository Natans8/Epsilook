import {copyText} from "./clipboard";
import {applyHiddenCols} from "./events";
import {canonField, isChipField, serializeQuery} from "./query";
import {cancelScheduledSearch, COUNT_SORTS} from "./run";
import {COL_FIELDS, TRI_LABELS, hiddenFields, shortVersion, state} from "./state";
import type {VersionEntry} from "../data";
import type {Chip} from "../query";
import * as Search from "../search";
import {$, $$} from "../dom";
// Copy a link to the exact current search. The URL is only updated
// after the search debounce settles, so flush it first — otherwise a
// share click right after typing could copy a stale query.
export function shareLink(): void {
    cancelScheduledSearch();
    state.lastQuery = serializeQuery();
    stateToUrl(false);
    copyText(location.href, false, "Link copied — paste it to share this search");
}

/* ----------------------------------------------------------- the URL */

// the default version stays out of the URL — links only carry v= when the
// user deliberately switched to another pack.
//
// An entry flagged `default` in versions.json wins; otherwise it is the
// newest visible pack. The flag exists because the newest build is not
// necessarily the one to serve first. Hidden packs never qualify either
// way: they exist only for whoever asks for one by name with ?v=, so
// nobody else ever downloads them.
export function defaultVersion(): VersionEntry | undefined {
    const visible = state.versions.filter((e) => !e.hidden);
    return visible.find((e) => e.default) || visible.at(-1);
}

// keep ":", "+" for space, and quotes readable — encodeURIComponent's
// %3A soup is exactly the mess a shareable URL shouldn't be
const encodeQueryValue = (s: string) =>
    encodeURIComponent(s).replace(/%3A/gi, ":").replace(/%20/g, "+").replace(/%22/g, '"');

/**
 * The URL for a view of the current page showing `query` — the pack, the
 * filters and the sort are the ones on screen, because everything except the
 * question is context the reader is already in.
 *
 * ONE BUILDER, TWO CALLERS, and that is the point: `stateToUrl` commits the
 * current query to history while `urlForQuery` hands a DIFFERENT query to a new
 * tab without touching this page. Those differ in exactly two things — which
 * query, and whether the help dialog counts — so they differ in two arguments
 * rather than in two copies of the parameter list. The copy is what drifts: a
 * new piece of shareable state added to one and not the other would make a
 * middle-click quietly drop it.
 */
function viewUrl(query: string, withHelp: boolean): string {
    const params: string[] = [];
    const dv = defaultVersion();
    if (state.version && dv && state.version.id !== dv.id) {
        params.push("v=" + encodeQueryValue(shortVersion(state.version.id)));
    }
    if (query) params.push("q=" + encodeQueryValue(query));
    // the "Only spells with / without" filters shape the shared result list
    // just like the query does, so they ride in the URL too: only= lists the
    // "with" categories (unchanged for back-compat), without= the "without" ones
    const only = Object.keys(state.filters).filter((k) => state.filters[k] === "with");
    if (only.length) params.push("only=" + only.join(","));
    const without = Object.keys(state.filters).filter((k) => state.filters[k] === "without");
    if (without.length) params.push("without=" + without.join(","));
    // sort order shapes the shared list — and the row order of ?export= —
    // so it rides in the URL too: one link must always yield one result set
    if (state.sort.key !== "auto") {
        params.push("sort=" + (state.sort.dir < 0 ? "-" : "") + state.sort.key);
    }
    // the help dialog is part of what a link can point at — "here is the
    // syntax" is a thing people send each other, and without this the only
    // way to share it is a sentence telling someone to click the ?
    //
    // It is a BARE FLAG (`?help`), not `help=1`: there is no second value it
    // could take, so the `=1` was a value pretending to mean something. Old
    // `help=1` links still open it — the reader asks whether the key is
    // present, which is true either way.
    if (withHelp && helpOpen()) params.push("help");
    return location.pathname + (params.length ? "?" + params.join("&") : "");
}

/**
 * The URL a middle-click opens in a new tab. `?help` is deliberately dropped:
 * a new tab is opened to look at RESULTS, and a modal over them is not what was
 * asked for.
 */
export function urlForQuery(query: string): string {
    return viewUrl(query, false);
}

export function stateToUrl(push: boolean): void {
    const url = viewUrl(state.lastQuery, true);
    if (url === location.pathname + location.search && !location.hash) return;
    // pushState (unlike the old location.hash assignment) fires no event,
    // so no suppression dance is needed
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
}

export function urlToState() {
    const params = new URLSearchParams(location.search);
    // legacy share links carried the state in the hash (#q=…&v=…)
    const legacy = new URLSearchParams(location.hash.slice(1));
    const get = (k: string) => params.get(k) ?? legacy.get(k);
    let q = get("q") || "";
    // even older links carried a mode: fold it into the query as a field tag
    const legacyMode = canonField(get("m") || "");
    if (legacyMode && isChipField(legacyMode) && q && !/[a-z]+:/i.test(q)) {
        q = `${legacyMode}:${/\s/.test(q) ? `"${q}"` : q}`;
    }
    return {
        v: get("v"), q, only: get("only"), without: get("without"), sort: get("sort"),
        // presence, not value: `?help` and the older `?help=1` both open it,
        // and a bare key reads as "" rather than null, which is falsy
        help: params.has("help") || legacy.has("help"),
    };
}

/** Is the help dialog on screen? (Its own open state is the truth.) */
const helpOpen = () =>
    !!(($("#help") as HTMLDialogElement) || {}).open;

/**
 * Show or hide the help dialog and write that into the URL, so it survives a
 * reload, a share and the back button. `push` is false while restoring from
 * a popstate — the URL is already what it should be.
 */
export function setHelp(on: boolean, push: boolean = true) {
    const help = ($("#help") as HTMLDialogElement);
    if (on === help.open) return;
    // showModal on an open dialog throws; close on a closed one is a no-op
    if (on) help.showModal(); else help.close();
    if (push) stateToUrl(true);
}

// set the "Only spells with / without" filters from the URL's only= (with)
// and without= lists (a category in neither = any) and sync the buttons
export function filtersFromUrl(onlyStr: string | null, withoutStr: string | null): void {
    const withSet = new Set((onlyStr || "").split(",").filter(Boolean));
    const withoutSet = new Set((withoutStr || "").split(",").filter(Boolean));
    for (const k of Object.keys(state.filters)) {
        state.filters[k] = withSet.has(k) ? "with" : withoutSet.has(k) ? "without" : "";
    }
    for (const btn of $$("#filters button.tri")) {
        const st = state.filters[btn.dataset.filter!];
        btn.dataset.state = st;
        btn.setAttribute("aria-label", `${(btn.textContent ?? "").trim()} filter: ${TRI_LABELS[st]}`);
    }
}

// set the sort from the URL's sort= value ("name" ascending, "-name"
// descending; absent or unknown = the automatic relevance order). Unknown
// keys fall back rather than sorting by nothing — a stale link from before
// a column was renamed still shows results.
export function sortFromUrl(str: string | null): void {
    const s = str || "";
    const key = s.replace(/^-/, "");
    const known = key === "id" || key === "name" || COUNT_SORTS.has(key);
    state.sort = known ? {key, dir: s.startsWith("-") ? -1 : 1} : {key: "auto", dir: 1};
}

// Un-hide every column a freshly loaded chip list searches into. This is
// deliberately NOT inside parseQueryParts: that parser is also how the help
// dialog draws its examples (decorateExamples), and merely rendering help
// text must not touch the user's column choices — it used to, which is why
// hiding a column never survived a reload.
export function ensureFieldsVisible(parts: Chip[]): void {
    for (const p of parts) ensureFieldVisible(p.field);
}

// A shared link may search a field whose column is hidden here —
// honor the link by un-hiding that column for this session.
export function ensureFieldVisible(field: string): void {
    if (!Search.FIELDS[field] || !hiddenFields().has(field)) return;
    for (const [col, fields] of Object.entries(COL_FIELDS)) {
        if (fields.includes(field)) state.hiddenCols[col] = false;
    }
    applyHiddenCols();
}

// accepts both full build ids and short "9.2.7" forms
export function findVersion(v: string | null): VersionEntry | undefined {
    if (!v) return undefined;
    return state.versions.find((e) => e.id === v) ||
        state.versions.findLast((e) => shortVersion(e.id) === v);
}
