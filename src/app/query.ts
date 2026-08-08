/* The bar's half of the query language — the four functions that CANNOT be
 * pure, because each one reads or writes the live search bar.
 *
 * The language itself (parseQueryParts, tokenSpans, serializeChips, canonField
 * and friends) moved to src/query.ts on 2026-08-08 and is re-exported below, so
 * the app modules that already import those names from here keep working while
 * a headless caller can reach the same functions without loading the GUI.
 */
import {syncBar} from "./bar";
import {qInput, state} from "./state";
import {ensureFieldsVisible} from "./url";
import {chipStr, parseQueryParts, tagStr, tokenizeQuery} from "../query";
import type {Chip} from "../query";
import type {QueryGroup} from "../search";

/* The query language, surfaced where the bar's callers already look for it. */
export {
    canonField, isChipField, tagStr, chipStr, serializeChips, parseQueryParts,
    tokenSpans, tokenizeQuery, groupsOf, ID_CMD_PASTE, ID_CMD_TYPED,
} from "../query";
export type {Chip, TokenSpan} from "../query";

/**
 * The bar as query text: the committed chips, with the live input's
 * contribution spliced in at state.pos — so a query typed before or between
 * chips serializes (and round-trips through the URL) in place.
 */
export function serializeQuery() {
    const parts = state.chips.map(chipStr);
    const at = Math.min(state.pos, state.chips.length);
    const inputText = qInput.value.trim();
    if (inputText) {
        parts.splice(at, 0, state.activeField ? tagStr(state.activeField, inputText, state.activeNot) : inputText);
    } else if (state.activeField) {
        parts.splice(at, 0, `${state.activeNot ? "-" : ""}${state.activeField}:`);
    }
    return parts.join(" ");
}

// put a parsed chip list in the bar, caret after the last one; syncBar
// pulls the trailing free run back into the input
export function setChips(parts: Chip[]): void {
    ensureFieldsVisible(parts);
    state.chips = parts;
    state.activeField = null;
    state.activeNot = false;
    qInput.value = "";
    state.pos = state.chips.length;
    syncBar();
}

// load a canonical string into the bar: field tags become committed chips
export function loadQueryString(str: string): void {
    setChips(parseQueryParts(str));
}

// group list for the engine: one group per chip + one for the live input,
// spliced in at state.pos so mid-bar typing groups correctly. Words in a
// group must match the same entity; groups AND together (not: true groups
// exclude instead).
export function currentGroups(): QueryGroup[] {
    const toGroup = (field: string, text: string, not?: boolean): QueryGroup | null => {
        const tokens = tokenizeQuery(text);
        return tokens.length ? {field, tokens, not: !!not} : null;
    };
    const groups = state.chips.map((c) => toGroup(c.field, c.text, c.not));
    const live = toGroup(state.activeField || "all", qInput.value, state.activeField ? state.activeNot : false);
    if (live) groups.splice(Math.min(state.pos, groups.length), 0, live);
    return groups.filter((g): g is QueryGroup => g !== null);
}
