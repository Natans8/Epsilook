import {activateField, sizeInput} from "./bar";
import {scheduleSearch} from "./run";
import {qInput, state} from "./state";
import * as P from "../pills";
import * as Search from "../search";
import {$, el} from "../util";
/* ------------------------------------------------------ autocomplete */

let suggestIndex = -1;

/* Attachment names pushed the word list past 60 entries, so the dropdown
   * needs a ceiling — a one-letter prefix would otherwise cover the results. */
const SUGGEST_LIMIT = 12;

/* ------------------------------------------------- keyword autocomplete */

/* Every word a chip can autocomplete comes from one of two places: the
   * pill-type registry (src/pilltypes.ts), which names the CONTENT types a
   * column shows, and the META words below, which are axes rather than content
   * — they qualify whatever else the chip says.
   *
   * Data VALUES are deliberately never offered (no attachment-point names, no
   * file names, no creature names): the suggestion list is a menu of what can
   * be asked, not of the answers. */

/* Target-type words autocomplete in every column that shows the icons. Both
   * the words and their descriptions live with the mask tests they describe
   * (Search.TARGET_WORDS / TARGET_WORD_TITLES), so a word cannot come to be
   * testable and undescribed. */

/* `count` is an axis rather than content — it asks how BIG the column is
   * instead of what is in it — so it is named here rather than in the
   * pill-type registry. Its description is shared with the bar's highlighter
   * (fieldVocab below), which is what stops the suggestion list and the
   * tooltip teaching two different things. */
export const COUNT_TIP = "How many entries this column has — count >4, count =0";

/* Words that say nothing without their argument, so picking one from the
   * suggestion list leaves a trailing space ready for it. A numeric category
   * word (seat, speed, scale) is deliberately NOT here: it is a perfectly good
   * search on its own, and the value only narrows it. */
/* The help dialog reads this too, for the same distinction from the other end:
 * a word it lists is a search you can RUN, unless it is one of these — in which
 * case clicking it STARTS the word in the bar rather than running a question
 * nobody asked (`model:attach` is a filename search for the letters "attach"). */
export const ARGUMENT_WORDS = new Set([...Object.keys(Search.META_KEYWORDS), Search.COUNT_AXIS]);

/**
 * The words a field offers in autocomplete, with their descriptions: its
 * registered content types, its meta words, and the target words every
 * marked column shares.
 *   Null = the field has no category words at all.
 */
export function fieldCategories(field: string | null): { words: string[], titles: Record<string, string> } | null {
    const d = state.data;
    if (!d || !field) return null;
    // `id:` has no CONTENT types — its words are just its meta keywords, which
    // today is `xpac`. Read from the same registry as every other field's, so a
    // keyword cannot come to be searchable and unsuggested. Target words are
    // deliberately not appended: the id column draws no target icons.
    if (field === "id") {
        const words = Search.keywordsIn(field, d);
        const titles: Record<string, string> = {};
        for (const w of words) titles[w] = Search.META_KEYWORDS[w].hint;
        return words.length ? {words, titles} : null;
    }
    // mech joins the list because the non-visual categories moved there —
    // its words come from the same registry, so nothing else needed saying
    if (!["model", "sound", "anim", "fx", "mech"].includes(field)) return null;
    const {words, titles} = P.keywordsFor(field, d);
    // the count axis, wherever the column has anything to count
    if (Search.COUNT_SOURCES[field]) {
        words.push(Search.COUNT_AXIS);
        titles[Search.COUNT_AXIS] = COUNT_TIP;
    }
    for (const w of Search.keywordsIn(field, d)) {
        words.push(w);
        titles[w] = Search.META_KEYWORDS[w].hint;
    }
    // every column that draws target icons can be filtered by them
    return {
        words: [...words, ...Search.TARGET_WORDS],
        titles: {...titles, ...Search.TARGET_WORD_TITLES},
    };
}

export function updateSuggest(): void {
    const input = qInput;
    const box = $("#suggest");
    // inside a chip whose column has category words, those autocomplete
    // instead of field prefixes ("des" -> desaturate, "rep" -> replace)
    if (state.activeField) {
        return fieldCategories(state.activeField) ? updateCategorySuggest() : hideSuggest();
    }
    let word = (input.value.split(/\s+/).pop() ?? "").toLowerCase();
    // "-mec" suggests mech: as an EXCLUSION, and says so: the minus is part of
    // what the user is typing, so the suggestion has to show the tag they
    // would actually get. selectSuggestion re-reads the same "-" from the
    // input, so the two cannot disagree about which it is.
    const not = word.startsWith("-");
    if (not) word = word.slice(1);
    if (word.length < 2) return hideSuggest();
    // hidden columns don't suppress suggestions — an explicit field search
    // un-hides its column anyway (ensureFieldVisible)
    const matches = Object.entries(Search.FIELDS).filter(([key, f]) =>
        f.tab && (key.startsWith(word) || f.label.toLowerCase().startsWith(word)));
    if (!matches.length) return hideSuggest();

    box.textContent = "";
    matches.forEach(([key, f], i) => {
        const b = el("button", "suggest-item");
        markSuggestOption(b, i);
        b.appendChild(el("span", `suggest-field f-${key}${not ? " not" : ""}`,
            `${not ? "−" : ""}${key}:`));
        b.appendChild(el("span", "suggest-hint",
            not ? `hide spells by ${f.short}` : f.hint));
        b.dataset.field = key;
        box.appendChild(b);
    });
    suggestIndex = -1;
    box.hidden = false;
    qInput.setAttribute("aria-expanded", "true");
    qInput.removeAttribute("aria-activedescendant");
}

// suggest the column's category words while typing in its chip; picking
// one completes the word in place (it stays part of the chip's text)
function updateCategorySuggest(): void {
    const input = qInput;
    const box = $("#suggest");
    const word = (input.value.split(/\s+/).pop() ?? "").toLowerCase();
    if (!word) return hideSuggest();
    // non-null: updateSuggest only routes here when the field has categories
    const {words, titles} = fieldCategories(state.activeField)!;
    /* Prefix hits first, then words that merely *contain* what was typed —
 * that is what lets "hand" reach SpellLeftHand / HandRight / SpellHandOmni
 * and "seat" reach VehicleSeat1..8, which is how attachment points are
 * actually half-remembered. Matching is case-insensitive because the
 * attachment names are CamelCase while the category words are lower. */
    const lc = (w: string) => w.toLowerCase();
    const usable = words.filter((w: string) => lc(w) !== word);
    const prefix = usable.filter((w: string) => lc(w).startsWith(word));
    const inner = usable.filter((w: string) => !lc(w).startsWith(word) && lc(w).includes(word));
    const matches = [...prefix, ...inner].slice(0, SUGGEST_LIMIT);
    if (!matches.length) return hideSuggest();

    box.textContent = "";
    matches.forEach((w, i) => {
        const b = el("button", "suggest-item");
        markSuggestOption(b, i);
        b.appendChild(el("span", `suggest-field f-${state.activeField}`, w));
        // the parenthesized table name is build trivia — the plain half explains
        b.appendChild(el("span", "suggest-hint", (titles[w] || "").split(" (")[0]));
        b.dataset.word = String(w);
        box.appendChild(b);
    });
    suggestIndex = -1;
    box.hidden = false;
    qInput.setAttribute("aria-expanded", "true");
    qInput.removeAttribute("aria-activedescendant");
}

// complete the partial last word of the chip's text to the category word.
// a word that needs an argument (attach/boneset/count) leaves a trailing
// space ready for it (attach chest, count >4) rather than butting the caret
export function applyCategoryWord(word: string): void {
    const input = qInput;
    input.value = input.value.replace(/\S*$/, word) + (ARGUMENT_WORDS.has(word) ? " " : "");
    hideSuggest();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    sizeInput();
    scheduleSearch();
}

// a suggestion item is either a field prefix or a category word
export function pickSuggestItem(item: HTMLElement): void {
    if (item.dataset.word) applyCategoryWord(item.dataset.word);
    else selectSuggestion(item.dataset.field!);
}

export function hideSuggest(): void {
    $("#suggest").hidden = true;
    suggestIndex = -1;
    qInput.setAttribute("aria-expanded", "false");
    qInput.removeAttribute("aria-activedescendant");
}

// ARIA listbox wiring shared by both suggestion builders: each item is an
// option with a stable id so aria-activedescendant can point at it
function markSuggestOption(b: HTMLElement, i: number): void {
    b.id = `suggest-opt-${i}`;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", "false");
}

function selectSuggestion(field: string): void {
    const input = qInput;
    const not = /(^|\s)-\S*$/.test(input.value);
    input.value = input.value.replace(/\S+$/, "").trimEnd();
    activateField(field, {not});
}

/** The highlighted suggestion's index (-1 = none) — the keydown handler asks. */
export const currentSuggestIndex = (): number => suggestIndex;

/** Arrow-key navigation over the open suggestion list. */
export function moveSuggestSelection(delta: number): void {
    const items = [...$("#suggest").querySelectorAll<HTMLElement>(".suggest-item")];
    if (!items.length) return;
    suggestIndex = (suggestIndex + delta + items.length) % items.length;
    items.forEach((it, i) => {
        const on = i === suggestIndex;
        it.classList.toggle("selected", on);
        it.setAttribute("aria-selected", String(on));
    });
    qInput.setAttribute("aria-activedescendant", items[suggestIndex].id);
}

/** Pick the highlighted suggestion, or the first when none is highlighted. */
export function pickCurrentSuggestion(): void {
    const items = [...$("#suggest").querySelectorAll<HTMLElement>(".suggest-item")];
    if (items.length) pickSuggestItem(items[Math.max(suggestIndex, 0)]);
}
