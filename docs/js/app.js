// @ts-check
/* Epsilook UI: chip search bar, results table, tags, clipboard, scrolling.
 * Shared shapes (SpellData, QueryGroup, the pack, the window globals) are
 * declared in types.d.ts; UI-local shapes are the typedefs below. */
"use strict";

(() => {
    const CFG = window.EpsilookConfig;
    const Data = window.EpsilookData;
    const Search = window.EpsilookSearch;
    // the pill/segment library — every result-cell pill is assembled through it
    const P = window.EpsilookPills;

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

    // spoken state for the tri-state column filters (any / with / without),
    // kept in the button's aria-label as it cycles
    const TRI_LABELS = {"": "showing all", with: "only spells with", without: "only spells without"};

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
     *   filters: Record<string, ("" | "with" | "without")>,
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
        // tri-state per category: "" = any, "with" = must have, "without" = must
        // not have. See HAS_CATEGORY / applyFiltersAndSort.
        filters: {models: "", sounds: "", animations: "", fx: ""},
        sort: {key: "auto", dir: 1},
        // hidden columns (also excluded from All-mode search and from exports)
        hiddenCols: {models: false, sounds: false, animations: false, fx: false, mechanics: true, commands: false},
    };

    // column -> search fields it contributes
    const COL_FIELDS = {
        models: ["model"],
        sounds: ["sound"],
        animations: ["anim"],
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
        try {
            document.execCommand("copy");
            done();
        } catch (e) {
            toast("Copy failed");
        }
        ta.remove();
        if (prev && prev !== document.body) prev.focus({preventScroll: true});
    }

    const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)}/g, (_, k) => vars[k] ?? "");

    /**
     * Wowhead site path prefix for the active pack's game version — "classic/"
     * for Vanilla, "" (retail) for everything else. Only /classic/ and retail
     * are permanent Wowhead sections, so any unmapped version falls back to
     * retail (see CFG.wowheadSitePrefix).
     * @returns {string}
     */
    const wowheadPrefix = () => {
        const major = state.version ? parseInt(state.version.id, 10) : 0;
        return (CFG.wowheadSitePrefix && CFG.wowheadSitePrefix[major]) || "";
    };

    /**
     * Fill a Wowhead URL template, injecting the version-appropriate site prefix
     * ({wh}) alongside the given vars. Templates with no {wh} slot (the model
     * viewer, which always stays on retail) are unaffected.
     * @param {string} template
     * @param {Record<string, string|number>} vars
     */
    const wowheadUrl = (template, vars) => fillTemplate(template, {wh: wowheadPrefix(), ...vars});

    /* ------------------------------------------------- query <-> chips */

    // legacy prefixes silently convert to their current field — effect: was
    // the fx: column's name before the effect:->mech: split; soundkit: and
    // animkit: folded into sound:/anim: 2026-07-19 (numeric chips match kit IDs)
    const FIELD_ALIASES = {effect: "fx", soundkit: "sound", animkit: "anim"};
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
            else parts.push({field: "all", text: word});
        };
        for (const m of (str || "").matchAll(/(?:(-)?([a-z]+):)?(?:\(([^)]*)\)|"([^"]*)"|([^\s"]+))/gi)) {
            const not = !!m[1];
            const field = canonField((m[2] || "").toLowerCase());
            if (isChipField(field)) {
                const text = (m[3] ?? m[4] ?? m[5] ?? "").trim();
                if (text) parts.push({field, text, not});
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
            if (t) tokens.push({text: t});
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
            return tokens.length ? {field, tokens, not: !!not} : null;
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
                // a real button so the include/exclude toggle is keyboard-operable
                const label = el("button", "qchip-field", `${c.not ? "−" : ""}${c.field}:`);
                label.type = "button";
                label.title = c.not ? `Excluding — click to include ${c.field} matches` : `Click to exclude ${c.field} matches instead`;
                label.setAttribute("aria-label", c.not ? `Include ${c.field} matches` : `Exclude ${c.field} matches`);
                label.dataset.chipNot = String(idx);
                chip.appendChild(label);
            }
            chip.appendChild(el("span", "qchip-text", c.text));
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

    function activateField(field, {not = false} = {}) {
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
    function insertFreeChipHere() {
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

    const barHistory = {stack: [], at: -1, lastTyping: false, lastTime: 0};
    const UNDO_CAP = 200;
    const TYPE_COALESCE_MS = 800;

    function barSnapshot() {
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

    /* Attachment names pushed the word list past 60 entries, so the dropdown
   * needs a ceiling — a one-letter prefix would otherwise cover the results. */
    const SUGGEST_LIMIT = 12;

    /* ------------------------------------------------- keyword autocomplete */

    /* Every word a chip can autocomplete comes from one of two places: the
   * pill-type registry (docs/js/pilltypes.js), which names the CONTENT types a
   * column shows, and the META words below, which are axes rather than content
   * — they qualify whatever else the chip says.
   *
   * Data VALUES are deliberately never offered (no attachment-point names, no
   * file names, no creature names): the suggestion list is a menu of what can
   * be asked, not of the answers. */

    /* Target-type words autocomplete in every column that shows the icons —
   * they read as categories to the user even though they are mask bit tests
   * rather than corpus words (see TARGET_TESTS in search.js). */
    const TARGET_WORD_TITLES = {
        caster: "Plays on the caster",
        target: "Plays on the target",
        area: "Plays where the spell lands",
        both: "Plays on the caster and the target",
    };

    /* The attachment-point keyword. It is the ONE attachment meta-word that
   * autocompletes: the point NAMES are data values (the user types the point
   * after it, `attach chest`). Offered only in the two columns that render
   * attachment segments, and only when the pack actually carries them. */
    const ATTACH_WORD = "attach";

    /**
     * One meta word: not a kind of content, but an axis any chip in `fields`
     * can carry. `when` gates it on the loaded pack, exactly as a pill type's
     * does — a pack with no attachment data never suggests `attach`.
     * @type {{word: string, hint: string, fields: string[],
     *         when?: (d: SpellData) => boolean}[]}
     */
    const META_WORDS = [
        {
            word: ATTACH_WORD, fields: ["model", "fx"],
            hint: "Attachment point follows, e.g. attach chest or attach spelllefthand",
            when: (d) => !!d.attachmentNames && Object.keys(d.attachmentNames).length > 0,
        },
    ];

    /**
     * The words a field offers in autocomplete, with their descriptions: its
     * registered content types, its meta words, and the target words every
     * marked column shares.
     * @param {string | null} field
     * @returns {{words: string[], titles: Record<string, string>} | null}
     *   Null = the field has no category words at all.
     */
    function fieldCategories(field) {
        const d = state.data;
        if (!d || !["model", "sound", "anim", "fx"].includes(field)) return null;
        const {words, titles} = P.keywordsFor(field, d);
        for (const meta of META_WORDS) {
            if (!meta.fields.includes(field) || (meta.when && !meta.when(d))) continue;
            words.push(meta.word);
            titles[meta.word] = meta.hint;
        }
        // every column that draws target icons can be filtered by them
        return {
            words: [...words, ...Search.TARGET_WORDS],
            titles: {...titles, ...TARGET_WORD_TITLES},
        };
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
        matches.forEach(([key, f], i) => {
            const b = el("button", "suggest-item");
            markSuggestOption(b, i);
            b.appendChild(el("span", `suggest-field f-${key}`, `${key}:`));
            b.appendChild(el("span", "suggest-hint", f.hint));
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
    function updateCategorySuggest() {
        const input = qInput;
        const box = $("#suggest");
        const word = input.value.split(/\s+/).pop().toLowerCase();
        if (!word) return hideSuggest();
        const {words, titles} = fieldCategories(state.activeField);
        /* Prefix hits first, then words that merely *contain* what was typed —
     * that is what lets "hand" reach SpellLeftHand / HandRight / SpellHandOmni
     * and "seat" reach VehicleSeat1..8, which is how attachment points are
     * actually half-remembered. Matching is case-insensitive because the
     * attachment names are CamelCase while the category words are lower. */
        const lc = (w) => w.toLowerCase();
        const usable = words.filter((w) => lc(w) !== word);
        const prefix = usable.filter((w) => lc(w).startsWith(word));
        const inner = usable.filter((w) => !lc(w).startsWith(word) && lc(w).includes(word));
        const matches = [...prefix, ...inner].slice(0, SUGGEST_LIMIT);
        if (!matches.length) return hideSuggest();

        box.textContent = "";
        matches.forEach((w, i) => {
            const b = el("button", "suggest-item");
            markSuggestOption(b, i);
            b.appendChild(el("span", `suggest-field f-${state.activeField}`, w));
            // the parenthesized table name is build trivia — the plain half explains
            b.appendChild(el("span", "suggest-hint", (titles[w] || "").split(" (")[0]));
            b.dataset.word = w;
            box.appendChild(b);
        });
        suggestIndex = -1;
        box.hidden = false;
        qInput.setAttribute("aria-expanded", "true");
        qInput.removeAttribute("aria-activedescendant");
    }

    // complete the partial last word of the chip's text to the category word.
    // the attach keyword takes a point name after it, so leave a trailing space
    // ready for it (attach chest) rather than butting the caret against it
    function applyCategoryWord(word) {
        const input = qInput;
        input.value = input.value.replace(/\S*$/, word) + (word === ATTACH_WORD ? " " : "");
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
        qInput.setAttribute("aria-expanded", "false");
        qInput.removeAttribute("aria-activedescendant");
    }

    // ARIA listbox wiring shared by both suggestion builders: each item is an
    // option with a stable id so aria-activedescendant can point at it
    function markSuggestOption(b, i) {
        b.id = `suggest-opt-${i}`;
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", "false");
    }

    function selectSuggestion(field) {
        const input = qInput;
        const not = /(^|\s)-\S*$/.test(input.value);
        input.value = input.value.replace(/\S+$/, "").trimEnd();
        activateField(field, {not});
    }

    /* ------------------------------------------------------------ search */

    let searchDebounce = null;

    function scheduleSearch() {
        recordBar();
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => runSearch(), CFG.searchDebounceMs);
    }

    function runSearch({push = false} = {}) {
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
            .flatMap((g) => g.tokens.map((t) => ({field: g.field, text: t.text})));
        state.searchMs = res.ms;
        applyFiltersAndSort();
        stateToUrl(push);
    }

    // multi-value columns sort by how many entries a row shows there — the
    // count keys mirror the column names; clicking those headers starts at
    // "most entries first" (the extreme spells are the interesting ones)
    const COUNT_SORTS = new Set(["models", "sounds", "animations", "fx", "mechanics"]);

    function entryCountFn(key) {
        const d = state.data;
        const len = (m, id) => (m.get(id) || []).length;
        switch (key) {
            case "models":
                return (id) =>
                    d.spellModelCats.size ? len(d.spellModelCats, id) : len(d.spellModels, id);
            case "sounds":
                return (id) => len(d.spellSounds, id);
            case "animations":
                return (id) =>
                    len(d.spellAnimKits, id) + len(d.spellAnims, id) + len(d.spellVisualAnims, id);
            // raw SpellEffect rows, not the rendered pill count — pills merge rows
            // that differ only in implicit target, and "how many effects does this
            // spell have" is the more meaningful sort (it is also what the export
            // lists, one line per row)
            case "mechanics":
                return (id) => len(d.spellMechanics, id);
            case "fx":
                return (id) =>
                    len(d.spellFx, id) + len(d.spellDissolves, id) + len(d.spellGlows, id)
                    + len(d.spellShadowies, id) + len(d.spellGhostMats, id) + len(d.spellTints, id)
                    + len(d.spellDesaturates, id) + len(d.spellTransps, id)
                    + (d.spellFreezes.has(id) ? 1 : 0) + (d.spellCamos.has(id) ? 1 : 0)
                    + len(d.spellScreens, id) + len(d.spellMorphs, id)
                    + len(d.spellShapeshifts, id) + len(d.spellSummons, id)
                    + len(d.spellKeybinds, id);
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
                    const matches = Search.FIELDS[g.field].run([{text: t.text}], d, new Set());
                    tests.push((id) => matches.has(id));
                }
            }
        }
        if (!tests.length) return null;
        return (id) => tests.reduce((n, f) => n + (f(id) ? 1 : 0), 0);
    }

    // presence test per filter category — the union of every pack section that
    // feeds that column. Both the "Only spells with / without" filter row and
    // the URL (only= / without=) read these; giving a future column a filter is
    // a one-line addition here plus its button in index.html.
    /** @type {Record<string, (d: any, id: number) => boolean>} */
    const HAS_CATEGORY = {
        models: (d, id) => d.spellModels.has(id),
        sounds: (d, id) => d.spellSounds.has(id),
        animations: (d, id) =>
            d.spellAnimKits.has(id) || d.spellAnims.has(id) || d.spellVisualAnims.has(id),
        fx: (d, id) =>
            d.spellFx.has(id) || d.spellDissolves.has(id) || d.spellGlows.has(id) ||
            d.spellShadowies.has(id) || d.spellGhostMats.has(id) || d.spellTints.has(id) ||
            d.spellDesaturates.has(id) || d.spellTransps.has(id) ||
            d.spellFreezes.has(id) || d.spellCamos.has(id) || d.spellScreens.has(id) ||
            d.spellMorphs.has(id) || d.spellShapeshifts.has(id) || d.spellSummons.has(id) ||
            d.spellVehicles.has(id) || d.spellInvisTypes.has(id) ||
            d.spellDetectTypes.has(id) || d.spellKeybinds.has(id),
    };

    function applyFiltersAndSort() {
        const d = state.data;
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
        const start = state.rendered;
        const end = Math.min(state.rendered + CFG.scrollBatch, state.display.length);
        const frag = document.createDocumentFragment();
        for (let i = state.rendered; i < end; i++) frag.appendChild(buildRow(state.display[i], i));
        tbody.appendChild(frag);
        state.rendered = end;
        // the cells are in the DOM now, so their heights are known — collapse each
        // new row to the shared height budget (see the row-layout section)
        for (let i = start; i < end; i++) layoutRow(/** @type {HTMLElement} */ (tbody.children[i]));
        $("#sentinel").hidden = state.rendered >= state.display.length;
    }

    /* ------------------------------------------------- row layout (collapse)
   *
   * Every multi-value cell renders all its pills; here we hide whatever
   * overflows a shared HEIGHT budget behind one "+N more". The budget belongs
   * to the ROW: it starts at CFG.collapsedRowHeight and grows to fit any cell
   * the user has expanded (td.dataset.expanded), so expanding one column lets
   * the others reveal more to fill the now-taller row — progressively, until
   * everything shows. Expansion is one-way (until the next search). Because a
   * cell's content flows top-to-bottom in DOM order (inline pills wrap, kit
   * groups stack), leaf bottoms are monotonic, so a leading prefix is exactly
   * "what fits". */
    const COLLAPSE_COLS = ".c-models, .c-sounds, .c-animations, .c-fx, .c-mechanics";

    /** A cell's content pills in DOM order (group heads are structural). */
    function cellLeaves(td) {
        return [...td.querySelectorAll(".tag")].filter((t) => !t.closest(".kit-head"));
    }

    /** Un-collapse a cell: show every pill/group, drop its "+N more". */
    function revealCell(td) {
        for (const o of td.querySelectorAll(".overflow")) o.classList.remove("overflow");
        const more = td.querySelector(":scope > .more");
        if (more) more.remove();
    }

    /** Natural height (px) of a fully-revealed cell's content. */
    function cellFullHeight(td) {
        const top = td.getBoundingClientRect().top;
        let bottom = top;
        for (const c of td.children) bottom = Math.max(bottom, c.getBoundingClientRect().bottom);
        return bottom - top;
    }

    /* Hide the pills that overflow `budget`, add a "+N more". The cell must be
   * revealed first (layoutRow does that). Always leaves at least one pill. */
    function clampCell(td, budget) {
        const leaves = cellLeaves(td);
        if (!leaves.length) return;
        const top = td.getBoundingClientRect().top;
        const extent = (elm) => elm.getBoundingClientRect().bottom - top;
        // largest leading run of pills whose bottoms fit the budget
        let shown = 1;
        for (let i = 0; i < leaves.length; i++) {
            if (extent(leaves[i]) <= budget) shown = i + 1; else break;
        }
        const apply = () => {
            leaves.forEach((lf, i) => lf.classList.toggle("overflow", i >= shown));
            // hide a whole group once every pill inside it is hidden (no empty head)
            for (const g of td.querySelectorAll(".kit-group")) {
                const gl = [...g.querySelectorAll(".tag")].filter((t) => !t.closest(".kit-head"));
                g.classList.toggle("overflow",
                    gl.length > 0 && gl.every((x) => x.classList.contains("overflow")));
            }
        };
        apply();
        const more = el("button", "more");
        more.dataset.expand = "1";
        td.appendChild(more);
        const relabel = () => {
            more.textContent = `+${leaves.length - shown} more`;
        };
        relabel();
        // if the button itself spilled past the budget, drop pills until it fits —
        // stops the "+N more" from eating the very space it is supposed to save
        let guard = leaves.length;
        while (shown > 1 && extent(more) > budget && guard-- > 0) {
            shown--;
            apply();
            relabel();
        }
    }

    /* Collapse a row's cells to a shared height budget grown by any expanded
   * cell. Called on every freshly rendered row, on expand, and on resize. */
    function layoutRow(tr) {
        const cells = [...tr.querySelectorAll(COLLAPSE_COLS)];
        for (const td of cells) revealCell(td);            // one write pass, then reads
        let budget = CFG.collapsedRowHeight;
        const full = new Map();
        for (const td of cells) {
            const h = cellFullHeight(td);
            full.set(td, h);
            if (td.dataset.expanded === "1") budget = Math.max(budget, h);
        }
        for (const td of cells) {
            if (td.dataset.expanded === "1") continue;       // fully shown, no button
            if (full.get(td) <= budget) continue;            // already fits
            clampCell(td, budget);
        }
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
        idBtn.type = "button";
        idBtn.title = "Copy spell ID\nShift-click: copy wrapped in `backticks`";
        idBtn.setAttribute("aria-label", `Copy spell ID ${spellId}`);
        idBtn.dataset.copy = String(spellId);
        tdId.appendChild(idBtn);
        tr.appendChild(tdId);

        // Name — wowhead link (their widget adds the hover tooltip); the parts
        // matched by a name search are highlighted
        const tdName = el("td", "c-name");
        const nameDiv = el("div", "spell-name");
        const nameLink = el("a", "spell-name-link");
        nameLink.href = wowheadUrl(CFG.wowheadSpellUrl, {id: spellId});
        nameLink.target = "_blank";
        nameLink.rel = "noopener";
        if (CFG.spellIconUrl && d.icons[i]) {
            const icon = el("img", "spell-icon");
            icon.src = fillTemplate(CFG.spellIconUrl, {icon: d.icons[i]});
            icon.alt = "";
            icon.loading = "lazy";
            icon.addEventListener("error", () => icon.remove(), {once: true});
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
            d.spellVisualAnims.get(spellId) || [], spellId));

        // Effects — visual FX (beams, morphs, summons), grouped by category
        tr.appendChild(fxCell(spellId));

        // Mechanics — one pill per SpellEffect (what it does + who it targets),
        // matched ones first
        const mechs = hitsFirst(mechanicPills(d.spellMechanics.get(spellId) || []),
            (p) => p.rows.some(mechanicIsHit));
        tr.appendChild(tagCell("c-mechanics", mechs.map(mechanicTag)));

        // Commands — one compact line that fits even single-line rows
        const tdCmd = el("td", "c-cmds");
        const row = el("div", "cmd-row");
        for (const cmd of CFG.spellCommands) {
            const b = el("button", "cmd", cmd.label);
            b.type = "button";
            b.title = `${cmd.hint} — ${fillTemplate(cmd.template, {id: spellId})}\nShift-click: copy wrapped in \`backticks\``;
            b.setAttribute("aria-label", `${cmd.hint} (${cmd.label})`);
            b.dataset.copy = fillTemplate(cmd.template, {id: spellId});
            row.appendChild(b);
        }
        // the same favicon link the pills use, on the row's command strip
        const wh = P.renderSegment(P.link(
            wowheadUrl(CFG.wowheadSpellUrl, {id: spellId}), "Open on Wowhead"));
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

    function tagCell(className, tags) {
        const td = el("td", className);
        if (tags.length === 0) {
            td.classList.add("empty");
            td.appendChild(el("span", "none", "—"));
            return td;
        }
        // render every tag; the height-based collapse happens after layout, in
        // layoutRow — see the "row layout" section below
        for (const tag of tags) td.appendChild(tag);
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
            if (!name) {
                loose.push(...items);
                continue;
            }
            cats.push({
                name,
                items,
                hit: items.some((e) => modelFileIsHit(d.files.get(e.fid), name)),
            });
        }
        // Loose (uncategorized attach) pills flow first — attachment splits can
        // pile many of them up; the height-based clamp (layoutRow) hides whatever
        // overflows the row budget behind the cell's single "+N more".
        for (const e of hitsFirst(loose, (x) => modelFileIsHit(d.files.get(x.fid), ""))) {
            td.appendChild(modelTag(e.fid, "", e.targets, e.src, e.dst, travels(e.cat)));
        }
        buildKitGroups(td, hitsFirst(cats, (c) => c.hit), {
            headerTag: (c) => modelCatHeadTag(c.name, c.hit),
            itemsOf: (c) => hitsFirst(c.items, (e) => modelFileIsHit(d.files.get(e.fid), c.name)),
            itemTag: (e, c) => (isDisplayCat(e.cat) ? displayTag(e)
                : isItemCat(e.cat) ? itemTag(e)
                    : modelTag(e.fid, c.name, e.targets, e.src, e.dst, travels(e.cat))),
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
            headerTag: (kitId) => kitTag(kitId, "soundkit", kitMask.get(kitId)),
            itemsOf: (kitId) => hitsFirst(byKit.get(kitId), (fid) => fileIsHit(d.files.get(fid), "sound")),
            itemTag: (fid) => soundTag(fid),
        });
        return td;
    }

    /* Animations cell, in render order: loose pills for the animations the
   * spell's visual kits play directly (SpellVisualAnim — nothing to group
   * them under, joined by a vehicle's own anims), AnimKits grouped with the
   * animations they play, then the headless category groups — "stance" for
   * direct stand/walk overrides (SpellProceduralEffect Type 7) and
   * "passenger" for what a rider plays in a vehicle seat (VehicleSeat).
   * Those use the same anim pills, with a category word where a kit id would
   * head the group. Loose pills never collapse (99%+ of spells have ≤3). */
    /* Sentinel "kit ids" for animation groups that have no AnimKit to head
   * them: they head on a category word instead. Adding another headless
   * category is one entry here plus one in ANIM_CAT_TITLES — nothing below
   * branches on which group it is. */
    const STANCE_GROUP = -1;
    const PASSENGER_GROUP = -2;
    const ANIM_GROUPS = [
        {id: STANCE_GROUP, word: "stance", animsOf: (d, s) => d.spellAnims.get(s)},
        {id: PASSENGER_GROUP, word: "passenger", animsOf: (d, s) => d.spellPassengerAnims.get(s)},
    ];

    function animationsCell(animKitIds, looseAnimIds, spellId) {
        const groupAnims = new Map();
        for (const g of ANIM_GROUPS) {
            const anims = g.animsOf(state.data, spellId) || [];
            if (anims.length) groupAnims.set(g.id, anims);
        }
        const td = el("td", "c-animations");
        if (animKitIds.length === 0 && groupAnims.size === 0
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
            groupAnims.get(kitId) || d.animKitAnims.get(kitId) || [];
        // a headless group's anims match through its category word too
        const wordOf = (kitId) =>
            (ANIM_GROUPS.find((g) => g.id === kitId) || {word: ""}).word;
        const kitHasHit = (kitId) =>
            (!groupAnims.has(kitId) && kitIsHit(kitId, "animkit")) ||
            animsOf(kitId).some((a) => animIsHit(a, wordOf(kitId)));
        const groups = animKitIds.slice().sort((a, b) => a - b);
        for (const g of ANIM_GROUPS) if (groupAnims.has(g.id)) groups.push(g.id);
        const kitIds = hitsFirst(groups, kitHasHit);

        buildKitGroups(td, kitIds, {
            // stance overrides are ~96% caster — a constant, so no icon there
            // (documented in the help dialog instead); animkits carry theirs
            headerTag: (kitId) => groupAnims.has(kitId)
                ? animCatHeadTag(wordOf(kitId), kitHasHit(kitId))
                : kitTag(kitId, "animkit", maskOf(d.animKitTargets, spellId, [kitId])),
            itemsOf: (kitId) => hitsFirst(animsOf(kitId).slice().sort((a, b) => a - b),
                (a) => animIsHit(a, wordOf(kitId))),
            itemTag: (animId, kitId) => animTag(animId, wordOf(kitId)),
        });
        return td;
    }

    /* Head of the stance group — a category word like the model/fx heads:
   * clicking searches the whole group via anim:stance. */

    function animCatHeadTag(word, hit) {
        return P.pill({
            cls: "animkit", hit, segments: [
                P.label(word, {
                    title: P.hintFor("anim", word),
                    search: P.query("anim", word),
                    finds: `all spells with a ${word} animation`,
                }),
            ]
        });
    }

    /* Shared group renderer: each kit is a small box — the kit tag as a
   * tinted head segment, its items flowing (and wrapping) beside it. Every
   * group and every item is rendered; the height-based clamp (layoutRow) hides
   * whatever overflows the row budget behind the cell's single "+N more".
   * Groups rendering ≤1 item for THIS row collapse to an inline pill — see
   * P.group, which decides that for every column alike. */
    function buildKitGroups(td, kitIds, opts) {
        for (const kitId of kitIds) {
            td.appendChild(P.group({
                head: opts.headerTag(kitId),
                items: opts.itemsOf(kitId).map((item) => opts.itemTag(item, kitId)),
            }));
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
        const vehicleIds = d.spellVehicles.get(spellId) || [];
        const invisPills = (d.spellInvisTypes.get(spellId) || []).slice().sort((a, b) => a.type - b.type);
        const detectPills = (d.spellDetectTypes.get(spellId) || []).slice().sort((a, b) => a.type - b.type);
        const keybindIds = d.spellKeybinds.get(spellId) || [];
        const td = el("td", "c-fx");
        if (chainIds.length === 0 && dissolveIds.length === 0 && glowIds.length === 0
            && shadowyIds.length === 0 && ghostMatIds.length === 0 && tintIds.length === 0
            && desatPcts.length === 0 && transpPcts.length === 0 && !hasFreeze && !hasCamo
            && screenIds.length === 0 && morphIds.length === 0 && formIds.length === 0
            && summonEntries.length === 0 && vehicleIds.length === 0
            && invisPills.length === 0 && detectPills.length === 0
            && keybindIds.length === 0) {
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
        const targetSplit = (masks) => {
            const first = masks.length ? masks[0] : 0;
            const uniform = masks.every((m) => m === first);
            return {
                /** the mask the category HEAD carries (0 = the head shows none) */
                head: uniform ? first : 0,
                /** a row's own mask, shown only when the head could not speak for it */
                pill: (mask) => (uniform ? 0 : mask),
            };
        };

        if (chainIds.length) {
            // one entry per distinct (texture, tint); untextured chains still show.
            // Chains collapsing into one pill union their masks onto it.
            const chainMask = (c) => maskOf(d.fxTargets, spellId, [c]);
            const byKey = new Map();
            // the drawing beam's attach points are part of the key, so one chain
            // drawn by two beams from different points stays two pills
            const rows = (d.spellChainRows.get(spellId)
                || chainIds.map((c) => ({chain: c, src: -1, dst: -1})))
                .slice().sort((a, b) => a.chain - b.chain);
            for (const {chain: c, src, dst} of rows) {
                const color = (d.fxChains.get(c) || {}).color ?? 0xffffff;
                const fids = d.fxTextures.get(c) || [0];
                for (const fid of fids) {
                    const key = fid + ":" + color + ":" + src + ":" + dst;
                    const prev = byKey.get(key);
                    if (prev) {
                        prev.mask |= chainMask(c);
                        continue;
                    }
                    byKey.set(key, {chainId: c, fid, color, src, dst, mask: chainMask(c)});
                }
            }
            const t = targetSplit(chainIds.map(chainMask));
            cats.push({
                name: "chain",
                hit: chainIds.some((c) => fxChainIsHit(c)),
                mask: t.head,
                items: hitsFirst([...byKey.values()], (e) => fxChainIsHit(e.chainId))
                    .map((e) => () => fxTag(e, t.pill(e.mask))),
            });
        }
        if (dissolveIds.length) {
            // one pill per distinct texture; textureless rows still show
            const dissolveMask = (id) => maskOf(d.dissolveTargets, spellId, [id]);
            const byKey = new Map();
            for (const id of dissolveIds.slice().sort((a, b) => a - b)) {
                for (const fid of d.dissolveTextures.get(id) || [0]) {
                    const prev = byKey.get(fid);
                    if (prev) {
                        prev.mask |= dissolveMask(id);
                        continue;
                    }
                    byKey.set(fid, {dissolveId: id, fid, mask: dissolveMask(id)});
                }
            }
            const t = targetSplit(dissolveIds.map(dissolveMask));
            cats.push({
                name: "dissolve",
                hit: dissolveIds.some((id) => dissolveIsHit(id)),
                mask: t.head,
                items: hitsFirst([...byKey.values()], (e) => dissolveIsHit(e.dissolveId))
                    .map((e) => () => dissolveTag(e, t.pill(e.mask))),
            });
        }
        if (glowIds.length) {
            // one pill per distinct color (no texture — the color is the payload)
            const glowMask = (id) => maskOf(d.glowTargets, spellId, [id]);
            const byKey = new Map();
            for (const id of glowIds.slice().sort((a, b) => a - b)) {
                const color = d.glowColors.get(id) ?? 0;
                const prev = byKey.get(color);
                if (prev) {
                    prev.mask |= glowMask(id);
                    continue;
                }
                byKey.set(color, {
                    glowId: id, color, alpha: d.glowAlphas.get(id), mask: glowMask(id),
                });
            }
            const t = targetSplit(glowIds.map(glowMask));
            cats.push({
                name: "glow",
                hit: glowIds.some((id) => glowIsHit(id)),
                mask: t.head,
                items: hitsFirst([...byKey.values()], (e) => glowIsHit(e.glowId))
                    .map((e) => () => colorFxTag("glow", e.color, glowIsHit(e.glowId), e.alpha,
                        t.pill(e.mask))),
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
                const c = d.shadowyColors.get(id) || {primary: 0, secondary: 0};
                for (const color of [c.primary, c.secondary]) {
                    const prev = byColor.get(color);
                    if (prev) {
                        prev.mask |= shadowyMask(id);
                        continue;
                    }
                    byColor.set(color, {color, hit: () => shadowyIsHit(id), mask: shadowyMask(id)});
                }
            }
            for (const id of ghostMatIds.slice().sort((a, b) => a - b)) {
                const color = d.ghostMatColors.get(id) ?? 0;
                const prev = byColor.get(color);
                if (prev) {
                    prev.mask |= ghostMatMask(id);
                    continue;
                }
                byColor.set(color, {color, hit: () => ghostMatIsHit(id), mask: ghostMatMask(id)});
            }
            const catHit = shadowyIds.some((id) => shadowyIsHit(id))
                || ghostMatIds.some((id) => ghostMatIsHit(id));
            // both sources feed one category, so both sets of masks decide the head
            const t = targetSplit(shadowyIds.map(shadowyMask)
                .concat(ghostMatIds.map(ghostMatMask)));
            cats.push({
                name: "ghost",
                hit: catHit,
                mask: t.head,
                items: hitsFirst([...byColor.values()], (e) => e.hit())
                    .map((e) => () => colorFxTag("ghost", e.color, e.hit(), undefined,
                        t.pill(e.mask))),
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
                entries.push({tintId: id, color});
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
            cats.push({name: "freeze", hit: freezeIsHit(), items: []});
        }
        if (hasCamo) {
            cats.push({name: "camo", hit: camoIsHit(), items: []});
        }
        if (screenIds.length) {
            // one pill per ScreenEffect row, labeled with its internal name.
            // ImplicitTarget icon (pack format 25): usually the caster's own view
            const screenMask = (id) => maskOf(d.screenTargets, spellId, [id]);
            const ids = hitsFirst(screenIds.slice().sort((a, b) => a - b), (id) => screenIsHit(id));
            const t = targetSplit(screenIds.map(screenMask));
            cats.push({
                name: "screen",
                hit: screenIds.some((id) => screenIsHit(id)),
                mask: t.head,
                items: ids.map((id) => () => screenTag(id, t.pill(screenMask(id)))),
            });
        }
        if (formIds.length) {
            // one pill per (form, display); a form with no display (Battle Stance,
            // Shadowform, Stealth — 11 of the 29 used forms) gets one name-only pill
            const ids = hitsFirst(formIds.slice().sort((a, b) => a - b), (f) => shapeshiftIsHit(f));
            const entries = ids.flatMap((f) =>
                (d.shapeshiftDisplays.get(f) || [{displayId: 0, fid: 0}])
                    .map((e) => ({formId: f, displayId: e.displayId, fid: e.fid})));
            const formMask = (f) => maskOf(d.shapeshiftTargets, spellId, [f]);
            const t = targetSplit(formIds.map(formMask));
            cats.push({
                name: "shapeshift",
                hit: formIds.some((f) => shapeshiftIsHit(f)),
                mask: t.head,
                items: entries.map((e) => () => shapeshiftTag(e, t.pill(formMask(e.formId)))),
            });
        }
        if (morphIds.length) {
            // one pill per (creature, display); creatures without TDB displays
            // still get a single fallback pill
            const ids = hitsFirst(morphIds.slice().sort((a, b) => a - b), (c) => morphIsHit(c));
            const entries = ids.flatMap((c) =>
                (d.morphDisplays.get(c) || [{displayId: 0, fid: 0}])
                    .map((e) => ({creatureId: c, displayId: e.displayId, fid: e.fid})));
            // who the morph lands on — the target for polymorph, the caster for
            // self-transforms (ImplicitTarget, pack format 25)
            const morphMask = (c) => maskOf(d.morphTargets, spellId, [c]);
            const t = targetSplit(morphIds.map(morphMask));
            cats.push({
                name: "morph",
                hit: morphIds.some((c) => morphIsHit(c)),
                mask: t.head,
                items: entries.map((e) => () => morphTag(e, t.pill(morphMask(e.creatureId)))),
            });
        }
        if (summonEntries.length) {
            // one pill per (creature, control) pair; ImplicitTarget icon shows where
            // the summon lands (usually a ground point → area)
            const summonMask = (e) => maskOf(d.summonTargets, spellId, [e.creatureId]);
            const entries = hitsFirst(
                summonEntries.slice().sort((a, b) => (a.creatureId - b.creatureId) || (a.control - b.control)),
                (e) => summonIsHit(e.creatureId, e.control));
            const t = targetSplit(summonEntries.map(summonMask));
            cats.push({
                name: "summon",
                hit: summonEntries.some((e) => summonIsHit(e.creatureId, e.control)),
                mask: t.head,
                items: entries.map((e) => () => summonTag(e, t.pill(summonMask(e)))),
            });
        }
        if (vehicleIds.length) {
            // one pill per SEAT, in SeatID order, labeled with its attachment
            // point — de-duped, because 38% of multi-seat vehicles put every seat
            // on the same attachment and would otherwise repeat one pill 8 times.
            // The mask now comes from the SET_VEHICLE_ID aura's ImplicitTarget (pack
            // format 25) — caster when the caster becomes the vehicle, target when a
            // unit is turned into one. It is per-vehicle, so every seat shares it and
            // the head carries the icon; only differing vehicles drop it to the pills.
            const d2 = state.data;
            const vehMask = (v) => maskOf(d2.vehicleTargets, spellId, [v]);
            const seatCount = vehicleIds.reduce(
                (n, v) => Math.max(n, (d2.vehicleSeats.get(v) || []).length), 0);
            const points = [...new Set(vehicleIds.flatMap((v) => d2.vehicleSeats.get(v) || []))];
            const t = targetSplit(vehicleIds.map(vehMask));
            const union = vehicleIds.reduce((m, v) => m | vehMask(v), 0);
            cats.push({
                name: "seat",
                hit: points.some((p) => vehicleIsHit(p, seatCount)),
                mask: t.head,
                items: hitsFirst(points, (p) => vehicleIsHit(p, seatCount))
                    .map((p) => () => vehicleTag(p, seatCount, t.pill(union))),
            });
        }
        // invisibility / detection channels. Counterpart count = the other side of
        // the same type; it drives the pill label AND the numeric hit test.
        for (const [side, pills, countMap] of /** @type {const} */ ([
            ["invis", invisPills, d.detectTypeSpells],
            ["detect", detectPills, d.invisTypeSpells]])) {
            if (!pills.length) continue;
            const countOf = (type) => (countMap.get(type) || []).length;
            const t = targetSplit(pills.map((e) => e.mask));
            cats.push({
                name: side,
                hit: pills.some((e) => channelIsHit(side, e.type)),
                mask: t.head,
                items: hitsFirst(pills, (e) => channelIsHit(side, e.type))
                    .map((e) => () => channelTag(side, e.type, countOf(e.type), t.pill(e.mask))),
            });
        }

        // keybound overrides: one pill per KEY the spell's aura overrides. Two
        // overrides on one spell can name the same key and differ only in the
        // replacement spell — which is not shown — so they would render as
        // duplicate pills; pills are keyed on what they actually display and their
        // masks union, the same de-duping vehicle seat attachments get.
        if (keybindIds.length) {
            const kbMask = (o) => maskOf(d.keybindTargets, spellId, [o]);
            /** @type {Map<string, {label: string, fn: string, ids: number[], mask: number}>} */
            const byLabel = new Map();
            for (const o of keybindIds) {
                const row = d.keybinds.get(o);
                if (!row) continue;
                const label = row.when ? `${row.fn} ${row.when}` : row.fn;
                const prev = byLabel.get(label);
                if (prev) {
                    prev.ids.push(o);
                    prev.mask |= kbMask(o);
                    continue;
                }
                byLabel.set(label, {label, fn: row.fn, ids: [o], mask: kbMask(o)});
            }
            const pills = [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
            const isHit = (p) => p.ids.some(keybindIsHit);
            const t = targetSplit(pills.map((p) => p.mask));
            cats.push({
                name: "keybind",
                hit: pills.some(isHit),
                mask: t.head,
                items: hitsFirst(pills, isHit)
                    .map((p) => () => keybindTag(p, t.pill(p.mask))),
            });
        }

        buildKitGroups(td, cats, {
            // the icon rides the category head, unioned over this spell's rows in
            // the category — only where the distribution isn't degenerate (a
            // category that is always the same type says nothing per pill)
            headerTag: (cat) => fxHeadTag(cat.name, cat.hit, cat.mask),
            itemsOf: (cat) => cat.items,
            itemTag: (make) => make(),
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

    /* A mechanic pill matches when any mech: group is satisfied by the names on
   * that ROW — effect, aura and implicit targets together. Row-level rather
   * than name-level, so mech:"school_damage unit_target_enemy" lights the one
   * effect that is both, not every row that has either. */
    function mechanicIsHit(row) {
        const d = state.data;
        const corpus = [
            d.effectNamesL.get(row.effect), d.auraNamesL.get(row.aura),
            d.implicitTargetNamesL.get(row.targetA), d.implicitTargetNamesL.get(row.targetB),
        ].filter(Boolean).join(" ");
        return groupsFor("mech").some((g) => g.tokens.every((t) => corpus.includes(t.text)));
    }

    /* Every fx pill lights up through ONE matcher — the pill-type registry's
   * (docs/js/pilltypes.js), which is the same one spellsByFx selects spells
   * with. Before, each of these was a hand-written twin of a scan loop in
   * search.js, with comments asking the next person to keep them in lockstep;
   * a pill can now only light up under a query that really selected it.
   *
   * Each name below is that matcher bound to one type, so the renderers read
   * as before and a typo'd type key fails loudly at load, not silently at
   * match time.
   * @param {string} key
   * @returns {(id?: any) => boolean}
   */
    function isHitOf(key) {
        const type = P.TYPES.get(key);
        if (!type) throw new Error(`unknown pill type "${key}"`);
        return (id) => groupsFor(type.field)
            .some((g) => P.idMatches(type, state.data, id, g.tokens));
    }

    const fxChainIsHit = isHitOf("fx:chain");
    const dissolveIsHit = isHitOf("fx:dissolve");
    const glowIsHit = isHitOf("fx:glow");
    const shadowyIsHit = isHitOf("fx:shadowy");
    const ghostMatIsHit = isHitOf("fx:ghostmat");
    const tintIsHit = isHitOf("fx:tint");
    const desatIsHit = isHitOf("fx:desaturate");
    const transpIsHit = isHitOf("fx:transparency");
    const freezeIsHit = isHitOf("fx:freeze");
    const camoIsHit = isHitOf("fx:camo");
    const screenIsHit = isHitOf("fx:screen");
    const shapeshiftIsHit = isHitOf("fx:shapeshift");
    const morphIsHit = isHitOf("fx:morph");
    const keybindIsHit = isHitOf("fx:keybind");
    /** Summons key on the (creature, control) pair the pill actually shows. */
    const summonPairIsHit = isHitOf("fx:summon");
    const summonIsHit = (creatureId, control) => summonPairIsHit(creatureId + ":" + control);
    /** Both sides of an invisibility channel key on the invisibility TYPE. */
    const invisIsHit = isHitOf("fx:invis"), detectIsHit = isHitOf("fx:detect");
    const channelIsHit = (side, type) => (side === "invis" ? invisIsHit : detectIsHit)(type);

    /* The one fx pill the registry cannot decide alone: a seat pill is ONE
   * attachment point, while the registry's corpus is per-VEHICLE (every seat
   * name it has). Matching by vehicle would light every point of a vehicle
   * when the query names one of them. The seat count still comes from the
   * registry's numeric axis, so the two halves cannot disagree about it. */
    function vehicleIsHit(attachment, seats) {
        const nameL = (attachment || "").toLowerCase();
        return groupsFor("fx").some((g) => g.tokens.every((t) =>
            "seat".includes(t.text) || nameL.includes(t.text)
            || Search.matchNumeric(t.text, seats)));
    }

    /* --- target-type icons ------------------------------------------------
   *
   * Who a piece of content plays on, from SpellVisualEvent.TargetType (see
   * TARGET_BITS in build_data.py). The bit vocabulary and the glyphs live in
   * pills.js (P.targets(mask) is the segment); only the two things that need
   * the loaded pack — the export words and the group-mask union — are here.
   */
    const {
        TARGET_CASTER, TARGET_TARGET, TARGET_AREA,
        TARGET_NOT_CASTER, TARGET_MISSILE_DEST
    } = P;

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

    function modelCatHeadTag(category, hit) {
        return P.pill({
            cls: "model-head", hit, segments: [
                P.label(category, {
                    title: P.hintFor("model", category),
                    search: P.query("model", category),
                    finds: `all spells with a ${category} model`,
                }),
            ]
        });
    }

    // model pills can be hit through their usage-category word too —
    // model:"attached backpack01" lights that attached pill (and its group
    // head, via the group hit). Mirrors spellsByModel's token test.
    function modelFileIsHit(file, catName) {
        const searchL = file ? file.searchL : "";
        return groupsFor("model").some((g) =>
            g.tokens.every((t) => catName.includes(t.text) || searchL.includes(t.text)));
    }

    /**
     * Where on the model a row plays, as a clickable pill segment.
     *
     * Two shapes, and they must not be confused. Attached models are a
     * SINGLE-point route — `dst` is unused by construction — and render the
     * bare point ("Chest"). Missiles and beams genuinely span two points and
     * render "Source → Dest"; when only one end is known they say "from X" /
     * "to Y" rather than leaving an arrow pointing at nothing. `twoPoint` is
     * what tells them apart, since "src set, dst unset" looks identical in the
     * data either way.
     *
     * These are raw M2 attachment slots, so the names are the game's own and
     * can read oddly — the tooltip says as much. Returns null when nothing is
     * set, the common case (34% of model rows on 9.2.7).
     * @param {number} src
     * @param {number} dst
     * @param {string} field the search field to emit ("model" / "fx")
     * @param {boolean} twoPoint true for routes that travel (missiles, beams)
     * @returns {HTMLElement|null}
     */
    /* Model categories whose rows TRAVEL between two attachment points, rather
   * than sitting at one. Only missiles do today; if another travelling route
   * is ever added, naming it here is the whole change. Matched by category
   * word so it survives the numeric ids shifting. */
    const TRAVELLING_MODEL_CATS = new Set(["missile"]);

    const travels = (cat) =>
        TRAVELLING_MODEL_CATS.has((state.data.modelCatNames || {})[cat] || "");

    /* The one model category resolved from a CreatureDisplayID rather than a
   * FileDataID: its pills carry the displayId and render morph-style (Wowhead
   * model viewer, copy displayId, .morph, .lo) instead of the plain model
   * treatment. Matched by category word so it survives the numeric id shifting,
   * same rule as TRAVELLING_MODEL_CATS. */
    const MODEL_CAT_DISPLAY_WORD = "display";
    // the category resolved from an Item::ID (SpellVisualEffectName Type 1): its
    // pills render item-style (Wowhead item page, item icon, quality-coloured
    // name, .add / .lo) instead of the plain model treatment. Same match-by-word
    // rule as the display category.
    const MODEL_CAT_ITEM_WORD = "item";

    const isDisplayCat = (cat) =>
        ((state.data.modelCatNames || {})[cat] || "") === MODEL_CAT_DISPLAY_WORD;
    const isItemCat = (cat) =>
        ((state.data.modelCatNames || {})[cat] || "") === MODEL_CAT_ITEM_WORD;

    function attachSegment(src, dst, field, twoPoint) {
        const d = state.data;
        const nameOf = (a) => (a >= 0 ? (d.attachmentNames[a] || "") : "");
        const s = nameOf(src);
        const t = twoPoint ? nameOf(dst) : "";
        if (!s && !t) return null;
        let label, why;
        if (s && t) {
            label = `${s} → ${t}`;
            why = `Travels from the ${s} attachment point to the ${t} one`;
        } else if (!twoPoint) {
            label = s;
            why = `Plays at the ${s} attachment point`;
        } else {
            label = s ? `from ${s}` : `to ${t}`;
            why = s ? `Launches from the ${s} attachment point`
                : `Lands on the ${t} attachment point`;
        }
        const words = [s, t].filter(Boolean);
        // each point is an `attach <point>` pair; always quoted (the space)
        return P.note(label, {
            hit: attachIsHit(field, words),
            title: `${why} — an M2 attachment slot, not a description`,
            search: P.quoted(field, words.map((w) => `attach ${w}`).join(" ")),
            finds: `spells using ${words.length > 1 ? "these points" : "this point"}`,
        });
    }

    /** The attachment points named by a group's `attach <point>` pairs. */
    function attachValues(tokens) {
        const out = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].text === "attach" && tokens[i + 1]) {
                out.push(tokens[i + 1].text);
                i++;
            }
        }
        return out;
    }

    // an attachment segment lights when a positive attach query in its field
    // (or free text) names points this row carries — the same substring test
    // the search uses (ATTACH_WORD in search.js)
    function attachIsHit(field, names) {
        const attachL = names.join(" ").toLowerCase();
        return groupsFor(field).some((g) => {
            const attaches = attachValues(g.tokens);
            return attaches.length && attaches.every((a) => attachL.includes(a));
        });
    }

    function modelTag(fid, catName, mask = 0, src = -1, dst = -1, twoPoint = false) {
        const d = state.data;
        const file = d.files.get(fid) || {fid, path: "", base: "", searchL: ""};
        // A negative fid is a fileless SENTINEL (SYNTHETIC_MODEL_FILES in
        // build_data): a weapon the caster already has, which has no fixed model in
        // the data — the pack ships the slot name ("equipped off hand") as the
        // file path, so the pill labels and searches itself through the ordinary
        // filename route. It keeps its category (attached vs thrown missile),
        // attachment point and target icon, and drops only what needs a real file:
        // the 3D preview and the .lookup command.
        const synthetic = fid < 0;
        // the sentinel's synthetic path IS its label, so both cases read it the
        // same way — only the tooltip differs (a slot name has no fid to report)
        const labelText = file.base ? stripExt(file.base) : `file #${fid}`;
        return P.pill({
            cls: "model" + (synthetic ? " synthetic" : ""),
            // with "" for the category (the stale-pack flat list) this reduces to
            // the plain fileIsHit test
            hit: modelFileIsHit(file, catName || ""),
            title: file.path || "(name unknown)",
            segments: [
                !synthetic && CFG.modelViewerUrl && P.view(
                    fillTemplate(CFG.modelViewerUrl, {fid}),
                    `Preview ${file.base || `file #${fid}`} in the WoW.tools model viewer (new tab)`),
                P.targets(mask),
                P.label(labelText, {
                    title: synthetic
                        ? "No fixed model — the game fills this in from the caster's own gear at"
                        + " cast time (SpellVisualEffectName Type 3–10)"
                        : file.path || "(name unknown)",
                    detail: [!synthetic && `FileDataID ${fid}`],
                    search: file.base ? P.quoted("model", file.base) : "",
                    finds: "spells using this model",
                }),
                attachSegment(src, dst, "model", twoPoint),
                // fileless sentinels have no fid to look up / copy — the marker is the pill
                !synthetic && P.cmd(".lo", CFG.modelCopyTemplate,
                    {base: stripExt(file.base), file: file.base, path: file.path, fid}),
            ],
        });
    }

    /* Display pill (MODELS column): a model reached through a CreatureDisplayID
   * (SpellVisualEffectName Type 2) rather than a raw file. Sits in the Models
   * column but wears the morph pill's buttons — the Wowhead model viewer opens
   * the creature skin composited, and .morph / display-id copies are what you
   * actually want for a creature. It still carries its attachment point like
   * any other attached model. Label is the model's base filename (no TDB
   * needed); the displayId drives the buttons. */
    function displayTag(e) {
        const d = state.data;
        const {fid, ref: displayId, targets: mask} = e;
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "model",
            hit: modelFileIsHit(d.files.get(fid), MODEL_CAT_DISPLAY_WORD),
            segments: [
                displayId && CFG.wowheadMorphUrl && P.link(
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId}),
                    `View DisplayID ${displayId} in Wowhead's model viewer`),
                P.targets(mask),
                P.label(base || `display #${displayId}`, {
                    title: file.path || "(model name unknown)",
                    detail: [`DisplayID ${displayId}`],
                    search: base ? P.quoted("model", file.base) : "",
                    finds: "spells using this model",
                }),
                // single-point route (dst unused), like an ordinary attached model
                attachSegment(e.src, e.dst, "model", false),
                displayId && [
                    P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                    P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
                ],
                file.base && P.cmd(".lo", CFG.morphLookupTemplate, {id: displayId, file: file.base}),
            ],
        });
    }

    /* Item pill (MODELS column): a model reached through an Item::ID
   * (SpellVisualEffectName Type 1). Two shapes share one renderer, differing
   * only by whether the item has a NAME:
   *   named    ( [wh] | {target}{icon}{ItemName} | attach | [copy] | [.add] | [.lo] )
   *   nameless ( [3d] | {target}{icon}{fileName} | attach | [.lo] )
   * The item icon always sits directly against the label. A named item's Wowhead
   * item page (opened on its model view) carries the tooltip, mirrored onto the
   * icon and the label via data-wowhead so hovering either raises it while the
   * label keeps its click-to-search. A nameless item has no item page and no
   * item id worth copying, so it drops [wh], [copy] and [.add] and takes the 3D
   * cube instead; .lookup item then falls back to the model's base filename. */
    function itemTag(e) {
        const d = state.data;
        const {fid, ref: itemId, targets: mask} = e;
        const info = d.items.get(itemId) || {name: "", quality: "", icon: ""};
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const named = !!info.name;
        const base = file.base ? stripExt(file.base) : "";
        // .lookup item accepts the item name OR the model base name (no extension)
        const lookupName = info.name || base;

        const itemHref = named && CFG.wowheadItemUrl
            ? wowheadUrl(CFG.wowheadItemUrl, {id: itemId}) : "";
        return P.pill({
            cls: "model item" + (info.quality ? ` q-${info.quality}` : ""),
            hit: itemIsHit(e),
            segments: [
                // leading action: Wowhead item page for named, 3D model viewer for nameless
                itemHref && P.link(itemHref, `Open ${info.name} on Wowhead`),
                !named && CFG.modelViewerUrl && fid && P.view(
                    fillTemplate(CFG.modelViewerUrl, {fid}),
                    `Preview ${base || `file #${fid}`} in the WoW.tools model viewer (new tab)`),
                P.targets(mask),
                // icon, then label, with nothing between them so they read as one unit.
                // On a named item the icon is a Wowhead item link, the same mechanism the
                // name link / [wh] button use — that anchor+href is what the app's tooltips
                // ride on (data-wowhead alone is unproven here), so hovering the icon raises
                // the same tooltip and clicking it opens the item. Nameless items have no
                // item page, so their icon is a plain img.
                info.icon && P.icon(fillTemplate(CFG.spellIconUrl, {icon: info.icon}), {
                    href: itemHref || undefined,
                    title: itemHref ? `Open ${info.name} on Wowhead` : undefined,
                    data: itemHref ? {wowhead: `item=${itemId}`} : undefined,
                }),
                P.label(named ? info.name : base || `item #${itemId}`, {
                    title: named ? `${info.name} (item ${itemId})`
                        : file.path || "(model name unknown)",
                    detail: [!named && `Item ${itemId} (no name)`],
                    // named items search the item corpus (name/quality); nameless by filename
                    search: named ? P.catQuery("model", MODEL_CAT_ITEM_WORD, info.name)
                        : (base ? P.quoted("model", file.base) : ""),
                    finds: named ? "spells using this item" : "spells using this model",
                    data: named ? {wowhead: `item=${itemId}`} : undefined, // tooltip on the name too
                }),
                attachSegment(e.src, e.dst, "model", false),
                named && [
                    P.copy("⧉", `Copy item ID: ${itemId}`, String(itemId)),
                    P.cmd(".add", CFG.itemAddTemplate, {id: itemId}),
                ],
                lookupName && P.cmd(".lo", CFG.itemLookupTemplate, {id: itemId, name: lookupName}),
            ],
        });
    }

    // an item pill lights when a positive model chip is satisfied by the item's
    // corpus (name / quality / id / the category word "item") OR its model file —
    // the same shape as modelFileIsHit, with the item corpus folded in so
    // model:"item sickle axe" matches on the NAME, not just the filename.
    function itemIsHit(e) {
        const d = state.data;
        const searchL = (d.files.get(e.fid) || {searchL: ""}).searchL;
        const corpus = d.itemSearchL.get(e.ref) || "";
        return groupsFor("model").some((g) => g.tokens.every((t) =>
            MODEL_CAT_ITEM_WORD.includes(t.text) || searchL.includes(t.text) || corpus.includes(t.text)));
    }

    function soundTag(fid) {
        const d = state.data;
        const file = d.files.get(fid) || {fid, path: "", base: "", searchL: ""};
        return P.pill({
            cls: "sound",
            hit: fileIsHit(file, "sound"),
            title: file.path || "(name unknown)",
            segments: [
                CFG.soundPlayUrl && P.play(
                    fillTemplate(CFG.soundPlayUrl, {
                        fid,
                        bucket: fid % 256,
                        base: encodeURIComponent(stripExt(file.base) || String(fid)),
                    }),
                    `Play ${file.base || `file #${fid}`} (streamed from Wowhead)`),
                // sound extensions stay visible (.ogg/.mp3 differ, unlike models)
                P.label(file.base || `file #${fid}`, {
                    title: file.path || "(name unknown)",
                    detail: [`FileDataID ${fid}`],
                    search: file.base ? P.quoted("sound", file.base) : "",
                    finds: "spells using this sound",
                }),
                P.copy("⧉", `Copy FileDataID ${fid}`, String(fid)),
            ],
        });
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
        nowPlaying = {audio, btn};
        setPlayGlyph(btn, "◌");

        const isCurrent = () => nowPlaying && nowPlaying.audio === audio;
        audio.addEventListener("playing", () => {
            if (isCurrent()) setPlayGlyph(btn, "■");
        });
        audio.addEventListener("ended", () => {
            if (isCurrent()) stopSound();
        });
        audio.addEventListener("error", () => {
            if (!isCurrent()) return;
            nowPlaying = null;
            setPlayGlyph(btn, "✕");
            btn.title = "This sound is unavailable on Wowhead's CDN";
            setTimeout(() => {
                if (btn.textContent === "✕") setPlayGlyph(btn, "▶");
            }, 1500);
        });
        audio.play().catch(() => {
        }); // failures surface via the error listener
    }

    function kitTag(kitId, field, mask = 0) {
        const sound = field === "soundkit";
        const kind = sound ? "SoundKit" : "AnimKit";
        return P.pill({
            cls: field,
            hit: kitIsHit(kitId, field),
            segments: [
                P.targets(mask),
                P.label(String(kitId), {
                    title: `${kind} ${kitId}`,
                    search: P.query(sound ? "sound" : "anim", kitId),
                    finds: `spells using this ${field}`,
                }),
                P.copy("⧉", `Copy ${kind} ID ${kitId}`, String(kitId)),
                P.cmd(sound ? "/" : ".mod",
                    sound ? CFG.soundKitCopyTemplate : CFG.animKitCopyTemplate, {id: kitId}),
                sound && P.link(wowheadUrl(CFG.wowheadSoundUrl, {id: kitId}),
                    `SoundKit ${kitId} on Wowhead`),
            ],
        });
    }

    function animTag(animId, groupWord = "", mask = 0) {
        const d = state.data;
        const name = d.animNames[animId];
        return P.pill({
            cls: "anim",
            hit: animIsHit(animId, groupWord),
            segments: [
                P.targets(mask),
                P.label(name, {
                    title: `Animation ${animId}: ${name}`,
                    search: P.quoted("anim", name),
                    finds: "spells playing this animation",
                }),
                P.cmd(".lo", CFG.animCopyTemplate, {name, id: animId}),
            ],
        });
    }

    /* One Mechanics pill = one SpellEffect. The SPECIFIC thing the effect does
   * leads the pill; the effect that carries it trails as a qualifier —
   *
   *   ( 👤 SCHOOL_DAMAGE )               a plain effect
   *   ( 👤 PERIODIC_DAMAGE | APPLY_AURA )  an aura-applying effect
   *
   * so the aura name — the part that actually says what the spell does — is
   * the headline, and the near-universal APPLY_AURA reads as the boilerplate
   * it is. Both segments search their own name.
   *
   * WHO it lands on is shown ONLY as the caster/target/area icons every other
   * column uses (user's call, 2026-07-23): the enum names are long, would
   * dominate the pill and repeat down the column. The exact implicit targets
   * stay in the tooltip and stay searchable through mech: — the icons cannot
   * tell UNIT_TARGET_ENEMY from UNIT_TARGET_ALLY, so the words still earn
   * their place in the corpus.
   * @param {MechanicPill} pill
   */
    function mechanicTag(pill) {
        const d = state.data;
        const effectName = pill.effect
            ? (d.effectNames.get(pill.effect) || `EFFECT_${pill.effect}`) : "";
        const auraName = pill.aura ? (d.auraNames.get(pill.aura) || `AURA_${pill.aura}`) : "";
        // Each row contributes its own targets, and a row setting both is one
        // rule with two anchors (SRC_CASTER + UNIT_SRC_AREA_ENEMY = "enemies
        // around me") — so rows join with "or", the pair inside a row with "+".
        const aims = pill.rows
            .map((r) => [r.targetA, r.targetB].filter(Boolean)
                .map((t) => `TARGET_${d.implicitTargetNames.get(t) || t}`).join(" + "))
            .filter(Boolean);
        const aimedAt = aims.length ? `Aimed at ${[...new Set(aims)].join(" or ")}` : "";

        /** Both segments carry the same shape; only which kind leads differs. */
        const seg = (make, text, title) => make(text, {
            title, detail: [aimedAt],
            search: P.quoted("mech", text),
            finds: "spells with this mechanic",
        });
        return P.pill({
            cls: "mechanic" + (pill.aura ? " aura" : ""),
            hit: pill.rows.some(mechanicIsHit),
            segments: [
                P.targets(pill.mask),
                // the aura leads when there is one, else the effect does
                auraName && seg(P.label, auraName, `Aura ${pill.aura}: SPELL_AURA_${auraName}`),
                effectName && seg(auraName ? P.note : P.label, effectName,
                    `Spell effect ${pill.effect}: SPELL_EFFECT_${effectName}`),
            ],
        });
    }

    /* Collapse a spell's mechanic rows to what the pills actually render.
   * Rows differing only in their implicit target now look identical (the
   * target is icons-only), so Soulstone's two DUMMY effects — one aimed at
   * CORPSE_TARGET_ALLY, one at UNIT_TARGET_ALLY, both "on the target" — would
   * come out as two indistinguishable pills. Key on (effect, aura, icon mask)
   * and keep every merged row: the rows drive the tooltip's target list and
   * the hit test, so nothing is lost, it just stops repeating itself.
   * @param {MechanicRow[]} rows
   * @returns {MechanicPill[]}
   */
    function mechanicPills(rows) {
        /** @type {Map<string, MechanicPill>} */
        const byLook = new Map();
        for (const r of rows) {
            const key = `${r.effect}:${r.aura}:${r.mask}`;
            const prev = byLook.get(key);
            if (prev) {
                prev.rows.push(r);
                continue;
            }
            byLook.set(key, {effect: r.effect, aura: r.aura, mask: r.mask, rows: [r]});
        }
        return [...byLook.values()];
    }

    /* Visual FX tags: the category head ("chain") and one pill per texture,
   * with a dot showing the chain's tint (hidden when untinted). Clicking
   * the head searches the whole category (fx:chain). */

    function fxHeadTag(category, hit, mask = 0) {
        return P.pill({
            cls: "fx-head", hit, segments: [
                P.targets(mask),
                P.label(category, {
                    title: P.hintFor("fx", category),
                    search: P.query("fx", category),
                    finds: `all spells with a ${category} effect`,
                }),
            ]
        });
    }

    /**
     * One chain (beam) pill: optional tint swatch + texture name.
     * @param {{chainId: number, fid: number, color: number, src?: number, dst?: number}} entry
     * @returns {HTMLElement}
     */
    function fxTag(entry, mask = 0) {
        const d = state.data;
        const file = entry.fid ? (d.files.get(entry.fid) || {path: "", base: ""}) : {path: "", base: ""};
        const info = d.fxChains.get(entry.chainId) || {color: 0xffffff, hue: ""};
        const tinted = entry.color !== 0xffffff;
        const hex = hexColor(entry.color);
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "fx",
            hit: fxChainIsHit(entry.chainId),
            segments: [
                P.targets(mask),
                tinted && P.swatch(hex, {
                    title: `Tint ${hex}` + (info.hue ? ` (${info.hue})` : ""),
                    info: "chain tint",
                }),
                P.label(base || "(untextured)", {
                    title: file.path || "(no texture)",
                    // category word + texture: the query stays scoped to chains once more
                    // fx categories exist ("fx:chain lightning" style)
                    search: file.base ? P.catQuery("fx", "chain", file.base) : "",
                    finds: "spells with this chain texture",
                    // the hover preview multiplies the texture by the chain's tint
                    data: entry.fid
                        ? {texFid: entry.fid, texTint: tinted ? hex : undefined}
                        : undefined,
                }),
                // a beam attaches at both ends — caster's hand to the target's chest
                attachSegment(entry.src ?? -1, entry.dst ?? -1, "fx", true),
                base && P.copy("⧉", `Copy texture name: ${base}`, base),
            ],
        });
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
        const colorData = {
            color: hex, colorInfo: category, alpha: alpha >= 0 ? alpha : undefined,
        };
        return P.pill({
            cls: "fx",
            hit,
            segments: [
                P.targets(mask),
                P.swatch(hex, {info: category, alpha}),
                P.label(hex, {
                    title: P.hintFor("fx", category),
                    detail: [`Color ${hex}`],
                    search: P.catQuery("fx", category, hex),
                    finds: `spells with this ${category} color`,
                    // the hex text is the color too — hovering it shows the same big patch
                    data: colorData,
                }),
                P.copy("⧉", `Copy color: ${hex}`, hex),
            ],
        });
    }

    /* Percent-only fx pill (desaturate / transparency): the strength is the
   * whole payload. Desaturate gets a decorative grey swatch keyed to the
   * strength; transparency has no swatch. Clicking searches category + %. */
    function percentFxTag(category, percent, hit) {
        const grey = Math.round(255 * (1 - percent / 200)); // 100% -> mid grey
        // .flat: as a compact pill this renders (label | value) — a flat divider
        // instead of the rounded value capsule other compact groups get
        return P.pill({
            cls: "fx flat",
            hit,
            segments: [
                category === "desaturate" && P.swatch(`rgb(${grey}, ${grey}, ${grey})`),
                P.label(`${percent}%`, {
                    title: P.hintFor("fx", category),
                    detail: [`${percent}%`],
                    search: P.catQuery("fx", category, `${percent}%`),
                    finds: `spells with this ${category} strength`,
                }),
            ],
        });
    }

    /* Vehicle seat pill: one per seat of the vehicle the aura turns the caster
   * into, labeled with the M2 attachment point that seat sits at. The names
   * are the game's own and read oddly as seat positions ("Breath",
   * "ChestBloodBack") because artists reuse generic attachment slots as seat
   * anchors — the tooltip says so, since otherwise it reads as a bug. The
   * Vehicle.db2 id says nothing to a user, so it is neither shown nor
   * copyable. Clicking finds every spell with a seat at the same point. */
    function vehicleTag(attachment, seats, mask = 0) {
        const label = attachment || "seat";
        return P.pill({
            cls: "fx",
            hit: vehicleIsHit(attachment, seats),
            segments: [
                P.targets(mask),
                P.label(label, {
                    title: P.hintFor("fx", "seat"),
                    detail: [`Seat at the ${label} attachment point`,
                        "(an M2 attachment slot, not a description of the seat)"],
                    search: P.catQuery("fx", "seat", label),
                    finds: "spells with a seat there",
                }),
            ],
        });
    }

    /* Invisibility-channel pill (MOD_INVISIBILITY[_DETECT]). One per invisibility
   * TYPE the spell touches; the type is the pairing key, so the pill navigates
   * to the OTHER side of that channel — an invis pill searches fx:detect <type>
   * (the spells that reveal it), a detect pill searches fx:invis <type> (the
   * ones it reveals). The counterpart count rides the label. An invisibility
   * nothing detects (count 0) is the priceless case: it still shows — that is
   * the whole point — but it is highlighted and non-clickable, since there is
   * nothing to navigate to. Detect pills never reach 0 (channels without an
   * invis side are not built). */
    function channelTag(side, type, count, mask = 0) {
        const invis = side === "invis";
        const priceless = invis && count === 0;
        const verb = invis ? (priceless ? "unseen" : `seen by ${count}`) : `reveals ${count}`;
        const other = invis ? "detect" : "invis";
        const plural = count === 1 ? "" : "s";
        // a priceless channel has no counterpart to navigate to, so it drops the
        // action entirely — both segments render inert (no search, no click line)
        const nav = priceless ? {} : {
            search: P.catQuery("fx", other, type),
            click: `show the ${count} counterpart${plural} (fx:${other} ${type})`,
        };
        const detail = [`${invis ? "Invisibility" : "Detection"} channel ${type}`,
            invis
                ? (priceless ? "Nothing detects this — nothing can reveal it (priceless)"
                    : `Detected by ${count} spell${plural}`)
                : `Reveals ${count} invisibility spell${plural}`];
        // two divider-separated segments — (id | count), mirroring the model pill's
        // (name | attach) grammar. Both carry the same navigation.
        // .flat: one per spell (SpellEffect aura) — render (label | id | count)
        // with flat dividers, not the rounded group capsule.
        return P.pill({
            cls: "fx flat" + (priceless ? " priceless" : ""),
            hit: channelIsHit(side, type),
            segments: [
                P.targets(mask),
                P.label(String(type), {detail, ...nav}),
                P.note(verb, {detail, ...nav}),
            ],
        });
    }

    /* Keybound-override pill (aura 406): while the aura holds, this key stops
   * working. One segment — the key, plus the timing word when it only applies
   * airborne:
   *
   *   ( JUMP )        ( JUMP mid-air )        ( TOGGLEWORLDMAP )
   *
   * The retail client casts a replacement spell (SpellKeyboundOverride.Data),
   * and the pack carries it — but Epsilon does NOT cast it, it only disables
   * the key, so naming the spell here would promise something users cannot
   * get. Deliberate omission, not an oversight (user's call, 2026-07-23).
   *
   * The timing word rides the key segment rather than taking its own: it says
   * WHEN that same key is overridden, so it reads as part of the key, and the
   * ordinary press stays bare so the common case is uncluttered.
   * @param {{label: string, fn: string, ids: number[]}} pill
   */
    function keybindTag(pill, mask = 0) {
        return P.pill({
            cls: "fx",
            hit: pill.ids.some(keybindIsHit),
            segments: [
                P.targets(mask),
                P.label(pill.label, {
                    title: `${pill.fn} is overridden while this aura holds`,
                    detail: ["On Epsilon the key is simply disabled"],
                    search: P.catQuery("fx", "keybind", pill.fn),
                    finds: "spells overriding this key",
                }),
            ],
        });
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
    function screenTag(screenId, mask = 0) {
        const d = state.data;
        const name = d.screenNames.get(screenId) || "";
        const colors = d.screenColors.get(screenId) || NO_SCREEN_COLORS;
        const texFids = d.screenTextures.get(screenId) || [];

        // only the fog color has an opacity byte; mul/add are pure grade factors
        const swatches = /** @type {[string, number, number][]} */ (
            [["fog tint", colors.fog, colors.fogAlpha],
                ["multiply", colors.mul, -1],
                ["addition", colors.add, -1]])
            .filter(([, c]) => c >= 0)
            .map(([what, c, a]) => P.swatch(hexColor(c), {
                title: `Screen ${what} ${hexColor(c)}`, info: `screen ${what}`, alpha: a,
            }));

        const texPaths = texFids.map((t) => ((d.files.get(t.fid) || {}).path || `#${t.fid}`)
            + (t.mask ? " (mask)" : ""));
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
        return P.pill({
            cls: "fx",
            hit: screenIsHit(screenId),
            segments: [
                P.targets(mask),
                swatches,
                P.label(name || `screen #${screenId}`, {
                    title: `${name || "(unnamed)"} — ScreenEffect ${screenId}`,
                    detail: texPaths,
                    // quotes inside a name would break the tag value; substring match
                    // doesn't need them (catQuery strips them)
                    search: P.catQuery("fx", "screen", name || screenId),
                    finds: "spells with this screen effect",
                    data: texFids.length ? {
                        texFid: texFids[0].fid,
                        texTint: colors.mul >= 0 ? hexColor(colors.mul) : undefined,
                    } : undefined,
                }),
            ],
        });
    }

    /* Dissolve pill: one per texture of the row's TextureBlendSet (mask +
   * material textures); tooltip carries the dissolve duration. */
    function dissolveTag(entry, mask = 0) {
        const d = state.data;
        const file = entry.fid ? (d.files.get(entry.fid) || {path: "", base: ""}) : {path: "", base: ""};
        const duration = d.dissolveDurations.get(entry.dissolveId) || 0;
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "fx",
            hit: dissolveIsHit(entry.dissolveId),
            segments: [
                P.targets(mask),
                P.label(base || "(untextured)", {
                    title: file.path || "(no texture)",
                    detail: [duration && `Duration ${duration}s`],
                    search: file.base ? P.catQuery("fx", "dissolve", file.base) : "",
                    finds: "spells with this dissolve texture",
                    data: entry.fid ? {texFid: entry.fid} : undefined,
                }),
                base && P.copy("⧉", `Copy texture name: ${base}`, base),
            ],
        });
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
    function shapeshiftTag(entry, mask = 0) {
        const d = state.data;
        const {formId, displayId, fid} = entry;
        const name = d.shapeshiftNames.get(formId) || "";
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "fx",
            hit: shapeshiftIsHit(formId),
            segments: [
                displayId && CFG.wowheadMorphUrl && P.link(
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId}),
                    `View DisplayID ${displayId} in Wowhead's model viewer`),
                P.targets(mask),
                P.label(base || name || `form #${formId}`, {
                    title: `${name || "(unnamed form)"} — SpellShapeshiftForm ${formId}`,
                    detail: [displayId ? `DisplayID ${displayId}`
                        : "(this form has no creature display)", file.path],
                    // search by the form NAME, which is stable and readable, unlike the model
                    search: P.catQuery("fx", "shapeshift", name || formId),
                    finds: "spells with this form",
                }),
                displayId && [
                    P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                    P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
                ],
                file.base && P.cmd(".lo", CFG.morphLookupTemplate, {id: displayId, file: file.base}),
            ],
        });
    }

    function morphTag(entry, mask = 0) {
        const d = state.data;
        const {creatureId, displayId, fid} = entry;
        const name = d.morphNames.get(creatureId) || "";
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "fx",
            hit: morphIsHit(creatureId),
            segments: [
                displayId && CFG.wowheadMorphUrl && P.link(
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId}),
                    `View DisplayID ${displayId} in Wowhead's model viewer`),
                P.targets(mask),
                P.label(base || (displayId ? `#${displayId}` : `creature #${creatureId}`), {
                    title: `${name || "(unknown creature)"} — creature ${creatureId}`,
                    detail: [displayId ? `DisplayID ${displayId}`
                        : "(no display known — creature not in TDB)",
                        file.path || "(model unknown)"],
                    search: P.catQuery("fx", "morph", base || creatureId),
                    finds: "spells with this morph",
                }),
                displayId && [
                    P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                    P.cmd(".morph", CFG.morphCopyTemplate, {id: displayId}),
                ],
                file.base && P.cmd(".lo", CFG.morphLookupTemplate, {id: displayId, file: file.base}),
            ],
        });
    }

    /* Summon pill: one per (creature, control). Label = the NPC name with the
   * SummonProperties control word dimmed beside it (uncontrolled summons
   * show no word) — the control word is its own button searching all
   * summons of that control type; ⧉ copies the creature ID, .lo / .npc the
   * ready-to-paste commands; the Wowhead icon on the left opens the NPC's
   * Wowhead page. Creatures missing from TDB show an inert "creature #id"
   * pill. */
    function summonTag(entry, mask = 0) {
        const d = state.data;
        const {creatureId, control} = entry;
        const name = d.summonNames.get(creatureId) || "";
        const ctrl = d.summonControlNames[control] || "";
        return P.pill({
            cls: "fx",
            hit: summonIsHit(creatureId, control),
            segments: [
                CFG.wowheadNpcUrl && P.link(wowheadUrl(CFG.wowheadNpcUrl, {id: creatureId}),
                    `Open NPC ${creatureId} on Wowhead`),
                P.targets(mask),
                P.label(name || `creature #${creatureId}`, {
                    title: `${name || "(unknown creature)"} — creature ${creatureId}`,
                    detail: [ctrl && `Control: ${ctrl}`],
                    search: P.catQuery("fx", "summon", name || creatureId),
                    finds: "spells summoning this creature",
                }),
                ctrl && P.aside(ctrl, {
                    title: `Control: ${ctrl}`,
                    search: P.catQuery("fx", "summon", ctrl),
                    finds: `all ${ctrl} summons`,
                }),
                P.copy("⧉", `Copy creature ID: ${creatureId}`, String(creatureId)),
                name && P.cmd(".lo", CFG.summonLookupTemplate, {name, id: creatureId}),
                P.cmd(".npc", CFG.summonSpawnTemplate, {id: creatureId, name}),
            ],
        });
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
            const url = fillTemplate(CFG.texturePreviewUrl, {fid, version: state.version.id});
            p = fetch(url)
                .then((r) => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.arrayBuffer();
                })
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
        window.addEventListener("scroll", hideTexPreview, {passive: true});
    }

    /* ------------------------------------------------------------ export */

    // Hidden columns are excluded from exports.
    function exportRows() {
        const d = state.data;
        const hc = state.hiddenCols;
        const pathOf = (fid) => (d.files.get(fid) || {}).path || `#${fid}`;
        return state.display.map((id) => {
            const i = d.spellIndex.get(id);
            const row = {id, name: d.names[i], subtext: d.subtexts[i]};
            if (!hc.models) {
                // grouped by usage category (soundKits-style shape); a stale pack
                // without categories exports the old flat path list
                const cats = d.spellModelCats.get(id);
                if (cats) {
                    const byCat = new Map();
                    for (const e of cats) {
                        if (!byCat.has(e.cat)) byCat.set(e.cat, []);
                        // each file carries who it plays on — the export's form of the icons
                        byCat.get(e.cat).push({path: pathOf(e.fid), targets: targetWordsOf(e.targets)});
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
            if (!hc.animations) {
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
                    const info = d.fxChains.get(c) || {color: 0xffffff, hue: ""};
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
                    const sh = d.shadowyColors.get(c) || {primary: 0, secondary: 0};
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
                    .map((p) => ({type: "desaturate", percent: p}))
                ).concat([...new Set(d.spellTransps.get(id) || [])].sort((a, b) => a - b)
                    .map((p) => ({type: "transparency", percent: p}))
                ).concat(d.spellFreezes.has(id) ? [{type: "freeze"}] : []
                ).concat(d.spellCamos.has(id) ? [{type: "camo"}] : []
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
                // one entry per effect, mirroring the pills — aura first, then the
                // effect carrying it. An export is read without tooltips or icons, so
                // unlike the pill it spells the implicit targets out:
                // "PERIODIC_DAMAGE / APPLY_AURA -> TARGET_UNIT_CASTER"
                row.mechanics = (d.spellMechanics.get(id) || []).map((m) => {
                    const does = [
                        m.aura ? (d.auraNames.get(m.aura) || `AURA_${m.aura}`) : "",
                        m.effect ? (d.effectNames.get(m.effect) || `EFFECT_${m.effect}`) : "",
                    ].filter(Boolean).join(" / ");
                    const at = [m.targetA, m.targetB].filter(Boolean)
                        .map((t) => `TARGET_${d.implicitTargetNames.get(t) || t}`).join(" + ");
                    return at ? `${does} -> ${at}` : does;
                });
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
        a.href = URL.createObjectURL(new Blob([content], {type: mime}));
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`Exported ${name}`);
    }

    function nothingToExport() {
        if (state.display.length === 0) {
            toast("Nothing to export — search first");
            return true;
        }
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
        if (!hc.animations) header.push("AnimKits", "Animations");
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
                    (k) => `${withTargets({path: k.id, targets: k.targets})}: ${k.files.join(" | ")}`)
                    .join("; ")));
            }
            if (!hc.animations) {
                cols.push(esc(r.animKits.map((k) => k.id).join("; ")));
                cols.push(esc((r.anims || []).map((a) => withTargets({path: a.name, targets: a.targets}))
                    .concat(r.animKits.map(
                        (k) => `${withTargets({path: k.id, targets: k.targets})}: ${k.anims.join(" | ")}`))
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
            th.setAttribute("aria-sort", active ? (state.sort.dir === 1 ? "ascending" : "descending") : "none");
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
        // the "Only spells with / without" filters shape the shared result list
        // just like the query does, so they ride in the URL too: only= lists the
        // "with" categories (unchanged for back-compat), without= the "without" ones
        const only = Object.keys(state.filters).filter((k) => state.filters[k] === "with");
        if (only.length) params.push("only=" + only.join(","));
        const without = Object.keys(state.filters).filter((k) => state.filters[k] === "without");
        if (without.length) params.push("without=" + without.join(","));
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
        return {v: get("v"), q, only: get("only"), without: get("without"), sort: get("sort")};
    }

    // set the "Only spells with / without" filters from the URL's only= (with)
    // and without= lists (a category in neither = any) and sync the buttons
    function filtersFromUrl(onlyStr, withoutStr) {
        const withSet = new Set((onlyStr || "").split(",").filter(Boolean));
        const withoutSet = new Set((withoutStr || "").split(",").filter(Boolean));
        for (const k of Object.keys(state.filters)) {
            state.filters[k] = withSet.has(k) ? "with" : withoutSet.has(k) ? "without" : "";
        }
        for (const btn of $$("#filters button.tri")) {
            const st = state.filters[btn.dataset.filter];
            btn.dataset.state = st;
            btn.setAttribute("aria-label", `${btn.textContent.trim()} filter: ${TRI_LABELS[st]}`);
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
        state.sort = known ? {key, dir: s.startsWith("-") ? -1 : 1} : {key: "auto", dir: 1};
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
        runSearch({push: true});
        window.scrollTo({top: 0});
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
                    activateField(field, {not: m[2] === "-"});
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
                    items.forEach((it, i) => {
                        const on = i === suggestIndex;
                        it.classList.toggle("selected", on);
                        it.setAttribute("aria-selected", String(on));
                    });
                    qInput.setAttribute("aria-activedescendant", items[suggestIndex].id);
                    return;
                }
                if (e.key === "Tab" || (e.key === "Enter" && suggestIndex >= 0)) {
                    e.preventDefault();
                    pickSuggestItem(items[Math.max(suggestIndex, 0)]);
                    return;
                }
                if (e.key === "Escape") {
                    hideSuggest();
                    return;
                }
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
                state.barSel = {anchor: 0, focus: atomCount()};
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
                if (e.key === "Escape") {
                    clearBarSel();
                    return;
                }
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
                runSearch({push: true});
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
        input.addEventListener("paste", () => {
            if (state.barSel) deleteBarSel();
        });
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
            if (focus === dragSel.anchor) {
                clearBarSel();
                return;
            }
            state.barSel = {anchor: dragSel.anchor, focus};
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
                input.focus({preventScroll: true});
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
            if (suppressBarClick) {
                suppressBarClick = false;
                return;
            }
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
            if (item) {
                e.preventDefault();
                pickSuggestItem(item);
            }
        });
        document.addEventListener("click", (e) => {
            if (!targetClosest(e, "#qbar") && !targetClosest(e, "#suggest")) hideSuggest();
        });

        // field buttons: "+ Label" includes, "−" (or shift-click) excludes
        $("#tabs").addEventListener("click", (e) => {
            const btn = targetClosest(e, "button[data-field]");
            if (btn) activateField(btn.dataset.field, {not: btn.dataset.not === "1" || e.shiftKey});
        });

        // results: copy buttons / cross-search / expanders (event delegation)
        $("#results").addEventListener("click", (e) => {
            const t = targetClosest(e, "button");
            if (!t) return;
            if (t.dataset.copy) copyText(t.dataset.copy, e.shiftKey);
            else if (t.dataset.play) toggleSound(t);
            else if (t.dataset.search) crossSearch((e.shiftKey ? "-" : "") + t.dataset.search);
            else if (t.dataset.expand) {
                // reveal this cell fully; the row grows to fit it and its siblings
                // re-clamp to the taller budget, revealing more of themselves
                const td = t.closest("td");
                td.dataset.expanded = "1";
                layoutRow(td.closest("tr"));
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

        // filters — tri-state, each click cycles any -> only with -> only without.
        // Part of the shareable state, so the URL follows (a push: Back undoes the
        // toggle like it undoes a search)
        /** @type {("" | "with" | "without")[]} */
        const TRI_STATES = ["", "with", "without"];
        for (const btn of $$("#filters button.tri")) {
            btn.addEventListener("click", () => {
                const key = btn.dataset.filter;
                const next = TRI_STATES[(TRI_STATES.indexOf(state.filters[key]) + 1) % TRI_STATES.length];
                state.filters[key] = next;
                btn.dataset.state = next;
                btn.setAttribute("aria-label", `${btn.textContent.trim()} filter: ${TRI_LABELS[next]}`);
                applyFiltersAndSort();
                stateToUrl(true);
            });
        }

        // column visibility
        for (const box of $$inputs("#columns input[type=checkbox]")) {
            box.addEventListener("change", () => {
                state.hiddenCols[box.dataset.col] = !box.checked;
                try {
                    localStorage.setItem("epsilook.hiddenCols.v4", JSON.stringify(state.hiddenCols));
                } catch (e) {
                }
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
                if (state.sort.key !== key) state.sort = {key, dir: first};
                else if (state.sort.dir === first) state.sort.dir = -first;
                else state.sort = {key: "auto", dir: 1};
                applyFiltersAndSort();
                stateToUrl(true); // shareable + Back undoes the sort, like the filters
            });
        }

        // help dialog (native <dialog>: Esc closes it for free)
        const help = /** @type {HTMLDialogElement} */ ($("#help"));
        $("#help-btn").addEventListener("click", () => help.showModal());
        $("#help-close").addEventListener("click", () => help.close());
        help.addEventListener("click", (e) => {
            if (e.target === help) return help.close(); // backdrop click
            // the worked examples are live: running one closes the dialog so the
            // results it just produced are actually visible
            const ex = targetClosest(e, ".help-ex button[data-search]");
            if (ex) {
                help.close();
                crossSearch(ex.dataset.search);
            }
        });

        // infinite scroll
        new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) renderMore();
        }, {rootMargin: "600px"}).observe($("#sentinel"));

        // resizing changes how pills wrap, so cell heights change — re-run the
        // height clamp on every rendered row (debounced). Expanded cells stay open.
        let resizeTimer = 0;
        window.addEventListener("resize", () => {
            clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(() => {
                for (const tr of $("#results tbody").children) layoutRow(/** @type {HTMLElement} */ (tr));
            }, 150);
        });

        // back/forward (pushState entries and legacy #q= entries both land here)
        window.addEventListener("popstate", () => applyUrl({push: false}));

        // version switch
        const versionSel = /** @type {HTMLSelectElement} */ ($("#version"));
        versionSel.addEventListener("change", async () => {
            const entry = state.versions.find((v) => v.id === versionSel.value);
            if (entry) await activateVersion(entry, {push: true});
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
    async function activateVersion(entry, {push = false} = {}) {
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
            runSearch({push});
        } catch (err) {
            console.error(err);
            loadText.textContent = "";
            loadError.textContent = `Failed to load spell data: ${err.message}`;
            loadError.hidden = false;
        }
    }

    function applyUrl({push}) {
        const h = urlToState();
        loadQueryString(h.q);
        filtersFromUrl(h.only, h.without);
        sortFromUrl(h.sort);
        // no v= in the URL means the default version, not "keep the current
        // one" — back/forward must return from an explicitly-chosen pack
        const wanted = findVersion(h.v) || defaultVersion();
        if (wanted && (!state.version || wanted.id !== state.version.id)) {
            // fire-and-forget: activateVersion reports its own load failures
            void activateVersion(wanted, {push});
        } else {
            runSearch({push});
        }
    }

    async function boot() {
        try {
            Object.assign(state.hiddenCols, JSON.parse(localStorage.getItem("epsilook.hiddenCols.v4") || "{}"));
        } catch (e) { /* corrupted storage — defaults apply */
        }
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
        filtersFromUrl(h.only, h.without);
        sortFromUrl(h.sort);
        await activateVersion(entry);
        if (autoExport === "json") exportJson();
        else if (autoExport === "csv") exportCsv();
        qInput.focus();
    }

    void boot(); // nothing to await it — boot renders its own load errors
})();
