/* The app's mutable UI state and the tiny helpers derived from it.
 * A leaf: every other app module imports from here; this imports nothing
 * of theirs. */
import {CFG} from "../config";
import type {SpellData, VersionEntry} from "../data";
import type {QueryGroup} from "../search";
import {fillTemplate} from "../util";

/**
 * One committed search-bar chip. field "all" = free text (rendered as
 * plain words, not boxed); not: true excludes matches instead.
 */
export interface Chip {
    field: string;
    text: string;
    not?: boolean;
}

/**
 * One highlight token of the last search: a positive group's word plus
 * the field it searched (hit checks match it against their own field).
 */
export interface HitToken {
    field: string;
    text: string;
}

// the search input (the bar's single editing gap) — grabbed once (the
// element is never replaced), along with the empty-bar placeholder from
// index.html, before renderBar() starts swapping the property around
export const qInput = document.getElementById("q") as HTMLInputElement;
export const DEFAULT_PLACEHOLDER = qInput.placeholder;

// spoken state for the tri-state column filters (any / with / without),
// kept in the button's aria-label as it cycles
export const TRI_LABELS: Record<string, string> =
    {"": "showing all", with: "only spells with", without: "only spells without"};

/* column -> search fields it contributes.
 *
 * DECLARATION ORDER IS THE DEFAULT COLUMN ORDER, and it is the only place that
 * order is written down. index.html's <th> sequence and the row builder's
 * appendChild sequence used to be two literals saying the same thing, which is
 * the "two copies of one decision" failure tools/repo.py and viewUrl() exist to
 * end — and it is what made reordering impossible to add without a third. Both
 * sides now read `state.colOrder`, seeded from these keys.
 *
 * It sits ABOVE `state` because the initializer reads it: a `const` below would
 * be in its temporal dead zone and throw at module load, not at first use. */
export const COL_FIELDS: Record<string, string[]> = {
    models: ["model"],
    sounds: ["sound"],
    animations: ["anim"],
    fx: ["fx"],
    mechanics: ["mech"],
};

/** The payload columns in their default left-to-right order. */
export const COL_ORDER = Object.keys(COL_FIELDS);

/* ------------------------------------------------------------- state */

/** A column filter's tri-state: any / must have / must not have. */
export type TriState = "" | "with" | "without";

/**
 * All mutable UI state. The bar is: committed `chips` + the chip being
 * typed (`activeField` + the input's text), with the input sitting at
 * gap `pos`.
 */
export interface AppState {
    versions: VersionEntry[];
    version: VersionEntry | null;
    data: SpellData | null;
    chips: Chip[];
    activeField: string | null;
    activeNot: boolean;
    pos: number;
    barSel: { anchor: number; focus: number } | null;
    groups: QueryGroup[];
    tokens: HitToken[];
    lastQuery: string;
    results: number[];
    display: number[];
    searchMs: number;
    rendered: number;
    filters: Record<string, TriState>;
    sort: { key: string; dir: number };
    hiddenCols: Record<string, boolean>;
    colOrder: string[];
}

export const state: AppState = {
    versions: [],       // manifest entries
    version: null,      // active manifest entry
    data: null,         // indexes for the active version

    chips: [],
    activeField: null,  // field of the chip currently being typed, or null
    activeNot: false,   // the chip being typed is an exclusion
    pos: 0,             // insertion gap: index in chips[] where the bar's
    // input sits, and where new content is inserted
    barSel: null,       // bar-wide selection {anchor, focus}: gap positions in
    // atom coordinates (each chip = one atom, the input =
    // one atom), or null when nothing is selected

    groups: [],         // groups of the last search (one per chip; for hit checks)
    tokens: [],         // flat tokens of the last search (for highlighting)
    lastQuery: "",      // serialized form of the last search (URL/export)
    results: [],        // spell ids matching the query
    display: [],        // results after filters + sort
    searchMs: 0,
    rendered: 0,        // rows currently in the table
    // tri-state per category: "" = any, "with" = must have, "without" = must
    // not have. See HAS_CATEGORY / applyFiltersAndSort.
    filters: {models: "", sounds: "", animations: "", fx: ""},
    sort: {key: "auto", dir: 1},
    // hidden columns — DISPLAY ONLY (they also trim the export's column set,
    // a visible choice). They never narrow the search: see FIELDS.all.
    // Mechanics ships VISIBLE (the storage key moved to v5 so the old
    // default does not linger for existing users).
    hiddenCols: {models: false, sounds: false, animations: false, fx: false, mechanics: false},
    // the payload columns left to right. DISPLAY ONLY, like hiddenCols, and
    // persisted the same way — deliberately absent from the URL (the user's
    // call): a shared link should show the recipient THEIR layout, and the
    // order changes nothing about which spells come back.
    colOrder: COL_ORDER.slice(),
};

/**
 * The active pack's indexes. Everything that renders or searches runs after
 * a pack has loaded, so the null window only exists during boot — this is
 * the one assertion of that, instead of a null check at every use.
 */
export function activeData(): SpellData {
    if (!state.data) throw new Error("no pack loaded yet");
    return state.data;
}

// Fields whose column is currently off screen. DISPLAY ONLY — this never
// reaches the search (see FIELDS.all in search.ts); its one job is letting
// ensureFieldVisible un-hide a column a shared link searches into.
export function hiddenFields(): Set<string> {
    const out = new Set<string>();
    for (const [col, fields] of Object.entries(COL_FIELDS)) {
        if (state.hiddenCols[col]) fields.forEach((f) => out.add(f));
    }
    return out;
}

/** "9.2.7.45745" -> "9.2.7" (used for clean URLs). */
export const shortVersion = (id: string): string => id.split(".").slice(0, 3).join(".");

/**
 * Display name for a version entry, without the build number — the label
 * from versions.json ("Shadowlands 9.2.7"), or the short patch when a pack
 * was built without --label (label then defaults to the full build id).
 */
export const versionLabel = (entry: VersionEntry): string =>
    entry.label && entry.label !== entry.id ? entry.label : shortVersion(entry.id);

/** File name without its extension. */
export const stripExt = (name: string): string => name.replace(/\.[^.]+$/, "");

/**
 * Wowhead site path prefix for the active pack's game version — "classic/"
 * for Vanilla, "" (retail) for everything else. Only /classic/ and retail
 * are permanent Wowhead sections, so any unmapped version falls back to
 * retail (see CFG.wowheadSitePrefix).
 */
const wowheadPrefix = (): string => {
    const major = state.version ? parseInt(state.version.id, 10) : 0;
    return (CFG.wowheadSitePrefix && CFG.wowheadSitePrefix[major]) || "";
};

/**
 * Fill a Wowhead URL template, injecting the version-appropriate site prefix
 * ({wh}) alongside the given vars. Templates with no {wh} slot (the model
 * viewer, which always stays on retail) are unaffected.
 */
export const wowheadUrl = (template: string, vars: Record<string, string | number>): string =>
    fillTemplate(template, {wh: wowheadPrefix(), ...vars});
