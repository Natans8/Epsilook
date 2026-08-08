import {hideSuggest} from "./autocomplete";
import {updateTabs} from "./events";
import {highlightBar, syncHighlight} from "./highlight";
import {serializeQuery, tagStr} from "./query";
import {scheduleSearch} from "./run";
import {DEFAULT_PLACEHOLDER, qInput, state} from "./state";
import type {Chip} from "../query";
import {ensureFieldVisible} from "./url";
import * as Search from "../search";
import {$, $$, el} from "../dom";
/* ------------------------------------------------------- search bar */

// The one entry point after any chips/pos/activeField mutation. Enforces
// two invariants, then repaints:
//  1. neighbouring free-text chips read as one run of plain words, so
//     they act as one: merge them wherever they touch. The pair
//     straddling the editing gap (state.pos) is left alone — the gap's
//     own content sits between them.
//  2. free text touching the gap lives in the input, never as committed
//     chips — so the caret can walk through the whole run and clicks
//     place it natively. (Skipped while a field tag is being typed: the
//     input's text belongs to the tag, not to the free run around it.)
export function syncBar() {
    const input = qInput;
    state.barSel = null; // any structural change invalidates a bar selection
    state.pos = Math.min(state.pos, state.chips.length);
    for (let i = state.chips.length - 1; i > 0; i--) {
        if (i === state.pos) continue;
        const a = state.chips[i - 1], b = state.chips[i];
        if (a.field === "all" && b.field === "all") {
            a.text += " " + b.text;
            state.chips.splice(i, 1);
            if (state.pos > i) state.pos -= 1;
        }
    }
    if (!state.activeField) {
        let caret = input.selectionStart ?? input.value.length;
        let absorbed = false;
        while (state.pos > 0 && state.chips[state.pos - 1].field === "all") {
            const t = state.chips.splice(--state.pos, 1)[0].text;
            const sep = input.value ? " " : "";
            input.value = t + sep + input.value;
            caret += t.length + sep.length;
            absorbed = true;
        }
        while (state.pos < state.chips.length && state.chips[state.pos].field === "all") {
            const t = state.chips.splice(state.pos, 1)[0].text;
            input.value += (input.value ? " " : "") + t;
            absorbed = true;
        }
        if (absorbed) input.setSelectionRange(caret, caret);
    }
    renderBar();
}

export function renderBar() {
    const bar = $("#qbar");
    for (const chip of bar.querySelectorAll(".qchip")) chip.remove();
    const editwrap = $("#editwrap");

    // the input sits at state.pos: at the end by default, or wherever the
    // user navigated / reopened a chip
    const editPos = Math.min(state.pos, state.chips.length);
    state.chips.forEach((c, idx) => {
        // free text renders as plain words (click to edit), not a boxed chip
        const isFree = c.field === "all";
        const chip = el("span", isFree ? "qchip qfree" : `qchip f-${c.field}${c.not ? " not" : ""}`);
        if (!isFree) {
            // a real button so the include/exclude toggle is keyboard-operable
            const label = el("button", "qchip-field", `${c.not ? "−" : ""}${c.field}:`);
            label.type = "button";
            label.title = c.not ? `Excluding — click to include ${c.field} matches` : `Click to exclude ${c.field} matches instead`;
            label.setAttribute("aria-label", c.not ? `Include ${c.field} matches` : `Exclude ${c.field} matches`);
            label.dataset.chipNot = String(idx);
            chip.appendChild(label);
        }
        // the chip's own text carries the same marking the input does — one
        // classifier, so a word cannot look like vocabulary while being
        // typed and like plain text once committed
        const textSpan = el("span", "qchip-text");
        textSpan.appendChild(highlightBar(c.field, c.text));
        chip.appendChild(textSpan);
        if (!isFree) {
            const x = el("button", "qchip-x", "×");
            x.type = "button";
            x.title = "Remove";
            x.setAttribute("aria-label", `Remove ${c.field} filter`);
            x.dataset.chipRemove = String(idx);
            chip.appendChild(x);
        }
        chip.dataset.chipEdit = String(idx);
        if (idx < editPos) bar.insertBefore(chip, editwrap);
        else bar.appendChild(chip);
    });

    editwrap.classList.toggle("editing", !!state.activeField);
    editwrap.classList.toggle("not", !!state.activeField && state.activeNot);
    // only the true trailing gap fills the rest of the line — a gap before
    // or between chips hugs its content instead, so the chips after it
    // don't get shoved to the far end of the bar
    editwrap.classList.toggle("fill", !state.activeField && editPos >= state.chips.length);
    if (state.activeField) editwrap.dataset.field = state.activeField;
    else delete editwrap.dataset.field;
    const editlabel = $("#editlabel");
    editlabel.textContent = state.activeField
        ? `${state.activeNot ? "−" : ""}${state.activeField}:` : "";
    editlabel.title = state.activeNot ? "Excluding — click to include" : "Click to exclude instead";
    editlabel.hidden = !state.activeField;
    qInput.placeholder = state.activeField
        ? (state.activeNot ? "exclude: " : "") + Search.FIELDS[state.activeField].short
        : (state.chips.length ? "" : DEFAULT_PLACEHOLDER);
    sizeInput();
    updateTabs();
    paintBarSel();
    // mirror the assembled chip query for screen readers — the committed
    // chips are separate DOM the input's own value can't convey
    const desc = document.getElementById("q-desc");
    if (desc) {
        const q = serializeQuery();
        desc.textContent = q ? `Current search: ${q}` : "";
    }
}

// The input hugs its content instead of stretching, except at the true
// trailing gap (nothing after it), which fills the rest of the line.
export function sizeInput() {
    const input = qInput;
    if (state.activeField) {
        const len = Math.max(input.value.length, input.placeholder.length, 4);
        input.style.width = (len + 2) + "ch";
    } else if ($("#editwrap").classList.contains("fill")) {
        input.style.width = "";
    } else {
        input.style.width = Math.max(input.value.length, 1) + "ch";
    }
    // the highlight backdrop copies the box this just settled, so it rides
    // the one function every value/width change already goes through
    syncHighlight();
}

export function activateField(field: string, {not = false} = {}): void {
    const input = qInput;

    if (state.activeField) {
        // already editing a chip: its own button cancels it (contents fall
        // back to plain text); a different button switches its type in place
        if (field === state.activeField) {
            cancelActiveField();
        } else {
            const prevStart = input.selectionStart, prevEnd = input.selectionEnd;
            ensureFieldVisible(field);
            state.activeField = field;
            state.activeNot = not;
            hideSuggest();
            syncBar();
            input.focus();
            input.setSelectionRange(prevStart, prevEnd);
            scheduleSearch();
        }
        return;
    }

    // plain text selected in the input becomes the new chip's text; the
    // words around the selection stay behind as free text
    const seed = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0).trim();
    if (seed) {
        const after = input.value.slice(input.selectionEnd ?? 0).trim();
        input.value = input.value.slice(0, input.selectionStart ?? 0);
        insertFreeChipHere();
        if (after) state.chips.splice(Math.min(state.pos, state.chips.length), 0, {field: "all", text: after});
    } else {
        insertFreeChipHere(); // any free words sitting in the gap
    }
    ensureFieldVisible(field);
    state.activeField = field;
    state.activeNot = not;
    input.value = seed;
    hideSuggest();
    syncBar();
    input.focus();
    input.setSelectionRange(seed.length, seed.length);
    scheduleSearch();
}

// Cancels the chip currently being typed without committing it — its
// text (if any) joins the plain-text run around the gap (syncBar merges
// it with any neighbouring free words).
export function cancelActiveField() {
    state.activeField = null;
    state.activeNot = false;
    syncBar();
    qInput.focus();
    scheduleSearch();
}

// Commits the field chip currently being typed (if any) into state.chips
// at state.pos. landing places the gap just past the new chip ("after",
// default) or just before it ("before"). Returns the insertion index,
// or -1 if there was nothing (or no field) to commit. Pure state
// mutation — the calling flow ends with its own syncBar().
export function commitActiveChip(landing = "after") {
    if (!state.activeField) return -1;
    const input = qInput;
    const text = input.value.trim();
    let at = -1;
    if (text) {
        at = Math.min(state.pos, state.chips.length);
        state.chips.splice(at, 0, {field: state.activeField, text, not: state.activeNot});
        state.pos = landing === "before" ? at : at + 1;
    }
    state.activeField = null;
    state.activeNot = false;
    input.value = "";
    return at;
}

// Same, but for free (non-field) words sitting in the gap — used when
// navigating away from a gap where the user was typing a plain phrase.
export function insertFreeChipHere() {
    const input = qInput;
    const text = input.value.trim();
    if (!text) return -1;
    const at = Math.min(state.pos, state.chips.length);
    state.chips.splice(at, 0, {field: "all", text});
    state.pos = at + 1;
    input.value = "";
    return at;
}

// Commits whatever's pending at the gap (field chip or free words).
export function flushPending() {
    return state.activeField ? commitActiveChip() : insertFreeChipHere();
}

// Pop a committed chip back into the editor at its own position (it
// recommits there, not at the end). caretAt places the cursor at the
// "start" or "end" of its text, so arrow keys can walk in one end and
// back out the other.
export function editChipAt(index: number, caretAt: "start" | "end" = "end"): void {
    const [edited] = state.chips.splice(index, 1);
    state.pos = index;
    const input = qInput;
    input.value = edited.text;
    state.activeField = edited.field === "all" ? null : edited.field;
    state.activeNot = edited.field === "all" ? false : !!edited.not;
    input.focus();
    // caret set before syncBar: absorption shifts it along with the text
    const caret = caretAt === "start" ? 0 : input.value.length;
    input.setSelectionRange(caret, caret);
    syncBar();
    scheduleSearch();
}

/* ---------------------------------------------------- bar selection
   *
   * The bar reads as one selectable line: each committed chip is one atom,
   * the input is one atom, and state.barSel = {anchor, focus} holds two gap
   * positions in that atom sequence. Chips inside the range paint
   * .selected; the input's own (native) selection carries the free-text
   * part, so a partial word + neighbouring chips select together. Copy/cut
   * serialize the range back to canonical query text ("model:book note"),
   * and Backspace/typing/paste replace it. */

export const inputAtom = () => Math.min(state.pos, state.chips.length);
export const atomCount = () => state.chips.length + 1;

export function selRange() {
    if (!state.barSel) return null;
    const {anchor, focus} = state.barSel;
    return [Math.min(anchor, focus), Math.max(anchor, focus)];
}

// chip indices (chip coordinates) inside the selection, ascending
function selectedChipIndices() {
    const r = selRange();
    if (!r) return [];
    const I = inputAtom();
    const out = [];
    for (let a = r[0]; a < r[1]; a++) if (a !== I) out.push(a < I ? a : a - 1);
    return out;
}

/** Repaint which chips show as selected (from state.barSel). */
export function paintBarSel() {
    const sel = new Set(selectedChipIndices());
    for (const chip of $$(".qchip", $("#qbar"))) {
        chip.classList.toggle("selected", sel.has(Number(chip.dataset.chipEdit)));
    }
}

export function clearBarSel() {
    if (!state.barSel) return;
    state.barSel = null;
    paintBarSel();
}

// the selected range as canonical query text — chips serialize like
// serializeQuery does; the input contributes its natively-selected
// substring (tag form only when the whole value of an open tag is taken)
export function serializeBarSel() {
    const r = selRange();
    if (!r) return "";
    const input = qInput;
    const I = inputAtom();
    const parts = [];
    for (let a = r[0]; a < r[1]; a++) {
        if (a === I) {
            const t = input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0).trim();
            if (!t) continue;
            const whole = input.selectionStart === 0 && input.selectionEnd === input.value.length;
            parts.push(state.activeField && whole ? tagStr(state.activeField, t, state.activeNot) : t);
        } else {
            const c = state.chips[a < I ? a : a - 1];
            parts.push(c.field === "all" ? c.text : tagStr(c.field, c.text, c.not));
        }
    }
    return parts.join(" ");
}

// remove everything the selection covers: selected chips, plus the
// input's selected substring (a fully-selected open tag is cancelled
// whole). Ends with syncBar, which also drops barSel.
export function deleteBarSel() {
    const r = selRange();
    if (!r) return;
    const input = qInput;
    const I = inputAtom();
    const chipIdxs = selectedChipIndices();
    if (r[0] <= I && I < r[1]) {
        const s = input.selectionStart ?? 0, e = input.selectionEnd ?? 0;
        if (s === 0 && e === input.value.length && state.activeField) {
            state.activeField = null;
            state.activeNot = false;
        }
        input.value = input.value.slice(0, s) + input.value.slice(e);
        // caret set before syncBar: absorption shifts it along with the text
        input.setSelectionRange(s, s);
    }
    const before = chipIdxs.filter((i) => i < state.pos).length;
    for (let k = chipIdxs.length - 1; k >= 0; k--) state.chips.splice(chipIdxs[k], 1);
    state.pos -= before;
    state.barSel = null;
    syncBar();
    scheduleSearch();
}

// keyboard extension (Shift+arrows): moves the focus gap, keeping the
// input's own partial selection untouched
export function applyKbSel(anchor: number, focus: number): void {
    const input = qInput;
    const I = inputAtom();
    state.barSel = anchor === focus ? null : {anchor, focus};
    if (state.barSel && !selectedChipIndices().length) state.barSel = null;
    const r = selRange();
    if (r && !(r[0] <= I && I < r[1])) {
        // the input fell out of the range: park its caret on the selection side
        const at = r[0] > I ? input.value.length : 0;
        input.setSelectionRange(at, at);
    }
    paintBarSel();
}

/* ---------------------------------------------------------- bar undo
   *
   * Native input undo can't see chip mutations (and programmatic value
   * writes wreck its stack), so the bar keeps its own history: full
   * snapshots of {chips, open tag, input text, caret}, recorded centrally
   * in scheduleSearch/runSearch — the one point every mutation flow
   * already ends at. Typing bursts coalesce into one step; caret-only
   * moves never create steps. stack[at] always equals the current state. */

/**
 * A full search-bar snapshot for the undo history — chips, the open tag,
 * the input's text and caret. stack[at] always equals the current state.
 */
interface BarSnapshot {
    chips: Chip[];
    activeField: string | null;
    activeNot: boolean;
    pos: number;
    value: string;
    caret: number;
}

const barHistory: {
    stack: BarSnapshot[]; at: number; lastTyping: boolean; lastTime: number;
} = {stack: [], at: -1, lastTyping: false, lastTime: 0};
const UNDO_CAP = 200;
const TYPE_COALESCE_MS = 800;

function barSnapshot(): BarSnapshot {
    const input = qInput;
    return {
        chips: state.chips.map((c) => ({...c})),
        activeField: state.activeField,
        activeNot: state.activeNot,
        pos: state.pos,
        value: input.value,
        caret: input.selectionStart ?? input.value.length,
    };
}

const snapKey = (s: BarSnapshot) => JSON.stringify([s.chips, s.activeField, s.activeNot, s.value]);

// Deferred by a tick so one user gesture records one step: replacing a
// selection is a delete + an insert (two scheduleSearch calls in the same
// task), and undo must step over the transient in-between state.
let recordTimer: number | null = null;

export function recordBar(): void {
    if (recordTimer !== null) return;
    recordTimer = setTimeout(recordBarNow, 0);
}

function recordBarNow(): void {
    if (recordTimer !== null) clearTimeout(recordTimer);
    recordTimer = null;
    const snap = barSnapshot();
    const cur = barHistory.stack[barHistory.at];
    if (cur && snapKey(cur) === snapKey(snap)) {
        // caret/gap moved but content didn't: refresh in place, no new step
        barHistory.stack[barHistory.at] = snap;
        barHistory.lastTyping = false;
        return;
    }
    const typing = cur
        && JSON.stringify(cur.chips) === JSON.stringify(snap.chips)
        && cur.activeField === snap.activeField && cur.activeNot === snap.activeNot
        && cur.value !== snap.value;
    const now = Date.now();
    if (typing && barHistory.lastTyping && now - barHistory.lastTime < TYPE_COALESCE_MS
        && barHistory.at === barHistory.stack.length - 1) {
        barHistory.stack[barHistory.at] = snap; // same burst: absorb into the top step
    } else {
        barHistory.stack.length = barHistory.at + 1; // truncate any redo tail
        barHistory.stack.push(snap);
        barHistory.at++;
        if (barHistory.stack.length > UNDO_CAP) {
            barHistory.stack.shift();
            barHistory.at--;
        }
    }
    barHistory.lastTyping = !!typing;
    barHistory.lastTime = now;
}

function restoreBar(snap: BarSnapshot): void {
    const input = qInput;
    state.chips = snap.chips.map((c) => ({...c}));
    state.activeField = snap.activeField;
    state.activeNot = snap.activeNot;
    state.pos = snap.pos;
    state.barSel = null;
    input.value = snap.value;
    hideSuggest();
    renderBar(); // verbatim restore — the snapshot already satisfies syncBar's invariants
    input.focus();
    input.setSelectionRange(snap.caret, snap.caret);
    barHistory.lastTyping = false;
    scheduleSearch(); // recordBar dedupes against the restored snapshot
}

export function undoBar() {
    recordBarNow(); // flush a pending record so the current state is on the stack
    if (barHistory.at <= 0) return;
    restoreBar(barHistory.stack[--barHistory.at]);
}

export function redoBar() {
    recordBarNow();
    if (barHistory.at >= barHistory.stack.length - 1) return;
    restoreBar(barHistory.stack[++barHistory.at]);
}

// which atom gap (0..atomCount) a point maps to — the same reading-order
// midpoint walk as click-to-place-gap, but counting the input as an atom
export function atomGapAtPoint(x: number, y: number): number {
    let gap = 0, idx = 0;
    for (const item of $("#qbar").children) {
        if (!item.classList.contains("qchip") && item.id !== "editwrap") continue;
        const r = item.getBoundingClientRect();
        if (y > r.bottom || (y >= r.top && x > (r.left + r.right) / 2)) gap = idx + 1;
        idx++;
    }
    return gap;
}
