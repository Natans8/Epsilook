/* Epsilook UI: chip search bar, results table, tags, clipboard, scrolling. */
"use strict";

(() => {
  const CFG = window.EpsilookConfig;
  const Data = window.EpsilookData;
  const Search = window.EpsilookSearch;

  // the empty-bar placeholder lives in index.html; grab it before render()
  // starts swapping the property around
  const DEFAULT_PLACEHOLDER = document.getElementById("q").placeholder;

  /* ------------------------------------------------------------- state */

  const state = {
    versions: [],       // manifest entries
    version: null,      // active manifest entry
    data: null,         // indexes for the active version

    // the search bar: committed chips + the chip being typed (activeField
    // + the input's text). Chips with field "all" are free text (rendered
    // as plain words, not boxed). not: true excludes matches instead.
    chips: [],          // [{field, text, not}]
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
    filters: { models: false, sounds: false, animkits: false, fx: false },
    sort: { key: "auto", dir: 1 },
    // hidden columns (also excluded from All-mode search and from exports)
    hiddenCols: { models: false, sounds: false, animkits: false, fx: false, mechanics: true, commands: false },
  };

  // column -> search fields it contributes
  const COL_FIELDS = {
    models: ["model"],
    sounds: ["sound", "soundkit"],
    animkits: ["animkit", "anim"],
    fx: ["fx"],
    mechanics: ["mech"],
  };

  function disabledFields() {
    const out = new Set();
    for (const [col, fields] of Object.entries(COL_FIELDS)) {
      if (state.hiddenCols[col]) fields.forEach((f) => out.add(f));
    }
    return out;
  }

  // "9.2.7.45745" -> "9.2.7" (used for clean URLs)
  const shortVersion = (id) => id.split(".").slice(0, 3).join(".");

  const stripExt = (name) => name.replace(/\.[^.]+$/, "");

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /* --------------------------------------------------------- clipboard */

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2000);
  }

  function copyText(text, wrapTicks = false, message) {
    if (wrapTicks) text = "`" + text + "`";
    const done = () => toast(message || `Copied:  ${text}`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  // Copy a link to the exact current search. The URL is only updated
  // after the search debounce settles, so flush it first — otherwise a
  // share click right after typing could copy a stale query.
  function shareLink() {
    clearTimeout(searchDebounce);
    state.lastQuery = serializeQuery();
    stateToUrl(false);
    copyText(location.href, false, "Link copied — paste it to share this search");
  }

  function fallbackCopy(text, done) {
    const prev = document.activeElement; // ta.select() steals focus — put it back
    const ta = el("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed"); }
    ta.remove();
    if (prev && prev !== document.body) prev.focus({ preventScroll: true });
  }

  const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

  /* ------------------------------------------------- query <-> chips */

  // legacy prefixes silently convert to their current field — effect: was
  // the fx: column's name before the effect:->mech: split
  const FIELD_ALIASES = { effect: "fx" };
  const canonField = (f) => FIELD_ALIASES[f] || f;

  function isChipField(f) {
    return f && f !== "all" && Search.FIELDS[f];
  }

  // canonical string form: model:"fel reaver" -mechanic:knockback free words.
  // The live input's contribution is spliced in at state.pos, so a query
  // typed before or between chips serializes (and round-trips) in place.
  // one chip as query text: single words as-is, multi-word values wrapped in
  // "quotes" (grouping — words match the same entity in any order), values
  // that themselves contain "phrase quotes" wrapped in (parens) instead so
  // the two kinds of quotes don't collide
  const tagStr = (field, text, not) => {
    const t = text.includes('"') ? `(${text})` : /\s/.test(text) ? `"${text}"` : text;
    return `${not ? "-" : ""}${field}:${t}`;
  };

  function serializeQuery() {
    const parts = state.chips.map((c) =>
      c.field === "all" ? c.text : tagStr(c.field, c.text, c.not));
    const at = Math.min(state.pos, state.chips.length);
    const inputText = $("#q").value.trim();
    if (inputText) {
      parts.splice(at, 0, state.activeField ? tagStr(state.activeField, inputText, state.activeNot) : inputText);
    } else if (state.activeField) {
      parts.splice(at, 0, `${state.activeNot ? "-" : ""}${state.activeField}:`);
    }
    return parts.join(" ");
  }

  // parse a canonical string into an ordered chip list — field tags become
  // field chips, runs of free words between them coalesce into single
  // field:"all" chips, so the original word order survives the round-trip.
  // A tag's value is one word, a "quoted group" (quotes stripped) or a
  // (paren group) kept verbatim — the paren form carries values that contain
  // phrase quotes. Everything else (bare "phrases" included, quotes kept so
  // their exact-match meaning survives) is free text.
  function parseQueryParts(str) {
    const parts = [];
    const pushFree = (word) => {
      const last = parts[parts.length - 1];
      if (last && last.field === "all") last.text += " " + word;
      else parts.push({ field: "all", text: word });
    };
    for (const m of (str || "").matchAll(/(?:(-)?([a-z]+):)?(?:\(([^)]*)\)|"([^"]*)"|([^\s"]+))/gi)) {
      const not = !!m[1];
      const field = canonField((m[2] || "").toLowerCase());
      if (isChipField(field)) {
        const text = (m[3] ?? m[4] ?? m[5] ?? "").trim();
        if (text) parts.push({ field, text, not });
        ensureFieldVisible(field);
      } else {
        const t = m[0].trim(); // unknown prefixes and quotes stay literal
        if (t && t !== '""') pushFree(t);
      }
    }
    return parts;
  }

  // load a canonical string into the bar: field tags become committed
  // chips; syncBar pulls the trailing free run into the input
  function loadQueryString(str) {
    state.chips = parseQueryParts(str);
    state.activeField = null;
    state.activeNot = false;
    $("#q").value = "";
    state.pos = state.chips.length;
    syncBar();
  }

  // chip text -> search tokens: words split on whitespace, except "quoted
  // spans" which stay whole — an exact phrase, spaces and word order
  // preserved. An unclosed quote runs to the end of the text (so a phrase
  // matches live while it's still being typed).
  function tokenizeQuery(text) {
    const tokens = [];
    for (const m of text.toLowerCase().matchAll(/"([^"]*)(?:"|$)|([^\s"]+)/g)) {
      const t = (m[1] !== undefined ? m[1] : m[2]).replace(/\s+/g, " ").trim();
      if (t) tokens.push({ text: t });
    }
    return tokens;
  }

  // group list for the engine: one group per chip + one for the live input,
  // spliced in at state.pos so mid-bar typing groups correctly. Words in a
  // group must match the same entity; groups AND together (not: true groups
  // exclude instead).
  function currentGroups() {
    const toGroup = (field, text, not) => {
      const tokens = tokenizeQuery(text);
      return tokens.length ? { field, tokens, not: !!not } : null;
    };
    const groups = state.chips.map((c) => toGroup(c.field, c.text, c.not));
    const live = toGroup(state.activeField || "all", $("#q").value, state.activeField ? state.activeNot : false);
    if (live) groups.splice(Math.min(state.pos, groups.length), 0, live);
    return groups.filter(Boolean);
  }

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
  function syncBar() {
    const input = $("#q");
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

  function renderBar() {
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
        const label = el("span", "qchip-field", `${c.not ? "−" : ""}${c.field}:`);
        label.title = c.not ? `Excluding — click to include ${c.field} matches` : `Click to exclude ${c.field} matches instead`;
        label.dataset.chipNot = String(idx);
        chip.appendChild(label);
      }
      chip.appendChild(el("span", "qchip-text", c.text));
      if (!isFree) {
        const x = el("button", "qchip-x", "×");
        x.title = "Remove";
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
    $("#q").placeholder = state.activeField
      ? (state.activeNot ? "exclude: " : "") + Search.FIELDS[state.activeField].short
      : (state.chips.length ? "" : DEFAULT_PLACEHOLDER);
    sizeInput();
    updateTabs();
    paintBarSel();
  }

  // The input hugs its content instead of stretching, except at the true
  // trailing gap (nothing after it), which fills the rest of the line.
  function sizeInput() {
    const input = $("#q");
    if (state.activeField) {
      const len = Math.max(input.value.length, input.placeholder.length, 4);
      input.style.width = (len + 2) + "ch";
    } else if ($("#editwrap").classList.contains("fill")) {
      input.style.width = "";
    } else {
      input.style.width = Math.max(input.value.length, 1) + "ch";
    }
  }

  function activateField(field, { not = false } = {}) {
    const input = $("#q");

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
    const seed = input.value.slice(input.selectionStart, input.selectionEnd).trim();
    if (seed) {
      const after = input.value.slice(input.selectionEnd).trim();
      input.value = input.value.slice(0, input.selectionStart);
      insertFreeChipHere();
      if (after) state.chips.splice(Math.min(state.pos, state.chips.length), 0, { field: "all", text: after });
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
  function cancelActiveField() {
    state.activeField = null;
    state.activeNot = false;
    syncBar();
    $("#q").focus();
    scheduleSearch();
  }

  // Commits the field chip currently being typed (if any) into state.chips
  // at state.pos. landing places the gap just past the new chip ("after",
  // default) or just before it ("before"). Returns the insertion index,
  // or -1 if there was nothing (or no field) to commit. Pure state
  // mutation — the calling flow ends with its own syncBar().
  function commitActiveChip(landing = "after") {
    if (!state.activeField) return -1;
    const input = $("#q");
    const text = input.value.trim();
    let at = -1;
    if (text) {
      at = Math.min(state.pos, state.chips.length);
      state.chips.splice(at, 0, { field: state.activeField, text, not: state.activeNot });
      state.pos = landing === "before" ? at : at + 1;
    }
    state.activeField = null;
    state.activeNot = false;
    input.value = "";
    return at;
  }

  // Same, but for free (non-field) words sitting in the gap — used when
  // navigating away from a gap where the user was typing a plain phrase.
  function insertFreeChipHere() {
    const input = $("#q");
    const text = input.value.trim();
    if (!text) return -1;
    const at = Math.min(state.pos, state.chips.length);
    state.chips.splice(at, 0, { field: "all", text });
    state.pos = at + 1;
    input.value = "";
    return at;
  }

  // Commits whatever's pending at the gap (field chip or free words).
  function flushPending() {
    return state.activeField ? commitActiveChip() : insertFreeChipHere();
  }

  // Pop a committed chip back into the editor at its own position (it
  // recommits there, not at the end). caretAt places the cursor at the
  // "start" or "end" of its text, so arrow keys can walk in one end and
  // back out the other.
  function editChipAt(index, caretAt = "end") {
    const [edited] = state.chips.splice(index, 1);
    state.pos = index;
    const input = $("#q");
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

  const inputAtom = () => Math.min(state.pos, state.chips.length);
  const atomCount = () => state.chips.length + 1;

  function selRange() {
    if (!state.barSel) return null;
    const { anchor, focus } = state.barSel;
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

  function paintBarSel() {
    const sel = new Set(selectedChipIndices());
    for (const chip of $("#qbar").querySelectorAll(".qchip")) {
      chip.classList.toggle("selected", sel.has(Number(chip.dataset.chipEdit)));
    }
  }

  function clearBarSel() {
    if (!state.barSel) return;
    state.barSel = null;
    paintBarSel();
  }

  // the selected range as canonical query text — chips serialize like
  // serializeQuery does; the input contributes its natively-selected
  // substring (tag form only when the whole value of an open tag is taken)
  function serializeBarSel() {
    const r = selRange();
    if (!r) return "";
    const input = $("#q");
    const I = inputAtom();
    const parts = [];
    for (let a = r[0]; a < r[1]; a++) {
      if (a === I) {
        const t = input.value.slice(input.selectionStart, input.selectionEnd).trim();
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
  function deleteBarSel() {
    const r = selRange();
    if (!r) return;
    const input = $("#q");
    const I = inputAtom();
    const chipIdxs = selectedChipIndices();
    if (r[0] <= I && I < r[1]) {
      const s = input.selectionStart, e = input.selectionEnd;
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
  function applyKbSel(anchor, focus) {
    const input = $("#q");
    const I = inputAtom();
    state.barSel = anchor === focus ? null : { anchor, focus };
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

  const barHistory = { stack: [], at: -1, lastTyping: false, lastTime: 0 };
  const UNDO_CAP = 200;
  const TYPE_COALESCE_MS = 800;

  function barSnapshot() {
    const input = $("#q");
    return {
      chips: state.chips.map((c) => ({ ...c })),
      activeField: state.activeField,
      activeNot: state.activeNot,
      pos: state.pos,
      value: input.value,
      caret: input.selectionStart ?? input.value.length,
    };
  }

  const snapKey = (s) => JSON.stringify([s.chips, s.activeField, s.activeNot, s.value]);

  // Deferred by a tick so one user gesture records one step: replacing a
  // selection is a delete + an insert (two scheduleSearch calls in the same
  // task), and undo must step over the transient in-between state.
  let recordTimer = null;
  function recordBar() {
    if (recordTimer !== null) return;
    recordTimer = setTimeout(recordBarNow, 0);
  }

  function recordBarNow() {
    clearTimeout(recordTimer);
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

  function restoreBar(snap) {
    const input = $("#q");
    state.chips = snap.chips.map((c) => ({ ...c }));
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

  function undoBar() {
    recordBarNow(); // flush a pending record so the current state is on the stack
    if (barHistory.at <= 0) return;
    restoreBar(barHistory.stack[--barHistory.at]);
  }

  function redoBar() {
    recordBarNow();
    if (barHistory.at >= barHistory.stack.length - 1) return;
    restoreBar(barHistory.stack[++barHistory.at]);
  }

  // which atom gap (0..atomCount) a point maps to — the same reading-order
  // midpoint walk as click-to-place-gap, but counting the input as an atom
  function atomGapAtPoint(x, y) {
    let gap = 0, idx = 0;
    for (const item of $("#qbar").children) {
      if (!item.classList.contains("qchip") && item.id !== "editwrap") continue;
      const r = item.getBoundingClientRect();
      if (y > r.bottom || (y >= r.top && x > (r.left + r.right) / 2)) gap = idx + 1;
      idx++;
    }
    return gap;
  }

  /* ------------------------------------------------------ autocomplete */

  let suggestIndex = -1;

  function updateSuggest() {
    const input = $("#q");
    const box = $("#suggest");
    if (state.activeField) return hideSuggest();
    let word = input.value.split(/\s+/).pop().toLowerCase();
    if (word.startsWith("-")) word = word.slice(1); // "-mec" suggests mechanic: as an exclusion
    if (word.length < 2) return hideSuggest();
    // hidden columns don't suppress suggestions — an explicit field search
    // un-hides its column anyway (ensureFieldVisible)
    const matches = Object.entries(Search.FIELDS).filter(([key, f]) =>
      f.tab && (key.startsWith(word) || f.label.toLowerCase().startsWith(word)));
    if (!matches.length) return hideSuggest();

    box.textContent = "";
    matches.forEach(([key, f]) => {
      const b = el("button", "suggest-item");
      b.appendChild(el("span", `suggest-field f-${key}`, `${key}:`));
      b.appendChild(el("span", "suggest-hint", f.hint));
      b.dataset.field = key;
      box.appendChild(b);
    });
    suggestIndex = -1;
    box.hidden = false;
  }

  function hideSuggest() {
    $("#suggest").hidden = true;
    suggestIndex = -1;
  }

  function selectSuggestion(field) {
    const input = $("#q");
    const not = /(^|\s)-\S*$/.test(input.value);
    input.value = input.value.replace(/\S+$/, "").trimEnd();
    activateField(field, { not });
  }

  /* ------------------------------------------------------------ search */

  let searchDebounce = null;
  function scheduleSearch() {
    recordBar();
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(), CFG.searchDebounceMs);
  }

  function runSearch({ push = false } = {}) {
    recordBar();
    const data = state.data;
    if (!data) return;
    clearTimeout(searchDebounce);

    const raw = serializeQuery();
    state.lastQuery = raw;

    // too little typed to search — counted on the searched tokens, so field
    // prefixes don't count but an unknown "word:" (literal text) does.
    // Exact-ID tags (id: soundkit: animkit:) always count as enough: IDs
    // below 10 are a single keystroke and the lookup is exact and cheap
    const groups = currentGroups();
    const typed = groups.reduce((n, g) => n + g.tokens.reduce((m, t) =>
      m + ((Search.FIELDS[g.field] || {}).orGroups ? CFG.minQueryLength : t.text.length), 0), 0);
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
    const res = Search.searchGroups(groups, data, disabledFields());
    state.results = res.spellIds;
    state.groups = groups;
    // excluded terms never appear in the results: no highlighting for them
    state.tokens = groups.filter((g) => !g.not)
      .flatMap((g) => g.tokens.map((t) => ({ field: g.field, text: t.text })));
    state.searchMs = res.ms;
    applyFiltersAndSort();
    stateToUrl(push);
  }

  function applyFiltersAndSort() {
    const d = state.data;
    let list = state.results;

    const f = state.filters;
    if (f.models || f.sounds || f.animkits || f.fx) {
      list = list.filter((id) =>
        (!f.models || d.spellModels.has(id)) &&
        (!f.sounds || d.spellSounds.has(id)) &&
        (!f.animkits || d.spellAnimKits.has(id)) &&
        (!f.fx || d.spellFx.has(id) || d.spellDissolves.has(id) || d.spellGlows.has(id)
          || d.spellShadowies.has(id) || d.spellTints.has(id)
          || d.spellMorphs.has(id) || d.spellSummons.has(id)));
    } else {
      list = list.slice();
    }

    const { key, dir } = state.sort;
    if (key === "id") {
      list.sort((a, b) => (a - b) * dir);
    } else if (key === "name") {
      list.sort((a, b) =>
        d.names[d.spellIndex.get(a)].localeCompare(d.names[d.spellIndex.get(b)]) * dir || a - b);
    } else { // auto
      const nameTokens = state.tokens.filter((t) => t.field === "name" || t.field === "all");
      if (nameTokens.length) {
        Search.sortByRelevance(list, nameTokens.map((t) => t.text).join(" "), d);
      } else {
        list.sort((a, b) => a - b);
      }
    }

    state.display = list;
    renderResults();
  }

  function setStatus(text) {
    $("#status").textContent = text;
  }

  /* --------------------------------------------------------- rendering */

  function renderResults() {
    const tbody = $("#results tbody");
    tbody.textContent = "";
    state.rendered = 0;
    renderMore();

    const total = state.results.length;
    const shown = state.display.length;
    // a purely negative query has no highlight tokens but is still a query
    const hasQuery = state.groups.length > 0;
    if (hasQuery) {
      const filtered = shown < total ? ` (${shown.toLocaleString()} after filters)` : "";
      setStatus(`${total.toLocaleString()} ${total === 1 ? "spell" : "spells"}${filtered} · ${state.searchMs.toFixed(0)} ms`);
    }
    $("#results").classList.toggle("empty", shown === 0);
    $("#empty-note").hidden = !(shown === 0 && hasQuery);
    $("#empty-state").hidden = hasQuery;
    updateSortHeaders();
  }

  function renderMore() {
    const tbody = $("#results tbody");
    const end = Math.min(state.rendered + CFG.scrollBatch, state.display.length);
    const frag = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) frag.appendChild(buildRow(state.display[i], i));
    tbody.appendChild(frag);
    state.rendered = end;
    $("#sentinel").hidden = state.rendered >= state.display.length;
  }

  function buildRow(spellId, displayIndex) {
    const d = state.data;
    const i = d.spellIndex.get(spellId);
    const tr = el("tr");

    // result index
    tr.appendChild(el("td", "c-idx", String(displayIndex + 1)));

    // ID
    const tdId = el("td", "c-id");
    const idBtn = el("button", "id-copy", String(spellId));
    idBtn.title = "Copy spell ID\nShift-click: copy wrapped in `backticks`";
    idBtn.dataset.copy = String(spellId);
    tdId.appendChild(idBtn);
    tr.appendChild(tdId);

    // Name — wowhead link (their widget adds the hover tooltip); the parts
    // matched by a name search are highlighted
    const tdName = el("td", "c-name");
    const nameDiv = el("div", "spell-name");
    const nameLink = el("a", "spell-name-link");
    nameLink.href = fillTemplate(CFG.wowheadSpellUrl, { id: spellId });
    nameLink.target = "_blank";
    nameLink.rel = "noopener";
    if (CFG.spellIconUrl && d.icons[i]) {
      const icon = el("img", "spell-icon");
      icon.src = fillTemplate(CFG.spellIconUrl, { icon: d.icons[i] });
      icon.alt = "";
      icon.loading = "lazy";
      icon.addEventListener("error", () => icon.remove(), { once: true });
      nameLink.appendChild(icon);
    }
    nameLink.appendChild(highlightMatches(d.names[i] || "(unnamed)"));
    nameDiv.appendChild(nameLink);
    tdName.appendChild(nameDiv);
    if (d.subtexts[i]) tdName.appendChild(el("div", "spell-sub", d.subtexts[i]));
    tr.appendChild(tdName);

    // Models — matched files first
    const modelFids = hitsFirst(d.spellModels.get(spellId) || [],
      (fid) => fileIsHit(d.files.get(fid), "model"));
    tr.appendChild(tagCell("c-models", modelFids.map((fid) => modelTag(fid))));

    // Sounds — grouped by SoundKit; kits containing a match come first
    tr.appendChild(soundsCell(d.spellSounds.get(spellId) || []));

    // Animations — AnimKits grouped with the animations they play
    tr.appendChild(animationsCell(d.spellAnimKits.get(spellId) || []));

    // Effects — visual FX (beams, morphs, summons), grouped by category
    tr.appendChild(fxCell(spellId));

    // Mechanics — spell effects, then aura mechanics; matched ones first
    const mechs = hitsFirst(
      (d.spellEffects.get(spellId) || []).slice().sort((a, b) => a - b)
        .map((e) => ({ effect: e }))
        .concat((d.spellAuras.get(spellId) || []).slice().sort((a, b) => a - b)
          .map((a) => ({ aura: a }))),
      (m) => m.effect !== undefined ? effectIsHit(m.effect) : auraIsHit(m.aura));
    tr.appendChild(tagCell("c-mechanics",
      mechs.map((m) => m.effect !== undefined ? effectTag(m.effect) : auraTag(m.aura))));

    // Commands — one compact line that fits even single-line rows
    const tdCmd = el("td", "c-cmds");
    const row = el("div", "cmd-row");
    for (const cmd of CFG.spellCommands) {
      const b = el("button", "cmd", cmd.label);
      b.title = `${cmd.hint} — ${fillTemplate(cmd.template, { id: spellId })}\nShift-click: copy wrapped in \`backticks\``;
      b.dataset.copy = fillTemplate(cmd.template, { id: spellId });
      row.appendChild(b);
    }
    const wh = wowheadLink(fillTemplate(CFG.wowheadSpellUrl, { id: spellId }), "Open on Wowhead");
    wh.classList.add("wh-cmd");
    row.appendChild(wh);
    tdCmd.appendChild(row);
    tr.appendChild(tdCmd);

    return tr;
  }

  /* Highlight the query-matched parts of a spell name; returns a fragment. */
  function highlightMatches(name) {
    const frag = document.createDocumentFragment();
    const tokens = tokensFor("name").map((t) => t.text);
    if (!tokens.length) {
      frag.appendChild(document.createTextNode(name));
      return frag;
    }
    const lower = name.toLowerCase();
    const ranges = [];
    for (const t of tokens) {
      let idx = 0;
      while (t && (idx = lower.indexOf(t, idx)) !== -1) {
        ranges.push([idx, idx + t.length]);
        idx += 1;
      }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    let pos = 0;
    for (const [s, e] of merged) {
      if (s > pos) frag.appendChild(document.createTextNode(name.slice(pos, s)));
      frag.appendChild(el("mark", "hl", name.slice(s, e)));
      pos = e;
    }
    if (pos < name.length) frag.appendChild(document.createTextNode(name.slice(pos)));
    return frag;
  }

  // stable partition: elements matching isHit come first, original order kept
  function hitsFirst(items, isHit) {
    if (!state.tokens.length) return items;
    const hits = [], rest = [];
    for (const it of items) (isHit(it) ? hits : rest).push(it);
    return hits.length ? hits.concat(rest) : rest;
  }

  function wowheadLink(url, title) {
    const a = el("a", "wowhead");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.title = title;
    const img = el("img");
    img.src = "https://wow.zamimg.com/images/logos/favicon-standard.png";
    img.alt = "WH";
    img.loading = "lazy";
    a.appendChild(img);
    return a;
  }

  // Collapsing 1-2 items would cost as much space as showing them, so a
  // cell only collapses when at least 3 items are hidden.
  const COLLAPSE_SLACK = 2;

  function tagCell(className, tags) {
    const td = el("td", className);
    if (tags.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const limit = tags.length <= CFG.tagsCollapsedLimit + COLLAPSE_SLACK
      ? tags.length : CFG.tagsCollapsedLimit;
    tags.forEach((tag, idx) => {
      if (idx >= limit) tag.classList.add("overflow");
      td.appendChild(tag);
    });
    if (tags.length > limit) {
      const more = el("button", "more", `+${tags.length - limit} more`);
      more.dataset.expand = "1";
      td.appendChild(more);
    }
    return td;
  }

  /* One cell showing each SoundKit with the sound files it contains. */
  function soundsCell(soundEntries) {
    const td = el("td", "c-sounds");
    if (soundEntries.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const d = state.data;

    const byKit = new Map(); // soundKitId -> [fid]
    for (const e of soundEntries) {
      const arr = byKit.get(e.soundKitId);
      if (arr) arr.push(e.fid); else byKit.set(e.soundKitId, [e.fid]);
    }

    const kitHasHit = (kitId) =>
      kitIsHit(kitId, "soundkit") ||
      byKit.get(kitId).some((fid) => fileIsHit(d.files.get(fid), "sound"));
    const kitIds = hitsFirst([...byKit.keys()].sort((a, b) => a - b), kitHasHit);

    buildKitGroups(td, kitIds, {
      headerTag: (kitId) => kitTag(kitId, "soundkit"),
      itemsOf: (kitId) => hitsFirst(byKit.get(kitId), (fid) => fileIsHit(d.files.get(fid), "sound")),
      itemTag: (fid) => soundTag(fid),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "kit",
    });
    return td;
  }

  /* Animations cell: AnimKits grouped with the animations they play. */
  function animationsCell(animKitIds) {
    const td = el("td", "c-animkits");
    if (animKitIds.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const d = state.data;
    const kitHasHit = (kitId) =>
      kitIsHit(kitId, "animkit") ||
      (d.animKitAnims.get(kitId) || []).some((a) => animIsHit(a));
    const kitIds = hitsFirst(animKitIds.slice().sort((a, b) => a - b), kitHasHit);

    buildKitGroups(td, kitIds, {
      headerTag: (kitId) => kitTag(kitId, "animkit"),
      itemsOf: (kitId) => hitsFirst((d.animKitAnims.get(kitId) || []).slice().sort((a, b) => a - b),
        (a) => animIsHit(a)),
      itemTag: (animId) => animTag(animId),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "kit",
    });
    return td;
  }

  /* Shared group renderer: each kit is a small box — the kit tag as a
   * tinted head segment, its items flowing (and wrapping) beside it —
   * collapsing only when it actually saves space. With opts.moreInHead a
   * group's own "+N" expander sits in its head bar (spare horizontal space)
   * instead of the td-level "+N more" strip. */
  function buildKitGroups(td, kitIds, opts) {
    const groupLimit = kitIds.length <= 2 + 1 ? kitIds.length : 2;
    let hiddenCount = 0;

    kitIds.forEach((kitId, gi) => {
      const group = el("div", "kit-group");
      if (gi >= groupLimit) group.classList.add("overflow");

      const head = el("div", "kit-head");
      const headTag = opts.headerTag(kitId);
      if (headTag.classList.contains("hit")) group.classList.add("hit");
      head.appendChild(headTag);
      group.appendChild(head);

      const items = opts.itemsOf(kitId);
      if (items.length) {
        const itemsDiv = el("div", "kit-files");
        const limit = items.length <= opts.itemLimit + COLLAPSE_SLACK ? items.length : opts.itemLimit;
        items.forEach((item, fi) => {
          const tag = opts.itemTag(item);
          if (gi >= groupLimit || fi >= limit) {
            tag.classList.add("overflow");
            hiddenCount++;
          }
          itemsDiv.appendChild(tag);
        });
        group.appendChild(itemsDiv);
        if (opts.moreInHead && gi < groupLimit && items.length > limit) {
          const more = el("button", "more head-more", `+${items.length - limit}`);
          more.title = `Show all ${items.length}`;
          more.dataset.expand = "1";
          head.appendChild(more);
          hiddenCount -= items.length - limit; // this expander's job, not the td strip's
        }
      }
      td.appendChild(group);
    });

    const hiddenGroups = Math.max(0, kitIds.length - groupLimit);
    if (hiddenGroups > 0 || hiddenCount > 0) {
      const label = hiddenGroups > 0
        ? `+${hiddenGroups} more ${hiddenGroups === 1 ? opts.groupNoun : opts.groupNoun + "s"}`
        : `+${hiddenCount} more`;
      const more = el("button", "more", label);
      more.dataset.expand = "1";
      td.appendChild(more);
    }
  }

  /* Effects cell: visual FX grouped by category — "beam" (chain effects),
   * "dissolve" (dissolve effects), "glow" / "shadowy" / "tint" (color-only
   * effects), "morph" (transform auras) and "summon" (summon effects).
   * Beam pills carry a tint dot per texture. */
  function fxCell(spellId) {
    const d = state.data;
    const chainIds = d.spellFx.get(spellId) || [];
    const dissolveIds = d.spellDissolves.get(spellId) || [];
    const glowIds = d.spellGlows.get(spellId) || [];
    const shadowyIds = d.spellShadowies.get(spellId) || [];
    const tintIds = d.spellTints.get(spellId) || [];
    const morphIds = d.spellMorphs.get(spellId) || [];
    const summonEntries = d.spellSummons.get(spellId) || [];
    const td = el("td", "c-fx");
    if (chainIds.length === 0 && dissolveIds.length === 0 && glowIds.length === 0
        && shadowyIds.length === 0 && tintIds.length === 0
        && morphIds.length === 0 && summonEntries.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }

    const cats = [];
    if (chainIds.length) {
      // one entry per distinct (texture, tint); untextured chains still show
      const entries = [];
      const seen = new Set();
      for (const c of chainIds.slice().sort((a, b) => a - b)) {
        const color = (d.fxChains.get(c) || {}).color ?? 0xffffff;
        const fids = d.fxTextures.get(c) || [0];
        for (const fid of fids) {
          const key = fid + ":" + color;
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({ chainId: c, fid, color });
        }
      }
      cats.push({
        name: "beam",
        hit: chainIds.some((c) => fxChainIsHit(c)),
        items: hitsFirst(entries, (e) => fxChainIsHit(e.chainId)).map((e) => () => fxTag(e)),
      });
    }
    if (dissolveIds.length) {
      // one pill per distinct texture; textureless rows still show
      const entries = [];
      const seen = new Set();
      for (const id of dissolveIds.slice().sort((a, b) => a - b)) {
        for (const fid of d.dissolveTextures.get(id) || [0]) {
          if (seen.has(fid)) continue;
          seen.add(fid);
          entries.push({ dissolveId: id, fid });
        }
      }
      cats.push({
        name: "dissolve",
        hit: dissolveIds.some((id) => dissolveIsHit(id)),
        items: hitsFirst(entries, (e) => dissolveIsHit(e.dissolveId)).map((e) => () => dissolveTag(e)),
      });
    }
    if (glowIds.length) {
      // one pill per distinct color (no texture — the color is the payload)
      const entries = [];
      const seen = new Set();
      for (const id of glowIds.slice().sort((a, b) => a - b)) {
        const color = d.glowColors.get(id) ?? 0;
        if (seen.has(color)) continue;
        seen.add(color);
        entries.push({ glowId: id, color });
      }
      cats.push({
        name: "glow",
        hit: glowIds.some((id) => glowIsHit(id)),
        items: hitsFirst(entries, (e) => glowIsHit(e.glowId))
          .map((e) => () => colorFxTag("glow", e.color, glowIsHit(e.glowId))),
      });
    }
    if (shadowyIds.length) {
      // one pill per distinct color across each row's primary + secondary
      const entries = [];
      const seen = new Set();
      for (const id of shadowyIds.slice().sort((a, b) => a - b)) {
        const c = d.shadowyColors.get(id) || { primary: 0, secondary: 0 };
        for (const color of [c.primary, c.secondary]) {
          if (seen.has(color)) continue;
          seen.add(color);
          entries.push({ shadowyId: id, color });
        }
      }
      cats.push({
        name: "shadowy",
        hit: shadowyIds.some((id) => shadowyIsHit(id)),
        items: hitsFirst(entries, (e) => shadowyIsHit(e.shadowyId))
          .map((e) => () => colorFxTag("shadowy", e.color, shadowyIsHit(e.shadowyId))),
      });
    }
    if (tintIds.length) {
      // one pill per distinct color (no texture — the color is the payload)
      const entries = [];
      const seen = new Set();
      for (const id of tintIds.slice().sort((a, b) => a - b)) {
        const color = d.tintColors.get(id) ?? 0;
        if (seen.has(color)) continue;
        seen.add(color);
        entries.push({ tintId: id, color });
      }
      cats.push({
        name: "tint",
        hit: tintIds.some((id) => tintIsHit(id)),
        items: hitsFirst(entries, (e) => tintIsHit(e.tintId))
          .map((e) => () => colorFxTag("tint", e.color, tintIsHit(e.tintId))),
      });
    }
    if (morphIds.length) {
      // one pill per (creature, display); creatures without TDB displays
      // still get a single fallback pill
      const ids = hitsFirst(morphIds.slice().sort((a, b) => a - b), (c) => morphIsHit(c));
      const entries = ids.flatMap((c) =>
        (d.morphDisplays.get(c) || [{ displayId: 0, fid: 0 }])
          .map((e) => ({ creatureId: c, displayId: e.displayId, fid: e.fid })));
      cats.push({
        name: "morph",
        hit: morphIds.some((c) => morphIsHit(c)),
        items: entries.map((e) => () => morphTag(e)),
      });
    }
    if (summonEntries.length) {
      // one pill per (creature, control) pair
      const entries = hitsFirst(
        summonEntries.slice().sort((a, b) => (a.creatureId - b.creatureId) || (a.control - b.control)),
        (e) => summonIsHit(e.creatureId, e.control));
      cats.push({
        name: "summon",
        hit: summonEntries.some((e) => summonIsHit(e.creatureId, e.control)),
        items: entries.map((e) => () => summonTag(e)),
      });
    }

    buildKitGroups(td, cats, {
      headerTag: (cat) => fxHeadTag(cat.name, cat.hit),
      itemsOf: (cat) => cat.items,
      itemTag: (make) => make(),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "category",
      moreInHead: true,
    });
    return td;
  }

  function tokensFor(field) {
    return state.tokens.filter((t) => t.field === field || t.field === "all");
  }

  function groupsFor(field) {
    return state.groups.filter((g) => !g.not && (g.field === field || g.field === "all"));
  }

  // hit = the entity fully satisfies at least one chip of its field
  function fileIsHit(file, field) {
    if (!file) return false;
    return groupsFor(field).some((g) => g.tokens.every((t) => file.searchL.includes(t.text)));
  }

  function kitIsHit(kitId, field) {
    return groupsFor(field).some((g) => g.tokens.some((t) => Number(t.text) === kitId));
  }

  function animIsHit(animId) {
    const nameL = state.data.animNamesL[animId];
    return groupsFor("anim").some((g) => g.tokens.every((t) => nameL.includes(t.text)));
  }

  function effectIsHit(effectId) {
    const nameL = state.data.effectNamesL.get(effectId) || "";
    return groupsFor("mech").some((g) => g.tokens.every((t) => nameL.includes(t.text)));
  }

  function auraIsHit(auraId) {
    const nameL = state.data.auraNamesL.get(auraId) || "";
    return groupsFor("mech").some((g) => g.tokens.every((t) => nameL.includes(t.text)));
  }

  function fxChainIsHit(chainId) {
    const corpus = state.data.fxSearchL.get(chainId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function dissolveIsHit(dissolveId) {
    const corpus = state.data.dissolveSearchL.get(dissolveId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function glowIsHit(glowId) {
    const corpus = state.data.glowSearchL.get(glowId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function shadowyIsHit(shadowyId) {
    const corpus = state.data.shadowySearchL.get(shadowyId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function tintIsHit(tintId) {
    const corpus = state.data.tintSearchL.get(tintId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function morphIsHit(displayId) {
    const corpus = state.data.morphSearchL.get(displayId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function summonIsHit(creatureId, control) {
    const corpus = state.data.summonPairSearchL.get(creatureId + ":" + control) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  // small helper: a copy button inside a tag. "⧉" copies an ID; command
  // buttons are labeled after what they copy (".lo", "/", ".mod").
  function tagButton(glyph, title, copyValue) {
    const b = el("button", "tag-copy", glyph);
    b.title = `${title}\nShift-click: copy wrapped in \`backticks\``;
    b.dataset.copy = copyValue;
    return b;
  }

  function modelTag(fid) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const tag = el("span", "tag model");
    tag.title = file.path || "(name unknown)";
    if (fileIsHit(file, "model")) tag.classList.add("hit");

    if (CFG.modelViewerUrl) {
      const view = el("a", "tag-view");
      // wireframe cube (the universal 3D-preview glyph); stroke inherits
      // currentColor so the gold hover tint applies
      view.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M12 2.5 21 7.5v9l-9 5-9-5v-9z"/>' +
        '<path d="M12 12.2 21 7.5M12 12.2v9.3M12 12.2 3 7.5"/></svg>';
      view.href = fillTemplate(CFG.modelViewerUrl, { fid });
      view.target = "_blank";
      view.rel = "noopener";
      view.title = `Preview ${file.base || `file #${fid}`} in the WoW.tools model viewer (new tab)`;
      tag.appendChild(view);
    }

    const txt = el("button", "tag-label", file.base ? stripExt(file.base) : `file #${fid}`);
    txt.title = `${file.path || "(name unknown)"}\nFileDataID ${fid}\nClick: find spells using this model\nShift-click: exclude them instead`;
    txt.dataset.search = file.base ? `model:"${file.base}"` : "";
    tag.appendChild(txt);

    const cmd = fillTemplate(CFG.modelCopyTemplate,
      { base: stripExt(file.base), file: file.base, path: file.path, fid });
    tag.appendChild(tagButton(".lo", `Copy:  ${cmd}`, cmd));
    return tag;
  }

  function soundTag(fid) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const tag = el("span", "tag sound");
    tag.title = file.path || "(name unknown)";
    if (fileIsHit(file, "sound")) tag.classList.add("hit");

    if (CFG.soundPlayUrl) {
      const play = el("button", "tag-play", "▶");
      play.title = `Play ${file.base || `file #${fid}`} (streamed from Wowhead)`;
      play.dataset.play = fillTemplate(CFG.soundPlayUrl, {
        fid,
        bucket: fid % 256,
        base: encodeURIComponent(stripExt(file.base) || String(fid)),
      });
      tag.appendChild(play);
    }

    // sound extensions stay visible (.ogg/.mp3 differ, unlike models)
    const txt = el("button", "tag-label", file.base || `file #${fid}`);
    txt.title = `${file.path || "(name unknown)"}\nFileDataID ${fid}\nClick: find spells using this sound\nShift-click: exclude them instead`;
    txt.dataset.search = file.base ? `sound:"${file.base}"` : "";
    tag.appendChild(txt);

    tag.appendChild(tagButton("⧉", `Copy FileDataID ${fid}`, String(fid)));
    return tag;
  }

  /* ------------------------------------------------- sound playback (▶) */

  // One shared player — starting a sound stops the previous one. Audio is
  // streamed from Wowhead's CDN only on click, never preloaded (same house
  // rule as the hotlinked icons).
  let nowPlaying = null; // { audio, btn }

  function stopSound() {
    if (!nowPlaying) return;
    nowPlaying.audio.pause();
    nowPlaying.audio.src = "";
    setPlayGlyph(nowPlaying.btn, "▶");
    nowPlaying = null;
  }

  function setPlayGlyph(btn, glyph) {
    btn.textContent = glyph;
    btn.classList.toggle("playing", glyph === "■");
    btn.classList.toggle("loading", glyph === "◌");
  }

  function toggleSound(btn) {
    const wasThis = nowPlaying && nowPlaying.btn === btn;
    stopSound();
    if (wasThis) return;

    const audio = new Audio(btn.dataset.play);
    audio.volume = Math.min(1, Math.max(0, CFG.soundVolume ?? 0.5));
    nowPlaying = { audio, btn };
    setPlayGlyph(btn, "◌");

    const isCurrent = () => nowPlaying && nowPlaying.audio === audio;
    audio.addEventListener("playing", () => { if (isCurrent()) setPlayGlyph(btn, "■"); });
    audio.addEventListener("ended", () => { if (isCurrent()) stopSound(); });
    audio.addEventListener("error", () => {
      if (!isCurrent()) return;
      nowPlaying = null;
      setPlayGlyph(btn, "✕");
      btn.title = "This sound is unavailable on Wowhead's CDN";
      setTimeout(() => { if (btn.textContent === "✕") setPlayGlyph(btn, "▶"); }, 1500);
    });
    audio.play().catch(() => {}); // failures surface via the error listener
  }

  function kitTag(kitId, field) {
    const tag = el("span", `tag ${field}`);
    if (kitIsHit(kitId, field)) tag.classList.add("hit");

    const txt = el("button", "tag-label", String(kitId));
    txt.title = field === "soundkit"
      ? `SoundKit ${kitId}\nClick: find spells using this soundkit\nShift-click: exclude them instead`
      : `AnimKit ${kitId}\nClick: find spells using this animkit\nShift-click: exclude them instead`;
    txt.dataset.search = `${field}:${kitId}`;
    tag.appendChild(txt);

    const kind = field === "soundkit" ? "SoundKit" : "AnimKit";
    tag.appendChild(tagButton("⧉", `Copy ${kind} ID ${kitId}`, String(kitId)));

    const tpl = field === "soundkit" ? CFG.soundKitCopyTemplate : CFG.animKitCopyTemplate;
    const cmd = fillTemplate(tpl, { id: kitId });
    tag.appendChild(tagButton(field === "soundkit" ? "/" : ".mod", `Copy:  ${cmd}`, cmd));

    if (field === "soundkit") {
      tag.appendChild(wowheadLink(fillTemplate(CFG.wowheadSoundUrl, { id: kitId }), `SoundKit ${kitId} on Wowhead`));
    }
    return tag;
  }

  function animTag(animId) {
    const d = state.data;
    const name = d.animNames[animId];
    const tag = el("span", "tag anim");
    if (animIsHit(animId)) tag.classList.add("hit");

    const txt = el("button", "tag-label", name);
    txt.title = `Animation ${animId}: ${name}\nClick: find spells playing this animation\nShift-click: exclude them instead`;
    txt.dataset.search = `anim:"${name}"`;
    tag.appendChild(txt);

    const cmd = fillTemplate(CFG.animCopyTemplate, { name, id: animId });
    tag.appendChild(tagButton(".lo", `Copy:  ${cmd}`, cmd));
    return tag;
  }

  function effectTag(effectId) {
    const d = state.data;
    const name = d.effectNames.get(effectId) || `EFFECT_${effectId}`;
    const tag = el("span", "tag mechanic");
    if (effectIsHit(effectId)) tag.classList.add("hit");
    const label = el("button", "tag-label", name);
    label.title = `Spell effect ${effectId}: SPELL_EFFECT_${name}\nClick: find spells with this mechanic\nShift-click: exclude them instead`;
    label.dataset.search = `mech:"${name}"`;
    tag.appendChild(label);
    return tag;
  }

  function auraTag(auraId) {
    const d = state.data;
    const name = d.auraNames.get(auraId) || `AURA_${auraId}`;
    const tag = el("span", "tag mechanic aura");
    if (auraIsHit(auraId)) tag.classList.add("hit");
    const label = el("button", "tag-label", name);
    label.title = `Aura ${auraId}: SPELL_AURA_${name}\nClick: find spells with this mechanic\nShift-click: exclude them instead`;
    label.dataset.search = `mech:"${name}"`;
    tag.appendChild(label);
    return tag;
  }

  /* Visual FX tags: the category head ("beam") and one pill per texture,
   * with a dot showing the chain's tint (hidden when untinted). Clicking
   * the head searches the whole category (fx:beam). */
  const FX_HEAD_TITLES = {
    beam: "Beam / chain effect (SpellChainEffects)",
    dissolve: "Dissolve / materialize effect (DissolveEffect)",
    glow: "Edge glow / rim-light effect (EdgeGlowEffect)",
    shadowy: "Shadowy overlay effect (ShadowyEffect)",
    tint: "Model tint (SpellProceduralEffect)",
    morph: "Morph / transform aura (CreatureDisplayInfo)",
    summon: "Summoned creature (SpellEffect SUMMON)",
  };

  function fxHeadTag(category, hit) {
    const tag = el("span", "tag fx-head");
    if (hit) tag.classList.add("hit");
    const label = el("button", "tag-label", category);
    label.title = `${FX_HEAD_TITLES[category] || ""}`
      + `\nClick: find all spells with a ${category} effect\nShift-click: exclude them instead`;
    label.dataset.search = /\s/.test(category) ? `fx:"${category}"` : `fx:${category}`;
    tag.appendChild(label);
    return tag;
  }

  function fxTag(entry) {
    const d = state.data;
    const file = entry.fid ? (d.files.get(entry.fid) || { path: "", base: "" }) : { path: "", base: "" };
    const info = d.fxChains.get(entry.chainId) || { color: 0xffffff, hue: "" };
    const tag = el("span", "tag fx");
    if (fxChainIsHit(entry.chainId)) tag.classList.add("hit");

    if (entry.color !== 0xffffff) {
      const hex = "#" + entry.color.toString(16).padStart(6, "0");
      const dot = el("span", "fx-swatch");
      dot.style.background = hex;
      dot.title = `Tint ${hex}` + (info.hue ? ` (${info.hue})` : "");
      tag.appendChild(dot);
    }

    const base = file.base ? stripExt(file.base) : "";
    const txt = el("button", "tag-label", base || "(untextured)");
    txt.title = `${file.path || "(no texture)"}\nClick: find spells with this beam texture\nShift-click: exclude them instead`;
    if (entry.fid) {
      txt.dataset.texFid = entry.fid;
      // the hover preview multiplies the texture by the chain's tint
      if (entry.color !== 0xffffff)
        txt.dataset.texTint = "#" + entry.color.toString(16).padStart(6, "0");
    }
    // category word + texture: the query stays scoped to beams once more
    // fx categories exist ("fx:beam lightning" style)
    txt.dataset.search = file.base ? `fx:"beam ${file.base}"` : "";
    tag.appendChild(txt);

    if (base) tag.appendChild(tagButton("⧉", `Copy texture name: ${base}`, base));
    return tag;
  }

  /* Color-only fx pill (glow / shadowy / tint): swatch + hex label — these
   * effects have no texture or model, the color is the whole payload.
   * Clicking searches the category + hex; ⧉ copies the hex. */
  function colorFxTag(category, color, hit) {
    const hex = "#" + color.toString(16).padStart(6, "0");
    const tag = el("span", "tag fx");
    if (hit) tag.classList.add("hit");

    const dot = el("span", "fx-swatch");
    dot.style.background = hex;
    tag.appendChild(dot);

    const txt = el("button", "tag-label", hex);
    txt.title = `${FX_HEAD_TITLES[category]}\nColor ${hex}`
      + `\nClick: find spells with this ${category} color\nShift-click: exclude them instead`;
    txt.dataset.search = `fx:"${category} ${hex}"`;
    tag.appendChild(txt);

    tag.appendChild(tagButton("⧉", `Copy color: ${hex}`, hex));
    return tag;
  }

  /* Dissolve pill: one per texture of the row's TextureBlendSet (mask +
   * material textures); tooltip carries the dissolve duration. */
  function dissolveTag(entry) {
    const d = state.data;
    const file = entry.fid ? (d.files.get(entry.fid) || { path: "", base: "" }) : { path: "", base: "" };
    const duration = d.dissolveDurations.get(entry.dissolveId) || 0;
    const tag = el("span", "tag fx");
    if (dissolveIsHit(entry.dissolveId)) tag.classList.add("hit");

    const base = file.base ? stripExt(file.base) : "";
    const txt = el("button", "tag-label", base || "(untextured)");
    txt.title = `${file.path || "(no texture)"}`
      + (duration ? `\nDuration ${duration}s` : "")
      + `\nClick: find spells with this dissolve texture\nShift-click: exclude them instead`;
    if (entry.fid) txt.dataset.texFid = entry.fid;
    txt.dataset.search = file.base ? `fx:"dissolve ${file.base}"` : "";
    tag.appendChild(txt);

    if (base) tag.appendChild(tagButton("⧉", `Copy texture name: ${base}`, base));
    return tag;
  }

  /* Morph pill: one per (creature, display). Label = the creature model's
   * file name; tooltip names the NPC the spell morphs
   * into; ⧉ copies the display ID, .morph / .lo the ready-to-paste
   * commands; the Wowhead icon on the left opens their model viewer on the
   * display. Creatures without TDB data get an inert "creature #id" pill. */
  function morphTag(entry) {
    const d = state.data;
    const { creatureId, displayId, fid } = entry;
    const name = d.morphNames.get(creatureId) || "";
    const file = fid ? (d.files.get(fid) || { path: "", base: "" }) : { path: "", base: "" };
    const tag = el("span", "tag fx");
    if (morphIsHit(creatureId)) tag.classList.add("hit");

    if (displayId && CFG.wowheadMorphUrl) {
      tag.appendChild(wowheadLink(fillTemplate(CFG.wowheadMorphUrl, { id: displayId }),
        `View DisplayID ${displayId} in Wowhead's model viewer`));
    }

    const base = file.base ? stripExt(file.base) : "";
    const txt = el("button", "tag-label");
    txt.appendChild(document.createTextNode(
      base || (displayId ? `#${displayId}` : `creature #${creatureId}`)));
    txt.title = `${name || "(unknown creature)"} — creature ${creatureId}`
      + (displayId ? `\nDisplayID ${displayId}` : "\n(no display known — creature not in TDB)")
      + `\n${file.path || "(model unknown)"}`
      + `\nClick: find spells with this morph\nShift-click: exclude them instead`;
    txt.dataset.search = `fx:"morph ${base || creatureId}"`;
    tag.appendChild(txt);

    if (displayId) {
      tag.appendChild(tagButton("⧉", `Copy display ID: ${displayId}`, String(displayId)));
      const cmd = fillTemplate(CFG.morphCopyTemplate, { id: displayId });
      tag.appendChild(tagButton(".morph", `Copy:  ${cmd}`, cmd));
    }
    if (file.base) {
      const lookup = fillTemplate(CFG.morphLookupTemplate, { id: displayId, file: file.base });
      tag.appendChild(tagButton(".lo", `Copy:  ${lookup}`, lookup));
    }
    return tag;
  }

  /* Summon pill: one per (creature, control). Label = the NPC name with the
   * SummonProperties control word dimmed beside it (uncontrolled summons
   * show no word) — the control word is its own button searching all
   * summons of that control type; ⧉ copies the creature ID, .lo / .npc the
   * ready-to-paste commands; the Wowhead icon on the left opens the NPC's
   * Wowhead page. Creatures missing from TDB show an inert "creature #id"
   * pill. */
  function summonTag(entry) {
    const d = state.data;
    const { creatureId, control } = entry;
    const name = d.summonNames.get(creatureId) || "";
    const ctrl = d.summonControlNames[control] || "";
    const tag = el("span", "tag fx");
    if (summonIsHit(creatureId, control)) tag.classList.add("hit");

    if (CFG.wowheadNpcUrl) {
      tag.appendChild(wowheadLink(fillTemplate(CFG.wowheadNpcUrl, { id: creatureId }),
        `Open NPC ${creatureId} on Wowhead`));
    }

    const txt = el("button", "tag-label");
    txt.appendChild(document.createTextNode(name || `creature #${creatureId}`));
    txt.title = `${name || "(unknown creature)"} — creature ${creatureId}`
      + (ctrl ? `\nControl: ${ctrl}` : "")
      + `\nClick: find spells summoning this creature\nShift-click: exclude them instead`;
    txt.dataset.search = `fx:"summon ${name || creatureId}"`;
    tag.appendChild(txt);
    if (ctrl) {
      const cb = el("button", "tag-ctrl", ctrl);
      cb.title = `Control: ${ctrl}`
        + `\nClick: find all ${ctrl} summons\nShift-click: exclude them instead`;
      cb.dataset.search = `fx:"summon ${ctrl}"`;
      tag.appendChild(cb);
    }

    tag.appendChild(tagButton("⧉", `Copy creature ID: ${creatureId}`, String(creatureId)));
    if (name) {
      const lookup = fillTemplate(CFG.summonLookupTemplate, { name, id: creatureId });
      tag.appendChild(tagButton(".lo", `Copy:  ${lookup}`, lookup));
    }
    const spawn = fillTemplate(CFG.summonSpawnTemplate, { id: creatureId, name });
    tag.appendChild(tagButton(".npc", `Copy:  ${spawn}`, spawn));
    return tag;
  }

  /* --------------------------------------------- texture hover preview */

  // Pills with data-tex-fid show the texture on hover: the raw .blp comes
  // from wago.tools (version-pinned), decoded onto a canvas by the vendored
  // js-blp + bufo libs (the same decoder wago.tools' own file viewer uses).
  // Fetched only after a short hover-intent delay, cached per session
  // (a failed fid caches as null and stays silent).
  const texCache = new Map(); // fid -> Promise<canvas|null> (untinted base)
  let texHoverKey = "";       // fid|tint of the pill being hovered
  let texHoverTimer = 0;

  function textureCanvas(fid) {
    let p = texCache.get(fid);
    if (!p) {
      const url = fillTemplate(CFG.texturePreviewUrl, { fid, version: state.version.id });
      p = fetch(url)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => {
          // encrypted CASC files come back as all-zero bytes — no preview
          if (!new Uint8Array(buf).some((b) => b !== 0)) return null;
          const blp = new BLPFile(buf);
          const cv = document.createElement("canvas");
          cv.width = blp.width;
          cv.height = blp.height;
          blp.getPixels(0, cv); // decodes mip 0 straight into the canvas
          return cv;
        })
        .catch(() => null);
      texCache.set(fid, p);
    }
    return p;
  }

  function texPanel() {
    let panel = $("#texpreview");
    if (!panel) {
      panel = el("div", "");
      panel.id = "texpreview";
      panel.append(el("div", "tex-img"), el("div", "tex-dims"));
      document.body.appendChild(panel);
    }
    return panel;
  }

  function hideTexPreview() {
    texHoverKey = "";
    clearTimeout(texHoverTimer);
    const panel = $("#texpreview");
    if (panel) panel.style.display = "none";
  }

  // beam tint: texture.rgb × tint.rgb (how the game colors chain textures),
  // keeping the texture's own alpha
  function tintedCanvas(base, tint) {
    const cv = document.createElement("canvas");
    cv.width = base.width;
    cv.height = base.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(base, 0, 0); // multiply fills alpha — restore the base's
    return cv;
  }

  function showTexPreview(label, baseCanvas) {
    const tint = label.dataset.texTint || "";
    const canvas = tint ? tintedCanvas(baseCanvas, tint) : baseCanvas;
    const max = CFG.texturePreviewMax || 256;
    const scale = Math.min(1, max / canvas.width, max / canvas.height);
    canvas.style.width = Math.round(canvas.width * scale) + "px";
    canvas.style.height = Math.round(canvas.height * scale) + "px";

    const panel = texPanel();
    panel.firstChild.replaceChildren(canvas);
    panel.lastChild.textContent = `${canvas.width}×${canvas.height}`
      + (tint ? ` · tint ${tint}` : "");
    // place above the pill (native title tooltips pop below the cursor),
    // measured invisibly first; fall back to below at the viewport top
    panel.style.visibility = "hidden";
    panel.style.display = "block";
    const r = label.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
    let y = r.top - pr.height - 6;
    if (y < 8) y = r.bottom + 6;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.visibility = "";
  }

  function initTexPreview() {
    if (!CFG.texturePreviewUrl || !window.matchMedia("(hover: hover)").matches) return;
    const results = $("#results");
    results.addEventListener("mouseover", (e) => {
      const label = e.target.closest("[data-tex-fid]");
      if (!label) return;
      const fid = Number(label.dataset.texFid);
      const key = fid + "|" + (label.dataset.texTint || "");
      if (key === texHoverKey) return;
      hideTexPreview();
      texHoverKey = key;
      texHoverTimer = setTimeout(async () => {
        const canvas = await textureCanvas(fid);
        if (canvas && texHoverKey === key && label.isConnected) showTexPreview(label, canvas);
      }, 150);
    });
    results.addEventListener("mouseout", (e) => {
      const label = e.target.closest("[data-tex-fid]");
      if (label && !label.contains(e.relatedTarget)) hideTexPreview();
    });
    window.addEventListener("scroll", hideTexPreview, { passive: true });
  }

  /* ------------------------------------------------------------ export */

  // Hidden columns are excluded from exports.
  function exportRows() {
    const d = state.data;
    const hc = state.hiddenCols;
    const pathOf = (fid) => (d.files.get(fid) || {}).path || `#${fid}`;
    return state.display.map((id) => {
      const i = d.spellIndex.get(id);
      const row = { id, name: d.names[i], subtext: d.subtexts[i] };
      if (!hc.models) row.models = (d.spellModels.get(id) || []).map(pathOf);
      if (!hc.sounds) {
        const byKit = new Map();
        for (const e of d.spellSounds.get(id) || []) {
          if (!byKit.has(e.soundKitId)) byKit.set(e.soundKitId, []);
          byKit.get(e.soundKitId).push(pathOf(e.fid));
        }
        row.soundKits = [...byKit.keys()].sort((a, b) => a - b)
          .map((k) => ({ id: k, files: byKit.get(k) }));
      }
      if (!hc.animkits) {
        row.animKits = (d.spellAnimKits.get(id) || []).slice().sort((a, b) => a - b)
          .map((k) => ({ id: k, anims: (d.animKitAnims.get(k) || []).map((a) => d.animNames[a]) }));
      }
      if (!hc.fx) {
        row.fx = (d.spellFx.get(id) || []).slice().sort((a, b) => a - b).map((c) => {
          const info = d.fxChains.get(c) || { color: 0xffffff, hue: "" };
          return {
            type: "beam",
            textures: (d.fxTextures.get(c) || []).map(pathOf),
            tint: info.color === 0xffffff ? null : "#" + info.color.toString(16).padStart(6, "0"),
          };
        }).concat((d.spellDissolves.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "dissolve",
          textures: (d.dissolveTextures.get(c) || []).map(pathOf),
          duration: d.dissolveDurations.get(c) || null,
        }))).concat((d.spellGlows.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "glow",
          color: "#" + (d.glowColors.get(c) ?? 0).toString(16).padStart(6, "0"),
        }))).concat((d.spellShadowies.get(id) || []).slice().sort((a, b) => a - b).map((c) => {
          const sh = d.shadowyColors.get(c) || { primary: 0, secondary: 0 };
          return {
            type: "shadowy",
            colors: [sh.primary, sh.secondary].map(
              (v) => "#" + v.toString(16).padStart(6, "0")),
          };
        })).concat((d.spellTints.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "tint",
          color: "#" + (d.tintColors.get(c) ?? 0).toString(16).padStart(6, "0"),
        }))).concat((d.spellMorphs.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "morph",
          creatureId: c,
          creature: d.morphNames.get(c) || null,
          displays: (d.morphDisplays.get(c) || []).map((e) => ({
            displayId: e.displayId,
            model: e.fid ? pathOf(e.fid) : null,
          })),
        }))).concat((d.spellSummons.get(id) || []).slice()
          .sort((a, b) => (a.creatureId - b.creatureId) || (a.control - b.control))
          .map((e) => ({
            type: "summon",
            creatureId: e.creatureId,
            creature: d.summonNames.get(e.creatureId) || null,
            control: d.summonControlNames[e.control] || null,
          })));
      }
      if (!hc.mechanics) {
        row.mechanics = (d.spellEffects.get(id) || []).slice().sort((a, b) => a - b)
          .map((e) => d.effectNames.get(e) || `EFFECT_${e}`)
          .concat((d.spellAuras.get(id) || []).slice().sort((a, b) => a - b)
            .map((a) => d.auraNames.get(a) || `AURA_${a}`));
      }
      return row;
    });
  }

  function exportFilename(ext) {
    const q = state.lastQuery.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "results";
    return `epsilook-${q}.${ext}`;
  }

  function downloadFile(name, mime, content) {
    const a = el("a");
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`Exported ${name}`);
  }

  function nothingToExport() {
    if (state.display.length === 0) { toast("Nothing to export — search first"); return true; }
    return false;
  }

  function exportCsv() {
    if (nothingToExport()) return;
    const hc = state.hiddenCols;
    const esc = (v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ["ID", "Name", "Subtext"];
    if (!hc.models) header.push("Models");
    if (!hc.sounds) header.push("SoundKits", "Sounds");
    if (!hc.animkits) header.push("AnimKits", "Animations");
    if (!hc.fx) header.push("Effects");
    if (!hc.mechanics) header.push("Mechanics");
    const lines = [header.join(",")];
    for (const r of exportRows()) {
      const cols = [r.id, esc(r.name), esc(r.subtext)];
      if (!hc.models) cols.push(esc(r.models.join("; ")));
      if (!hc.sounds) {
        cols.push(esc(r.soundKits.map((k) => k.id).join("; ")));
        cols.push(esc(r.soundKits.map((k) => `${k.id}: ${k.files.join(" | ")}`).join("; ")));
      }
      if (!hc.animkits) {
        cols.push(esc(r.animKits.map((k) => k.id).join("; ")));
        cols.push(esc(r.animKits.map((k) => `${k.id}: ${k.anims.join(" | ")}`).join("; ")));
      }
      if (!hc.fx) {
        cols.push(esc(r.fx.map((e) => {
          if (e.type === "morph") {
            return `morph: ${e.creature || "?"} (creature ${e.creatureId}): `
              + (e.displays.map((disp) => `${disp.displayId}=${disp.model || "?"}`).join(" | ") || "?");
          }
          if (e.type === "summon") {
            return `summon: ${e.creature || "?"} (creature ${e.creatureId})`
              + (e.control ? ` [${e.control}]` : "");
          }
          if (e.color || e.colors) // color-only fx (glow / shadowy / tint)
            return `${e.type}: ${e.color || e.colors.join(" | ")}`;
          return `${e.type}: ${e.textures.join(" | ") || "(untextured)"}`
            + (e.tint ? ` (${e.tint})` : "") + (e.duration ? ` (${e.duration}s)` : "");
        }).join("; ")));
      }
      if (!hc.mechanics) cols.push(esc(r.mechanics.join("; ")));
      lines.push(cols.join(","));
    }
    downloadFile(exportFilename("csv"), "text/csv", lines.join("\r\n"));
  }

  function exportJson() {
    if (nothingToExport()) return;
    const payload = {
      app: "Epsilook",
      url: location.href,
      gameVersion: state.version.id,
      query: state.lastQuery,
      count: state.display.length,
      spells: exportRows(),
    };
    downloadFile(exportFilename("json"), "application/json", JSON.stringify(payload, null, 2));
  }

  function exportDiscord() {
    if (nothingToExport()) return;
    const rows = exportRows();
    const idWidth = Math.max(...rows.map((r) => String(r.id).length), 2);
    const header = `**Epsilook** — ${rows.length.toLocaleString()} ${rows.length === 1 ? "spell" : "spells"} for \`${state.lastQuery}\`\n<${location.href}>\n\`\`\`\n`;
    const closer = "\n```";
    const footer = (remaining) => `\n…and ${remaining.toLocaleString()} more (full list: link above)`;
    const reserve = closer.length + footer(rows.length).length; // worst-case footer length

    let body = "";
    let shown = 0;
    for (const r of rows) {
      const line = `${String(r.id).padEnd(idWidth)}  ${r.name}${r.subtext ? ` (${r.subtext})` : ""}`;
      const candidate = body + (shown ? "\n" : "") + line;
      if (shown > 0 && header.length + candidate.length + reserve > CFG.discordCharLimit) break;
      body = candidate;
      shown++;
    }

    let text = header + body + closer;
    if (shown < rows.length) text += footer(rows.length - shown);
    const summary = shown < rows.length
      ? `Copied ${shown.toLocaleString()} of ${rows.length.toLocaleString()} spells to clipboard`
      : `Copied ${shown.toLocaleString()} ${shown === 1 ? "spell" : "spells"} to clipboard`;
    copyText(text, false, summary);
  }

  function updateSortHeaders() {
    for (const th of document.querySelectorAll("th[data-sort]")) {
      const active = state.sort.key === th.dataset.sort;
      th.classList.toggle("sorted", active);
      th.querySelector(".arrow").textContent = active ? (state.sort.dir === 1 ? "▲" : "▼") : "";
    }
  }

  /* ----------------------------------------------------------- the URL */

  // the default (newest) version stays out of the URL — links only carry
  // v= when the user deliberately switched to an older pack
  function defaultVersion() {
    return state.versions[state.versions.length - 1];
  }

  // keep ":", "+" for space, and quotes readable — encodeURIComponent's
  // %3A soup is exactly the mess a shareable URL shouldn't be
  const encodeQueryValue = (s) =>
    encodeURIComponent(s).replace(/%3A/gi, ":").replace(/%20/g, "+").replace(/%22/g, '"');

  function stateToUrl(push) {
    const params = [];
    const dv = defaultVersion();
    if (state.version && dv && state.version.id !== dv.id) {
      params.push("v=" + encodeQueryValue(shortVersion(state.version.id)));
    }
    if (state.lastQuery) params.push("q=" + encodeQueryValue(state.lastQuery));
    // the "Only spells with" filters shape the shared result list just like
    // the query does, so they ride in the URL too
    const only = Object.keys(state.filters).filter((k) => state.filters[k]);
    if (only.length) params.push("only=" + only.join(","));
    const url = location.pathname + (params.length ? "?" + params.join("&") : "");
    if (url === location.pathname + location.search && !location.hash) return;
    // pushState (unlike the old location.hash assignment) fires no event,
    // so no suppression dance is needed
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }

  function urlToState() {
    const params = new URLSearchParams(location.search);
    // legacy share links carried the state in the hash (#q=…&v=…)
    const legacy = new URLSearchParams(location.hash.slice(1));
    const get = (k) => params.get(k) ?? legacy.get(k);
    let q = get("q") || "";
    // even older links carried a mode: fold it into the query as a field tag
    const legacyMode = get("m");
    if (legacyMode && isChipField(legacyMode) && q && !/[a-z]+:/i.test(q)) {
      q = `${legacyMode}:${/\s/.test(q) ? `"${q}"` : q}`;
    }
    return { v: get("v"), q, only: get("only") };
  }

  // set the "Only spells with" filters from the URL's only= list (absent
  // = all off) and sync the checkboxes
  function filtersFromUrl(str) {
    const wanted = new Set((str || "").split(","));
    for (const k of Object.keys(state.filters)) state.filters[k] = wanted.has(k);
    for (const box of document.querySelectorAll("#filters input[type=checkbox]")) {
      box.checked = state.filters[box.dataset.filter];
    }
  }

  // A shared link may search a field whose column is hidden here —
  // honor the link by un-hiding that column for this session.
  function ensureFieldVisible(field) {
    if (!Search.FIELDS[field] || !disabledFields().has(field)) return;
    for (const [col, fields] of Object.entries(COL_FIELDS)) {
      if (fields.includes(field)) state.hiddenCols[col] = false;
    }
    applyHiddenCols();
  }

  // accepts both full build ids and short "9.2.7" forms
  function findVersion(v) {
    if (!v) return undefined;
    return state.versions.find((e) => e.id === v) ||
           state.versions.findLast((e) => shortVersion(e.id) === v);
  }

  /* ------------------------------------------------------------ events */

  function crossSearch(query) {
    loadQueryString(query);
    runSearch({ push: true });
    window.scrollTo({ top: 0 });
  }

  function wireEvents() {
    const input = $("#q");

    input.addEventListener("input", (e) => {
      if (!state.activeField) {
        // pasted text arrives whole, so a "model:fire" inside it never
        // passes the caret check below — parse the full value into chips
        // instead. Only for pastes: while typing, tags chip at the ":"
        if (e.inputType === "insertFromPaste" && /(^|\s)-?[a-z]+:\S/i.test(input.value)) {
          const parts = parseQueryParts(input.value);
          if (parts.some((p) => p.field !== "all")) {
            const last = parts[parts.length - 1];
            const trailing = last && last.field === "all" ? parts.pop().text : "";
            const at = Math.min(state.pos, state.chips.length);
            state.chips.splice(at, 0, ...parts);
            state.pos = at + parts.length;
            input.value = trailing;
            input.setSelectionRange(input.value.length, input.value.length);
            syncBar();
            scheduleSearch();
            return;
          }
        }
        // a "field:" tag just typed — anywhere, not only at the end: text
        // before it stays free words, text after the caret becomes the
        // tag's content (e.g. "model:|statue" -> model: chip with "statue").
        // Inside an open "quote the prefix stays literal — quoting is how
        // you search for the text model: itself.
        const caret = input.selectionStart;
        const before = input.value.slice(0, caret);
        const inQuote = ((before.match(/"/g) || []).length % 2) === 1;
        const m = before.match(/(^|\s)(-?)([a-z]+):$/i);
        if (m && !inQuote && isChipField(canonField(m[3].toLowerCase()))) {
          const field = canonField(m[3].toLowerCase());
          const rest = input.value.slice(caret);
          input.value = input.value.slice(0, m.index + m[1].length);
          activateField(field, { not: m[2] === "-" });
          if (rest) {
            input.value = rest;
            input.setSelectionRange(0, 0);
            sizeInput();
            scheduleSearch();
          }
          return;
        }
        updateSuggest();
      }
      sizeInput();
      scheduleSearch();
    });

    input.addEventListener("keydown", (e) => {
      const box = $("#suggest");
      if (!box.hidden) {
        const items = [...box.querySelectorAll(".suggest-item")];
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          suggestIndex = (suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items.forEach((it, i) => it.classList.toggle("selected", i === suggestIndex));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && suggestIndex >= 0)) {
          e.preventDefault();
          selectSuggestion(items[Math.max(suggestIndex, 0)].dataset.field);
          return;
        }
        if (e.key === "Escape") { hideSuggest(); return; }
      }

      // ---- bar undo/redo (the bar keeps its own history — see barHistory) ----
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redoBar(); else undoBar();
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoBar();
        return;
      }

      // ---- bar-wide selection (chips + input as one line) ----
      if (mod && !e.altKey && e.key.toLowerCase() === "a"
          && (state.chips.length || state.activeField || input.value)) {
        e.preventDefault();
        input.select();
        state.barSel = { anchor: 0, focus: atomCount() };
        paintBarSel();
        return;
      }
      if (state.barSel) {
        if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
          e.preventDefault();
          const text = serializeBarSel();
          if (text) copyText(text);
          if (e.key.toLowerCase() === "x") deleteBarSel();
          return;
        }
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          deleteBarSel();
          return;
        }
        if (e.key === "Escape") { clearBarSel(); return; }
        if (!e.shiftKey && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
          clearBarSel();
          return; // the input's own selection collapses natively
        }
        // typing/pasting over the selection is handled in beforeinput —
        // it fires for every way text can enter the input, keydown doesn't
      }
      if (e.shiftKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const I = inputAtom(), N = atomCount();
        if (state.barSel) {
          e.preventDefault();
          const focus = state.barSel.focus + (e.key === "ArrowLeft" ? -1 : 1);
          applyKbSel(state.barSel.anchor, Math.max(0, Math.min(N, focus)));
          return;
        }
        // spill out of the input into the chips beside it
        if (e.key === "ArrowLeft" && input.selectionStart === 0 && I > 0) {
          e.preventDefault();
          applyKbSel(I + 1, I - 1);
          return;
        }
        if (e.key === "ArrowRight" && input.selectionEnd === input.value.length && I < N - 1) {
          e.preventDefault();
          applyKbSel(I, I + 2);
          return;
        }
      }

      const caretAtStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const caretAtEnd = input.selectionStart === input.value.length
        && input.selectionEnd === input.value.length;

      // typing "-" at the very start of a tag flips it to an exclusion,
      // instead of typing "-model:..." from scratch
      if (e.key === "-" && state.activeField && caretAtStart) {
        e.preventDefault();
        state.activeNot = !state.activeNot;
        renderBar();
        return;
      }

      if (e.key === "Enter") {
        commitActiveChip();
        syncBar();
        runSearch({ push: true });
      } else if ((e.key === "Tab" || e.key === "Escape" || (e.key === "ArrowRight" && caretAtEnd))
                 && state.activeField) {
        // close the tag being typed — lands in the gap right after it
        e.preventDefault();
        commitActiveChip();
        syncBar();
        scheduleSearch();
      } else if (e.key === "ArrowLeft" && state.activeField && caretAtStart) {
        // close the tag being typed — lands in the gap right before it
        e.preventDefault();
        commitActiveChip("before");
        syncBar();
        scheduleSearch();
      } else if (e.key === "ArrowLeft" && !state.activeField && caretAtStart && state.pos > 0) {
        // walk left out of the plain-text run (or empty gap) into the
        // chip before it — any text is committed as a free run first
        e.preventDefault();
        const at = insertFreeChipHere();
        editChipAt(at === -1 ? state.pos - 1 : at - 1, "end");
      } else if (e.key === "ArrowRight" && !state.activeField && caretAtEnd && state.pos < state.chips.length) {
        // walk right out of the plain-text run into the chip after it
        e.preventDefault();
        const at = insertFreeChipHere();
        editChipAt(at === -1 ? state.pos : at + 1, "start");
      } else if (e.key === "Backspace" && state.activeField && caretAtStart) {
        // cursor at the start of a tag's contents (or tag empty): strip the
        // tag, leaving the contents behind as plain text
        e.preventDefault();
        cancelActiveField();
      } else if (e.key === "Backspace" && !state.activeField && caretAtStart && state.pos > 0) {
        // backspacing past the start of the plain-text run: dive into
        // editing the chip to the left, caret at its end
        e.preventDefault();
        const at = insertFreeChipHere();
        editChipAt(at === -1 ? state.pos - 1 : at - 1, "end");
      }
    });

    // context-menu copy/cut on the input honor a bar selection too
    input.addEventListener("copy", (e) => {
      if (!state.barSel) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", serializeBarSel());
    });
    input.addEventListener("cut", (e) => {
      if (!state.barSel) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", serializeBarSel());
      deleteBarSel();
    });
    // any text entering the input (typed, pasted, IME-composed) replaces a
    // bar selection first — beforeinput fires before the mutation lands, so
    // the new text arrives at the collapsed caret the deletion leaves.
    // Context-menu Undo/Redo reroute to the bar's own history: the native
    // stack only knows the input's text, not the chips around it.
    input.addEventListener("beforeinput", (e) => {
      if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
        e.preventDefault();
        if (e.inputType === "historyUndo") undoBar(); else redoBar();
        return;
      }
      if (state.barSel) deleteBarSel();
    });
    input.addEventListener("paste", () => { if (state.barSel) deleteBarSel(); });
    document.addEventListener("mousedown", (e) => {
      if (state.barSel && !e.target.closest("#qbar")) clearBarSel();
    });

    // mouse-drag selection across the bar. A drag within the input stays
    // native; once the pointer leaves the editor (or the drag started on a
    // chip), whole atoms select between the anchor gap and the pointer.
    let dragSel = null;        // { anchor, x0, y0, fromInput, engaged }
    let suppressBarClick = false;

    function onBarDragMove(e) {
      if (!dragSel) return;
      if (!dragSel.engaged) {
        if (Math.abs(e.clientX - dragSel.x0) < 4 && Math.abs(e.clientY - dragSel.y0) < 4) return;
        if (dragSel.fromInput) {
          const r = $("#editwrap").getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right
              && e.clientY >= r.top && e.clientY <= r.bottom) return;
          // leaving the editor: anchor at the input's far edge so the
          // whole free-text run rides along with the selection
          const I = inputAtom();
          dragSel.anchor = atomGapAtPoint(e.clientX, e.clientY) <= I ? I + 1 : I;
        }
        dragSel.engaged = true;
      }
      e.preventDefault(); // stop native text selection fighting the overlay
      const focus = atomGapAtPoint(e.clientX, e.clientY);
      if (focus === dragSel.anchor) { clearBarSel(); return; }
      state.barSel = { anchor: dragSel.anchor, focus };
      const [s, en] = selRange();
      const I = inputAtom();
      if (s <= I && I < en) input.select();
      else input.setSelectionRange(input.value.length, input.value.length);
      paintBarSel();
    }

    function onBarDragEnd(e) {
      onBarDragMove(e); // a fast drag's last mousemove lags the release point
      document.removeEventListener("mousemove", onBarDragMove);
      document.removeEventListener("mouseup", onBarDragEnd);
      if (dragSel && dragSel.engaged) {
        suppressBarClick = true; // the release click must not move the gap
        input.focus({ preventScroll: true });
      }
      dragSel = null;
    }

    $("#qbar").addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      clearBarSel();
      const fromInput = !!e.target.closest("#editwrap");
      // keep focus (and suppress native chip-text selection); clicks still fire
      if (!fromInput) e.preventDefault();
      dragSel = {
        anchor: atomGapAtPoint(e.clientX, e.clientY),
        x0: e.clientX, y0: e.clientY, fromInput, engaged: false,
      };
      document.addEventListener("mousemove", onBarDragMove);
      document.addEventListener("mouseup", onBarDragEnd);
    });

    // chip clicks: × removes, field label flips include/exclude, body edits
    $("#qbar").addEventListener("click", (e) => {
      if (suppressBarClick) { suppressBarClick = false; return; }
      const x = e.target.closest("[data-chip-remove]");
      if (x) {
        const idx = Number(x.dataset.chipRemove);
        state.chips.splice(idx, 1);
        if (idx < state.pos) state.pos -= 1;
        syncBar();
        input.focus();
        scheduleSearch();
        return;
      }
      const label = e.target.closest("[data-chip-not]");
      if (label) {
        const chip = state.chips[Number(label.dataset.chipNot)];
        chip.not = !chip.not;
        renderBar();
        input.focus();
        scheduleSearch();
        return;
      }
      if (e.target.closest("#editlabel")) {
        state.activeNot = !state.activeNot;
        renderBar();
        input.focus();
        scheduleSearch();
        return;
      }
      const chip = e.target.closest("[data-chip-edit]");
      if (chip) {
        // flush anything pending elsewhere first, correcting the target
        // index if that insertion landed before it
        let idx = Number(chip.dataset.chipEdit);
        const insertedAt = flushPending();
        if (insertedAt !== -1 && insertedAt <= idx) idx += 1;
        editChipAt(idx);
        return;
      }
      if (e.target.closest("#editwrap")) return; // clicks in the editor place the caret natively

      // bar background: commit whatever's pending and move the gap (and
      // cursor) to where the click landed
      const past = (elem) => { // is the click past this element in reading order?
        const r = elem.getBoundingClientRect();
        return e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > (r.left + r.right) / 2);
      };
      let gap = 0;
      for (const c of $("#qbar").querySelectorAll(".qchip")) {
        if (past(c)) gap = Number(c.dataset.chipEdit) + 1;
      }
      const afterPending = past($("#editwrap"));
      const insertedAt = flushPending();
      if (insertedAt !== -1 && (insertedAt < gap || (insertedAt === gap && afterPending))) gap += 1;
      state.pos = Math.min(gap, state.chips.length);
      syncBar();
      input.focus();
      scheduleSearch();
    });

    // suggestions
    $("#suggest").addEventListener("mousedown", (e) => {
      const item = e.target.closest(".suggest-item");
      if (item) { e.preventDefault(); selectSuggestion(item.dataset.field); }
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#qbar") && !e.target.closest("#suggest")) hideSuggest();
    });

    // field buttons: "+ Label" includes, "−" (or shift-click) excludes
    $("#tabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-field]");
      if (btn) activateField(btn.dataset.field, { not: btn.dataset.not === "1" || e.shiftKey });
    });

    // results: copy buttons / cross-search / expanders (event delegation)
    $("#results").addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      if (t.dataset.copy) copyText(t.dataset.copy, e.shiftKey);
      else if (t.dataset.play) toggleSound(t);
      else if (t.dataset.search) crossSearch((e.shiftKey ? "-" : "") + t.dataset.search);
      else if (t.dataset.expand) {
        const td = t.closest("td");
        td.classList.add("expanded");
        // expansion is cell-wide: every "+N" expander in the cell is spent
        for (const m of td.querySelectorAll(".more")) m.remove();
      }
    });

    // example searches on the empty-state panel
    $("#empty-state").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-search]");
      if (b) crossSearch(b.dataset.search);
    });

    // share + export
    $("#share-link").addEventListener("click", shareLink);
    $("#export-csv").addEventListener("click", exportCsv);
    $("#export-json").addEventListener("click", exportJson);
    $("#export-discord").addEventListener("click", exportDiscord);

    // filters — part of the shareable state, so the URL follows (a push:
    // Back undoes the toggle like it undoes a search)
    for (const box of document.querySelectorAll("#filters input[type=checkbox]")) {
      box.addEventListener("change", () => {
        state.filters[box.dataset.filter] = box.checked;
        applyFiltersAndSort();
        stateToUrl(true);
      });
    }

    // column visibility
    for (const box of document.querySelectorAll("#columns input[type=checkbox]")) {
      box.addEventListener("change", () => {
        state.hiddenCols[box.dataset.col] = !box.checked;
        try { localStorage.setItem("epsilook.hiddenCols.v4", JSON.stringify(state.hiddenCols)); } catch (e) {}
        applyHiddenCols();
        runSearch();
      });
    }

    // sorting: click cycles ascending -> descending -> back to automatic order
    for (const th of document.querySelectorAll("th[data-sort]")) {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (state.sort.key !== key) state.sort = { key, dir: 1 };
        else if (state.sort.dir === 1) state.sort.dir = -1;
        else state.sort = { key: "auto", dir: 1 };
        applyFiltersAndSort();
      });
    }

    // help dialog (native <dialog>: Esc closes it for free)
    const help = $("#help");
    $("#help-btn").addEventListener("click", () => help.showModal());
    $("#help-close").addEventListener("click", () => help.close());
    help.addEventListener("click", (e) => {
      if (e.target === help) help.close(); // backdrop click
    });

    // infinite scroll
    new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) renderMore();
    }, { rootMargin: "600px" }).observe($("#sentinel"));

    // back/forward (pushState entries and legacy #q= entries both land here)
    window.addEventListener("popstate", () => applyUrl({ push: false }));

    // version switch
    $("#version").addEventListener("change", async (e) => {
      const entry = state.versions.find((v) => v.id === e.target.value);
      if (entry) await activateVersion(entry, { push: true });
    });
  }

  function updateTabs() {
    for (const tab of document.querySelectorAll("#tabs .tab")) {
      const isField = tab.dataset.field === state.activeField;
      tab.classList.toggle("active", isField && !state.activeNot);
      tab.classList.toggle("active-not", isField && state.activeNot);
    }
  }

  /* Hide table columns and sync the checkboxes. Field buttons stay
   * visible — clicking one un-hides its column via ensureFieldVisible.
   * The "Only spells with" filters are independent of column visibility:
   * they narrow the result list whether or not the column is shown. */
  function applyHiddenCols() {
    const table = $("#results");
    for (const [col, hidden] of Object.entries(state.hiddenCols)) {
      table.classList.toggle(`hide-${col}`, hidden);
    }
    for (const box of document.querySelectorAll("#columns input[type=checkbox]")) {
      box.checked = !state.hiddenCols[box.dataset.col];
    }
  }

  /* ------------------------------------------------------------- boot */

  function buildTabs() {
    const tabs = $("#tabs");
    for (const [id, field] of Object.entries(Search.FIELDS)) {
      if (!field.tab) continue;
      // split pill: "+ Label" includes, the "−" half excludes
      const wrap = el("span", "tab");
      wrap.dataset.field = id;
      const inc = el("button", "tab-inc", `${field.label}`);
      inc.dataset.field = id;
      inc.title = `Add a ${id}: tag — ${field.hint}`;
      const exc = el("button", "tab-exc", "−");
      exc.dataset.field = id;
      exc.dataset.not = "1";
      exc.title = `Exclude ${id}: matches (-${id}:)`;
      wrap.append(inc, exc);
      tabs.appendChild(wrap);
    }
  }

  async function activateVersion(entry, { push = false } = {}) {
    const overlay = $("#loading");
    overlay.hidden = false;
    $("#load-error").hidden = true;
    try {
      const pack = await Data.loadPack(entry, (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : 0;
        $("#load-bar").style.width = pct + "%";
        $("#load-text").textContent = total
          ? `Downloading spell data… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
          : `Downloading spell data… ${(got / 1048576).toFixed(1)} MB`;
      });
      $("#load-text").textContent = "Building search indexes…";
      await new Promise((r) => setTimeout(r)); // let the text paint
      state.data = Data.buildIndexes(pack);
      state.version = entry;
      $("#version").value = entry.id;
      $("#meta-info").textContent =
        `${entry.label} (${entry.id}) · Listfile ${state.data.meta.listfileTag} · Built ${state.data.meta.built} · ` +
        `${state.data.meta.counts.spells.toLocaleString()} spells`;
      $("#es-count").textContent = state.data.meta.counts.spells.toLocaleString();
      overlay.hidden = true;
      runSearch({ push });
    } catch (err) {
      console.error(err);
      $("#load-text").textContent = "";
      $("#load-error").textContent = `Failed to load spell data: ${err.message}`;
      $("#load-error").hidden = false;
    }
  }

  function applyUrl({ push }) {
    const h = urlToState();
    loadQueryString(h.q);
    filtersFromUrl(h.only);
    // no v= in the URL means the default version, not "keep the current
    // one" — back/forward must return from an explicitly-chosen pack
    const wanted = findVersion(h.v) || defaultVersion();
    if (wanted && (!state.version || wanted.id !== state.version.id)) {
      activateVersion(wanted, { push });
    } else {
      runSearch({ push });
    }
  }

  async function boot() {
    try {
      Object.assign(state.hiddenCols, JSON.parse(localStorage.getItem("epsilook.hiddenCols.v4") || "{}"));
    } catch (e) { /* corrupted storage — defaults apply */ }
    buildTabs();
    wireEvents();
    initTexPreview();
    applyHiddenCols();
    try {
      state.versions = await Data.loadVersions();
    } catch (err) {
      $("#load-text").textContent = "";
      $("#load-error").textContent =
        `Failed to load data/versions.json: ${err.message}. ` +
        `If you opened index.html directly from disk, serve the folder over HTTP instead ` +
        `(e.g. "python -m http.server" in the docs folder).`;
      $("#load-error").hidden = false;
      return;
    }

    const sel = $("#version");
    for (const v of state.versions) {
      const opt = el("option", "", `${v.label} (${v.id})`);
      opt.value = v.id;
      sel.appendChild(opt);
    }
    $("#version-wrap").hidden = state.versions.length < 2;

    const h = urlToState();
    // ?export=json|csv downloads the query's results as soon as they're
    // ready. Read it before activateVersion — the first search rewrites the
    // URL (stateToUrl keeps only v/q), so refresh/back won't re-download.
    const autoExport = (new URLSearchParams(location.search).get("export") || "").toLowerCase();
    const entry = findVersion(h.v) || defaultVersion();
    loadQueryString(h.q);
    filtersFromUrl(h.only);
    await activateVersion(entry);
    if (autoExport === "json") exportJson();
    else if (autoExport === "csv") exportCsv();
    $("#q").focus();
  }

  boot();
})();
