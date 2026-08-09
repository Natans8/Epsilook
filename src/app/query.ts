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
import {chipStr, groupsOf, parseQueryParts, tagStr} from "../query";
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
//
// The live input becomes a CHIP and the whole list goes through groupsOf, so
// this module owns only the one thing it can: where the live text sits. What
// a chip tokenizes to, and that an empty one is dropped, are the language's
// rules and are stated once. Splicing chips rather than groups is also what
// makes the index right — state.pos counts chips, so dropping the empties
// first would shift it.
export function currentGroups(): QueryGroup[] {
    const chips = [...state.chips];
    chips.splice(Math.min(state.pos, chips.length), 0, {
        field: state.activeField || "all",
        text: qInput.value,
        not: state.activeField ? state.activeNot : false,
    });
    return groupsOf(chips);
}
