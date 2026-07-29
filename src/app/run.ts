import {$} from "../util";
import {TARGET_WORD_TITLES} from "./autocomplete";
import {recordBar} from "./bar";
import {currentGroups, serializeQuery} from "./query";
import {renderResults} from "./render";
import type {SpellData} from "../data";
import type {QueryGroup, QueryToken} from "../search";
import {activeData, state} from "./state";
import type {HitToken} from "./state";
import {stateToUrl} from "./url";
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

// multi-value columns sort by how many entries a row shows there — the
// count keys mirror the column names; clicking those headers starts at
// "most entries first" (the extreme spells are the interesting ones)
export const COUNT_SORTS = new Set(["models", "sounds", "animations", "fx", "mechanics"]);

function entryCountFn(key: string): (id: number) => number {
    const d = activeData();
    const len = (m: Map<number, unknown[]>, id: number) => (m.get(id) || []).length;
    switch (key) {
        case "models":
            return (id) =>
                d.spellModelCats.size ? len(d.spellModelCats, id) : len(d.spellModels, id);
        case "sounds":
            return (id) => len(d.spellSounds, id);
        case "animations":
            return (id) =>
                len(d.spellAnimKits, id) + len(d.spellReplaceAnims, id) + len(d.spellVisualAnims, id);
        // raw SpellEffect rows, not the rendered pill count — pills merge rows
        // that differ only in implicit target, and "how many effects does this
        // spell have" is the more meaningful sort (it is also what the export
        // lists, one line per row)
        case "mechanics":
            // the SpellEffect rows plus the non-visual categories that moved
            // into this column, so the sort counts what the cell shows
            return (id) => len(d.spellMechanics, id)
                + len(d.spellVehicles, id) + len(d.spellInvisTypes, id)
                + len(d.spellDetectTypes, id) + len(d.spellKeybinds, id)
                + len(d.spellSpeedMods, id);
        case "fx":
            return (id) =>
                len(d.spellFx, id) + len(d.spellDissolves, id) + len(d.spellGlows, id)
                + len(d.spellShadowies, id) + len(d.spellGhostMats, id) + len(d.spellTints, id)
                + len(d.spellDesaturates, id) + len(d.spellTransps, id)
                + (d.spellFreezes.has(id) ? 1 : 0) + (d.spellCamos.has(id) ? 1 : 0)
                + len(d.spellScreens, id) + len(d.spellMorphs, id)
                + len(d.spellShapeshifts, id) + len(d.spellSummons, id)
                + len(d.spellObjects, id) + len(d.spellScaleMods, id);
        default: // unreachable: callers gate on COUNT_SORTS
            return () => 0;
    }
}

// Spells that actually carry a category a chip names rank above spells
// matched only through a file/texture name containing the same word —
// fx:desaturate must not drown under "desaturated" chain textures.
// Returns null when no chip names a category, else (id) -> hit count.
function categoryRanker(): ((id: number) => number) | null {
    const d = activeData();
    const FX_SETS: Record<string, Map<number, unknown> | Set<number>> = {
        chain: d.spellFx, dissolve: d.spellDissolves, glow: d.spellGlows,
        tint: d.spellTints, desaturate: d.spellDesaturates,
        transparency: d.spellTransps, freeze: d.spellFreezes, camo: d.spellCamos,
        screen: d.spellScreens, shapeshift: d.spellShapeshifts,
        morph: d.spellMorphs, summon: d.spellSummons,
    };
    const tests: ((id: number) => boolean)[] = [];
    for (const g of state.groups) {
        if (g.not) continue;
        // each alternative ranks on its own — `fx:chain|dissolve` floats
        // both categories, the same way it selects both
        for (const t of g.tokens.flatMap((tk) =>
            (tk.alts || [tk.text]).map((a) => ({text: a})))) {
            if (g.field === "fx") {
                if (t.text === "ghost" || t.text === "shadowy") {
                    tests.push((id) => d.spellShadowies.has(id) || d.spellGhostMats.has(id));
                } else if (FX_SETS[t.text]) {
                    const s = FX_SETS[t.text];
                    tests.push((id) => s.has(id));
                }
            } else if (g.field === "model") {
                for (const [cat, spells] of d.modelCatSpells) {
                    if ((d.modelCatNames[cat] || "") === t.text) tests.push((id) => spells.has(id));
                }
            } else if (g.field === "anim" && t.text === "stance") {
                tests.push((id) => d.spellReplaceAnims.has(id));
            }
            // a target word floats spells that really carry a row of that type
            // above the ones that merely have it in a file name
            // (beamtarget_onground). Resolved once via the field's own matcher.
            if (TARGET_WORD_TITLES[t.text] && Search.FIELDS[g.field]) {
                const matches = Search.FIELDS[g.field].run([{text: t.text}], d);
                tests.push((id) => matches.has(id));
            }
        }
    }
    if (!tests.length) return null;
    return (id: number) => tests.reduce((n, f) => n + (f(id) ? 1 : 0), 0);
}

// presence test per filter category — the union of every pack section that
// feeds that column. Both the "Only spells with / without" filter row and
// the URL (only= / without=) read these; giving a future column a filter is
// a one-line addition here plus its button in index.html.
const HAS_CATEGORY: Record<string, (d: SpellData, id: number) => boolean> = {
    models: (d, id) => d.spellModels.has(id),
    sounds: (d, id) => d.spellSounds.has(id),
    animations: (d, id) =>
        d.spellAnimKits.has(id) || d.spellReplaceAnims.has(id) || d.spellVisualAnims.has(id),
    // the five non-visual sections (vehicles, invis, detect, keybinds,
    // speed) moved to the Mechanics column and are no longer fx content
    fx: (d, id) =>
        d.spellFx.has(id) || d.spellDissolves.has(id) || d.spellGlows.has(id) ||
        d.spellShadowies.has(id) || d.spellGhostMats.has(id) || d.spellTints.has(id) ||
        d.spellDesaturates.has(id) || d.spellTransps.has(id) ||
        d.spellFreezes.has(id) || d.spellCamos.has(id) || d.spellScreens.has(id) ||
        d.spellMorphs.has(id) || d.spellShapeshifts.has(id) || d.spellSummons.has(id) ||
        d.spellObjects.has(id) || d.spellScaleMods.has(id),
};

export function applyFiltersAndSort(): void {
    const d = activeData();
    let list = state.results;

    const f = state.filters;
    const active = Object.keys(f).filter((k) => f[k]);
    if (active.length) {
        // each active category is "with" (keep spells that HAVE it) or "without"
        // (keep spells that LACK it); several AND together
        list = list.filter((id) =>
            active.every((k) => {
                const has = HAS_CATEGORY[k](d, id);
                return f[k] === "without" ? !has : has;
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
            .filter((s) => !Search.hasOperator(s) && !/^#?\d+$/.test(s));
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
