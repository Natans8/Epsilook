// @ts-check
/* Epsilook UI: chip search bar, results table, tags, clipboard, scrolling.
 * Shared shapes (SpellData, QueryGroup, the pack, the window globals) are
 * declared in types.d.ts; UI-local shapes are the typedefs below. */
"use strict";

(() => {
  const CFG = window.EpsilookConfig;
  const Data = window.EpsilookData;
  const Search = window.EpsilookSearch;

  /* ---------------------------------------------------------- typedefs */

  /**
   * One committed search-bar chip. field "all" = free text (rendered as
   * plain words, not boxed); not: true excludes matches instead.
   * @typedef {{field: string, text: string, not?: boolean}} Chip
   */

  /**
   * One highlight token of the last search: a positive group's word plus
   * the field it searched (hit checks match it against their own field).
   * @typedef {{field: string, text: string}} HitToken
   */

  /**
   * A full search-bar snapshot for the undo history — chips, the open tag,
   * the input's text and caret. stack[at] always equals the current state.
   * @typedef {Object} BarSnapshot
   * @property {Chip[]} chips
   * @property {string | null} activeField
   * @property {boolean} activeNot
   * @property {number} pos
   * @property {string} value
   * @property {number} caret
   */

  // the search input (the bar's single editing gap) — grabbed once (the
  // element is never replaced), along with the empty-bar placeholder from
  // index.html, before render() starts swapping the property around
  const qInput = /** @type {HTMLInputElement} */ (document.getElementById("q"));
  const DEFAULT_PLACEHOLDER = qInput.placeholder;

  /* ------------------------------------------------------------- state */

  /**
   * All mutable UI state. The bar is: committed `chips` + the chip being
   * typed (`activeField` + the input's text), with the input sitting at
   * gap `pos`.
   * @type {{
   *   versions: VersionEntry[],
   *   version: VersionEntry | null,
   *   data: SpellData | null,
   *   chips: Chip[],
   *   activeField: string | null,
   *   activeNot: boolean,
   *   pos: number,
   *   barSel: {anchor: number, focus: number} | null,
   *   groups: QueryGroup[],
   *   tokens: HitToken[],
   *   lastQuery: string,
   *   results: number[],
   *   display: number[],
   *   searchMs: number,
   *   rendered: number,
   *   filters: Record<string, boolean>,
   *   sort: {key: string, dir: number},
   *   hiddenCols: Record<string, boolean>,
   * }}
   */
  const state = {
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
    filters: { models: false, sounds: false, animkits: false, fx: false },
    sort: { key: "auto", dir: 1 },
    // hidden columns (also excluded from All-mode search and from exports)
    hiddenCols: { models: false, sounds: false, animkits: false, fx: false, mechanics: true, commands: false },
  };

  // column -> search fields it contributes
  const COL_FIELDS = {
    models: ["model"],
    sounds: ["sound"],
    animkits: ["anim"],
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

  /**
   * "9.2.7.45745" -> "9.2.7" (used for clean URLs).
   * @param {string} id
   */
  const shortVersion = (id) => id.split(".").slice(0, 3).join(".");

  /**
   * Display name for a version entry, without the build number — the label
   * from versions.json ("Shadowlands 9.2.7"), or the short patch when a pack
   * was built without --label (label then defaults to the full build id).
   * @param {VersionEntry} entry
   */
  const versionLabel = (entry) =>
    entry.label && entry.label !== entry.id ? entry.label : shortVersion(entry.id);

  /**
   * File name without its extension.
   * @param {string} name
   */
  const stripExt = (name) => name.replace(/\.[^.]+$/, "");

  /**
   * A packed 0xRRGGBB color as a CSS hex string. Every color in the pack —
   * chain tints, glows, ghosts, screen grades — is stored packed, so this is
   * the one place that formatting lives.
   * @param {number} packed
   * @returns {string}
   */
  const hexColor = (packed) => "#" + packed.toString(16).padStart(6, "0");

  /**
   * querySelector shorthand — for elements that provably exist in
   * index.html (hence the non-null HTMLElement return).
   * @param {string} sel
   * @returns {HTMLElement}
   */
  const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

  /**
   * querySelectorAll shorthand, typed for HTML elements.
   * @param {string} sel
   * @param {ParentNode} [root]
   * @returns {NodeListOf<HTMLElement>}
   */
  const $$ = (sel, root = document) =>
    /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(sel));

  /**
   * querySelectorAll for form controls — the checkbox rows read .checked and
   * .value, which plain Element / HTMLElement don't carry.
   * @param {string} sel
   * @param {ParentNode} [root]
   * @returns {NodeListOf<HTMLInputElement>}
   */
  const $$inputs = (sel, root = document) =>
    /** @type {NodeListOf<HTMLInputElement>} */ (root.querySelectorAll(sel));

  /**
   * Create an element, optionally with a class and text content.
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /**
   * The closest ancestor of an event's target matching sel, or null —
   * the typed form of `e.target.closest(sel)`.
   * @param {Event} e
   * @param {string} sel
   * @returns {HTMLElement | null}
   */
  const targetClosest = (e, sel) => e.target instanceof Element
    ? /** @type {HTMLElement | null} */ (e.target.closest(sel)) : null;

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

  /**
   * execCommand-based clipboard fallback (the deprecated API is the only
   * option when navigator.clipboard is unavailable, e.g. plain-http hosts).
   * @param {string} text
   * @param {() => void} done - called only when the copy succeeded
   */
  function fallbackCopy(text, done) {
    // ta.select() steals focus — put it back afterwards
    const prev = /** @type {HTMLElement | null} */ (document.activeElement);
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

  const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)}/g, (_, k) => vars[k] ?? "");

  /* ------------------------------------------------- query <-> chips */

  // legacy prefixes silently convert to their current field — effect: was
  // the fx: column's name before the effect:->mech: split; soundkit: and
  // animkit: folded into sound:/anim: 2026-07-19 (numeric chips match kit IDs)
  const FIELD_ALIASES = { effect: "fx", soundkit: "sound", animkit: "anim" };
  const canonField = (f) => FIELD_ALIASES[f] || f;

  // Epsilon commands go straight into the bar: ".cast 12345" / ".aura 12345"
  // (and truncations down to .c / .au — .a stays plain text) mean id:, the
  // space after the command acting as the tag's ":". One alternation,
  // three uses: rewriting parsed strings (quoted spans stay literal),
  // sniffing pastes, and live typing (the \s just typed ends the match).
  const ID_CMDS = "cast|cas|ca|c|aura|aur|au";
  const ID_CMD_REWRITE = new RegExp(`"[^"]*"|(^|\\s)\\.(?:${ID_CMDS})\\s+(?=\\S)`, "gi");
  const ID_CMD_PASTE = new RegExp(`(^|\\s)\\.(?:${ID_CMDS})\\s+\\S`, "i");
  const ID_CMD_TYPED = new RegExp(`(^|\\s)\\.(?:${ID_CMDS})\\s$`, "i");

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
    const inputText = qInput.value.trim();
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
    // Epsilon commands become id: tags (".cast 12345" -> id:12345);
    // inside "quoted phrases" the text stays literal
    str = (str || "").replace(ID_CMD_REWRITE,
      (m, pre) => pre === undefined ? m : pre + "id:");
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
    qInput.value = "";
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
    const live = toGroup(state.activeField || "all", qInput.value, state.activeField ? state.activeNot : false);
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
    qInput.placeholder = state.activeField
      ? (state.activeNot ? "exclude: " : "") + Search.FIELDS[state.activeField].short
      : (state.chips.length ? "" : DEFAULT_PLACEHOLDER);
    sizeInput();
    updateTabs();
    paintBarSel();
  }

  // The input hugs its content instead of stretching, except at the true
  // trailing gap (nothing after it), which fills the rest of the line.
  function sizeInput() {
    const input = qInput;
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
    qInput.focus();
    scheduleSearch();
  }

  // Commits the field chip currently being typed (if any) into state.chips
  // at state.pos. landing places the gap just past the new chip ("after",
  // default) or just before it ("before"). Returns the insertion index,
  // or -1 if there was nothing (or no field) to commit. Pure state
  // mutation — the calling flow ends with its own syncBar().
  function commitActiveChip(landing = "after") {
    if (!state.activeField) return -1;
    const input = qInput;
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
    const input = qInput;
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

  /** Repaint which chips show as selected (from state.barSel). */
  function paintBarSel() {
    const sel = new Set(selectedChipIndices());
    for (const chip of $$(".qchip", $("#qbar"))) {
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
    const input = qInput;
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
    const input = qInput;
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
    const input = qInput;
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
    const input = qInput;
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
    const input = qInput;
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

  /**
   * The category words a field's column shows as group heads, with the
   * tooltip text explaining each — one registry drives the chip
   * autocomplete; the columns' own cell/search code keeps the same words
   * searchable and their heads clickable. Add a new column's words here.
   * @param {string | null} field
   * @returns {{words: string[], titles: Record<string, string>} | null}
   *   Null = the field has no category words.
   */
  /* Target-type words autocomplete in every column that shows the icons —
   * they read as categories to the user even though they are mask bit tests
   * rather than corpus words (see TARGET_TESTS in search.js). */
  const TARGET_WORD_TITLES = {
    caster: "Plays on the caster",
    target: "Plays on the target",
    area: "Plays in the spell's area of effect (or where a missile lands)",
    both: "Plays on both the caster and the target",
  };

  function fieldCategories(field) {
    const d = state.data;
    /** Category words plus the target words every marked column shares. */
    const withTargets = (words, titles) => ({
      words: [...words, ...Search.TARGET_WORDS],
      titles: { ...titles, ...TARGET_WORD_TITLES },
    });
    switch (field) {
      case "fx": return withTargets(Object.keys(FX_HEAD_TITLES), FX_HEAD_TITLES);
      case "model": return withTargets(
        // "" is the attach category: loose pills, no word to search by
        Object.values((d && d.modelCatNames) || {}).filter(Boolean),
        MODEL_CAT_TITLES);
      case "anim": return withTargets(Object.keys(ANIM_CAT_TITLES), ANIM_CAT_TITLES);
      case "sound": return withTargets([], {});
      default: return null;
    }
  }

  function updateSuggest() {
    const input = qInput;
    const box = $("#suggest");
    // inside a chip whose column has category words, those autocomplete
    // instead of field prefixes ("des" -> desaturate, "sta" -> stance)
    if (state.activeField) {
      return fieldCategories(state.activeField) ? updateCategorySuggest() : hideSuggest();
    }
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

  // suggest the column's category words while typing in its chip; picking
  // one completes the word in place (it stays part of the chip's text)
  function updateCategorySuggest() {
    const input = qInput;
    const box = $("#suggest");
    const word = input.value.split(/\s+/).pop().toLowerCase();
    if (!word) return hideSuggest();
    const { words, titles } = fieldCategories(state.activeField);
    const matches = words.filter((w) => w.startsWith(word) && w !== word);
    if (!matches.length) return hideSuggest();

    box.textContent = "";
    matches.forEach((w) => {
      const b = el("button", "suggest-item");
      b.appendChild(el("span", `suggest-field f-${state.activeField}`, w));
      // the parenthesized table name is build trivia — the plain half explains
      b.appendChild(el("span", "suggest-hint", (titles[w] || "").split(" (")[0]));
      b.dataset.word = w;
      box.appendChild(b);
    });
    suggestIndex = -1;
    box.hidden = false;
  }

  // complete the partial last word of the chip's text to the category word
  function applyCategoryWord(word) {
    const input = qInput;
    input.value = input.value.replace(/\S*$/, word);
    hideSuggest();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    sizeInput();
    scheduleSearch();
  }

  // a suggestion item is either a field prefix or a category word
  function pickSuggestItem(item) {
    if (item.dataset.word) applyCategoryWord(item.dataset.word);
    else selectSuggestion(item.dataset.field);
  }

  function hideSuggest() {
    $("#suggest").hidden = true;
    suggestIndex = -1;
  }

  function selectSuggestion(field) {
    const input = qInput;
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
    // Exact-ID tags (id:, and numeric kit IDs in sound:/anim:) always count
    // as enough: IDs below 10 are a single keystroke and the lookup is
    // exact and cheap
    const groups = currentGroups();
    const isExactId = (g, t) => (Search.FIELDS[g.field] || {}).orGroups
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

  // multi-value columns sort by how many entries a row shows there — the
  // count keys mirror the column names; clicking those headers starts at
  // "most entries first" (the extreme spells are the interesting ones)
  const COUNT_SORTS = new Set(["models", "sounds", "animkits", "fx", "mechanics"]);

  function entryCountFn(key) {
    const d = state.data;
    const len = (m, id) => (m.get(id) || []).length;
    switch (key) {
      case "models": return (id) =>
        d.spellModelCats.size ? len(d.spellModelCats, id) : len(d.spellModels, id);
      case "sounds": return (id) => len(d.spellSounds, id);
      case "animkits": return (id) =>
        len(d.spellAnimKits, id) + len(d.spellAnims, id) + len(d.spellVisualAnims, id);
      case "mechanics": return (id) => len(d.spellEffects, id) + len(d.spellAuras, id);
      case "fx": return (id) =>
        len(d.spellFx, id) + len(d.spellDissolves, id) + len(d.spellGlows, id)
        + len(d.spellShadowies, id) + len(d.spellGhostMats, id) + len(d.spellTints, id)
        + len(d.spellDesaturates, id) + len(d.spellTransps, id)
        + (d.spellFreezes.has(id) ? 1 : 0) + (d.spellCamos.has(id) ? 1 : 0)
        + len(d.spellScreens, id) + len(d.spellMorphs, id)
        + len(d.spellShapeshifts, id) + len(d.spellSummons, id);
    }
  }

  // Spells that actually carry a category a chip names rank above spells
  // matched only through a file/texture name containing the same word —
  // fx:desaturate must not drown under "desaturated" chain textures.
  // Returns null when no chip names a category, else (id) -> hit count.
  function categoryRanker() {
    const d = state.data;
    const FX_SETS = {
      chain: d.spellFx, dissolve: d.spellDissolves, glow: d.spellGlows,
      tint: d.spellTints, desaturate: d.spellDesaturates,
      transparency: d.spellTransps, freeze: d.spellFreezes, camo: d.spellCamos,
      screen: d.spellScreens, shapeshift: d.spellShapeshifts,
      morph: d.spellMorphs, summon: d.spellSummons,
    };
    const tests = [];
    for (const g of state.groups) {
      if (g.not) continue;
      for (const t of g.tokens) {
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
          tests.push((id) => d.spellAnims.has(id));
        }
        // a target word floats spells that really carry a row of that type
        // above the ones that merely have it in a file name
        // (beamtarget_onground). Resolved once via the field's own matcher.
        if (TARGET_WORD_TITLES[t.text] && Search.FIELDS[g.field]) {
          const matches = Search.FIELDS[g.field].run([{ text: t.text }], d, new Set());
          tests.push((id) => matches.has(id));
        }
      }
    }
    if (!tests.length) return null;
    return (id) => tests.reduce((n, f) => n + (f(id) ? 1 : 0), 0);
  }

  function applyFiltersAndSort() {
    const d = state.data;
    let list = state.results;

    const f = state.filters;
    if (f.models || f.sounds || f.animkits || f.fx) {
      list = list.filter((id) =>
        (!f.models || d.spellModels.has(id)) &&
        (!f.sounds || d.spellSounds.has(id)) &&
        (!f.animkits || d.spellAnimKits.has(id) || d.spellAnims.has(id)
          || d.spellVisualAnims.has(id)) &&
        (!f.fx || d.spellFx.has(id) || d.spellDissolves.has(id) || d.spellGlows.has(id)
          || d.spellShadowies.has(id) || d.spellGhostMats.has(id) || d.spellTints.has(id)
          || d.spellDesaturates.has(id) || d.spellTransps.has(id)
          || d.spellFreezes.has(id) || d.spellCamos.has(id) || d.spellScreens.has(id)
          || d.spellMorphs.has(id) || d.spellShapeshifts.has(id)
          || d.spellSummons.has(id)));
    } else {
      list = list.slice();
    }

    const { key, dir } = state.sort;
    if (key === "id") {
      list.sort((a, b) => (a - b) * dir);
    } else if (key === "name") {
      list.sort((a, b) =>
        d.names[d.spellIndex.get(a)].localeCompare(d.names[d.spellIndex.get(b)]) * dir || a - b);
    } else if (COUNT_SORTS.has(key)) {
      const count = entryCountFn(key);
      const c = new Map(list.map((id) => [id, count(id)]));
      list.sort((a, b) => (c.get(a) - c.get(b)) * dir || a - b);
    } else { // auto
      const nameTokens = state.tokens.filter((t) => t.field === "name" || t.field === "all");
      if (nameTokens.length) {
        Search.sortByRelevance(list, nameTokens.map((t) => t.text).join(" "), d);
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

    // Models — grouped by how each model is used (attach/missile/area/...)
    tr.appendChild(modelsCell(spellId));

    // Sounds — grouped by SoundKit; kits containing a match come first
    tr.appendChild(soundsCell(d.spellSounds.get(spellId) || []));

    // Animations — loose kit-played anims first, then AnimKits grouped with
    // the animations they play, then direct stand/walk anims ("stance")
    tr.appendChild(animationsCell(d.spellAnimKits.get(spellId) || [],
      d.spellAnims.get(spellId) || [],
      d.spellVisualAnims.get(spellId) || [], spellId));

    // Effects — visual FX (beams, morphs, summons), grouped by category
    tr.appendChild(fxCell(spellId));

    // Mechanics — spell effects, then aura mechanics; matched ones first
    const mechs = hitsFirst(
      (d.spellEffects.get(spellId) || []).slice().sort((a, b) => a - b)
        .map((e) => /** @type {{effect?: number, aura?: number}} */ ({ effect: e }))
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

  /**
   * Highlight the query-matched parts of a spell name.
   * @param {string} name
   * @returns {DocumentFragment}
   */
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

  /* Models cell: grouped by how each model is used — "attached" (to the
   * caster/target), "missile" (projectile), "area" (ground/area model),
   * "trail" (weapon trail), "barrage" (volley) — fx-cell conventions:
   * clickable heads searching model:<category>, pills inside. A stale
   * cached pack carries no categories: flat-list fallback. */
  function modelsCell(spellId) {
    const d = state.data;
    const entries = d.spellModelCats.get(spellId);
    if (!entries) {
      const modelFids = hitsFirst(d.spellModels.get(spellId) || [],
        (fid) => fileIsHit(d.files.get(fid), "model"));
      return tagCell("c-models", modelFids.map((fid) => modelTag(fid)));
    }
    const td = el("td", "c-models");
    const byCat = new Map(); // cat id -> [{fid, targets}]
    for (const e of entries) {
      const arr = byCat.get(e.cat);
      if (arr) arr.push(e); else byCat.set(e.cat, [e]);
    }
    // a category with no word (attach models) has nothing a group head could
    // usefully say — which unit the model plays on is the target icon's job
    // now — so those render as loose pills, like the loose animation pills
    const loose = [];
    const cats = [];
    for (const c of [...byCat.keys()].sort((a, b) => a - b)) {
      const name = d.modelCatNames[c] || "";
      const items = byCat.get(c);
      if (!name) { loose.push(...items); continue; }
      cats.push({
        name,
        items,
        hit: items.some((e) => modelFileIsHit(d.files.get(e.fid), name)),
      });
    }
    for (const e of hitsFirst(loose, (x) => modelFileIsHit(d.files.get(x.fid), ""))) {
      td.appendChild(modelTag(e.fid, "", e.targets));
    }
    buildKitGroups(td, hitsFirst(cats, (c) => c.hit), {
      headerTag: (c) => modelCatHeadTag(c.name, c.hit),
      itemsOf: (c) => hitsFirst(c.items, (e) => modelFileIsHit(d.files.get(e.fid), c.name)),
      itemTag: (e, c) => modelTag(e.fid, c.name, e.targets),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "category",
      moreInHead: true,
      compact: true,
    });
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
    const kitMask = new Map(); // soundKitId -> union of its rows' target masks
    for (const e of soundEntries) {
      const arr = byKit.get(e.soundKitId);
      if (arr) arr.push(e.fid); else byKit.set(e.soundKitId, [e.fid]);
      kitMask.set(e.soundKitId, (kitMask.get(e.soundKitId) || 0) | (e.targets || 0));
    }

    const kitHasHit = (kitId) =>
      kitIsHit(kitId, "soundkit") ||
      byKit.get(kitId).some((fid) => fileIsHit(d.files.get(fid), "sound"));
    const kitIds = hitsFirst([...byKit.keys()].sort((a, b) => a - b), kitHasHit);

    buildKitGroups(td, kitIds, {
      // the icon rides the kit head: every file in a kit plays together, so
      // the whole kit shares one target type
      headerTag: (kitId) => addTargetIcons(kitTag(kitId, "soundkit"), kitMask.get(kitId)),
      itemsOf: (kitId) => hitsFirst(byKit.get(kitId), (fid) => fileIsHit(d.files.get(fid), "sound")),
      itemTag: (fid) => soundTag(fid),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "kit",
    });
    return td;
  }

  /* Animations cell, three sources in render order: loose pills for the
   * animations the spell's visual kits play directly (SpellVisualAnim —
   * nothing to group them under), AnimKits grouped with the animations they
   * play, and a "stance" group for direct stand/walk anim overrides
   * (SpellProceduralEffect Type 7) — same anim pills, no kit id to head the
   * group with. Loose pills never collapse (99%+ of spells have ≤3). */
  const STANCE_GROUP = -1; // sentinel kit id for the direct-anim group

  function animationsCell(animKitIds, stanceAnimIds, looseAnimIds, spellId) {
    const td = el("td", "c-animkits");
    if (animKitIds.length === 0 && stanceAnimIds.length === 0
        && looseAnimIds.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }
    const d = state.data;
    const looseMasks = d.visualAnimTargets.get(spellId);
    for (const a of hitsFirst(looseAnimIds.slice().sort((x, y) => x - y),
      (x) => animIsHit(x))) {
      td.appendChild(animTag(a, "", looseMasks ? looseMasks.get(a) || 0 : 0));
    }
    const animsOf = (kitId) =>
      kitId === STANCE_GROUP ? stanceAnimIds : (d.animKitAnims.get(kitId) || []);
    // the stance group's anims match through its category word too
    const wordOf = (kitId) => (kitId === STANCE_GROUP ? "stance" : "");
    const kitHasHit = (kitId) =>
      (kitId !== STANCE_GROUP && kitIsHit(kitId, "animkit")) ||
      animsOf(kitId).some((a) => animIsHit(a, wordOf(kitId)));
    const groups = animKitIds.slice().sort((a, b) => a - b);
    if (stanceAnimIds.length) groups.push(STANCE_GROUP);
    const kitIds = hitsFirst(groups, kitHasHit);

    buildKitGroups(td, kitIds, {
      // stance overrides are ~96% caster — a constant, so no icon there
      // (documented in the help dialog instead); animkits carry theirs
      headerTag: (kitId) => kitId === STANCE_GROUP
        ? stanceHeadTag(kitHasHit(kitId))
        : addTargetIcons(kitTag(kitId, "animkit"),
          maskOf(d.animKitTargets, spellId, [kitId])),
      itemsOf: (kitId) => hitsFirst(animsOf(kitId).slice().sort((a, b) => a - b),
        (a) => animIsHit(a, wordOf(kitId))),
      itemTag: (animId, kitId) => animTag(animId, wordOf(kitId)),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "kit",
    });
    return td;
  }

  /* Head of the stance group — a category word like the model/fx heads:
   * clicking searches the whole group via anim:stance. */
  const ANIM_CAT_TITLES = {
    stance: "Stand/walk animation override (SpellProceduralEffect) — "
      + "the caster plays these as its idle/move animations while the visual is active",
  };

  function stanceHeadTag(hit) {
    const tag = el("span", "tag animkit");
    if (hit) tag.classList.add("hit");
    const label = el("button", "tag-label", "stance");
    label.title = `${ANIM_CAT_TITLES.stance}`
      + "\nClick: find all spells with a stance override\nShift-click: exclude them instead";
    label.dataset.search = "anim:stance";
    tag.appendChild(label);
    return tag;
  }

  /* Shared group renderer: each kit is a small box — the kit tag as a
   * tinted head segment, its items flowing (and wrapping) beside it —
   * collapsing only when it actually saves space. With opts.moreInHead a
   * group's own "+N" expander sits in its head bar (spare horizontal space)
   * instead of the td-level "+N more" strip. With opts.compact, groups that
   * render ≤1 item for THIS row become inline pills (head + lone item fused)
   * sharing a line instead of a full-width strip; they don't count toward
   * the group limit and are never overflow-hidden. */
  function buildKitGroups(td, kitIds, opts) {
    const entries = kitIds.map((kitId) => {
      const items = opts.itemsOf(kitId);
      return { kitId, items, compact: !!opts.compact && items.length <= 1 };
    });
    const bigCount = entries.reduce((n, e) => n + !e.compact, 0);
    const groupLimit = bigCount <= 2 + 1 ? bigCount : 2;
    let hiddenCount = 0;
    let bigIndex = 0;

    entries.forEach((e) => {
      const gi = e.compact ? -1 : bigIndex++;
      const hideGroup = !e.compact && gi >= groupLimit;
      const group = el("div", "kit-group");
      if (e.compact) group.classList.add("compact");
      if (hideGroup) group.classList.add("overflow");

      const head = el("div", "kit-head");
      const headTag = opts.headerTag(e.kitId);
      if (headTag.classList.contains("hit")) group.classList.add("hit");
      head.appendChild(headTag);
      group.appendChild(head);

      const items = e.items;
      if (items.length) {
        const itemsDiv = el("div", "kit-files");
        const limit = items.length <= opts.itemLimit + COLLAPSE_SLACK ? items.length : opts.itemLimit;
        items.forEach((item, fi) => {
          const tag = opts.itemTag(item, e.kitId);
          if (hideGroup || fi >= limit) {
            tag.classList.add("overflow");
            hiddenCount++;
          }
          itemsDiv.appendChild(tag);
        });
        group.appendChild(itemsDiv);
        if (opts.moreInHead && !hideGroup && items.length > limit) {
          const more = el("button", "more head-more", `+${items.length - limit}`);
          more.title = `Show all ${items.length}`;
          more.dataset.expand = "1";
          head.appendChild(more);
          hiddenCount -= items.length - limit; // this expander's job, not the td strip's
        }
      }
      td.appendChild(group);
    });

    const hiddenGroups = Math.max(0, bigCount - groupLimit);
    if (hiddenGroups > 0 || hiddenCount > 0) {
      const plural = opts.groupNoun.endsWith("y")
        ? opts.groupNoun.slice(0, -1) + "ies" : opts.groupNoun + "s";
      const label = hiddenGroups > 0
        ? `+${hiddenGroups} more ${hiddenGroups === 1 ? opts.groupNoun : plural}`
        : `+${hiddenCount} more`;
      const more = el("button", "more", label);
      more.dataset.expand = "1";
      td.appendChild(more);
    }
  }

  /* Effects cell: visual FX grouped by category — "chain" (beam/chain effects),
   * "dissolve" (dissolve effects), "glow" / "ghost" / "tint" (color-only
   * effects), "desaturate" / "transparency" (percent-only), "freeze" /
   * "camo" (valueless), "screen" (full-screen effects), "morph" (transform
   * auras) and "summon" (summon effects). Chain pills carry a tint dot per
   * texture. */
  function fxCell(spellId) {
    const d = state.data;
    const chainIds = d.spellFx.get(spellId) || [];
    const dissolveIds = d.spellDissolves.get(spellId) || [];
    const glowIds = d.spellGlows.get(spellId) || [];
    const shadowyIds = d.spellShadowies.get(spellId) || [];
    const ghostMatIds = d.spellGhostMats.get(spellId) || [];
    const tintIds = d.spellTints.get(spellId) || [];
    const desatPcts = d.spellDesaturates.get(spellId) || [];
    const transpPcts = d.spellTransps.get(spellId) || [];
    const hasFreeze = d.spellFreezes.has(spellId);
    const hasCamo = d.spellCamos.has(spellId);
    const screenIds = d.spellScreens.get(spellId) || [];
    const morphIds = d.spellMorphs.get(spellId) || [];
    const formIds = d.spellShapeshifts.get(spellId) || [];
    const summonEntries = d.spellSummons.get(spellId) || [];
    const td = el("td", "c-fx");
    if (chainIds.length === 0 && dissolveIds.length === 0 && glowIds.length === 0
        && shadowyIds.length === 0 && ghostMatIds.length === 0 && tintIds.length === 0
        && desatPcts.length === 0 && transpPcts.length === 0 && !hasFreeze && !hasCamo
        && screenIds.length === 0 && morphIds.length === 0 && formIds.length === 0
        && summonEntries.length === 0) {
      td.classList.add("empty");
      td.appendChild(el("span", "none", "—"));
      return td;
    }

    const cats = [];
    /* Where a category's target icons go. One icon on the HEAD when every
     * row of the category agrees — the common case, and far less noisy than
     * repeating it on each pill. When they disagree, the head would have to
     * show a union that no individual row actually has (measured on 9.2.7:
     * 44 chain spells and 51 glow spells hit exactly that), so the icons
     * drop to the pills, which are the things that really carry a type. */
    const targetGroup = (masks) => {
      const first = masks.length ? masks[0] : 0;
      return { uniform: masks.every((m) => m === first), mask: first };
    };

    if (chainIds.length) {
      // one entry per distinct (texture, tint); untextured chains still show.
      // Chains collapsing into one pill union their masks onto it.
      const chainMask = (c) => maskOf(d.fxTargets, spellId, [c]);
      const byKey = new Map();
      for (const c of chainIds.slice().sort((a, b) => a - b)) {
        const color = (d.fxChains.get(c) || {}).color ?? 0xffffff;
        const fids = d.fxTextures.get(c) || [0];
        for (const fid of fids) {
          const key = fid + ":" + color;
          const prev = byKey.get(key);
          if (prev) { prev.mask |= chainMask(c); continue; }
          byKey.set(key, { chainId: c, fid, color, mask: chainMask(c) });
        }
      }
      const grp = targetGroup(chainIds.map(chainMask));
      cats.push({
        name: "chain",
        hit: chainIds.some((c) => fxChainIsHit(c)),
        mask: grp.uniform ? grp.mask : 0,
        items: hitsFirst([...byKey.values()], (e) => fxChainIsHit(e.chainId))
          .map((e) => () => fxTag(e, grp.uniform ? 0 : e.mask)),
      });
    }
    if (dissolveIds.length) {
      // one pill per distinct texture; textureless rows still show
      const dissolveMask = (id) => maskOf(d.dissolveTargets, spellId, [id]);
      const byKey = new Map();
      for (const id of dissolveIds.slice().sort((a, b) => a - b)) {
        for (const fid of d.dissolveTextures.get(id) || [0]) {
          const prev = byKey.get(fid);
          if (prev) { prev.mask |= dissolveMask(id); continue; }
          byKey.set(fid, { dissolveId: id, fid, mask: dissolveMask(id) });
        }
      }
      const grp = targetGroup(dissolveIds.map(dissolveMask));
      cats.push({
        name: "dissolve",
        hit: dissolveIds.some((id) => dissolveIsHit(id)),
        mask: grp.uniform ? grp.mask : 0,
        items: hitsFirst([...byKey.values()], (e) => dissolveIsHit(e.dissolveId))
          .map((e) => () => dissolveTag(e, grp.uniform ? 0 : e.mask)),
      });
    }
    if (glowIds.length) {
      // one pill per distinct color (no texture — the color is the payload)
      const glowMask = (id) => maskOf(d.glowTargets, spellId, [id]);
      const byKey = new Map();
      for (const id of glowIds.slice().sort((a, b) => a - b)) {
        const color = d.glowColors.get(id) ?? 0;
        const prev = byKey.get(color);
        if (prev) { prev.mask |= glowMask(id); continue; }
        byKey.set(color, {
          glowId: id, color, alpha: d.glowAlphas.get(id), mask: glowMask(id),
        });
      }
      const grp = targetGroup(glowIds.map(glowMask));
      cats.push({
        name: "glow",
        hit: glowIds.some((id) => glowIsHit(id)),
        mask: grp.uniform ? grp.mask : 0,
        items: hitsFirst([...byKey.values()], (e) => glowIsHit(e.glowId))
          .map((e) => () => colorFxTag("glow", e.color, glowIsHit(e.glowId), e.alpha,
            grp.uniform ? 0 : e.mask)),
      });
    }
    if (shadowyIds.length || ghostMatIds.length) {
      // "ghost" merges ShadowyEffect rows (two colors each) and Type-22
      // material recolors (one color each). One pill per distinct color; each
      // pill carries which isHit to use so the category can mix both sources.
      const shadowyMask = (id) => maskOf(d.shadowyTargets, spellId, [id]);
      const ghostMatMask = (id) => maskOf(d.ghostMatTargets, spellId, [id]);
      const byColor = new Map();
      for (const id of shadowyIds.slice().sort((a, b) => a - b)) {
        const c = d.shadowyColors.get(id) || { primary: 0, secondary: 0 };
        for (const color of [c.primary, c.secondary]) {
          const prev = byColor.get(color);
          if (prev) { prev.mask |= shadowyMask(id); continue; }
          byColor.set(color, { color, hit: () => shadowyIsHit(id), mask: shadowyMask(id) });
        }
      }
      for (const id of ghostMatIds.slice().sort((a, b) => a - b)) {
        const color = d.ghostMatColors.get(id) ?? 0;
        const prev = byColor.get(color);
        if (prev) { prev.mask |= ghostMatMask(id); continue; }
        byColor.set(color, { color, hit: () => ghostMatIsHit(id), mask: ghostMatMask(id) });
      }
      const catHit = shadowyIds.some((id) => shadowyIsHit(id))
        || ghostMatIds.some((id) => ghostMatIsHit(id));
      // both sources feed one category, so both sets of masks decide the head
      const grp = targetGroup(shadowyIds.map(shadowyMask)
        .concat(ghostMatIds.map(ghostMatMask)));
      cats.push({
        name: "ghost",
        hit: catHit,
        mask: grp.uniform ? grp.mask : 0,
        items: hitsFirst([...byColor.values()], (e) => e.hit())
          .map((e) => () => colorFxTag("ghost", e.color, e.hit(), undefined,
            grp.uniform ? 0 : e.mask)),
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
    if (desatPcts.length) {
      // one pill per distinct percent — the desaturation strength is the
      // whole payload (no color; a computed grey swatch keys off strength)
      const pcts = [...new Set(desatPcts)].sort((a, b) => a - b);
      cats.push({
        name: "desaturate",
        hit: pcts.some((p) => desatIsHit(p)),
        items: hitsFirst(pcts, (p) => desatIsHit(p))
          .map((p) => () => percentFxTag("desaturate", p, desatIsHit(p))),
      });
    }
    if (transpPcts.length) {
      const pcts = [...new Set(transpPcts)].sort((a, b) => a - b);
      cats.push({
        name: "transparency",
        hit: pcts.some((p) => transpIsHit(p)),
        items: hitsFirst(pcts, (p) => transpIsHit(p))
          .map((p) => () => percentFxTag("transparency", p, transpIsHit(p))),
      });
    }
    if (hasFreeze) {
      // valueless: the clickable category head IS the whole pill
      cats.push({ name: "freeze", hit: freezeIsHit(), items: [] });
    }
    if (hasCamo) {
      cats.push({ name: "camo", hit: camoIsHit(), items: [] });
    }
    if (screenIds.length) {
      // one pill per ScreenEffect row, labeled with its internal name
      const ids = hitsFirst(screenIds.slice().sort((a, b) => a - b), (id) => screenIsHit(id));
      cats.push({
        name: "screen",
        hit: screenIds.some((id) => screenIsHit(id)),
        items: ids.map((id) => () => screenTag(id)),
      });
    }
    if (formIds.length) {
      // one pill per (form, display); a form with no display (Battle Stance,
      // Shadowform, Stealth — 11 of the 29 used forms) gets one name-only pill
      const ids = hitsFirst(formIds.slice().sort((a, b) => a - b), (f) => shapeshiftIsHit(f));
      const entries = ids.flatMap((f) =>
        (d.shapeshiftDisplays.get(f) || [{ displayId: 0, fid: 0 }])
          .map((e) => ({ formId: f, displayId: e.displayId, fid: e.fid })));
      cats.push({
        name: "shapeshift",
        hit: formIds.some((f) => shapeshiftIsHit(f)),
        items: entries.map((e) => () => shapeshiftTag(e)),
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
      // the icon rides the category head, unioned over this spell's rows in
      // the category — only where the distribution isn't degenerate (a
      // category that is always the same type says nothing per pill)
      headerTag: (cat) => addTargetIcons(fxHeadTag(cat.name, cat.hit), cat.mask),
      itemsOf: (cat) => cat.items,
      itemTag: (make) => make(),
      itemLimit: CFG.kitFilesCollapsedLimit ?? CFG.tagsCollapsedLimit,
      groupNoun: "category",
      moreInHead: true,
      compact: true,
    });
    return td;
  }

  /**
   * The query tokens that can highlight in a given field's column — the
   * field's own plus the unscoped free text.
   * @param {string} field
   * @returns {HitToken[]}
   */
  function tokensFor(field) {
    return state.tokens.filter((t) => t.field === field || t.field === "all");
  }

  /**
   * As tokensFor, but whole (positive) groups — a hit must satisfy every
   * token of at least one of them.
   * @param {string} field
   * @returns {QueryGroup[]}
   */
  function groupsFor(field) {
    return state.groups.filter((g) => !g.not && (g.field === field || g.field === "all"));
  }

  // hit = the entity fully satisfies at least one chip of its field
  function fileIsHit(file, field) {
    if (!file) return false;
    return groupsFor(field).some((g) => g.tokens.every((t) => file.searchL.includes(t.text)));
  }

  // kit ids live in the sound:/anim: fields since the soundkit:/animkit:
  // merge — a chip's numeric tokens hit the kit whose id they equal
  function kitIsHit(kitId, field) {
    const searchField = field === "soundkit" ? "sound" : "anim";
    return groupsFor(searchField).some((g) => g.tokens.some((t) => Number(t.text) === kitId));
  }

  // anim pills can be hit through their group's category word too — today
  // only the stance group carries one ("stance"); kit groups pass "".
  // Mirrors spellsByAnim's token test.
  function animIsHit(animId, groupWord = "") {
    const nameL = state.data.animNamesL[animId];
    return groupsFor("anim").some((g) =>
      g.tokens.every((t) => groupWord.includes(t.text) || nameL.includes(t.text)));
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

  function ghostMatIsHit(ghostMatId) {
    const corpus = state.data.ghostMatSearchL.get(ghostMatId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function desatIsHit(percent) {
    const corpus = state.data.desatSearchL.get(percent) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function transpIsHit(percent) {
    const corpus = state.data.transpSearchL.get(percent) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function screenIsHit(screenId) {
    const corpus = state.data.screenSearchL.get(screenId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function freezeIsHit() {
    return groupsFor("fx").some((g) => g.tokens.every((t) => "freeze".includes(t.text)));
  }

  function camoIsHit() {
    return groupsFor("fx").some((g) => g.tokens.every((t) => "camo".includes(t.text)));
  }

  function morphIsHit(displayId) {
    const corpus = state.data.morphSearchL.get(displayId) || "";
    return groupsFor("fx").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
  }

  function shapeshiftIsHit(formId) {
    const corpus = state.data.shapeshiftSearchL.get(formId) || "";
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

  /* --- target-type icons ------------------------------------------------
   *
   * Who a piece of content plays on, from SpellVisualEvent.TargetType (see
   * TARGET_BITS in build_data.py). Every type is marked — there is no
   * unmarked default — and a row whose mask has several bits renders one
   * icon per bit rather than a fused glyph: the mixes are common (16.5% of
   * model rows are caster+target on 9.2.7) and the rarer ones (caster+area)
   * have no sensible single glyph. Masters live in build/icons/*.svg with a
   * preview page at build/target_icons.html; the markup below is lifted from
   * them, inlined the same way modelTag's cube glyph is.
   */
  const TARGET_CASTER = 1, TARGET_TARGET = 2, TARGET_AREA = 4,
    TARGET_NOT_CASTER = 8, TARGET_MISSILE_DEST = 16;

  const T_SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const T_PERSON = T_SVG_OPEN
    + '<circle cx="12" cy="8" r="4"/>'
    + '<path d="M4.5 20.5c1.8-3.8 4.3-5.5 7.5-5.5s5.7 1.7 7.5 5.5"/></svg>';
  const T_CROSSHAIR = T_SVG_OPEN
    + '<circle cx="12" cy="12" r="7"/><line x1="12" y1="1.5" x2="12" y2="6"/>'
    + '<line x1="12" y1="18" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="6" y2="12"/>'
    + '<line x1="18" y1="12" x2="22.5" y2="12"/>'
    + '<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/></svg>';
  const T_AREA = T_SVG_OPEN
    + '<ellipse cx="12" cy="18" rx="9" ry="3.4"/><line x1="12" y1="3" x2="12" y2="14.5"/>'
    + '<path d="M8.5 11 12 15l3.5-4"/></svg>';

  /* One entry per icon, in render order. `bits` is every mask bit the icon
   * stands for, so the two area types share one glyph instead of drawing it
   * twice; "target" and "target, never caster" stay separate because they
   * are separate colors. */
  const TARGET_ICONS = [
    {
      bits: TARGET_CASTER, cls: "t-caster", svg: T_PERSON,
      title: () => "On the caster",
    },
    {
      bits: TARGET_TARGET, cls: "t-target", svg: T_CROSSHAIR,
      title: () => "On the target",
    },
    {
      bits: TARGET_NOT_CASTER, cls: "t-notcaster", svg: T_CROSSHAIR,
      title: () => "On the target only — never the caster",
    },
    {
      // TargetType 3 is the spell's own effect area, wherever that lands —
      // Flamestrike's chosen spot, Frost Nova around the caster, an
      // explosion's impact point. It is NOT the target's location, so the
      // wording must not claim one.
      bits: TARGET_AREA | TARGET_MISSILE_DEST, cls: "t-area", svg: T_AREA,
      title: (mask) => (mask & TARGET_AREA
        ? "In the spell's area of effect"
        : "Where the missile lands"),
    },
  ];

  /**
   * Render a row's target mask as leading icons.
   * @param {number} mask union of TARGET_* bits; 0 renders nothing
   * @returns {HTMLElement|null}
   */
  function targetIcons(mask) {
    if (!mask) return null;
    const wrap = el("span", "ticons");
    for (const icon of TARGET_ICONS) {
      if (!(mask & icon.bits)) continue;
      const span = el("span", `ticon ${icon.cls}`);
      span.title = icon.title(mask);
      span.innerHTML = icon.svg;
      wrap.appendChild(span);
    }
    return wrap.childNodes.length ? wrap : null;
  }

  /**
   * A mask's search words, deduped and in bit order — what the exports say
   * instead of drawing icons. Reads the pack's own bit -> word map, so the
   * two never drift apart.
   * @param {number} mask
   * @returns {string[]}
   */
  function targetWordsOf(mask) {
    const names = state.data.targetNames;
    const words = [];
    for (const bit of [TARGET_CASTER, TARGET_TARGET, TARGET_AREA,
      TARGET_NOT_CASTER, TARGET_MISSILE_DEST]) {
      const w = names[bit];
      if ((mask & bit) && w && !words.includes(w)) words.push(w);
    }
    return words;
  }

  /**
   * Put a mask's icons on a tag, immediately before what it describes.
   *
   * The anchor is the pill's colour swatch if it has one, otherwise its
   * label — whichever comes first. Not the pill's leading edge: that can
   * already hold action buttons (the 3D-view cube, the Wowhead link), and an
   * icon stranded left of those reads as another button. But a colour pill's
   * swatch and hex text are one unit, so the icons belong left of the swatch
   * rather than wedged between the two.
   */
  function addTargetIcons(tag, mask) {
    const icons = targetIcons(mask);
    if (icons) tag.insertBefore(icons, tag.querySelector(".fx-swatch, .tag-label"));
    return tag;
  }

  /** Union the target masks of a spell's rows for one group of item ids. */
  function maskOf(index, spellId, itemIds) {
    const byItem = index.get(spellId);
    if (!byItem) return 0;
    let mask = 0;
    for (const id of itemIds) mask |= byItem.get(id) || 0;
    return mask;
  }

  /* Model-category head ("missile", "area", ...) — the fx-head pattern:
   * clicking searches the whole category via the model field. */
  const MODEL_CAT_TITLES = {
    attached: "Model attached to the caster/target (SpellVisualKitModelAttach)", // stale-pack word
    attach: "Model attached to the caster/target (SpellVisualKitModelAttach)", // stale-pack word
    missile: "Projectile model in flight (SpellVisualMissile)",
    ground: "Ground / area model (SpellVisualKitAreaModel)",
    area: "Ground / area model (SpellVisualKitAreaModel)", // stale-pack word
    trail: "Weapon trail model (WeaponTrail)",
    barrage: "Volley of models (BarrageEffect)",
  };

  function modelCatHeadTag(category, hit) {
    const tag = el("span", "tag model-head");
    if (hit) tag.classList.add("hit");
    const label = el("button", "tag-label", category);
    label.title = `${MODEL_CAT_TITLES[category] || ""}`
      + `\nClick: find all spells with a ${category} model\nShift-click: exclude them instead`;
    label.dataset.search = `model:${category}`;
    tag.appendChild(label);
    return tag;
  }

  // model pills can be hit through their usage-category word too —
  // model:"attached backpack01" lights that attached pill (and its group
  // head, via the group hit). Mirrors spellsByModel's token test.
  function modelFileIsHit(file, catName) {
    const searchL = file ? file.searchL : "";
    return groupsFor("model").some((g) =>
      g.tokens.every((t) => catName.includes(t.text) || searchL.includes(t.text)));
  }

  function modelTag(fid, catName, mask = 0) {
    const d = state.data;
    const file = d.files.get(fid) || { fid, path: "", base: "", searchL: "" };
    const tag = el("span", "tag model");
    tag.title = file.path || "(name unknown)";
    // with "" for the category (the stale-pack flat list) this reduces to
    // the plain fileIsHit test
    if (modelFileIsHit(file, catName || "")) tag.classList.add("hit");

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
    addTargetIcons(tag, mask);

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
    txt.dataset.search = `${field === "soundkit" ? "sound" : "anim"}:${kitId}`;
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

  function animTag(animId, groupWord = "", mask = 0) {
    const d = state.data;
    const name = d.animNames[animId];
    const tag = el("span", "tag anim");
    if (animIsHit(animId, groupWord)) tag.classList.add("hit");

    const txt = el("button", "tag-label", name);
    txt.title = `Animation ${animId}: ${name}\nClick: find spells playing this animation\nShift-click: exclude them instead`;
    txt.dataset.search = `anim:"${name}"`;
    tag.appendChild(txt);
    addTargetIcons(tag, mask);

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

  /* Visual FX tags: the category head ("chain") and one pill per texture,
   * with a dot showing the chain's tint (hidden when untinted). Clicking
   * the head searches the whole category (fx:chain). */
  const FX_HEAD_TITLES = {
    chain: "Chain / beam effect (SpellChainEffects)",
    dissolve: "Dissolve / materialize effect (DissolveEffect)",
    glow: "Edge glow / rim-light effect (EdgeGlowEffect)",
    ghost: "Ghostly recolor (ShadowyEffect / ghost material)",
    tint: "Model tint (SpellProceduralEffect)",
    desaturate: "Model desaturation (SpellProceduralEffect)",
    transparency: "Model transparency (SpellProceduralEffect)",
    freeze: "Freeze / petrify in place (SpellProceduralEffect)",
    camo: "Camouflage / cloaking effect (SpellProceduralEffect)",
    screen: "Full-screen tint / overlay while the aura holds (ScreenEffect)",
    shapeshift: "Shapeshift form (SpellShapeshiftForm)",
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

  /**
   * One chain (beam) pill: optional tint swatch + texture name.
   * @param {{chainId: number, fid: number, color: number}} entry
   * @returns {HTMLElement}
   */
  function fxTag(entry, mask = 0) {
    const d = state.data;
    const file = entry.fid ? (d.files.get(entry.fid) || { path: "", base: "" }) : { path: "", base: "" };
    const info = d.fxChains.get(entry.chainId) || { color: 0xffffff, hue: "" };
    const tag = el("span", "tag fx");
    if (fxChainIsHit(entry.chainId)) tag.classList.add("hit");

    if (entry.color !== 0xffffff) {
      const hex = hexColor(entry.color);
      const dot = el("span", "fx-swatch");
      dot.style.background = hex;
      dot.title = `Tint ${hex}` + (info.hue ? ` (${info.hue})` : "");
      dot.dataset.color = hex;
      dot.dataset.colorInfo = "chain tint";
      tag.appendChild(dot);
    }

    const base = file.base ? stripExt(file.base) : "";
    const txt = el("button", "tag-label", base || "(untextured)");
    txt.title = `${file.path || "(no texture)"}\nClick: find spells with this chain texture\nShift-click: exclude them instead`;
    if (entry.fid) {
      txt.dataset.texFid = String(entry.fid);
      // the hover preview multiplies the texture by the chain's tint
      if (entry.color !== 0xffffff)
        txt.dataset.texTint = hexColor(entry.color);
    }
    // category word + texture: the query stays scoped to chains once more
    // fx categories exist ("fx:chain lightning" style)
    txt.dataset.search = file.base ? `fx:"chain ${file.base}"` : "";
    tag.appendChild(txt);
    addTargetIcons(tag, mask);

    if (base) tag.appendChild(tagButton("⧉", `Copy texture name: ${base}`, base));
    return tag;
  }

  /** Color-only fx pill (glow / ghost / tint): swatch + hex label — these
   * effects have no texture or model, the color is the whole payload.
   * Clicking searches the category + hex; ⧉ copies the hex.
   * @param {string} category
   * @param {number} color Packed 0xRRGGBB.
   * @param {boolean} hit Whether the current query matches this pill.
   * @param {number} [alpha] Source alpha 0..255, where the source has a real one.
   * @param {number} [mask] Target mask, when the category's rows disagree and
   *   the icons ride the pills instead of the category head.
   * @returns {HTMLElement}
   */
  function colorFxTag(category, color, hit, alpha, mask = 0) {
    const hex = hexColor(color);
    const tag = el("span", "tag fx");
    if (hit) tag.classList.add("hit");

    const dot = el("span", "fx-swatch");
    dot.style.background = hex;
    dot.dataset.color = hex;
    dot.dataset.colorInfo = category;
    if (alpha >= 0) dot.dataset.alpha = String(alpha);
    tag.appendChild(dot);

    const txt = el("button", "tag-label", hex);
    txt.title = `${FX_HEAD_TITLES[category]}\nColor ${hex}`
      + `\nClick: find spells with this ${category} color\nShift-click: exclude them instead`;
    txt.dataset.search = `fx:"${category} ${hex}"`;
    // the hex text is the color too — hovering it shows the same big patch
    txt.dataset.color = hex;
    txt.dataset.colorInfo = category;
    if (alpha >= 0) txt.dataset.alpha = String(alpha);
    tag.appendChild(txt);
    addTargetIcons(tag, mask);

    tag.appendChild(tagButton("⧉", `Copy color: ${hex}`, hex));
    return tag;
  }

  /* Percent-only fx pill (desaturate / transparency): the strength is the
   * whole payload. Desaturate gets a decorative grey swatch keyed to the
   * strength; transparency has no swatch. Clicking searches category + %. */
  function percentFxTag(category, percent, hit) {
    // .pct: as a compact pill this renders (label | value) — a flat divider
    // instead of the rounded value capsule other compact groups get
    const tag = el("span", "tag fx pct");
    if (hit) tag.classList.add("hit");

    if (category === "desaturate") {
      const v = Math.round(255 * (1 - percent / 200)); // 100% -> mid grey
      const dot = el("span", "fx-swatch");
      dot.style.background = `rgb(${v}, ${v}, ${v})`;
      tag.appendChild(dot);
    }

    const txt = el("button", "tag-label", `${percent}%`);
    txt.title = `${FX_HEAD_TITLES[category]}\n${percent}%`
      + `\nClick: find spells with this ${category} strength\nShift-click: exclude them instead`;
    txt.dataset.search = `fx:"${category} ${percent}%"`;
    tag.appendChild(txt);
    return tag;
  }

  /** Stand-in for a ScreenEffect row with no color payload at all (-1 = the
   *  row has no such color; maskSize 0 = no FullScreenEffect row).
   *  @type {ScreenColors} */
  const NO_SCREEN_COLORS = {
    fog: -1, fogAlpha: -1, mul: -1, add: -1,
    maskOffsetY: 0, maskSize: 0, maskPower: 0,
  };

  /* Screen-effect pill: the whole screen tints/overlays while the aura
   * holds. Label = the ScreenEffect row's internal name; swatch dots show
   * the fog tint and the FullScreenEffect multiply/addition screen colors
   * when present; rows with textures get the hover preview on the first one
   * (shown untinted — in game the colors grade the world, they're not baked
   * into the overlay image). ⧉ copies the ScreenEffect ID. */
  function screenTag(screenId) {
    const d = state.data;
    const name = d.screenNames.get(screenId) || "";
    const colors = d.screenColors.get(screenId) || NO_SCREEN_COLORS;
    const texFids = d.screenTextures.get(screenId) || [];
    const tag = el("span", "tag fx");
    if (screenIsHit(screenId)) tag.classList.add("hit");

    // only the fog color has an opacity byte; mul/add are pure grade factors
    for (const [what, c, a] of /** @type {[string, number, number][]} */ (
        [["fog tint", colors.fog, colors.fogAlpha],
         ["multiply", colors.mul, -1],
         ["addition", colors.add, -1]])) {
      if (c < 0) continue;
      const hex = hexColor(c);
      const dot = el("span", "fx-swatch");
      dot.style.background = hex;
      dot.title = `Screen ${what} ${hex}`;
      dot.dataset.color = hex;
      dot.dataset.colorInfo = `screen ${what}`;
      if (a >= 0) dot.dataset.alpha = String(a);
      tag.appendChild(dot);
    }

    const texPaths = texFids.map((t) => ((d.files.get(t.fid) || {}).path || `#${t.fid}`)
      + (t.mask ? " (mask)" : ""));
    const txt = el("button", "tag-label", name || `screen #${screenId}`);
    txt.title = `${name || "(unnamed)"} — ScreenEffect ${screenId}`
      + (texPaths.length ? `\n${texPaths.join("\n")}` : "")
      + `\nClick: find spells with this screen effect\nShift-click: exclude them instead`;
    // Preview the overlay texture with the effect's color multiplied in —
    // the same treatment chain pills get. Overlays sort first, so [0] is the
    // finished art when the row has any. The color matters: 9.0 Arcane's
    // overlay is a cyan texture that reads magenta in game, because
    // ColorMultiply (#ff00f7) tints it.
    //
    // Compositing the full effect (grade + blend-set masks + radial Mask*
    // vignette) was tried and abandoned — see the batch 5/6 notes in
    // CLAUDE.md. None of the candidate models matched in game closely enough
    // to be worth the complexity, so this shows the art and its color, and
    // claims nothing more.
    if (texFids.length) {
      txt.dataset.texFid = String(texFids[0].fid);
      if (colors.mul >= 0) {
        txt.dataset.texTint = hexColor(colors.mul);
      }
    }
    // quotes inside a name would break the tag value; substring match
    // doesn't need them
    txt.dataset.search = `fx:"screen ${(name || String(screenId)).replace(/"/g, "")}"`;
    tag.appendChild(txt);
    return tag;
  }

  /* Dissolve pill: one per texture of the row's TextureBlendSet (mask +
   * material textures); tooltip carries the dissolve duration. */
  function dissolveTag(entry, mask = 0) {
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
    if (entry.fid) txt.dataset.texFid = String(entry.fid);
    txt.dataset.search = file.base ? `fx:"dissolve ${file.base}"` : "";
    tag.appendChild(txt);
    addTargetIcons(tag, mask);

    if (base) tag.appendChild(tagButton("⧉", `Copy texture name: ${base}`, base));
    return tag;
  }

  /* Morph pill: one per (creature, display). Label = the creature model's
   * file name; tooltip names the NPC the spell morphs
   * into; ⧉ copies the display ID, .morph / .lo the ready-to-paste
   * commands; the Wowhead icon on the left opens their model viewer on the
   * display. Creatures without TDB data get an inert "creature #id" pill. */
  /* Shapeshift pill: one per (form, display). Label is the model basename
   * where the form has a display, otherwise the form name itself — Battle
   * Stance and Shadowform are real forms with no model at all, and a
   * name-only pill is the honest rendering. */
  function shapeshiftTag(entry) {
    const d = state.data;
    const { formId, displayId, fid } = entry;
    const name = d.shapeshiftNames.get(formId) || "";
    const file = fid ? (d.files.get(fid) || { path: "", base: "" }) : { path: "", base: "" };
    const tag = el("span", "tag fx");
    if (shapeshiftIsHit(formId)) tag.classList.add("hit");

    if (displayId && CFG.wowheadMorphUrl) {
      tag.appendChild(wowheadLink(fillTemplate(CFG.wowheadMorphUrl, { id: displayId }),
        `View DisplayID ${displayId} in Wowhead's model viewer`));
    }

    const base = file.base ? stripExt(file.base) : "";
    const label = base || name || `form #${formId}`;
    const txt = el("button", "tag-label", label);
    txt.title = `${name || "(unnamed form)"} — SpellShapeshiftForm ${formId}`
      + (displayId ? `\nDisplayID ${displayId}` : "\n(this form has no creature display)")
      + (file.path ? `\n${file.path}` : "")
      + `\nClick: find spells with this form\nShift-click: exclude them instead`;
    // search by the form NAME, which is stable and readable, unlike the model
    txt.dataset.search = `fx:"shapeshift ${(name || String(formId)).replace(/"/g, "")}"`;
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

  // place the panel above its anchor (native title tooltips pop below the
  // cursor), measured invisibly first; fall back to below at the viewport top
  function placeTexPanel(panel, anchor) {
    panel.style.visibility = "hidden";
    panel.style.display = "block";
    const r = anchor.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const x = Math.max(8, Math.min(r.left, window.innerWidth - pr.width - 8));
    let y = r.top - pr.height - 6;
    if (y < 8) y = r.bottom + 6;
    panel.style.left = x + "px";
    panel.style.top = y + "px";
    panel.style.visibility = "";
  }

  function showTexPreview(label, baseCanvas) {
    const tint = label.dataset.texTint || "";
    const canvas = tint ? tintedCanvas(baseCanvas, tint) : baseCanvas;
    const note = tint ? ` · tint ${tint}` : "";
    const max = CFG.texturePreviewMax || 256;
    const scale = Math.min(1, max / canvas.width, max / canvas.height);
    canvas.style.width = Math.round(canvas.width * scale) + "px";
    canvas.style.height = Math.round(canvas.height * scale) + "px";

    const panel = texPanel();
    panel.firstElementChild.replaceChildren(canvas);
    panel.lastChild.textContent = `${canvas.width}×${canvas.height}` + note;
    placeTexPanel(panel, label);
  }

  // same panel for color swatches: a large patch of the color, captioned with
  // the hex, the channel values, the hue word and which effect it belongs to
  // (data-color-info). Alpha only where the source actually carries one
  // (data-alpha): screen fog opacity and EdgeGlowEffect.GlowAlpha.
  function showColorPreview(swatch) {
    const hex = swatch.dataset.color;
    const alpha = swatch.dataset.alpha;
    const patch = el("div", "tex-color");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    // a translucent color shows the panel's checkerboard through it
    patch.style.background = alpha === undefined
      ? hex : `rgba(${r}, ${g}, ${b}, ${(alpha / 255).toFixed(3)})`;
    const panel = texPanel();
    panel.firstElementChild.replaceChildren(patch);
    const hue = hueWordOf(hex);
    const rgb = alpha === undefined
      ? `rgb(${r}, ${g}, ${b})`
      // show alpha both as the raw byte and the 0..1 the tables store
      : `rgba(${r}, ${g}, ${b}, ${(alpha / 255).toFixed(2)})`;
    panel.lastChild.textContent = `${hex} · ${rgb}`
      + (alpha === undefined ? "" : ` · alpha ${alpha}/255`)
      + (hue ? ` · ${hue}` : "")
      + (swatch.dataset.colorInfo ? ` · ${swatch.dataset.colorInfo}` : "");
    placeTexPanel(panel, swatch);
  }

  // coarse hue word for the caption — the same buckets build_data.py bakes
  // into the search corpora, so the word shown is the word that searches
  function hueWordOf(hex) {
    const c = parseInt(hex.slice(1), 16);
    const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    if (sat < 0.15 || max < 0.08) return ""; // white / grey / near-black
    const d = max - min;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    let deg = h * 60;
    if (deg < 0) deg += 360;
    for (const [limit, name] of /** @type {[number, string][]} */ ([
        [15, "red"], [45, "orange"], [70, "yellow"], [160, "green"],
        [200, "cyan"], [255, "blue"], [290, "purple"], [330, "pink"],
        [361, "red"]])) {
      if (deg < limit) return name;
    }
    return "";
  }

  function initTexPreview() {
    if (!window.matchMedia("(hover: hover)").matches) return;
    const results = $("#results");
    results.addEventListener("mouseover", (e) => {
      // color swatches first — no fetch involved, same intent delay
      const swatch = targetClosest(e, "[data-color]");
      if (swatch) {
        const key = "color|" + swatch.dataset.color + "|" + (swatch.dataset.colorInfo || "")
          + "|" + (swatch.dataset.alpha || "");
        if (key === texHoverKey) return;
        hideTexPreview();
        texHoverKey = key;
        texHoverTimer = setTimeout(() => {
          if (texHoverKey === key && swatch.isConnected) showColorPreview(swatch);
        }, 150);
        return;
      }
      if (!CFG.texturePreviewUrl) return;
      const label = targetClosest(e, "[data-tex-fid]");
      if (!label) return;
      const fid = Number(label.dataset.texFid);
      // the tint joins the key: two pills can share a texture but tint it
      // differently, and the cache is per-fid untinted
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
      const label = targetClosest(e, "[data-tex-fid], [data-color]");
      if (label && !label.contains(/** @type {Node} */ (e.relatedTarget))) hideTexPreview();
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
      if (!hc.models) {
        // grouped by usage category (soundKits-style shape); a stale pack
        // without categories exports the old flat path list
        const cats = d.spellModelCats.get(id);
        if (cats) {
          const byCat = new Map();
          for (const e of cats) {
            if (!byCat.has(e.cat)) byCat.set(e.cat, []);
            // each file carries who it plays on — the export's form of the icons
            byCat.get(e.cat).push({ path: pathOf(e.fid), targets: targetWordsOf(e.targets) });
          }
          row.models = [...byCat.keys()].sort((a, b) => a - b).map((c) => ({
            // the wordless attach category renders as loose pills in the UI,
            // but an export still needs a name for it
            category: d.modelCatNames[c] || (c === 0 ? "attached" : `cat ${c}`),
            files: byCat.get(c),
          }));
        } else {
          row.models = (d.spellModels.get(id) || []).map(pathOf);
        }
      }
      if (!hc.sounds) {
        const byKit = new Map();
        const kitMask = new Map();
        for (const e of d.spellSounds.get(id) || []) {
          if (!byKit.has(e.soundKitId)) byKit.set(e.soundKitId, []);
          byKit.get(e.soundKitId).push(pathOf(e.fid));
          kitMask.set(e.soundKitId, (kitMask.get(e.soundKitId) || 0) | (e.targets || 0));
        }
        row.soundKits = [...byKit.keys()].sort((a, b) => a - b).map((k) => ({
          id: k, files: byKit.get(k), targets: targetWordsOf(kitMask.get(k) || 0),
        }));
      }
      if (!hc.animkits) {
        const loose = (d.spellVisualAnims.get(id) || []).slice().sort((a, b) => a - b);
        const looseMasks = d.visualAnimTargets.get(id);
        if (loose.length) {
          row.anims = loose.map((a) => ({
            name: d.animNames[a],
            targets: targetWordsOf(looseMasks ? looseMasks.get(a) || 0 : 0),
          }));
        }
        row.animKits = (d.spellAnimKits.get(id) || []).slice().sort((a, b) => a - b)
          .map((k) => ({
            id: k,
            anims: (d.animKitAnims.get(k) || []).map((a) => d.animNames[a]),
            targets: targetWordsOf(maskOf(d.animKitTargets, id, [k])),
          }));
        const stance = (d.spellAnims.get(id) || []).slice().sort((a, b) => a - b);
        if (stance.length) row.stanceAnims = stance.map((a) => d.animNames[a]);
      }
      if (!hc.fx) {
        // one entry per pill, in the cell's category order; the shapes differ
        // per category, hence the shared loose ExportFxEntry
        /** @type {ExportFxEntry[]} */
        const chains = (d.spellFx.get(id) || []).slice().sort((a, b) => a - b).map((c) => {
          const info = d.fxChains.get(c) || { color: 0xffffff, hue: "" };
          return {
            type: "chain",
            textures: (d.fxTextures.get(c) || []).map(pathOf),
            tint: info.color === 0xffffff ? null : hexColor(info.color),
          };
        });
        row.fx = chains.concat((d.spellDissolves.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "dissolve",
          textures: (d.dissolveTextures.get(c) || []).map(pathOf),
          duration: d.dissolveDurations.get(c) || null,
        }))).concat((d.spellGlows.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "glow",
          color: hexColor(d.glowColors.get(c) ?? 0),
        }))).concat((d.spellShadowies.get(id) || []).slice().sort((a, b) => a - b).map((c) => {
          const sh = d.shadowyColors.get(c) || { primary: 0, secondary: 0 };
          return {
            type: "ghost",
            colors: [sh.primary, sh.secondary].map(hexColor),
          };
        })).concat((d.spellGhostMats.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "ghost",
          color: hexColor(d.ghostMatColors.get(c) ?? 0),
        }))).concat((d.spellTints.get(id) || []).slice().sort((a, b) => a - b).map((c) => ({
          type: "tint",
          color: hexColor(d.tintColors.get(c) ?? 0),
        }))).concat([...new Set(d.spellDesaturates.get(id) || [])].sort((a, b) => a - b)
          .map((p) => ({ type: "desaturate", percent: p }))
        ).concat([...new Set(d.spellTransps.get(id) || [])].sort((a, b) => a - b)
          .map((p) => ({ type: "transparency", percent: p }))
        ).concat(d.spellFreezes.has(id) ? [{ type: "freeze" }] : []
        ).concat(d.spellCamos.has(id) ? [{ type: "camo" }] : []
        ).concat((d.spellScreens.get(id) || []).slice().sort((a, b) => a - b).map((sc) => {
          const c = d.screenColors.get(sc) || NO_SCREEN_COLORS;
          /** @param {number} v -1 = the row has no such color. */
          const hx = (v) => v >= 0 ? hexColor(v) : null;
          return {
            type: "screen",
            screenId: sc,
            name: d.screenNames.get(sc) || null,
            fogTint: hx(c.fog),
            fogAlpha: c.fogAlpha >= 0 ? c.fogAlpha : null,
            colorMultiply: hx(c.mul),
            colorAddition: hx(c.add),
            // overlays are finished art; masks are painted by the colors
            overlays: (d.screenTextures.get(sc) || [])
              .filter((t) => !t.mask).map((t) => pathOf(t.fid)),
            masks: (d.screenTextures.get(sc) || [])
              .filter((t) => t.mask).map((t) => pathOf(t.fid)),
          };
        })).concat((d.spellShapeshifts.get(id) || []).slice().sort((a, b) => a - b)
          .map((f) => ({
            type: "shapeshift",
            formId: f,
            form: d.shapeshiftNames.get(f) || null,
            displays: (d.shapeshiftDisplays.get(f) || []).map((e) => ({
              displayId: e.displayId,
              model: e.fid ? pathOf(e.fid) : null,
            })),
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
    // CSV has no icons, so a row's target types ride its text: "file [caster+target]"
    const withTargets = (e) =>
      (e.targets && e.targets.length ? `${e.path} [${e.targets.join("+")}]` : `${e.path}`);
    const lines = [header.join(",")];
    for (const r of exportRows()) {
      const cols = [r.id, esc(r.name), esc(r.subtext)];
      if (!hc.models) {
        cols.push(esc(r.models.map((m) => (m.files
          ? `${m.category}: ${m.files.map(withTargets).join(" | ")}`
          : m)).join("; ")));
      }
      if (!hc.sounds) {
        cols.push(esc(r.soundKits.map((k) => k.id).join("; ")));
        cols.push(esc(r.soundKits.map(
          (k) => `${withTargets({ path: k.id, targets: k.targets })}: ${k.files.join(" | ")}`)
          .join("; ")));
      }
      if (!hc.animkits) {
        cols.push(esc(r.animKits.map((k) => k.id).join("; ")));
        cols.push(esc((r.anims || []).map((a) => withTargets({ path: a.name, targets: a.targets }))
          .concat(r.animKits.map(
            (k) => `${withTargets({ path: k.id, targets: k.targets })}: ${k.anims.join(" | ")}`))
          .concat(r.stanceAnims ? [`stance: ${r.stanceAnims.join(" | ")}`] : []).join("; ")));
      }
      if (!hc.fx) {
        cols.push(esc(r.fx.map((e) => {
          if (e.type === "morph") {
            return `morph: ${e.creature || "?"} (creature ${e.creatureId}): `
              + (e.displays.map((disp) => `${disp.displayId}=${disp.model || "?"}`).join(" | ") || "?");
          }
          // a form with no display is name-only — no ": …" tail
          if (e.type === "shapeshift") {
            const disp = e.displays
              .map((x) => `${x.displayId}=${x.model || "?"}`).join(" | ");
            return `shapeshift: ${e.form || `form ${e.formId}`}`
              + (disp ? `: ${disp}` : "");
          }
          if (e.type === "summon") {
            return `summon: ${e.creature || "?"} (creature ${e.creatureId})`
              + (e.control ? ` [${e.control}]` : "");
          }
          if (e.percent !== undefined) // percent-only fx (desaturate / transparency)
            return `${e.type}: ${e.percent}%`;
          if (e.type === "freeze" || e.type === "camo") // valueless fx
            return e.type;
          if (e.type === "screen") { // named + optional colors/textures
            const tex = e.overlays.concat(e.masks);
            return `screen: ${e.name || e.screenId}`
              + (e.fogTint ? ` (${e.fogTint})` : "")
              + (tex.length ? `: ${tex.join(" | ")}` : "");
          }
          if (e.color || e.colors) // color-only fx (glow / ghost / tint)
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
    for (const th of $$("th[data-sort]")) {
      const active = state.sort.key === th.dataset.sort;
      th.classList.toggle("sorted", active);
      th.querySelector(".arrow").textContent = active ? (state.sort.dir === 1 ? "▲" : "▼") : "";
    }
  }

  /* ----------------------------------------------------------- the URL */

  // the default version stays out of the URL — links only carry v= when the
  // user deliberately switched to another pack.
  //
  // An entry flagged `default` in versions.json wins; otherwise it is the
  // newest visible pack. The flag exists because the newest build is not
  // necessarily the one to serve first. Hidden packs never qualify either
  // way: they exist only for whoever asks for one by name with ?v=, so
  // nobody else ever downloads them.
  function defaultVersion() {
    const visible = state.versions.filter((e) => !e.hidden);
    return visible.find((e) => e.default) || visible.at(-1);
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
    // sort order shapes the shared list — and the row order of ?export= —
    // so it rides in the URL too: one link must always yield one result set
    if (state.sort.key !== "auto") {
      params.push("sort=" + (state.sort.dir < 0 ? "-" : "") + state.sort.key);
    }
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
    const legacyMode = canonField(get("m") || "");
    if (legacyMode && isChipField(legacyMode) && q && !/[a-z]+:/i.test(q)) {
      q = `${legacyMode}:${/\s/.test(q) ? `"${q}"` : q}`;
    }
    return { v: get("v"), q, only: get("only"), sort: get("sort") };
  }

  // set the "Only spells with" filters from the URL's only= list (absent
  // = all off) and sync the checkboxes
  function filtersFromUrl(str) {
    const wanted = new Set((str || "").split(","));
    for (const k of Object.keys(state.filters)) state.filters[k] = wanted.has(k);
    for (const box of $$inputs("#filters input[type=checkbox]")) {
      box.checked = state.filters[box.dataset.filter];
    }
  }

  // set the sort from the URL's sort= value ("name" ascending, "-name"
  // descending; absent or unknown = the automatic relevance order). Unknown
  // keys fall back rather than sorting by nothing — a stale link from before
  // a column was renamed still shows results.
  function sortFromUrl(str) {
    const s = str || "";
    const key = s.replace(/^-/, "");
    const known = key === "id" || key === "name" || COUNT_SORTS.has(key);
    state.sort = known ? { key, dir: s.startsWith("-") ? -1 : 1 } : { key: "auto", dir: 1 };
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
    const input = qInput;
    // the three bar elements every handler below reaches for
    const bar = $("#qbar");
    const editwrap = $("#editwrap");
    const suggestBox = $("#suggest");

    input.addEventListener("input", (e) => {
      if (!state.activeField) {
        // pasted text arrives whole, so a "model:fire" inside it never
        // passes the caret check below — parse the full value into chips
        // instead. Only for pastes: while typing, tags chip at the ":"
        if (e.inputType === "insertFromPaste"
            && (/(^|\s)-?[a-z]+:\S/i.test(input.value) || ID_CMD_PASTE.test(input.value))) {
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
        // an Epsilon command just finished with a space — ".cast " (or
        // .cas/.ca/.c/.aura/.aur/.au) opens an id: chip, the space acting
        // as the tag's ":"
        const cm = before.match(ID_CMD_TYPED);
        if (cm && !inQuote) {
          const rest = input.value.slice(caret);
          input.value = input.value.slice(0, cm.index + cm[1].length);
          activateField("id");
          if (rest) {
            input.value = rest;
            input.setSelectionRange(0, 0);
            sizeInput();
            scheduleSearch();
          }
          return;
        }
      }
      updateSuggest(); // field prefixes, or category words inside fx:/model:
      sizeInput();
      scheduleSearch();
    });

    input.addEventListener("keydown", (e) => {
      const box = suggestBox;
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
          pickSuggestItem(items[Math.max(suggestIndex, 0)]);
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
      if (state.barSel && !targetClosest(e, "#qbar")) clearBarSel();
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
          const r = editwrap.getBoundingClientRect();
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

    bar.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      clearBarSel();
      const fromInput = !!targetClosest(e, "#editwrap");
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
    bar.addEventListener("click", (e) => {
      if (suppressBarClick) { suppressBarClick = false; return; }
      const x = targetClosest(e, "[data-chip-remove]");
      if (x) {
        const idx = Number(x.dataset.chipRemove);
        state.chips.splice(idx, 1);
        if (idx < state.pos) state.pos -= 1;
        syncBar();
        input.focus();
        scheduleSearch();
        return;
      }
      const label = targetClosest(e, "[data-chip-not]");
      if (label) {
        const chip = state.chips[Number(label.dataset.chipNot)];
        chip.not = !chip.not;
        renderBar();
        input.focus();
        scheduleSearch();
        return;
      }
      if (targetClosest(e, "#editlabel")) {
        state.activeNot = !state.activeNot;
        renderBar();
        input.focus();
        scheduleSearch();
        return;
      }
      const chip = targetClosest(e, "[data-chip-edit]");
      if (chip) {
        // flush anything pending elsewhere first, correcting the target
        // index if that insertion landed before it
        let idx = Number(chip.dataset.chipEdit);
        const insertedAt = flushPending();
        if (insertedAt !== -1 && insertedAt <= idx) idx += 1;
        editChipAt(idx);
        return;
      }
      if (targetClosest(e, "#editwrap")) return; // clicks in the editor place the caret natively

      // bar background: commit whatever's pending and move the gap (and
      // cursor) to where the click landed
      const past = (elem) => { // is the click past this element in reading order?
        const r = elem.getBoundingClientRect();
        return e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > (r.left + r.right) / 2);
      };
      let gap = 0;
      for (const c of $$(".qchip", bar)) {
        if (past(c)) gap = Number(c.dataset.chipEdit) + 1;
      }
      const afterPending = past(editwrap);
      const insertedAt = flushPending();
      if (insertedAt !== -1 && (insertedAt < gap || (insertedAt === gap && afterPending))) gap += 1;
      state.pos = Math.min(gap, state.chips.length);
      syncBar();
      input.focus();
      scheduleSearch();
    });

    // suggestions
    suggestBox.addEventListener("mousedown", (e) => {
      const item = targetClosest(e, ".suggest-item");
      if (item) { e.preventDefault(); pickSuggestItem(item); }
    });
    document.addEventListener("click", (e) => {
      if (!targetClosest(e, "#qbar") && !targetClosest(e, "#suggest")) hideSuggest();
    });

    // field buttons: "+ Label" includes, "−" (or shift-click) excludes
    $("#tabs").addEventListener("click", (e) => {
      const btn = targetClosest(e, "button[data-field]");
      if (btn) activateField(btn.dataset.field, { not: btn.dataset.not === "1" || e.shiftKey });
    });

    // results: copy buttons / cross-search / expanders (event delegation)
    $("#results").addEventListener("click", (e) => {
      const t = targetClosest(e, "button");
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
      const b = targetClosest(e, "button[data-search]");
      if (b) crossSearch(b.dataset.search);
    });

    // share + export
    $("#share-link").addEventListener("click", shareLink);
    $("#export-csv").addEventListener("click", exportCsv);
    $("#export-json").addEventListener("click", exportJson);
    $("#export-discord").addEventListener("click", exportDiscord);

    // filters — part of the shareable state, so the URL follows (a push:
    // Back undoes the toggle like it undoes a search)
    for (const box of $$inputs("#filters input[type=checkbox]")) {
      box.addEventListener("change", () => {
        state.filters[box.dataset.filter] = box.checked;
        applyFiltersAndSort();
        stateToUrl(true);
      });
    }

    // column visibility
    for (const box of $$inputs("#columns input[type=checkbox]")) {
      box.addEventListener("change", () => {
        state.hiddenCols[box.dataset.col] = !box.checked;
        try { localStorage.setItem("epsilook.hiddenCols.v4", JSON.stringify(state.hiddenCols)); } catch (e) {}
        applyHiddenCols();
        runSearch();
      });
    }

    // sorting: click cycles ascending -> descending -> back to automatic
    // order; entry-count columns start descending (extreme spells first)
    for (const th of $$("th[data-sort]")) {
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        const first = COUNT_SORTS.has(key) ? -1 : 1;
        if (state.sort.key !== key) state.sort = { key, dir: first };
        else if (state.sort.dir === first) state.sort.dir = -first;
        else state.sort = { key: "auto", dir: 1 };
        applyFiltersAndSort();
        stateToUrl(true); // shareable + Back undoes the sort, like the filters
      });
    }

    // help dialog (native <dialog>: Esc closes it for free)
    const help = /** @type {HTMLDialogElement} */ ($("#help"));
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
    const versionSel = /** @type {HTMLSelectElement} */ ($("#version"));
    versionSel.addEventListener("change", async () => {
      const entry = state.versions.find((v) => v.id === versionSel.value);
      if (entry) await activateVersion(entry, { push: true });
    });
  }

  function updateTabs() {
    for (const tab of $$("#tabs .tab")) {
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
    for (const box of $$inputs("#columns input[type=checkbox]")) {
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

  /**
   * Point the version dropdown at the active pack.
   *
   * A hidden pack has no option until it is activated — whoever passed its
   * ?v= has asked for it by name, and a select left showing a blank value
   * would just be lying about what is loaded.
   * @param {VersionEntry} entry
   */
  function showVersionOption(entry) {
    const sel = /** @type {HTMLSelectElement} */ ($("#version"));
    if (![...sel.options].some((o) => o.value === entry.id)) {
      const opt = el("option", "", versionLabel(entry));
      opt.value = entry.id;
      sel.appendChild(opt);
    }
    sel.value = entry.id;
    $("#version-wrap").hidden = sel.options.length < 2;
  }

  /**
   * Show the active version's expansion logo beside the selector.
   *
   * The art is a game texture, so it comes from the same version-pinned CASC
   * API (and the same in-browser BLP decoder) the texture previews use — one
   * small image per version switch. Anything unknown or unfetchable just
   * leaves the slot empty rather than showing a broken image.
   * @param {VersionEntry} entry
   */
  async function showVersionLogo(entry) {
    const slot = $("#version-logo");
    if (!slot) return;
    const major = Number(entry.id.split(".")[0]);
    const logo = CFG.expansionLogos && CFG.expansionLogos[major];
    slot.replaceChildren();
    slot.title = "";
    if (!logo) return;
    const canvas = await textureCanvas(logo.fid);
    // a slow fetch can land after the user has switched again
    if (!canvas || state.version !== entry) return;
    canvas.style.height = CFG.expansionLogoHeight + "px";
    canvas.style.width = "auto";
    slot.title = logo.name;
    slot.replaceChildren(canvas);
  }

  /**
   * @param {VersionEntry} entry
   * @param {{push?: boolean}} [opts]
   */
  async function activateVersion(entry, { push = false } = {}) {
    const overlay = $("#loading");
    const loadText = $("#load-text");
    const loadError = $("#load-error");
    overlay.hidden = false;
    loadError.hidden = true;
    try {
      const pack = await Data.loadPack(entry, (got, total) => {
        const pct = total ? Math.round((got / total) * 100) : 0;
        $("#load-bar").style.width = pct + "%";
        loadText.textContent = total
          ? `Downloading spell data… ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`
          : `Downloading spell data… ${(got / 1048576).toFixed(1)} MB`;
      });
      loadText.textContent = "Building search indexes…";
      await new Promise((r) => setTimeout(r)); // let the text paint
      state.data = Data.buildIndexes(pack);
      state.version = entry;
      showVersionOption(entry);
      void showVersionLogo(entry);  // fire-and-forget: failure just hides it
      $("#meta-info").textContent =
        `${entry.label} (${entry.id}) · Listfile ${state.data.meta.listfileTag} · Built ${state.data.meta.built} · ` +
        `${state.data.meta.counts.spells.toLocaleString()} spells`;
      $("#es-count").textContent = state.data.meta.counts.spells.toLocaleString();
      overlay.hidden = true;
      runSearch({ push });
    } catch (err) {
      console.error(err);
      loadText.textContent = "";
      loadError.textContent = `Failed to load spell data: ${err.message}`;
      loadError.hidden = false;
    }
  }

  function applyUrl({ push }) {
    const h = urlToState();
    loadQueryString(h.q);
    filtersFromUrl(h.only);
    sortFromUrl(h.sort);
    // no v= in the URL means the default version, not "keep the current
    // one" — back/forward must return from an explicitly-chosen pack
    const wanted = findVersion(h.v) || defaultVersion();
    if (wanted && (!state.version || wanted.id !== state.version.id)) {
      // fire-and-forget: activateVersion reports its own load failures
      void activateVersion(wanted, { push });
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
      const loadError = $("#load-error");
      $("#load-text").textContent = "";
      loadError.textContent =
        `Failed to load data/versions.json: ${err.message}. ` +
        `If you opened index.html directly from disk, serve the folder over HTTP instead ` +
        `(e.g. "python -m http.server" in the docs folder).`;
      loadError.hidden = false;
      return;
    }

    const sel = /** @type {HTMLSelectElement} */ ($("#version"));
    for (const v of state.versions) {
      if (v.hidden) continue;  // URL-only pack: activateVersion adds it if asked for
      const opt = el("option", "", versionLabel(v));
      opt.value = v.id;
      sel.appendChild(opt);
    }
    $("#version-wrap").hidden = sel.options.length < 2;

    const h = urlToState();
    // ?export=json|csv downloads the query's results as soon as they're
    // ready. Read it before activateVersion — the first search rewrites the
    // URL (stateToUrl keeps only v/q), so refresh/back won't re-download.
    const autoExport = (new URLSearchParams(location.search).get("export") || "").toLowerCase();
    const entry = findVersion(h.v) || defaultVersion();
    loadQueryString(h.q);
    filtersFromUrl(h.only);
    sortFromUrl(h.sort);
    await activateVersion(entry);
    if (autoExport === "json") exportJson();
    else if (autoExport === "csv") exportCsv();
    qInput.focus();
  }

  void boot(); // nothing to await it — boot renders its own load errors
})();
