import {ARGUMENT_WORDS, COUNT_TIP, fieldCategories} from "./autocomplete";
import {state} from "./state";
import * as P from "../pills";
import * as Search from "../search";
import {$, $$, el} from "../util";
/* ---------------------------------------------------- the help dialog

   * THE HELP IS AN ANATOMY DIAGRAM OF A QUERY. The app already draws one for a
   * spell — a pill is its parts, labelled — and it already draws one for a
   * search, in the bar: six marks that say what the grammar understood. Nothing
   * ever explained those marks, so the dialog's whole job is to name them once
   * and get out of the way.
   *
   * NOTHING HERE IS HAND-COPIED, and that is the point rather than a flourish.
   * The specimen is rendered by `decorateExamples()` through the SAME parser and
   * the SAME highlighter as the bar, so an example cannot describe a syntax the
   * app stopped supporting. The legend's swatches are the real classes on real
   * text. The vocabulary is `fieldCategories()`, so a category word that
   * autocompletes is a category word the help lists. The target icons come from
   * `P.TARGET_ICONS`.
   *
   * The hand-written version of all three had already drifted: it taught
   * "Shift-click excludes" a year after Shift started ADDING, and its category
   * lists were missing `triggers`, `origin` and `motion`.
   *
   * DETAIL LIVES IN TOOLTIPS. Every generated word carries the registry's own
   * one-line hint, so the visible surface can stay the SHAPE of the language
   * while the meaning of any single word is one hover away. */

/* The specimen: one query carrying every mark the bar can draw, and a real
 * search rather than a sentence about one — it narrows 274,486 spells to one
 * ("Battle Suit Firing at Fel Reaver", 253062 on 9.2.7). Kept here beside the
 * legend that dissects it, because the two have to agree: a mark with nothing
 * to point at in the specimen is a legend row that never lights.
 *
 * It reaches the DOM as a `data-search` attribute like every other example, so
 * it is drawn by decorateExamples() and needs no render path of its own. */
export const SPECIMEN = 'model:"caster attach hand|chest" -mech:school_damage "fel reaver"';

/* Which class in the rendered specimen answers to which legend row.
 *
 * ORDER IS SIGNIFICANT — a span is claimed by the FIRST entry that matches it.
 * A capsule's opening half carries `bar-kw bar-cap-l`, so it is both a category
 * word and part of a word-plus-value; the capsule wins, because that is the
 * larger thing the reader is being shown. */
const MARKS: { mark: string; sel: string }[] = [
    {mark: "field", sel: ".qchip-field"},
    {mark: "alt", sel: ".bar-alt"},
    {mark: "value", sel: "[class*='bar-cap-']"},
    {mark: "phrase", sel: ".bar-phrase"},
    {mark: "word", sel: ".bar-kw"},
];

/**
 * Tag the specimen's spans with the legend row each belongs to.
 *
 * Runs AFTER decorateExamples(), because it reads what that produced: the
 * marks are found by the classes the highlighter wrote, never re-derived from
 * the query text. A mark that stops being drawn stops being tagged, and its
 * legend row simply never lights — which is visible, unlike a stale sentence.
 */
function markSpecimen(): void {
    const box = $("#help-specimen");
    if (!box) return;
    for (const {mark, sel} of MARKS) {
        for (const span of $$(sel, box)) {
            if (!span.dataset.mark) span.dataset.mark = mark;
        }
    }
    // exclusion is the whole chip, not one span inside it: what the reader is
    // being shown is a tag drawn in the danger tone from its prefix outwards
    for (const chip of $$(".exchip.not", box)) chip.dataset.mark = "not";
}

/**
 * Light the specimen part a legend row names, and vice versa.
 *
 * One delegated listener over the section, so a legend row and a specimen span
 * are the same gesture from either end — the dialog's one interactive idea, and
 * the reason the legend beats a list of prose definitions: it points.
 */
function wireLegend(): void {
    const box = $(".help-anatomy");
    if (!box) return;
    const light = (mark: string | null) => {
        box.classList.toggle("lit", !!mark);
        for (const n of $$("[data-mark]", box)) n.classList.toggle("lit", n.dataset.mark === mark);
        /* A capsule is drawn in several pieces and an alternation inside its
         * value takes a mark of its own, so lighting "word and its value"
         * would leave a hole at the `|`. The pieces already share the
         * highlighter's own `data-cap` range — extend along that rather than
         * re-deriving which spans belong together. */
        for (const n of $$("#help-specimen .lit[data-cap]", box)) {
            for (const sib of $$(`[data-cap="${n.dataset.cap}"]`, box)) sib.classList.add("lit");
        }
    };
    const at = (e: Event) => {
        const n = e.target instanceof Element ? e.target.closest("[data-mark]") : null;
        light(n instanceof HTMLElement ? n.dataset.mark! : null);
    };
    box.addEventListener("mouseover", at);
    box.addEventListener("mouseout", (e) => {
        if (!box.contains(e.relatedTarget as Node)) light(null);
    });
    // keyboard parity: the legend rows are focusable, so tabbing through them
    // teaches the same thing hovering does
    box.addEventListener("focusin", at);
    box.addEventListener("focusout", (e) => {
        if (!box.contains(e.relatedTarget as Node)) light(null);
    });
}

/**
 * One word chip. Most RUN their search; the few that say nothing without an
 * argument START in the bar instead, with the caret where their value goes.
 *
 * The split is `ARGUMENT_WORDS`, the autocomplete's own — the same set that
 * decides whether picking a suggestion leaves a trailing space. So a word
 * behaves the same way whether it is reached from the help or from the
 * dropdown, and a fifth such word gets both behaviours by being declared once.
 */
function wordChip(field: string, word: string, tip: string): HTMLElement {
    const b = el("button", "vocab-word", word);
    b.type = "button";
    if (ARGUMENT_WORDS.has(word)) {
        b.classList.add("takes-value");
        b.dataset.start = word;
        b.dataset.field = field;
    } else {
        b.dataset.search = `${field}:${word}`;
    }
    // the registry's hint verbatim — the suggestion list shows the same string,
    // so a word is described identically wherever the app names it
    if (tip) b.title = tip;
    return b;
}

/* The words that mean the same thing in every column, so they are listed once
 * rather than five times: the target-mask tests, and the count axis. */
const SHARED = new Set<string>([...Search.TARGET_WORDS, Search.COUNT_AXIS]);

/**
 * A field's own category words, deduped and with the shared ones lifted out.
 *
 * `fieldCategories` concatenates several sources and can name one word twice —
 * `ghost` has two feeding types, `attach` is both a model category and a
 * keyword — so first spelling wins, along with its hint.
 */
function ownWords(field: string): { word: string; tip: string }[] {
    const cats = fieldCategories(field);
    if (!cats) return [];
    const seen = new Set<string>();
    const out: { word: string; tip: string }[] = [];
    for (const w of cats.words) {
        if (SHARED.has(w) || seen.has(w)) continue;
        seen.add(w);
        out.push({word: w, tip: cats.titles[w] || ""});
    }
    return out;
}

/**
 * The words every marked column shares, each behind the glyph the pills draw
 * it as.
 *
 * THE WORD -> GLYPH PAIRING IS ASKED, NOT TABULATED: a word takes the first
 * icon whose own bits its test accepts. So the legend cannot pair a word with
 * a glyph the search would disagree about, and `both` falls out with no glyph
 * and no special case — it is caster AND target at once, which no single bit
 * spells and which this project has already refused to fuse into one glyph
 * three times (illegible at 12px).
 */
function sharedRow(): HTMLElement {
    const row = el("div", "vocab-row vocab-shared");
    const label = el("span", "vocab-field", "any column");
    label.title = "These work in every column that draws target icons";
    row.appendChild(label);
    const words = el("div", "vocab-words");
    for (const w of Search.TARGET_WORDS) {
        const b = wordChip("model", w, Search.TARGET_WORD_TITLES[w] || "");
        const icon = P.TARGET_ICONS.find((i) => Search.TARGET_TESTS[w](i.bits));
        if (icon) {
            const g = el("span", `ticon ${icon.cls}`);
            g.innerHTML = icon.svg;
            b.prepend(g);
        }
        words.appendChild(b);
    }
    words.appendChild(wordChip("model", Search.COUNT_AXIS, COUNT_TIP));
    row.appendChild(words);
    return row;
}

/**
 * Build the vocabulary: one row per column that has words of its own, then the
 * words every column shares.
 *
 * A column with nothing to list is left out entirely rather than shown empty —
 * Sounds has no content types, only the shared words, and a row reading
 * "Sound:" followed by nothing says the pack is broken.
 */
function buildVocab(): void {
    const box = $("#help-vocab");
    if (!box || !state.data) return;
    box.textContent = "";
    for (const field of ["model", "sound", "anim", "fx", "mech"]) {
        const words = ownWords(field);
        if (!words.length) continue;
        const row = el("div", "vocab-row");
        const label = el("span", `vocab-field f-${field}`, `${field}:`);
        label.title = Search.FIELDS[field].hint || "";
        row.appendChild(label);
        const list = el("div", "vocab-words");
        for (const {word, tip} of words) list.appendChild(wordChip(field, word, tip));
        row.appendChild(list);
        box.appendChild(row);
    }
    box.appendChild(sharedRow());
}

/**
 * Fill in everything the dialog generates.
 *
 * Called from boot AFTER decorateExamples(), and after the pack has loaded —
 * the vocabulary is the loaded pack's, so a word is never offered in a version
 * that has no data for it.
 */
export function buildHelp(): void {
    buildVocab();
    markSpecimen();
    wireLegend();
}
