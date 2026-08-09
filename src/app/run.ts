import {$} from "../dom";
import {recordBar} from "./bar";
import {currentGroups, serializeQuery} from "./query";
import {renderResults} from "./render";
import type {SpellData} from "../data";
import type {QueryGroup, QueryToken} from "../search";
import {activeData, state} from "./state";
import type {HitToken} from "./state";
import {stateToUrl} from "./url";
import * as P from "../pills";
import * as Search from "../search";
import {CFG} from "../config";
/* ------------------------------------------------------------ search */

let searchDebounce = 0;

/** Drop a pending debounced search (shareLink flushes the URL by hand). */
export function cancelScheduledSearch(): void {
    clearTimeout(searchDebounce);
}

export function scheduleSearch(): void {
    recordBar();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(), CFG.searchDebounceMs);
}

export function runSearch({push = false} = {}): void {
    recordBar();
    const data = state.data;
    if (!data) return;
    clearTimeout(searchDebounce);

    const raw = serializeQuery();
    state.lastQuery = raw;

    // too little typed to search — counted on the searched tokens, so field
    // prefixes don't count but an unknown "word:" (literal text) does.
    // Exact-ID tags (id:, and numeric kit IDs in sound:/anim:) always count
    // as enough: IDs below 10 are a single keystroke and the lookup is
    // exact and cheap
    const groups = currentGroups();
    const isExactId = (g: QueryGroup, t: QueryToken) => !!Search.FIELDS[g.field]?.orGroups
        || ((g.field === "sound" || g.field === "anim") && /^\d+$/.test(t.text));
    const typed = groups.reduce((n, g) => n + g.tokens.reduce((m, t) =>
        m + (isExactId(g, t) ? CFG.minQueryLength : t.text.length), 0), 0);
    if (typed < CFG.minQueryLength) {
        state.results = [];
        state.groups = [];
        state.tokens = [];
        state.searchMs = 0;
        applyFiltersAndSort();
        setStatus(raw ? `Type at least ${CFG.minQueryLength} characters` : "");
        stateToUrl(push);
        return;
    }
    const res = Search.searchGroups(groups, data);
    state.results = res.spellIds;
    state.groups = groups;
    // excluded terms never appear in the results: no highlighting for them.
    // Alternatives flatten to one token each — highlighting already asks
    // "does this pill match ANY query token", which is what `|` means.
    state.tokens = (groups.filter((g) => !g.not)
        .flatMap((g) => g.tokens.flatMap((t) =>
            (t.alts || [t.text]).map((a) => ({field: g.field, text: a})))) as HitToken[]);
    state.searchMs = res.ms;
    applyFiltersAndSort();
    stateToUrl(push);
}

/* One pack section: spell id -> its entries, or a plain Set of the spells
 * that have the thing at all (freeze and camo, which have nothing to list). */
type Section = Map<number, unknown[]> | Set<number>;

/** How many entries this section holds for one spell. A Set holds 0 or 1. */
const sizeIn = (s: Section, id: number): number =>
    s instanceof Set ? (s.has(id) ? 1 : 0) : (s.get(id) || []).length;

/* WHICH PACK SECTIONS FEED EACH COLUMN — one list, two readers. The count
 * sort asks how many entries they hold; the filter row asks whether any of
 * them has the spell at all. The fx column's sixteen used to be written out
 * in both places, so a section added to one silently stayed missing from
 * the other. Adding a section to a column is one entry here. */
const COLUMN_SECTIONS: Record<string, (d: SpellData) => Section[]> = {
    // the per-category rows once the pack has them (format 15+), else the
    // old flat file list. spellModels is DERIVED from spellModelCats when
    // both exist, so which one is read never changes WHICH spells qualify —
    // only whether a fid used twice counts once or twice.
    models: (d) => [d.spellModelCats.size ? d.spellModelCats : d.spellModels],
    sounds: (d) => [d.spellSounds],
    animations: (d) => [d.spellAnimKits, d.spellReplaceAnims, d.spellVisualAnims],
    // raw SpellEffect rows, not the rendered pill count — pills merge rows
    // that differ only in implicit target, and "how many effects does this
    // spell have" is the more meaningful sort (it is also what the export
    // lists, one line per row). Plus the five non-visual categories that
    // moved into this column, so the sort counts what the cell shows.
    mechanics: (d) => [d.spellMechanics, d.spellVehicles, d.spellInvisTypes,
        d.spellDetectTypes, d.spellKeybinds, d.spellSpeedMods],
    fx: (d) => [d.spellFx, d.spellDissolves, d.spellGlows, d.spellShadowies,
        d.spellGhostMats, d.spellTints, d.spellDesaturates, d.spellTransps,
        d.spellFreezes, d.spellCamos, d.spellScreens, d.spellMorphs,
        d.spellShapeshifts, d.spellSummons, d.spellObjects, d.spellScaleMods],
};

// multi-value columns sort by how many entries a row shows there — the
// count keys mirror the column names; clicking those headers starts at
// "most entries first" (the extreme spells are the interesting ones)
export const COUNT_SORTS = new Set(Object.keys(COLUMN_SECTIONS));

function entryCountFn(key: string): (id: number) => number {
    // callers gate on COUNT_SORTS, which is this record's own key set
    const sections = COLUMN_SECTIONS[key](activeData());
    return (id) => sections.reduce((n, s) => n + sizeIn(s, id), 0);
}

/* Headless animation groups, which the pill-type registry cannot state:
 * its `spells()` slot is id -> spell ids, and these have no id at all (a
 * "replace" pair is two anim ids, not one of anything), so the build keys
 * them BY SPELL. They still have a category word, so they still rank — one
 * line each, keyed the way carriersOf asks. */
const SPELL_KEYED_GROUPS: Record<string, (d: SpellData) => Map<number, unknown>> = {
    "anim:replace": (d) => d.spellReplaceAnims,
    "anim:passenger": (d) => d.spellPassengerAnims,
};

/* A category word's carrier set is a flatten of the registry's id -> spells
 * map, and applyFiltersAndSort re-ranks on every sort and filter toggle
 * without re-searching — so it is worth computing once per pack. Weak, so a
 * pack the user switches away from is not pinned in memory by this. */
const carrierCache = new WeakMap<SpellData, Map<string, Set<number> | null>>();

/**
 * The spells that really CARRY `word` in `field`, as opposed to merely
 * mentioning it in a file name. Null when the word names no category.
 *
 * Derived from the pill-type registry — the same declaration the cells
 * render from and the search selects with — so a new type ranks without
 * being listed a second time. The hand-written map this replaced had
 * drifted exactly as a second copy does: it never gained fx:object or
 * fx:scale, and it never gained a `mech` branch at all, so none of the five
 * categories that moved to that column had ranked since the move.
 *
 * Several types may share a word (ghost is fed by ShadowyEffect rows AND
 * Type-22 material recolors), which is why this unions rather than picking.
 */
function carriersOf(field: string, word: string, d: SpellData): Set<number> | null {
    let byWord = carrierCache.get(d);
    if (!byWord) carrierCache.set(d, byWord = new Map());
    const key = field + ":" + word;
    const cached = byWord.get(key);
    if (cached !== undefined) return cached;

    const found = new Set<number>();
    const add = (ids: Iterable<number>) => {
        for (const id of ids) found.add(id);
    };

    for (const type of P.typesFor(field)) {
        if (type.word !== word || !type.spells || (type.when && !type.when(d))) continue;
        const spells = type.spells(d);
        // a Set is the valueless shape (freeze/camo): it IS the spells
        if (spells instanceof Set) add(spells);
        else for (const ids of spells.values()) add(ids);
    }
    const grouped = SPELL_KEYED_GROUPS[key];
    if (grouped) add(grouped(d).keys());
    // model categories are keyed by CATEGORY — the pills are files rather
    // than ids of a type, so these words are registered without a `spells`
    if (field === "model") {
        for (const [cat, spells] of d.modelCatSpells) {
            if ((d.modelCatNames[cat] || "") === word) add(spells);
        }
    }

    // "nothing carries it" and "no such category" are the same answer to the
    // ranker, so a pack without the content ranks nothing rather than
    // sorting on a test that can never fire
    const out = found.size ? found : null;
    byWord.set(key, out);
    return out;
}

// Spells that actually carry a category a chip names rank above spells
// matched only through a file/texture name containing the same word —
// fx:desaturate must not drown under "desaturated" chain textures.
// Returns null when no chip names a category, else (id) -> hit count.
function categoryRanker(): ((id: number) => number) | null {
    const d = activeData();
    const tests: ((id: number) => boolean)[] = [];
    for (const g of state.groups) {
        if (g.not) continue;
        // each alternative ranks on its own — `fx:chain|dissolve` floats
        // both categories, the same way it selects both
        for (const t of g.tokens.flatMap((tk) =>
            (tk.alts || [tk.text]).map((a) => ({text: a})))) {
            const carriers = carriersOf(g.field, t.text, d);
            if (carriers) tests.push((id) => carriers.has(id));
            // a target word floats spells that really carry a row of that type
            // above the ones that merely have it in a file name
            // (beamtarget_onground). Resolved once via the field's own matcher.
            if (Search.TARGET_WORD_TITLES[t.text] && Search.FIELDS[g.field]) {
                const matches = Search.FIELDS[g.field].run([{text: t.text}], d);
                tests.push((id) => matches.has(id));
            }
        }
    }
    if (!tests.length) return null;
    return (id: number) => tests.reduce((n, f) => n + (f(id) ? 1 : 0), 0);
}

/* The columns the "Only spells with / without" row can filter on. The test
 * itself is COLUMN_SECTIONS asked "any at all?", so the sections are named
 * once; this is only WHICH columns offer the filter. Mechanics sorts but is
 * deliberately absent — it has no button, and a filter reachable only from a
 * URL could not be switched back off — so giving a future column a filter is
 * its name here plus its button in index.html. */
const FILTER_CATEGORIES = new Set(["models", "sounds", "animations", "fx"]);

export function applyFiltersAndSort(): void {
    const d = activeData();
    let list = state.results;

    const f = state.filters;
    const active = Object.keys(f).filter((k) => f[k] && FILTER_CATEGORIES.has(k));
    if (active.length) {
        // each active category is "with" (keep spells that HAVE it) or "without"
        // (keep spells that LACK it); several AND together. The sections are
        // resolved once per category, not once per spell.
        const gates = active.map((k) => ({want: f[k], sections: COLUMN_SECTIONS[k](d)}));
        list = list.filter((id) =>
            gates.every((g) => {
                const has = g.sections.some((s) => sizeIn(s, id) > 0);
                return g.want === "without" ? !has : has;
            }));
    } else {
        list = list.slice();
    }

    const {key, dir} = state.sort;
    if (key === "id") {
        list.sort((a, b) => (a - b) * dir);
    } else if (key === "name") {
        list.sort((a, b) =>
            d.names[d.spellIndex.get(a)!].localeCompare(d.names[d.spellIndex.get(b)!]) * dir || a - b);
    } else if (COUNT_SORTS.has(key)) {
        const count = entryCountFn(key);
        const c = new Map(list.map((id) => [id, count(id)]));
        list.sort((a, b) => (c.get(a)! - c.get(b)!) * dir || a - b);
    } else { // auto — relevance is the default; the ID header gives ID order
        // Ranked against tokens from EVERY field, not just name:/free text.
        // Someone searching `model:fireball` wants the spell called Fireball
        // first, and a token that names no spell simply leaves every row at
        // the same rank, where sortByRelevance's tiebreak restores ID order —
        // so this degrades to the old behaviour instead of scrambling it.
        const words = state.tokens
            .map((t) => t.text)
            // a comparison and a bare number are not words and cannot rank.
            // This asks isComparison, NOT hasOperator: a name may OPEN with an
            // operator character (`<INTERNAL>…`), and the loose predicate threw
            // those six spells out of their own relevance ranking.
            .filter((s) => !P.isComparison(s) && !/^#?\d+$/.test(s));
        if (words.length) {
            Search.sortByRelevance(list, words.join(" "), d);
        } else {
            list.sort((a, b) => a - b);
        }
        // exact category-word chips float their category's spells on top
        // (stable sort: the relevance/id order above survives within ranks)
        const rank = categoryRanker();
        if (rank) list.sort((a, b) => rank(b) - rank(a));
    }

    state.display = list;
    renderResults();
}

export function setStatus(text: string): void {
    $("#status").textContent = text;
}
