import {COUNT_TIP, fieldCategories} from "./autocomplete";
import {parseQueryParts, tokenSpans} from "./query";
import type {TokenSpan} from "./query";
import type {SpellData} from "../data";
import {qInput, state} from "./state";
import * as P from "../pills";
import * as Search from "../search";
import {$, $$, el} from "../util";
/* ------------------------------------------------ bar syntax highlighting

   * THE BAR HIGHLIGHTS, IT DOES NOT RE-RENDER. Every character stays where it
   * was typed and stays selectable and copyable — the bar's text is what gets
   * pasted into Discord and into another search bar, so it must never become a
   * row of mini-pills that reads differently from what the user wrote. Colour
   * goes OVER the exact characters instead.
   *
   * Two surfaces, one classifier:
   *   - a committed chip's text is our own DOM, so its spans carry `title` and
   *     hover natively;
   *   - an <input> cannot hold markup, so the same spans are drawn on a
   *     backdrop (#qhl) sitting exactly under the input, whose own text goes
   *     transparent. The backdrop is pointer-events: none — the input keeps
   *     every click, caret and selection — so its tooltip is served by
   *     hit-testing the spans under the pointer (barHover below).
   *
   * IT READS THE SAME TOKENS THE SEARCH DOES. Both walk tokenSpans, which is
   * what makes it impossible for a query to match one way and be drawn another
   * — the failure that made `fire | frost` search correctly and highlight as
   * nothing at all.
   *
   * ONE SHAPE IS MARKED: a word, optionally followed by its value. That covers
   * `attach chest`, `boneset upper body`, `seat >2` and `count >4` alike, and
   * they all draw as one capsule, because in the grammar they are one thing.
   * Nothing is ever marked WRONG: a word the vocabulary has not heard of is an
   * ordinary text search, which is exactly what it does. */

/** One classified run of a chip's text (concatenating runs restores it). */
interface BarRun {
    text: string;
    cls: string;
    tip: string;
    cap: string;
}

type PushRun = (t: string, cls?: string, tip?: string, cap?: string) => void;

const PHRASE_TIP = "Exact phrase — these words together, in this order";
const ALT_TIP = "Either side matches";

/* The vocabulary is rebuilt on every keystroke otherwise — it walks the
 * whole pill-type registry — so it is cached per field until the pack
 * changes underneath it. */
interface BarVocab {
    /** category / target word -> description */
    words: Map<string, string>;
    /** words that take a comparison after them */
    valued: Set<string>;
    /** meta keywords (they take a name) */
    keywords: Set<string>;
}

let barVocab: { data: SpellData | null; byField: Map<string, BarVocab> } =
    {data: null, byField: new Map()};

/**
 * Every word one field's chips can carry, and which of them take a value.
 * THE WORDS ARE THE AUTOCOMPLETE'S OWN LIST, read from `fieldCategories`
 * rather than reassembled here — a word that autocompletes must highlight,
 * or the two are describing different languages. All this adds is which of
 * them take something after them, which the suggestion list has no use for.
 */
function fieldVocab(field: string): BarVocab {
    const d = state.data;
    if (barVocab.data !== d) barVocab = {data: d, byField: new Map()};
    const cached = barVocab.byField.get(field);
    if (cached) return cached;
    const v: BarVocab = {words: new Map(), valued: new Set(), keywords: new Set()};
    // never CACHE an empty vocabulary from a pack-less render (the bar is
    // drawn from the URL before the pack finishes loading) — the cache key
    // is the data object, and null is a legitimate value of it
    if (!d) return v;
    const cats = fieldCategories(field);
    if (cats) {
        for (const w of cats.words) v.words.set(w, cats.titles[w] || "");
        // a category word whose pill type carries a number takes a comparison
        for (const t of P.typesFor(field)) {
            if (t.numeric && t.word && (!t.when || t.when(d))) v.valued.add(t.word);
        }
        if (Search.COUNT_SOURCES[field]) v.valued.add(Search.COUNT_AXIS);
    }
    for (const w of Search.keywordsIn(field, d)) v.keywords.add(w);
    barVocab.byField.set(field, v);
    return v;
}

/** A comparison token that WROTE its operator (`>2`, `<=-50`). */
const isComparison = (s: string) => P.isValue(s) && P.hasOperator(s);

/**
 * Does the span at `i` take the span after it as its value?
 *
 * Both kinds of value are ONE token, and one function answers for both, so
 * the bar draws a single capsule shape and the user is told a single rule.
 * A meta keyword takes whatever token follows (search.js owns that call, so
 * the capsule always covers exactly what the matcher consumed); a numeric
 * word takes the one VALUE after it — a comparison, or the bare number that
 * means `=` — which pills.js owns for the same reason.
 *
 * "Is a value" is asked of every ALTERNATIVE, not of the raw text, so
 * `count >4|>9` capsules exactly like `count >4`: the engine runs an
 * alternation as one combination per branch, and each of these branches is
 * a value, so the whole token is one.
 */
function valueRun(v: BarVocab, spans: {text: string, alts: string[]}[], i: number): number {
    const word = spans[i].text;
    if (v.keywords.has(word)) return Search.keywordRun(spans, i);
    const next = spans[i + 1];
    if (v.valued.has(word) && next && next.alts.every((a) => P.isValue(a))) return 1;
    return 0;
}

/**
 * Classify one word. Returns "" for anything the grammar does not know —
 * which is drawn as plain text, because that is what it searches as.
 *
 * `lone` says this word is the chip's only token, which is the one case
 * where a bare comparison means something by itself (`model:>4`, the count
 * shorthand). A comparison anywhere else is either part of a capsule —
 * handled by the caller — or attached to nothing, and marking it then would
 * claim a meaning it does not have.
 */
function classifyAtom(v: BarVocab, word: string, lone: boolean = false): {cls: string, tip: string} {
    const lower = word.trim().toLowerCase();
    if (v.words.has(lower)) return {cls: "bar-kw", tip: v.words.get(lower)!};
    if (lone && isComparison(lower) && v.valued.has(Search.COUNT_AXIS)) {
        return {cls: "bar-num", tip: `Short for ${Search.COUNT_AXIS} — ${COUNT_TIP}`};
    }
    return {cls: "", tip: ""};
}

/**
 * Split one chip's text into classified runs that concatenate back to it
 * EXACTLY — whitespace and quotes included. That is the invariant the
 * backdrop depends on: it has to occupy the same glyphs as the input.
 */
function classifyBar(field: string, text: string): BarRun[] {
    const v = fieldVocab(field);
    const out: BarRun[] = [];
    const push: PushRun = (t, cls = "", tip = "", cap = "") => {
        if (t) out.push({text: t, cls, tip, cap});
    };
    const spans = tokenSpans(text);
    let at = 0;
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i];
        if (s.start > at) push(text.slice(at, s.start)); // the gap before it
        const taken = valueRun(v, spans, i);
        if (taken) {
            // one capsule over the word and its value, whatever lies between.
            // Both halves carry the WHOLE capsule's character range, so the
            // caret can be asked whether it is inside this one thing rather
            // than inside one of its two drawing halves.
            const last = spans[i + taken];
            const tip = v.words.get(s.text) || "";
            const cap = `${s.start}:${last.end}`;
            push(text.slice(s.start, s.end), "bar-tok bar-kw bar-cap-l", tip, cap);
            emitCapValue(text.slice(s.end, last.end), last, tip, cap, push);
            at = last.end;
            i += taken;
            continue;
        }
        emitSpan(v, text, s, push, spans.length === 1);
        at = s.end;
    }
    if (at < text.length) push(text.slice(at));
    return out;
}

/**
 * The separator a span actually alternates on, or "" if it does not.
 *
 * IT COMES FROM THE SPAN'S OWN `alts`, never from "does the text contain a
 * bar" — so what is drawn as an alternation is exactly what the engine
 * alternated on. `id:133,134` gets a gold comma because altsOf split it;
 * the comma in `hunter, tame beast` stays ordinary text because it did not,
 * and marking that one would promise an OR the search never performs.
 */
const altSep = (s: TokenSpan): string => (!s.quoted && s.alts.length > 1
    ? (s.text.includes("|") ? "|" : ",") : "");

/** Split on a separator, keeping the separators as pieces of their own. */
function splitKeepSep(text: string, sep: string): string[] {
    const out: string[] = [];
    for (const part of text.split(sep)) out.push(part, sep);
    out.pop();
    return out;
}

/**
 * One span's own characters, with its alternation bars picked out. The
 * pieces are emitted whole (spaces included) so they still concatenate back
 * to the source — `fire | frost` keeps its air and gets a gold bar.
 */
function emitSpan(v: BarVocab, text: string, s: TokenSpan, push: PushRun, lone: boolean): void {
    const raw = text.slice(s.start, s.end);
    if (s.quoted) return push(raw, "bar-tok bar-phrase", PHRASE_TIP);
    const sep = altSep(s);
    if (!sep) {
        const {cls, tip} = classifyAtom(v, raw, lone);
        return push(raw, cls && `bar-tok ${cls}`, tip);
    }
    // keep the separators as their own runs; classify what sits between
    for (const piece of splitKeepSep(raw, sep)) {
        if (piece === sep) {
            push(piece, "bar-tok bar-alt", ALT_TIP);
            continue;
        }
        const {cls, tip} = classifyAtom(v, piece);
        push(piece, cls && `bar-tok ${cls}`, tip);
    }
}

/**
 * The VALUE half of a capsule — a keyword's one token, plus the space in
 * front of it.
 *
 * It goes through the same alternation split as any other span, because an
 * alternation means the same thing wherever it is written:
 * `model:"attach hand|chest"` searches both points, so its bar is marked
 * like the bar in `model:hand|chest`. It used to be emitted as one flat run
 * and came out plain — the query worked and the bar said nothing about it.
 *
 * The capsule's fill is carried across every piece (and its character range
 * with it, so markCaretCapsule still lights the whole thing as one), with
 * the rounding kept on the far end only — otherwise the split would show as
 * a notch in a shape that has to read as one object.
 *
 * What sits between the bars is NOT classified: inside a capsule every
 * token is the keyword's value, so a piece that happens to spell a category
 * word (`attach chest|missile`) is still an attachment name here, and
 * tinting it gold would claim a meaning the matcher does not give it.
 */
function emitCapValue(raw: string, s: TokenSpan, tip: string, cap: string, push: PushRun): void {
    const sep = altSep(s);
    if (!sep) return push(raw, "bar-tok bar-cap-r", tip, cap);
    const pieces = splitKeepSep(raw, sep);
    pieces.forEach((piece, i) => {
        const end = i === pieces.length - 1 ? "bar-cap-r" : "bar-cap-m";
        const alt = piece === sep;
        push(piece, `bar-tok ${alt ? "bar-alt " : ""}${end}`, alt ? ALT_TIP : tip, cap);
    });
}

/**
 * The classified runs as nodes. Unclassified runs stay bare text nodes, so
 * only the marked ones become elements — which is also what makes the
 * backdrop's hit-test cheap.
 */
export function highlightBar(field: string, text: string): DocumentFragment {
    const frag = document.createDocumentFragment();
    for (const run of classifyBar(field, text)) {
        if (!run.cls) {
            frag.appendChild(document.createTextNode(run.text));
            continue;
        }
        const s = el("span", run.cls, run.text);
        if (run.tip) s.title = run.tip;
        if (run.cap) s.dataset.cap = run.cap;
        frag.appendChild(s);
    }
    return frag;
}

/**
 * Redraw the backdrop under the live input and park it exactly over the
 * input's box. Called from sizeInput, so every path that changes the value
 * or the width already goes through it.
 */
export function syncHighlight() {
    const box = document.getElementById("qhl");
    if (!box) return;
    const wrap = $("#editwrap");
    const value = qInput.value;
    wrap.classList.toggle("hl", !!value);
    box.textContent = "";
    if (!value) return;
    box.appendChild(highlightBar(state.activeField || "all", value));
    // #editwrap is the offsetParent of both, so the input's own offsets are
    // already in the backdrop's coordinate system
    box.style.left = qInput.offsetLeft + "px";
    box.style.top = qInput.offsetTop + "px";
    box.style.width = qInput.offsetWidth + "px";
    box.style.height = qInput.offsetHeight + "px";
    box.scrollLeft = qInput.scrollLeft;
    markCaretCapsule();
}

/* ------------------------------------------- inside a capsule, or outside
   *
   * A keyword and its value draw as one capsule, and how far that value reaches
   * is decided by the data — which left it as something you could observe but
   * never state, and never quite locate. Two answers, in that order:
   *
   *   THE CAPSULE LIGHTS UP while the caret is inside its characters, so walking
   *   the caret across the bar shows you exactly where the value begins and ends.
   *   "QUOTES" DECIDE. Quoting the value states its extent outright, and the
   *   capsule redraws around what you said. That is deliberately the ONLY way to
   *   overrule the data: it is text you can see, copy, share and edit by hand,
   *   so the choice never becomes a mode the bar remembers or a keystroke you
   *   had to be told about. A resize shortcut was built here and dropped for
   *   exactly that reason — it could do nothing quotes cannot, and it collided
   *   with the browser's own Alt+← (Back). */

/** Light the capsule the caret is sitting in (none, when the bar is unfocused). */
export function markCaretCapsule() {
    const box = document.getElementById("qhl");
    if (!box) return;
    const live = document.activeElement === qInput;
    // selectionStart/End are null only for non-text inputs, which #q is not
    const from = live ? qInput.selectionStart ?? -1 : -1;
    const to = live ? qInput.selectionEnd ?? -1 : -1;
    for (const span of box.children) {
        const cap = (span as HTMLElement).dataset.cap;
        if (!cap) continue;
        const [s, e] = cap.split(":").map(Number);
        span.classList.toggle("on", from >= s && to <= e);
    }
}

/**
 * The backdrop cannot receive :hover (it is inert by design), so the input
 * serves the tooltip for whatever span sits under the pointer — which is
 * what gives a word in the input the same hover behaviour it has inside a
 * committed chip.
 */
export function barHover(e: MouseEvent) {
    const box = document.getElementById("qhl");
    if (!box) return;
    let found = null;
    for (const span of box.children) {
        const r = span.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right
            && e.clientY >= r.top && e.clientY <= r.bottom) {
            found = (span as HTMLElement);
            break;
        }
    }
    for (const span of box.children) span.classList.toggle("hover", span === found);
    const tip = found ? found.title : "";
    if (qInput.title !== tip) qInput.title = tip;
}

/**
 * Draw every `data-search` example as the chips it would actually make.
 *
 * The help used to spell its examples as code text, which left the reader to
 * translate `model:"attach chest"` into the thing they would see in the bar.
 * Building them out of the SAME parser and the SAME highlighter as the bar
 * means an example can never drift from what clicking it does — and a syntax
 * the app stops supporting stops rendering as syntax.
 *
 * Called after the pack loads, because the marking needs its vocabulary.
 */
export function decorateExamples() {
    for (const btn of $$("[data-search]")) {
        const q = btn.dataset.search;
        // Epsilon-command examples are meant to be read as commands, and a
        // chip row would hide the very thing they demonstrate
        if (!q || q.startsWith(".")) continue;
        const parts = parseQueryParts(q);
        if (!parts.length) continue;
        btn.textContent = "";
        btn.classList.add("ex-chips");
        for (const p of parts) {
            const chip = el("span", p.field === "all"
                ? "exchip exfree" : `exchip f-${p.field}${p.not ? " not" : ""}`);
            if (p.field !== "all") {
                chip.appendChild(el("span", "qchip-field", `${p.not ? "−" : ""}${p.field}:`));
            }
            const text = el("span", "qchip-text");
            text.appendChild(highlightBar(p.field, p.text));
            chip.appendChild(text);
            btn.appendChild(chip);
        }
    }
}

export function barHoverOut() {
    const box = document.getElementById("qhl");
    if (box) for (const span of box.children) span.classList.remove("hover");
    qInput.title = "";
}
