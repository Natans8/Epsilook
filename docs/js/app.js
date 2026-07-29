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
    // .blp loading + the hover previews built on it
    const Texture = window.EpsilookTexture;
    // CSV/JSON/Discord output; given what it needs by initExport() at boot
    const Export = window.EpsilookExport;
    // the theme picker — owns everything under <html data-theme>
    const Theme = window.EpsilookTheme;

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
        // hidden columns — DISPLAY ONLY (they also trim the export's column set,
        // a visible choice). They never narrow the search: see FIELDS.all.
        // Mechanics ships VISIBLE (the storage key moved to v5 so the old
        // default does not linger for existing users).
        hiddenCols: {models: false, sounds: false, animations: false, fx: false, mechanics: false},
    };

    // column -> search fields it contributes
    const COL_FIELDS = {
        models: ["model"],
        sounds: ["sound"],
        animations: ["anim"],
        fx: ["fx"],
        mechanics: ["mech"],
    };

    // Fields whose column is currently off screen. DISPLAY ONLY — this never
    // reaches the search (see FIELDS.all in search.js); its one job is letting
    // ensureFieldVisible un-hide a column a shared link searches into.
    function hiddenFields() {
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

    // Leaf DOM/template helpers - see docs/js/util.js.
    const {$, $$, $$inputs, el, targetClosest, fillTemplate, hexColor} = window.EpsilookUtil;

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
            // Fallback for browsers without async navigator.clipboard — there is no
            // non-deprecated synchronous copy API.
            // noinspection JSDeprecatedSymbols
            document.execCommand("copy");
            done();
        } catch (e) {
            toast("Copy failed");
        }
        ta.remove();
        if (prev && prev !== document.body) prev.focus({preventScroll: true});
    }

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
    // one chip as query text. The rule lives in pills.js (P.tagQuery) because
    // pill queries are built there and the two must agree character for
    // character — a pill click that did not serialize like a typed chip would
    // not survive the URL.
    const tagStr = P.tagQuery;

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
        // `model:fire | frost` is ONE tag with two alternatives, so the bar's
        // air has to come out before the tag/free-text split runs — otherwise
        // `frost` lands outside the tag and means something else entirely.
        // (Inside a chip the tokenizer handles the same spacing; this is the
        // one thing it cannot see, because chip boundaries are decided here.)
        // Two exemptions: quoted spans, where a pipe is a literal character,
        // and a pipe before a REAL field tag — `a | model:b` is two search
        // terms with a stray bar, and joining would eat the tag.
        str = str.split(/("[^"]*"?)/).map((part, i) => (i % 2 ? part
            : part.replace(/\s*\|\s*/g, (m, off, s) => {
                const tag = /^-?([a-z]+):/i.exec(s.slice(off + m.length));
                return tag && isChipField(canonField(tag[1].toLowerCase())) ? m : "|";
            }))).join("");
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
            } else {
                const t = m[0].trim(); // unknown prefixes and quotes stay literal
                if (t && t !== '""') pushFree(t);
            }
        }
        return parts;
    }

    // put a parsed chip list in the bar, caret after the last one; syncBar
    // pulls the trailing free run back into the input
    function setChips(parts) {
        ensureFieldsVisible(parts);
        state.chips = parts;
        state.activeField = null;
        state.activeNot = false;
        qInput.value = "";
        state.pos = state.chips.length;
        syncBar();
    }

    // load a canonical string into the bar: field tags become committed chips
    function loadQueryString(str) {
        setChips(parseQueryParts(str));
    }

    // a numeric alternative, with the id sigil optional
    const NUM_ALT = /^#?\d+$/;

    /* The three shapes tokenSpans needs to recognise a comparison however it is
       spaced: an operator standing alone, the number that belongs to it, and a
       word with the whole comparison glued onto it. */
    const LONE_OP = /^(<=|>=|<|>|=)$/;
    const NUMBER = /^-?\d+(?:\.\d+)?$/;
    const GLUED_CMP = /^([a-z][a-z_]*)((?:<=|>=|<|>|=)-?\d+(?:\.\d+)?)$/;

    /**
     * A token's ALTERNATIVES — the values any one of which satisfies it.
     *
     * `|` always separates them: no corpus in any pack contains a pipe
     * (measured across names, model/sound paths, animations and fx on 9.2.7),
     * so it can never collide with real data.
     *
     * A COMMA separates them only when every piece is a number. Spell names
     * really do contain commas — 399 of them match "e," on 9.2.7 — so a
     * literal comma has to keep working, while `id:133,134` still reads as OR.
     * The rule is SYNTACTIC, not per-field: a comma between numbers means the
     * same thing in every chip, which is why this is not a return to
     * field-specific parsing.
     *
     * A "quoted phrase" is exempt — quoting is how you ask for the literal
     * character.
     * @param {string} text
     * @returns {string[]}
     */
    function altsOf(text) {
        if (text.includes("|")) {
            const parts = text.split("|").filter(Boolean);
            if (parts.length > 1) return parts;
        }
        if (text.includes(",")) {
            const parts = text.split(",").filter(Boolean);
            if (parts.length > 1 && parts.every((p) => NUM_ALT.test(p))) return parts;
        }
        return [text];
    }

    /**
     * THE tokenizer. One function, two readers: the search engine takes each
     * span's text and alternatives, the search bar's highlighting takes its
     * character offsets. Neither can disagree with the other about what a token
     * is — which is precisely how `fire | frost` once came to search correctly
     * and highlight as nothing at all.
     *
     * A span covers the EXACT characters it came from. Words split on
     * whitespace, except:
     *   - "quoted spans" stay whole — an exact phrase, spaces and word order
     *     preserved. An unclosed quote runs to the end (a phrase matches while
     *     it is still being typed).
     *   - an ALTERNATION is one span however it is spaced. `fire|frost`,
     *     `fire | frost` and `fire |frost` are the same token, so the operator
     *     means the same thing whether or not you put air around it.
     *   - a COMPARISON is one span however it is spaced, and never glued to the
     *     word in front of it: `seat >2`, `seat > 2` and `seat>2` all tokenize
     *     to `seat` + `>2`. Spacing is the last thing anyone should have to
     *     remember about a number, and doing it here means the engine, the
     *     capsule and the autocomplete all get it at once.
     * @param {string} text
     * @returns {{start: number, end: number, text: string, quoted: boolean, alts: string[]}[]}
     */
    function tokenSpans(text) {
        const lower = text.toLowerCase();
        /** @type {{start: number, end: number, text: string, quoted: boolean}[]} */
        const spans = [];
        for (const m of lower.matchAll(/"([^"]*)(?:"|$)|([^\s"]+)/g)) {
            const quoted = m[1] !== undefined;
            const raw = quoted ? m[1] : m[2];
            const prev = spans[spans.length - 1];
            // a bar touching either side joins the two words into one token
            if (prev && !prev.quoted && !quoted
                && (prev.text.endsWith("|") || raw.startsWith("|"))) {
                prev.text += raw;
                prev.end = m.index + m[0].length;
                continue;
            }
            // a lone operator adopts the number after it (`> 2` -> `>2`). Only a
            // LONE one: `c'thun -> phase 2` must keep its arrow, and 265 spell
            // names on 9.2.7 carry one of these characters as ordinary text.
            if (prev && !prev.quoted && !quoted
                && LONE_OP.test(prev.text) && NUMBER.test(raw)) {
                prev.text += raw;
                prev.end = m.index + m[0].length;
                continue;
            }
            spans.push({start: m.index, end: m.index + m[0].length, text: raw, quoted});
        }
        const out = [];
        for (const s of spans) {
            const t = s.text.replace(/\s+/g, " ").trim();
            // a token of nothing but separators is punctuation left over from a
            // half-written alternation; it can never match, so it must not
            // narrow the search to nothing either
            if (!t || (!s.quoted && /^[|,]+$/.test(t))) continue;
            // a glued `word>2` is the same two tokens, split back apart. Safe to
            // do blind: nothing in any pack's corpus has this shape (checked
            // across names, paths, animations and effect names on 9.2.7).
            const glued = !s.quoted && s.end - s.start === t.length && GLUED_CMP.exec(t);
            if (glued) {
                const cut = s.start + glued[1].length;
                out.push({start: s.start, end: cut, text: glued[1], quoted: false, alts: [glued[1]]});
                out.push({start: cut, end: s.end, text: glued[2], quoted: false, alts: [glued[2]]});
                continue;
            }
            out.push({...s, text: t, alts: s.quoted ? [t] : altsOf(t)});
        }
        return out;
    }

    /** The engine's view of a chip: just the text and the alternatives. */
    function tokenizeQuery(text) {
        return tokenSpans(text).map((s) => ({text: s.text, alts: s.alts}));
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
        // the highlight backdrop copies the box this just settled, so it rides
        // the one function every value/width change already goes through
        syncHighlight();
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

    /* The two meta keywords, named here because app.js builds queries with them.
   * Everything ELSE about them — which fields offer them, what the tooltip says,
   * which packs carry the data — lives in ONE record, Search.META_KEYWORDS, so
   * the autocomplete and the search bar cannot describe them differently. */
    const ATTACH_WORD = "attach";
    const BONESET_WORD = "boneset";
    // meta words take an argument after them, so picking one leaves a trailing space
    const META_KEYWORDS = new Set(Object.keys(Search.META_KEYWORDS));

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
        // mech joins the list because the non-visual categories moved there —
        // its words come from the same registry, so nothing else needed saying
        if (!d || !["model", "sound", "anim", "fx", "mech"].includes(field)) return null;
        const {words, titles} = P.keywordsFor(field, d);
        for (const w of Search.keywordsIn(field, d)) {
            words.push(w);
            titles[w] = Search.META_KEYWORDS[w].hint;
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
            b.dataset.word = String(w);
            box.appendChild(b);
        });
        suggestIndex = -1;
        box.hidden = false;
        qInput.setAttribute("aria-expanded", "true");
        qInput.removeAttribute("aria-activedescendant");
    }

    // complete the partial last word of the chip's text to the category word.
    // a meta keyword (attach/boneset) takes an argument after it, so leave a
    // trailing space ready for it (attach chest) rather than butting the caret
    function applyCategoryWord(word) {
        const input = qInput;
        input.value = input.value.replace(/\S*$/, word) + (META_KEYWORDS.has(word) ? " " : "");
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

    const PHRASE_TIP = "Exact phrase — these words together, in this order";
    const ALT_TIP = "Either side matches";
    const COUNT_TIP = "How many entries this column has — count >4, count =0";

    /* The vocabulary is rebuilt on every keystroke otherwise — it walks the
     * whole pill-type registry — so it is cached per field until the pack
     * changes underneath it. */
    /**
     * @typedef {Object} BarVocab
     * @property {Map<string, string>} words  category / target word -> description
     * @property {Set<string>} valued  words that take a comparison after them
     * @property {Set<string>} keywords  meta keywords (they take a name)
     */
    /** @type {{data: any, byField: Map<string, BarVocab>}} */
    let barVocab = {data: null, byField: new Map()};

    /**
     * Every word one field's chips can carry, and which of them take a value.
     * Same sources as the autocomplete — a word that autocompletes must
     * highlight, or the two are describing different languages.
     * @param {string} field
     * @returns {BarVocab}
     */
    function fieldVocab(field) {
        const d = state.data;
        if (barVocab.data !== d) barVocab = {data: d, byField: new Map()};
        const cached = barVocab.byField.get(field);
        if (cached) return cached;
        /** @type {BarVocab} */
        const v = {words: new Map(), valued: new Set(), keywords: new Set()};
        // never CACHE an empty vocabulary from a pack-less render (the bar is
        // drawn from the URL before the pack finishes loading) — the cache key
        // is the data object, and null is a legitimate value of it
        if (!d) return v;
        if (fieldCategories(field)) {
            const {words, titles} = P.keywordsFor(field, d);
            for (const w of words) v.words.set(w, titles[w] || "");
            for (const w of Search.TARGET_WORDS) v.words.set(w, TARGET_WORD_TITLES[w]);
            // a category word whose pill type carries a number takes a comparison
            for (const t of P.typesFor(field)) {
                if (t.numeric && t.word && (!t.when || t.when(d))) v.valued.add(t.word);
            }
            if (Search.COUNT_SOURCES[field]) {
                v.words.set(Search.COUNT_AXIS, COUNT_TIP);
                v.valued.add(Search.COUNT_AXIS);
            }
        }
        for (const w of Search.keywordsIn(field, d)) {
            v.keywords.add(w);
            v.words.set(w, Search.META_KEYWORDS[w].hint);
        }
        barVocab.byField.set(field, v);
        return v;
    }

    /** A comparison token (`>2`, `<=-50`). */
    const isComparison = (s) => /^(<=|>=|<|>|=)-?\d+(?:\.\d+)?$/.test(s);

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
     * @param {BarVocab} v
     * @param {{text: string, alts: string[]}[]} spans
     * @param {number} i
     * @returns {number} tokens taken (0 = no value)
     */
    function valueRun(v, spans, i) {
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
     * @param {BarVocab} v
     * @param {string} word
     * @param {boolean} [lone]
     * @returns {{cls: string, tip: string}}
     */
    function classifyAtom(v, word, lone = false) {
        const lower = word.trim().toLowerCase();
        if (v.words.has(lower)) return {cls: "bar-kw", tip: v.words.get(lower)};
        if (lone && isComparison(lower) && v.valued.has(Search.COUNT_AXIS)) {
            return {cls: "bar-num", tip: `Short for ${Search.COUNT_AXIS} — ${COUNT_TIP}`};
        }
        return {cls: "", tip: ""};
    }

    /**
     * Split one chip's text into classified runs that concatenate back to it
     * EXACTLY — whitespace and quotes included. That is the invariant the
     * backdrop depends on: it has to occupy the same glyphs as the input.
     * @param {string} field
     * @param {string} text
     * @returns {{text: string, cls: string, tip: string, cap: string}[]}
     */
    function classifyBar(field, text) {
        const v = fieldVocab(field);
        /** @type {{text: string, cls: string, tip: string, cap: string}[]} */
        const out = [];
        const push = (t, cls = "", tip = "", cap = "") => {
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
     * @param {{text: string, quoted: boolean, alts: string[]}} s
     * @returns {string}
     */
    const altSep = (s) => (!s.quoted && s.alts.length > 1
        ? (s.text.includes("|") ? "|" : ",") : "");

    /** Split on a separator, keeping the separators as pieces of their own. */
    function splitKeepSep(text, sep) {
        const out = [];
        for (const part of text.split(sep)) out.push(part, sep);
        out.pop();
        return out;
    }

    /**
     * One span's own characters, with its alternation bars picked out. The
     * pieces are emitted whole (spaces included) so they still concatenate back
     * to the source — `fire | frost` keeps its air and gets a gold bar.
     */
    function emitSpan(v, text, s, push, lone) {
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
    function emitCapValue(raw, s, tip, cap, push) {
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
     * @param {string} field
     * @param {string} text
     * @returns {DocumentFragment}
     */
    function highlightBar(field, text) {
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
    function syncHighlight() {
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
    function markCaretCapsule() {
        const box = document.getElementById("qhl");
        if (!box) return;
        const live = document.activeElement === qInput;
        const from = live ? qInput.selectionStart : -1;
        const to = live ? qInput.selectionEnd : -1;
        for (const span of box.children) {
            const cap = /** @type {HTMLElement} */ (span).dataset.cap;
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
     * @param {MouseEvent} e
     */
    function barHover(e) {
        const box = document.getElementById("qhl");
        if (!box) return;
        let found = null;
        for (const span of box.children) {
            const r = span.getBoundingClientRect();
            if (e.clientX >= r.left && e.clientX <= r.right
                && e.clientY >= r.top && e.clientY <= r.bottom) {
                found = /** @type {HTMLElement} */ (span);
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
    function decorateExamples() {
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

    function barHoverOut() {
        const box = document.getElementById("qhl");
        if (box) for (const span of box.children) span.classList.remove("hover");
        qInput.title = "";
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
        const res = Search.searchGroups(groups, data);
        state.results = res.spellIds;
        state.groups = groups;
        // excluded terms never appear in the results: no highlighting for them.
        // Alternatives flatten to one token each — highlighting already asks
        // "does this pill match ANY query token", which is what `|` means.
        state.tokens = /** @type {HitToken[]} */ (groups.filter((g) => !g.not)
            .flatMap((g) => g.tokens.flatMap((t) =>
                (t.alts || [t.text]).map((a) => ({field: g.field, text: a})))));
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
        // matched by a name search are highlighted. The Epsilon command strip
        // rides under the name rather than in a column of its own: a command is
        // ABOUT the spell, and beside the name it can never be pushed off the
        // right edge by however many pills the visual columns happen to carry.
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
        tdName.appendChild(commandStrip(spellId));
        tr.appendChild(tdName);

        // Models — grouped by how each model is used (attach/missile/area/...)
        tr.appendChild(modelsCell(spellId));

        // Sounds — grouped by SoundKit; kits containing a match come first
        tr.appendChild(soundsCell(d.spellSounds.get(spellId) || []));

        // Animations — loose kit-played anims first, then AnimKits grouped with
        // the animations they play, then direct stand/walk anims ("stance")
        tr.appendChild(animationsCell(d.spellAnimKits.get(spellId) || [],
            d.spellVisualAnims.get(spellId) || [], spellId));

        // Effects — visual FX (beams, morphs, summons), grouped by category.
        // The same pass produces the Mechanics column's non-visual categories
        // (seat, invis, detect, keybind, speed), which used to live here.
        const effects = effectCells(spellId);
        tr.appendChild(effects.fx);

        // Mechanics — one pill per SpellEffect (what it does + who it targets),
        // then the non-visual category blocks. Both go in as blocks so the cell
        // ranks them against each other (see mechanicsCell); an enum pill can
        // never be a "named" hit, since its corpus is enum names, not keywords.
        /** @type {{hit: boolean, named?: boolean, el: Node}[]} */
        const mechBlocks = mechanicPills(d.spellMechanics.get(spellId) || []).map((p) => ({
            hit: p.rows.some(mechanicIsHit),
            el: mechanicTag(p),
        }));
        tr.appendChild(mechanicsCell(mechBlocks.concat(effects.mechBlocks)));

        return tr;
    }

    /**
     * The Epsilon command strip for one spell — a copy button per configured
     * command, then the Wowhead link. One nowrap line, so it sets the name
     * column's minimum width (see .c-name) instead of ever wrapping to two.
     * @param {number} spellId
     * @returns {HTMLElement}
     */
    function commandStrip(spellId) {
        const row = el("div", "cmd-row");
        for (const cmd of CFG.spellCommands) {
            const b = el("button", "cmd");
            b.type = "button";
            // The leading "." is Epsilon chat syntax, not decoration, so it is
            // its own span and carries the accent. That mark is what makes the
            // strip read as commands, which is what lets the buttons drop their
            // borders at rest. A label with no dot just renders plain.
            const dot = cmd.label.startsWith(".") ? "." : "";
            if (dot) b.appendChild(el("span", "cmd-dot", dot));
            b.appendChild(document.createTextNode(cmd.label.slice(dot.length)));
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
        return row;
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

    /**
     * Stable rank-partition of a cell's contents: things the query NAMED first,
     * then everything else it merely matched, then the rest. Original order is
     * kept inside each band, so a cell's deliberate layout survives.
     *
     * The middle band exists because a category word is also ordinary text.
     * `mech:speed` selects the spells with a movement-speed pill AND every spell
     * whose effect enum happens to read MOD_SPEED_SLOW_ALL — both are honest
     * hits, but only one is what was asked for, and burying it under a dozen
     * enum names (or clamping it away behind "+N more") reads as a bug. Same
     * story for `fx:glow` against a texture called beam_webglowwhite.
     *
     * `isKeyword` is optional: a cell whose contents carry no category word (the
     * sound kits) simply has no first band.
     * @template T
     * @param {T[]} items
     * @param {(it: T) => boolean} isHit
     * @param {((it: T) => boolean) | null} [isKeyword]
     * @returns {T[]}
     */
    function hitsFirst(items, isHit, isKeyword = null) {
        if (!state.tokens.length) return items;
        const named = [], hits = [], rest = [];
        for (const it of items) {
            if (!isHit(it)) rest.push(it);
            else (isKeyword && isKeyword(it) ? named : hits).push(it);
        }
        return named.concat(hits, rest);
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

    /**
     * The Mechanics cell: loose SpellEffect pills, then the non-visual category
     * blocks built alongside the fx column (seat, invis, detect, keybind,
     * speed).
     *
     * The enum pills come FIRST because they describe the effect itself, and
     * the categories qualify it — but the two halves are ONE ranked list, not
     * two appended ones, because that resting order is exactly wrong under a
     * query that names a category. `mech:speed` matches the speed pill outright
     * and every SPELL_AURA_MOD_SPEED_* enum by substring; handing the enums the
     * whole top of the cell buries the pill that was asked for. renderBlocks
     * ranks them together, so a named category rises past them and an unnamed
     * one keeps its place below.
     *
     * The cell only reads as empty when neither half has anything — a spell
     * with a speed aura but no SpellEffect rows still shows the speed pill.
     * @param {{hit: boolean, named?: boolean, el: Node}[]} blocks
     * @returns {HTMLElement}
     */
    function mechanicsCell(blocks) {
        const td = el("td", "c-mechanics");
        if (!blocks.length) {
            td.classList.add("empty");
            td.appendChild(el("span", "none", "—"));
            return td;
        }
        renderBlocks(td, blocks);
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
        // mounts live outside the model graph (Mount.db2, keyed by display id),
        // so a spell can have mounts and no model rows at all — read them before
        // the no-categories fallback, which would otherwise drop them
        const mountIds = d.spellMounts.get(spellId) || [];
        if (!entries && !mountIds.length) {
            const modelFids = hitsFirst(d.spellModels.get(spellId) || [],
                (fid) => fileIsHit(d.files.get(fid), "model"));
            return tagCell("c-models", modelFids.map((fid) => modelTag(fid)));
        }
        const td = el("td", "c-models");
        const byCat = new Map(); // cat id -> [{fid, targets}]
        for (const e of entries || []) {
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
        // Loose (uncategorized attach) pills come first, then the category
        // groups — but renderBlocks floats whichever hold the search hit above
        // the rest, so a matched category is not stranded below a pile of
        // non-matching attach splits (nor clamped away behind "+N more").
        const blocks = [];
        for (const e of loose) {
            blocks.push({
                hit: modelFileIsHit(d.files.get(e.fid), ""),
                el: modelTag(e.fid, "", e.targets, e.src, e.dst, travels(e.cat)),
            });
        }
        for (const c of cats) {
            blocks.push({
                hit: c.hit,
                named: wordIsNamed("model", c.name),
                el: P.group({
                    head: modelCatHeadTag(c.name, c.hit),
                    items: hitsFirst(c.items, (e) => modelFileIsHit(d.files.get(e.fid), c.name))
                        .map((e) => (isDisplayCat(e.cat) ? displayTag(e, spellId)
                            : isItemCat(e.cat) ? itemTag(e)
                                : modelTag(e.fid, c.name, e.targets, e.src, e.dst, travels(e.cat)))),
                }),
            });
        }
        // mounts: their own group, keyed on display ids rather than model files.
        // No target icons — a mount is always the caster's own.
        if (mountIds.length) {
            const hit = mountIds.some((m) => mountIsHit(m));
            blocks.push({
                hit,
                named: wordIsNamed("model", "mount"),
                el: P.group({
                    head: modelCatHeadTag("mount", hit),
                    items: hitsFirst(mountIds.slice().sort((a, b) => a - b),
                        (m) => mountIsHit(m)).map((m) => mountTag(m, spellId)),
                }),
            });
        }
        renderBlocks(td, blocks);
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

        // one block per SoundKit (numeric order); renderBlocks floats the hit
        // kits up. The icon rides the kit head — every file in a kit plays
        // together, so the whole kit shares one target type.
        renderBlocks(td, [...byKit.keys()].sort((a, b) => a - b).map((kitId) => ({
            hit: kitHasHit(kitId),
            el: P.group({
                head: kitTag(kitId, "soundkit", kitMask.get(kitId)),
                items: hitsFirst(byKit.get(kitId), (fid) => fileIsHit(d.files.get(fid), "sound"))
                    .map((fid) => soundTag(fid)),
            }),
        })));
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
    const PASSENGER_GROUP = -2;
    const ANIM_GROUPS = [
        {id: PASSENGER_GROUP, word: "passenger", animsOf: (d, s) => d.spellPassengerAnims.get(s)},
    ];
    // a replacement pill is a hit when either side's anim matches the query,
    // under the "replace" word or by anim name
    const replaceAnimHit = (a) => animIsHit(a, "replace");

    function animationsCell(animKitIds, looseAnimIds, spellId) {
        const groupAnims = new Map();
        for (const g of ANIM_GROUPS) {
            const anims = g.animsOf(state.data, spellId) || [];
            if (anims.length) groupAnims.set(g.id, anims);
        }
        // animation replacements (proc Type 7 + aura 312, merged). Their items
        // are PAIRS, not single anim ids, so they sit outside ANIM_GROUPS; the
        // build already unioned both sources and deduped, so this is a plain read.
        const swaps = state.data.spellReplaceAnims.get(spellId) || [];
        const td = el("td", "c-animations");
        if (animKitIds.length === 0 && groupAnims.size === 0
            && swaps.length === 0
            && looseAnimIds.length === 0) {
            td.classList.add("empty");
            td.appendChild(el("span", "none", "—"));
            return td;
        }
        const d = state.data;
        const looseMasks = d.visualAnimTargets.get(spellId);
        const animsOf = (kitId) =>
            groupAnims.get(kitId) || d.animKitAnims.get(kitId) || [];
        // a headless group's anims match through its category word too
        const wordOf = (kitId) =>
            (ANIM_GROUPS.find((g) => g.id === kitId) || {word: ""}).word;
        // Expand a kit's anims into pill ENTRIES: one per specific boneset region
        // an anim (segment) animates, so two regions are two pills (never merged),
        // and an anim with no region is its plain pill. Bonesets ride real
        // AnimKits only — a headless group (passenger/stance) has none.
        const animEntries = (kitId) => {
            const bones = groupAnims.has(kitId) ? null : d.animKitAnimBoneset.get(kitId);
            const out = [];
            for (const animId of animsOf(kitId).slice().sort((a, b) => a - b)) {
                const regions = bones && bones.get(animId);
                if (regions && regions.length) {
                    for (const r of regions) out.push({animId, region: r});
                } else {
                    out.push({animId, region: null});
                }
            }
            return out;
        };
        const entryHit = (kitId, e) => animIsHit(e.animId, wordOf(kitId))
            || (!!e.region && bonesetIsHit([e.region]));
        const kitHasHit = (kitId) =>
            (!groupAnims.has(kitId) && kitIsHit(kitId, "animkit")) ||
            animEntries(kitId).some((e) => entryHit(kitId, e));
        const groups = animKitIds.slice().sort((a, b) => a - b);
        for (const g of ANIM_GROUPS) if (groupAnims.has(g.id)) groups.push(g.id);

        // loose visual-anim pills first, then the kit / stance / passenger
        // groups; renderBlocks floats whichever hold the hit to the top.
        const blocks = [];
        for (const a of looseAnimIds.slice().sort((x, y) => x - y)) {
            blocks.push({
                hit: animIsHit(a),
                el: animTag(a, "", looseMasks ? looseMasks.get(a) || 0 : 0),
            });
        }
        for (const kitId of groups) {
            blocks.push({
                hit: kitHasHit(kitId),
                named: wordIsNamed("anim", wordOf(kitId)),
                el: P.group({
                    // stance overrides are ~96% caster — a constant, so no icon
                    // there (documented in the help dialog); animkits carry theirs
                    head: groupAnims.has(kitId)
                        ? animCatHeadTag(wordOf(kitId), kitHasHit(kitId))
                        : kitTag(kitId, "animkit", maskOf(d.animKitTargets, spellId, [kitId])),
                    items: hitsFirst(animEntries(kitId), (e) => entryHit(kitId, e))
                        .map((e) => animTag(e.animId, wordOf(kitId), 0,
                            e.region ? [e.region] : null)),
                }),
            });
        }
        if (swaps.length) {
            const swapHit = (sw) => replaceAnimHit(sw.src) || replaceAnimHit(sw.dst);
            const hit = swaps.some(swapHit);
            blocks.push({
                hit,
                named: wordIsNamed("anim", "replace"),
                el: P.group({
                    head: animCatHeadTag("replace", hit),
                    items: hitsFirst(swaps, swapHit).map((sw) => animSwapTag(sw.src, sw.dst)),
                }),
            });
        }
        renderBlocks(td, blocks);
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
    /* Render a cell's BLOCKS with search hits floated to the top.
   *
   * A block is one renderable unit of a cell — a loose pill, or a whole group
   * (a head with its items). Each carries whether it holds a hit and the
   * element to append. Under an active query the hit blocks come first (stable
   * partition via hitsFirst, so the deliberate order is otherwise untouched —
   * e.g. loose model pills still precede their category groups); with no query
   * nothing moves.
   *
   * Floating hits up is also what keeps them on screen: clampCell hides leaves
   * from the BOTTOM, so the pill you searched for stays visible instead of
   * disappearing behind "+N more". Every pill-bearing cell renders through here
   * so that one rule holds for all of them — the models, sounds, animations and
   * fx cells all build a `blocks` array and hand it over.
   *
   * `named` is the block's second rank: it was matched because the query spelled
   * its category word, not because some file name contained the same letters
   * (see hitsFirst). A block with no category word simply never sets it.
   * @param {HTMLElement} td
   * @param {{hit: boolean, named?: boolean, el: Node}[]} blocks
   */
    function renderBlocks(td, blocks) {
        for (const b of hitsFirst(blocks, (x) => x.hit, (x) => !!x.named)) td.appendChild(b.el);
    }

    /* Effects cell: visual FX grouped by category — "chain" (beam/chain effects),
   * "dissolve" (dissolve effects), "glow" / "ghost" / "tint" (color-only
   * effects), "desaturate" / "transparency" (percent-only), "freeze" /
   * "camo" (valueless), "screen" (full-screen effects), "morph" (transform
   * auras) and "summon" (summon effects). Chain pills carry a tint dot per
   * texture. */
    /**
     * Builds the Effects cell AND the pill half of the Mechanics cell.
     *
     * One function because the two columns share every piece of machinery a
     * category needs — target-icon splitting, hit-floating, the group shape —
     * and differ only in which column a category was declared for. Returns the
     * fx `<td>` plus the mech-side blocks for mechanicsCell to render after its
     * enum pills.
     * @param {number} spellId
     * @returns {{fx: HTMLElement, mechBlocks: {hit: boolean, el: Node}[]}}
     */
    function effectCells(spellId) {
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
        const objectIds = d.spellObjects.get(spellId) || [];
        const vehicleIds = d.spellVehicles.get(spellId) || [];
        const invisPills = (d.spellInvisTypes.get(spellId) || []).slice().sort((a, b) => a.type - b.type);
        const detectPills = (d.spellDetectTypes.get(spellId) || []).slice().sort((a, b) => a.type - b.type);
        const keybindIds = d.spellKeybinds.get(spellId) || [];
        const speedMods = d.spellSpeedMods.get(spellId) || [];
        const scaleMods = d.spellScaleMods.get(spellId) || [];
        const td = el("td", "c-fx");
        // No combined emptiness check up front: the categories below now feed
        // TWO columns, so "this spell has no content at all" is not the question
        // either cell is asking. Each is judged on its own blocks at the end —
        // a spell with only a speed aura has an empty fx cell and a populated
        // mechanics one, which the old single test could not express.
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

        /**
         * Push one fx category onto `cats` in the shape every category shares:
         * the head-vs-pill icon split above, hit-floating, and the
         * {name, hit, mask, items} envelope the renderer at the end consumes.
         * A category with no rows pushes nothing, so callers need no `if`.
         *
         * Two levels are deliberately distinct, because most categories collapse
         * or expand between them:
         *   - SOURCE ROWS (`rows`) are what the spell actually has in this
         *     category. They decide the category's hit state and, through
         *     `targetSplit`, whether the target icon can ride the head.
         *   - ENTRIES are what become pills. `entries` maps rows to them: chain
         *     and glow DEDUPE (rows drawing the same texture become one pill and
         *     union their masks), morph and shapeshift EXPAND (one creature with
         *     three displays becomes three pills). Omit it when rows are pills.
         *
         * @param {object} spec
         * @param {string} spec.name category word — the head label, and the key
         *   into the owning column's search vocabulary.
         * @param {string} [spec.col] which column renders it — "fx" (default)
         *   or "mech". The only thing that differs between the two.
         * @param {any[]} spec.rows source rows (see above).
         * @param {(row: any) => boolean} spec.isHit does a source row match the query.
         * @param {(entry: any, mask: number) => Node} [spec.render] build one pill.
         *   Omitted only by valueless categories, whose head IS the whole pill and
         *   which therefore produce no entries for it to be called on.
         * @param {(row: any) => number} [spec.mask] a source row's target mask.
         *   Default: no icons anywhere — for categories with no target data.
         * @param {(rows: any[]) => any[]} [spec.entries] rows → pills. Default: identity.
         * @param {(entry: any) => boolean} [spec.entryIsHit] Default: `isHit`, which
         *   is correct whenever entries and rows are the same thing.
         * @param {(entry: any) => number} [spec.entryMask] Default: `mask`.
         * @param {(rows: any[], entries: any[]) => number[]} [spec.headMasks] which
         *   masks decide whether the icon can ride the head. Defaults to the source
         *   rows'. Override only where a row's own mask is not what a pill shows —
         *   `keybind` merges rows by label, so a merged pill carries their union.
         */
        const pushCat = ({
            name, rows, isHit, col = "fx",
            render = () => el("span"),
            mask = () => 0,
            entries = (rs) => rs,
            entryIsHit = isHit,
            entryMask = mask,
            headMasks = (rs) => rs.map(mask),
        }) => {
            if (!rows.length) return;
            const pills = entries(rows);
            const t = targetSplit(headMasks(rows, pills));
            cats.push({
                name, col,
                hit: rows.some(isHit),
                mask: t.head,
                items: hitsFirst(pills, entryIsHit)
                    .map((e) => () => render(e, t.pill(entryMask(e)))),
            });
        };

        const chainMask = (c) => maskOf(d.fxTargets, spellId, [c]);
        pushCat({
            name: "chain",
            rows: chainIds,
            mask: chainMask,
            isHit: (c) => fxChainIsHit(c),
            // one entry per distinct (texture, tint); untextured chains still show.
            // The drawing beam's attach points are part of the key, so one chain
            // drawn by two beams from different points stays two pills.
            entries: (ids) => {
                const byKey = new Map();
                const rows = (d.spellChainRows.get(spellId)
                    || ids.map((c) => ({chain: c, src: -1, dst: -1})))
                    .slice().sort((a, b) => a.chain - b.chain);
                for (const {chain: c, src, dst} of rows) {
                    const color = (d.fxChains.get(c) || {}).color ?? 0xffffff;
                    for (const fid of d.fxTextures.get(c) || [0]) {
                        const key = fid + ":" + color + ":" + src + ":" + dst;
                        const prev = byKey.get(key);
                        if (prev) {
                            prev.mask |= chainMask(c);
                            continue;
                        }
                        byKey.set(key, {chainId: c, fid, color, src, dst, mask: chainMask(c)});
                    }
                }
                return [...byKey.values()];
            },
            entryIsHit: (e) => fxChainIsHit(e.chainId),
            entryMask: (e) => e.mask,
            render: (e, m) => fxTag(e, m),
        });

        const dissolveMask = (id) => maskOf(d.dissolveTargets, spellId, [id]);
        pushCat({
            name: "dissolve",
            rows: dissolveIds,
            mask: dissolveMask,
            isHit: (id) => dissolveIsHit(id),
            // one pill per distinct texture; textureless rows still show
            entries: (ids) => {
                const byKey = new Map();
                for (const id of ids.slice().sort((a, b) => a - b)) {
                    for (const fid of d.dissolveTextures.get(id) || [0]) {
                        const prev = byKey.get(fid);
                        if (prev) {
                            prev.mask |= dissolveMask(id);
                            continue;
                        }
                        byKey.set(fid, {dissolveId: id, fid, mask: dissolveMask(id)});
                    }
                }
                return [...byKey.values()];
            },
            entryIsHit: (e) => dissolveIsHit(e.dissolveId),
            entryMask: (e) => e.mask,
            render: (e, m) => dissolveTag(e, m),
        });

        const glowMask = (id) => maskOf(d.glowTargets, spellId, [id]);
        pushCat({
            name: "glow",
            rows: glowIds,
            mask: glowMask,
            isHit: (id) => glowIsHit(id),
            // one pill per distinct color (no texture — the color is the payload)
            entries: (ids) => {
                const byKey = new Map();
                for (const id of ids.slice().sort((a, b) => a - b)) {
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
                return [...byKey.values()];
            },
            entryIsHit: (e) => glowIsHit(e.glowId),
            entryMask: (e) => e.mask,
            render: (e, m) => colorFxTag("glow", e.color, glowIsHit(e.glowId), e.alpha, m),
        });
        // "ghost" merges ShadowyEffect rows (two colors each) and Type-22 material
        // recolors (one color each). Its rows are tagged with which source they
        // came from, so one category can mix both; sorted and shadowy-first, since
        // the dedup below keeps the first row to claim a color.
        const ghostRows = [
            ...shadowyIds.slice().sort((a, b) => a - b).map((id) => ({id, mat: false})),
            ...ghostMatIds.slice().sort((a, b) => a - b).map((id) => ({id, mat: true})),
        ];
        pushCat({
            name: "ghost",
            rows: ghostRows,
            mask: (r) => maskOf(r.mat ? d.ghostMatTargets : d.shadowyTargets, spellId, [r.id]),
            isHit: (r) => (r.mat ? ghostMatIsHit : shadowyIsHit)(r.id),
            // one pill per distinct color; each pill carries its own isHit, because
            // which source a color came from decides how it matches the query
            entries: (rows) => {
                const byColor = new Map();
                for (const r of rows) {
                    const rowMask = maskOf(r.mat ? d.ghostMatTargets : d.shadowyTargets,
                        spellId, [r.id]);
                    // Type-22 material recolors carry one color and no attach point;
                    // ShadowyEffect rows carry two colors and a body region
                    const colors = r.mat
                        ? [d.ghostMatColors.get(r.id) ?? 0]
                        : (({primary, secondary}) => [primary, secondary])(
                            d.shadowyColors.get(r.id) || {primary: 0, secondary: 0});
                    const region = r.mat ? "" : effectRegionName(d.shadowyAttach.get(r.id));
                    const hit = () => (r.mat ? ghostMatIsHit : shadowyIsHit)(r.id);
                    for (const color of colors) {
                        const prev = byColor.get(color);
                        if (prev) {
                            prev.mask |= rowMask;
                            if (region) prev.regions.add(region);
                            continue;
                        }
                        byColor.set(color, {color, hit, mask: rowMask,
                            regions: new Set(region ? [region] : [])});
                    }
                }
                return [...byColor.values()];
            },
            entryIsHit: (e) => e.hit(),
            entryMask: (e) => e.mask,
            render: (e, m) => colorFxTag("ghost", e.color, e.hit(), undefined, m,
                effectAttachNote([...e.regions], "ghost")),
        });

        pushCat({
            name: "tint",
            rows: tintIds,
            isHit: (id) => tintIsHit(id),
            // one pill per distinct color (no texture — the color is the payload)
            entries: (ids) => {
                const byColor = new Map();
                for (const id of ids.slice().sort((a, b) => a - b)) {
                    const color = d.tintColors.get(id) ?? 0;
                    if (!byColor.has(color)) byColor.set(color, {tintId: id, color});
                }
                return [...byColor.values()];
            },
            entryIsHit: (e) => tintIsHit(e.tintId),
            render: (e) => colorFxTag("tint", e.color, tintIsHit(e.tintId)),
        });

        // one pill per distinct percent — the strength is the whole payload.
        // (desaturate keys a computed grey swatch off it; transparency does not.)
        const uniqueSorted = (pcts) => [...new Set(pcts)].sort((a, b) => a - b);
        for (const [name, pcts, pctIsHit] of /** @type {[string, number[], (p: number) => boolean][]} */ ([
            ["desaturate", desatPcts, desatIsHit],
            ["transparency", transpPcts, transpIsHit],
        ])) {
            pushCat({
                name,
                rows: pcts,
                isHit: pctIsHit,
                entries: uniqueSorted,
                render: (p) => percentFxTag(name, p, pctIsHit(p)),
            });
        }

        // valueless: the clickable category head IS the whole pill, so these have
        // one nominal row (to exist at all) and no entries
        for (const [name, present, isHit] of /** @type {[string, boolean, () => boolean][]} */ ([
            ["freeze", hasFreeze, freezeIsHit],
            ["camo", hasCamo, camoIsHit],
        ])) {
            pushCat({
                name,
                rows: present ? [null] : [],
                isHit,
                entries: () => [],
            });
        }

        const screenMask = (id) => maskOf(d.screenTargets, spellId, [id]);
        pushCat({
            name: "screen",
            rows: screenIds,
            mask: screenMask,
            isHit: (id) => screenIsHit(id),
            // one pill per ScreenEffect row, labeled with its internal name.
            // ImplicitTarget icon (pack format 25): usually the caster's own view
            entries: (ids) => ids.slice().sort((a, b) => a - b),
            render: (id, m) => screenTag(id, m),
        });
        // shapeshift and morph share a shape: one pill per (row, display), with a
        // single fallback pill for rows that have no display at all.
        const withDisplays = (displays) => (ids) => ids.slice().sort((a, b) => a - b)
            .flatMap((id) => (displays.get(id) || [{displayId: 0, fid: 0}])
                .map((e) => ({id, displayId: e.displayId, fid: e.fid})));

        const formMask = (f) => maskOf(d.shapeshiftTargets, spellId, [f]);
        pushCat({
            name: "shapeshift",
            rows: formIds,
            mask: formMask,
            isHit: (f) => shapeshiftIsHit(f),
            // a form with no display (Battle Stance, Shadowform, Stealth — 11 of
            // the 29 used forms) gets one name-only pill
            entries: withDisplays(d.shapeshiftDisplays),
            entryIsHit: (e) => shapeshiftIsHit(e.id),
            entryMask: (e) => formMask(e.id),
            render: (e, m) => shapeshiftTag({formId: e.id, displayId: e.displayId, fid: e.fid},
                m, spellId),
        });

        // who the morph lands on — the target for polymorph, the caster for
        // self-transforms (ImplicitTarget, pack format 25)
        const morphMask = (c) => maskOf(d.morphTargets, spellId, [c]);
        pushCat({
            name: "morph",
            rows: morphIds,
            mask: morphMask,
            isHit: (c) => morphIsHit(c),
            // creatures without TDB displays still get a single fallback pill
            entries: withDisplays(d.morphDisplays),
            entryIsHit: (e) => morphIsHit(e.id),
            entryMask: (e) => morphMask(e.id),
            render: (e, m) => morphTag({creatureId: e.id, displayId: e.displayId, fid: e.fid},
                m, spellId),
        });

        const summonMask = (e) => maskOf(d.summonTargets, spellId, [e.creatureId]);
        pushCat({
            name: "summon",
            rows: summonEntries,
            mask: summonMask,
            isHit: (e) => summonIsHit(e.creatureId, e.control),
            // one pill per (creature, control) pair; ImplicitTarget icon shows where
            // the summon lands (usually a ground point → area)
            entries: (es) => es.slice().sort(
                (a, b) => (a.creatureId - b.creatureId) || (a.control - b.control)),
            render: (e, m) => summonTag(e, m),
        });

        const objMask = (o) => maskOf(d.objectTargets, spellId, [o]);
        pushCat({
            name: "object",
            rows: objectIds,
            mask: objMask,
            isHit: (o) => objectIsHit(o),
            // one pill per gameobject the spell places. Same shape as summon —
            // the ImplicitTarget icon says where it lands (usually a ground point)
            entries: (ids) => ids.slice().sort((a, b) => a - b),
            render: (o, m) => objectTag(o, m),
        });

        // one pill per SEAT, in SeatID order, labeled with its attachment point —
        // de-duped, because 38% of multi-seat vehicles put every seat on the same
        // attachment and would otherwise repeat one pill 8 times. The mask comes
        // from the SET_VEHICLE_ID aura's ImplicitTarget (pack format 25) — caster
        // when the caster becomes the vehicle, target when a unit is turned into
        // one. It is per-VEHICLE, not per-seat, so every pill in the category
        // carries the same union of the spell's vehicles rather than its own mask.
        const vehMask = (v) => maskOf(d.vehicleTargets, spellId, [v]);
        const seatCount = vehicleIds.reduce(
            (n, v) => Math.max(n, (d.vehicleSeats.get(v) || []).length), 0);
        pushCat({
            name: "seat", col: "mech",
            rows: vehicleIds,
            mask: vehMask,
            // a vehicle is "hit" through the attachment points of its seats
            isHit: (v) => (d.vehicleSeats.get(v) || []).some((p) => vehicleIsHit(p, seatCount)),
            entries: (vs) => [...new Set(vs.flatMap((v) => d.vehicleSeats.get(v) || []))],
            entryIsHit: (p) => vehicleIsHit(p, seatCount),
            entryMask: () => vehicleIds.reduce((m, v) => m | vehMask(v), 0),
            render: (p, m) => vehicleTag(p, seatCount, m),
        });
        // invisibility / detection channels. Counterpart count = the other side of
        // the same type; it drives the pill label AND the numeric hit test.
        /** @type {Array<[string, {type: number, mask: number}[], Map<number, number[]>]>} */
        const channels = [
            ["invis", invisPills, d.detectTypeSpells],
            ["detect", detectPills, d.invisTypeSpells]];
        for (const [side, pills, countMap] of channels) {
            const countOf = (type) => (countMap.get(type) || []).length;
            pushCat({
                name: side, col: "mech",
                rows: pills,
                mask: (e) => e.mask,
                isHit: (e) => channelIsHit(side, e.type),
                render: (e, m) => channelTag(side, e.type, countOf(e.type), m),
            });
        }

        // keybound overrides: one pill per KEY the spell's aura overrides. Two
        // overrides on one spell can name the same key and differ only in the
        // replacement spell — which is not shown — so they would render as
        // duplicate pills; pills are keyed on what they actually display and their
        // masks union, the same de-duping vehicle seat attachments get.
        const kbMask = (o) => maskOf(d.keybindTargets, spellId, [o]);
        pushCat({
            name: "keybind", col: "mech",
            // an override with no keybind row displays nothing, so it is not a row
            rows: keybindIds.filter((o) => d.keybinds.has(o)),
            mask: kbMask,
            isHit: keybindIsHit,
            entries: (ids) => {
                /** @type {Map<string, {label: string, fn: string, ids: number[], mask: number}>} */
                const byLabel = new Map();
                for (const o of ids) {
                    const row = d.keybinds.get(o);
                    const label = row.when ? `${row.fn} ${row.when}` : row.fn;
                    const prev = byLabel.get(label);
                    if (prev) {
                        prev.ids.push(o);
                        prev.mask |= kbMask(o);
                        continue;
                    }
                    byLabel.set(label, {label, fn: row.fn, ids: [o], mask: kbMask(o)});
                }
                return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
            },
            entryIsHit: (p) => p.ids.some(keybindIsHit),
            entryMask: (p) => p.mask,
            // a merged pill shows its members' union, so the union is what the head
            // has to agree with — see `headMasks` on pushCat
            headMasks: (_rows, pills) => pills.map((p) => p.mask),
            render: (p, m) => keybindTag(p, m),
        });

        // movement-speed modifiers: one pill per (movement, percent) the spell
        // sets. The pack has already collapsed the auras that share a movement,
        // so two pills here are two genuinely different statements.
        pushCat({
            name: "speed", col: "mech",
            rows: speedMods,
            mask: (p) => p.mask,
            isHit: (p) => speedIsHit(p.key),
            render: (p, m) => speedTag(p, m),
        });

        // object-scale modifiers: one pill per distinct percent, the three scale
        // auras having already collapsed into it in the pack
        pushCat({
            name: "scale",
            rows: scaleMods,
            mask: (p) => p.mask,
            isHit: (p) => scaleIsHit(p.pct),
            render: (p, m) => scaleTag(p, m),
        });

        // one block per category, in the order pushed above; renderBlocks
        // floats the matched category to the top. The icon rides the category
        // head, unioned over this spell's rows in the category — only where the
        // distribution isn't degenerate (a category that is always the same type
        // says nothing per pill).
        //
        // `col` splits the categories between the two cells this builds. The
        // pushes above are one list on purpose: a category's SHAPE is the same
        // wherever it lands, so which column owns it is one field on the spec
        // rather than a second copy of this machinery.
        const blocksFor = (c) => cats.filter((cat) => cat.col === c).map((cat) => ({
            hit: cat.hit,
            named: wordIsNamed(c, cat.name),
            el: P.group({
                head: fxHeadTag(cat.name, cat.hit, cat.mask, cat.col),
                items: cat.items.map((make) => make()),
            }),
        }));
        const fxBlocks = blocksFor("fx");
        if (fxBlocks.length) renderBlocks(td, fxBlocks);
        else {
            td.classList.add("empty");
            td.appendChild(el("span", "none", "—"));
        }
        return {fx: td, mechBlocks: blocksFor("mech")};
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

    /**
     * Does any positive chip of `field` accept this entity?
     *
     * `test` receives ONE combination of a chip's tokens, with alternation
     * already distributed by the engine — so a hit test never has to know that
     * `|` exists, exactly as the matchers in search.js don't. Every hit test in
     * this file goes through here, and that is what keeps highlighting in step
     * with selection: a pill can only light up under a combination that could
     * have selected its spell.
     * @param {string} field
     * @param {(tokens: QueryToken[]) => boolean} test
     * @returns {boolean}
     */
    function anyGroup(field, test) {
        return groupsFor(field).some((g) => Search.combosOf(g).some(test));
    }

    /**
     * Did a positive chip of `field` NAME this category word outright — as a
     * whole token, not as a fragment of some longer value?
     *
     * This is the "full keyword hit" test hitsFirst ranks on. Equality, not
     * substring, is the whole point: `mech:speed` names the speed category,
     * while `mech:spe` merely reaches it (and reaches half the enum names too),
     * so only the first has earned the top of the cell.
     * @param {string} field
     * @param {string} word category word ("" for content that has none)
     * @returns {boolean}
     */
    function wordIsNamed(field, word) {
        if (!word) return false;
        return anyGroup(field, (ts) => ts.some((t) => t.text === word));
    }

    // hit = the entity fully satisfies at least one chip of its field
    function fileIsHit(file, field) {
        if (!file) return false;
        return anyGroup(field, (ts) => ts.every((t) => file.searchL.includes(t.text)));
    }

    // kit ids live in the sound:/anim: fields since the soundkit:/animkit:
    // merge — a chip's numeric tokens hit the kit whose id they equal
    function kitIsHit(kitId, field) {
        const searchField = field === "soundkit" ? "sound" : "anim";
        return anyGroup(searchField, (ts) => ts.some((t) => Number(t.text) === kitId));
    }

    // anim pills can be hit through their group's category word too — today
    // only the stance group carries one ("stance"); kit groups pass "".
    // Mirrors spellsByAnim's token test.
    function animIsHit(animId, groupWord = "") {
        const nameL = state.data.animNamesL[animId];
        return anyGroup("anim", (ts) =>
            ts.every((t) => groupWord.includes(t.text) || nameL.includes(t.text)));
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
        return anyGroup("mech", (ts) => ts.every((t) => corpus.includes(t.text)));
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
        // id is optional: valueless pill types (freeze, camo) call with no id
        return (id = undefined) =>
            anyGroup(type.field, (ts) => P.idMatches(type, state.data, id, ts));
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
    /** A gameobject-spawn pill keys on the gameobject_template entry. */
    const objectIsHit = isHitOf("fx:object");
    /** A mount pill keys on the CreatureDisplayID it rides on. */
    const mountIsHit = isHitOf("model:mount");
    /** A speed pill keys on the (movement, percent) pair it displays. */
    const speedIsHit = isHitOf("fx:speed");
    /** A scale pill keys on the percent, which is all it displays. */
    const scaleIsHit = isHitOf("fx:scale");
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
        // "mech", not "fx": this is the one migrated category whose hit test is
        // hand-written rather than derived from the registry via isHitOf, so it
        // is the one place the column move had to be repeated by hand.
        return anyGroup("mech", (ts) => ts.every((t) =>
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
        return anyGroup("model", (ts) =>
            ts.every((t) => catName.includes(t.text) || searchL.includes(t.text)));
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
        // The label already shows the slot name, so the tooltip only has to say
        // what the pill does WITH it. It used to append "an M2 attachment slot,
        // not a description" to every one of these — 42 characters of the same
        // caveat on every attachment pill on screen.
        let label, why;
        if (s && t) {
            label = `${s} → ${t}`;
            why = `Travels from ${s} to ${t}`;
        } else if (!twoPoint) {
            label = s;
            why = `Plays at ${s}`;
        } else {
            label = s ? `from ${s}` : `to ${t}`;
            why = s ? `Launches from ${s}` : `Lands on ${t}`;
        }
        const words = [s, t].filter(Boolean);
        // one `attach <point>` per point, so two points AND rather than running
        // together into one unreadable value (Search.keywordValue quotes if the
        // name ever gains a space)
        return P.note(label, {
            hit: attachIsHit(field, words),
            title: why,
            search: P.quoted(field, words.map((w) => Search.keywordValue(ATTACH_WORD, w)).join(" ")),
            finds: `spells using ${words.length > 1 ? "these points" : "this point"}`,
        });
    }

    /**
     * The values a chip gives one meta keyword — the engine's own splitter, so
     * a pill can only light up under a query that really selected its spell,
     * and the arity a hit test assumes is the arity the search used.
     * @param {{text: string}[]} tokens
     * @param {string} word
     * @returns {string[]}
     */
    const keywordValues = (tokens, word) =>
        Search.splitKeyword(tokens, word).values;

    /* An attachment segment lights when a positive attach query in its field (or
   * free text) names points this row carries; a boneset pill when a `boneset`
   * query names one of its regions. Both defer to Search.matchesNames — the
   * engine's own value test — so a pill can only light up under a query that
   * really selected its spell. */
    const lowered = (names) => names.map((n) => n.toLowerCase());

    function attachIsHit(field, names) {
        const namesL = lowered(names);
        return anyGroup(field, (ts) => {
            const attaches = keywordValues(ts, ATTACH_WORD);
            return attaches.length > 0 && Search.matchesNames(attaches, namesL);
        });
    }

    function bonesetIsHit(names) {
        const namesL = lowered(names);
        return anyGroup("anim", (ts) => {
            const words = keywordValues(ts, BONESET_WORD);
            return words.length > 0 && Search.matchesNames(words, namesL);
        });
    }

    /* A boneset segment: the body region(s) an AnimKit — or one of its anims —
   * animates ("Upper Body", "Head · Right Hand"). Reads as a dim qualifier on
   * the pill, searchable via the `boneset` keyword. Built exactly like its twin
   * attachSegment — ONE keyword per region, each quoted if its name is spaced
   * ("Upper Body") — so the two twins produce the same shape of query. Shown on
   * the AnimKit head when the whole kit shares one region, on the anim pill when
   * its anims differ. */
    function bonesetSegment(names) {
        if (!names || !names.length) return null;
        return P.note(names.join(" · "), {
            hit: bonesetIsHit(names),
            title: `Animates ${names.join(", ")}`,
            search: P.quoted("anim", names.map((n) => Search.keywordValue(BONESET_WORD, n)).join(" ")),
            finds: `spells animating ${names.length > 1 ? "these regions" : "this region"}`,
        });
    }

    /* A raw M2 attach id an EFFECT (Shadowy/Dissolve) carries -> its region
   * word. -1, the common value, is the WHOLE body ("full body") rather than a
   * missing point; anything else names the M2 attachment slot. */
    const effectRegionName = (a) =>
        a == null ? "" : (a < 0 ? "full body" : (state.data.attachmentNames[a] || ""));

    /* Where on the model a Shadowy/Dissolve effect is anchored, as a dim note
   * segment. Searchable through the effect's own fx corpus (`category`), so it
   * needs no new keyword — the attach word rides the same corpus as the hue or
   * texture words. `regionNames` may hold several when a merged pill (one ghost
   * colour drawn by effects at different points) spans more than one. */
    function effectAttachNote(regionNames, category) {
        const names = [...new Set(regionNames.filter(Boolean))];
        if (!names.length) return null;
        const full = names.length === 1 && names[0] === "full body";
        return P.note(names.join(" · "), {
            title: full ? "Anchored to the whole body"
                : `Anchored at the ${names.join(", ")} attachment point`,
            search: P.catQuery("fx", category, names[0]),
            finds: full ? "effects on the full body" : "effects at this attachment point",
        });
    }

    function modelTag(fid, catName = "", mask = 0, src = -1, dst = -1, twoPoint = false) {
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
    function displayTag(e, spellId) {
        const d = state.data;
        const {fid, ref: displayId, targets: mask} = e;
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "model",
            hit: modelFileIsHit(d.files.get(fid), MODEL_CAT_DISPLAY_WORD),
            segments: [
                displayId && CFG.wowheadMorphUrl && P.link(
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
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
        return anyGroup("model", (ts) => ts.every((t) =>
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

    /**
     * One anim-replacement swap pill: "Stand → StealthStand".
     *
     * Both sides are searchable, because both are questions worth asking — the
     * base animation being overridden, and the one played instead. Reads as a
     * pair rather than two pills because neither half means anything alone.
     * @param {number} src base AnimationData id
     * @param {number} dst what plays instead
     */
    function animSwapTag(src, dst) {
        const d = state.data;
        const srcName = d.animNames[src] || `#${src}`;
        const dstName = d.animNames[dst] || `#${dst}`;
        const srcHit = replaceAnimHit(src);
        const dstHit = replaceAnimHit(dst);
        // both halves are equally prominent labels (neither is "the qualifier"),
        // joined by an inert arrow — the replacement is as real as the original
        return P.pill({
            cls: "anim",
            hit: srcHit || dstHit,
            segments: [
                P.label(srcName, {
                    hit: srcHit,
                    title: `Base animation replaced: ${srcName} (${src})`,
                    search: P.catQuery("anim", "replace", srcName),
                    finds: `spells replacing ${srcName}`,
                }),
                P.label("→", {cls: "swap-arrow"}),
                P.label(dstName, {
                    hit: dstHit,
                    title: `Played instead: ${dstName} (${dst})`,
                    search: P.catQuery("anim", "replace", dstName),
                    finds: `spells replacing into ${dstName}`,
                }),
                P.cmd(".lo", CFG.animCopyTemplate, {name: dstName, id: dst}),
            ],
        });
    }

    function animTag(animId, groupWord = "", mask = 0, boneset = null) {
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
                // per-anim boneset: only when this kit's anims animate different
                // regions (a uniform kit carries it on the head instead)
                bonesetSegment(boneset),
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

    // `field` is which column owns the category, so a head clicked in the
    // Mechanics column searches mech:seat rather than fx:seat — the head's
    // query has to be the one that would actually select its own pills.
    function fxHeadTag(category, hit, mask = 0, field = "fx") {
        return P.pill({
            cls: "fx-head", hit, segments: [
                P.targets(mask),
                P.label(category, {
                    title: P.hintFor(field, category),
                    search: P.query(field, category),
                    finds: `all spells with a ${category} effect`,
                }),
            ]
        });
    }

    /**
     * One chain (beam) pill: optional tint swatch + texture name.
     * @param {{chainId: number, fid: number, color: number, src?: number, dst?: number}} entry
     * @param {number} [mask] Target mask, when the category head can't carry it.
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
     * @param {PillSegment | null} [extra] An extra segment (a Shadowy attach-point
     *   anchor) to ride in the pill when present.
     * @returns {HTMLElement}
     */
    function colorFxTag(category, color, hit, alpha, mask = 0, extra = null) {
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
                // an effect anchor (Shadowy attach point) rides here when present
                extra,
                P.copy("⧉", `Copy color: ${hex}`, hex),
            ],
        });
    }

    /* Percent-only fx pill (desaturate / transparency): the strength is the
   * whole payload. Desaturate gets a decorative grey swatch keyed to the
   * strength; transparency has no swatch. Clicking searches category + %. */
    function percentFxTag(category, percent, hit) {
        const grey = Math.round(255 * (1 - percent / 200)); // 100% -> mid grey
        return P.pill({
            cls: "fx",
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
                    title: P.hintFor("mech", "seat"),
                    detail: [`Seat at the ${label} attachment point`,
                        "(an M2 attachment slot, not a description of the seat)"],
                    search: P.catQuery("mech", "seat", label),
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
            search: P.catQuery("mech", other, type),
            click: `show the ${count} counterpart${plural} (mech:${other} ${type})`,
        };
        const detail = [`${invis ? "Invisibility" : "Detection"} channel ${type}`,
            invis
                ? (priceless ? "Nothing detects this — nothing can reveal it (priceless)"
                    : `Detected by ${count} spell${plural}`)
                : `Reveals ${count} invisibility spell${plural}`];
        // two divider-separated segments — (id | count), mirroring the model pill's
        // (name | attach) grammar. Both carry the same navigation.
        return P.pill({
            cls: "fx" + (priceless ? " priceless" : ""),
            hit: channelIsHit(side, type),
            segments: [
                P.targets(mask),
                P.label(String(type), {detail, ...nav}),
                P.note(verb, {detail, ...nav}),
            ],
        });
    }

    /* What each movement word means, for the pill's tooltip. The words come
   * from the pack (SPEED_AURAS in build_data), so a word with no line here
   * still renders — it simply says nothing extra.
   * @type {Record<string, string>} */
    const SPEED_MOVEMENT_NOTES = {
        run: "On foot",
        mounted: "On a ground mount",
        swim: "Swimming",
        // six auras share this word: which one applies depends on whether you
        // are mounted or in a vehicle, not on a different kind of movement
        flight: "Flying, mounted or otherwise",
        all: "Running, mounted, swimming and flying alike",
    };

    /**
     * What a percent change LEAVES YOU AT, as a multiple of normal — the reading
     * of the number that a percentage change does not give you directly. Shared
     * by the two routes whose payload is a signed percent, movement speed and
     * object scale, because the arithmetic and the reasoning are the same one.
     *
     * The PILL deliberately shows the change rather than this: the change is
     * what SpellEffect stores (the server applies it with AddPct), what the
     * game's own tooltip prints ("Increases your movement speed by 70%"), and
     * the only form that survives the whole range — 10 speed rows on 9.2.7 are
     * below -100%, which as a resulting speed would be negative. So the
     * multiplier rides the tooltip, where it can simply be absent when it says
     * nothing: below -100% there is nothing meaningful left to name, and -100%
     * itself is the floor `bottom` describes.
     * @param {number} pct
     * @param {string} noun what is being scaled ("speed", "size")
     * @param {string} bottom what a -100% change leaves behind
     * @returns {string} "" when the change has no sensible resulting value
     */
    function changeMultiplier(pct, noun, bottom) {
        const mult = 1 + pct / 100;
        if (mult < 0) return "";
        if (mult === 0) return bottom;
        if (mult === 1) return "";  // a 0% change: the "+0%" already said it
        return `${mult.toFixed(2)}× normal ${noun}`;
    }

    /* Movement-speed pill (SPEED_AURAS in build_data): what the aura scales and
   * by how much —
   *
   *   ( run | +70% )      ( all | -50% )      ( swim | +100% )
   *
   * The movement is the label because it is the identity of the pill; the
   * percent qualifies it, the way an attachment point qualifies a model. Both
   * are clickable and they ask different questions: the movement finds every
   * spell that changes that movement, the percent narrows it to this exact
   * amount.
   *
   * "all" is the one aura that reaches every movement type at once
   * (MOD_DECREASE_SPEED — every snare in the game), so it is a value like the
   * others rather than a collapse the renderer performs: no spell's separate
   * auras ever add up to full coverage (checked on 9.2.7 — the widest reaches
   * four of the five and never swim).
   *
   * The sign is the whole story of faster-vs-slower and the aura NAME is not:
   * "MOD_DECREASE_SPEED" carries a positive amount on 187 rows of 9.2.7. So the
   * pill prints what the data says and never translates it into a verb.
   * @param {{move: string, pct: number, amount: string, key: string}} pill
   */
    function speedTag(pill, mask = 0) {
        const detail = [`Movement speed ${pill.amount}`,
            changeMultiplier(pill.pct, "speed", "Brings movement to a stop"),
            SPEED_MOVEMENT_NOTES[pill.move] || ""];
        return P.pill({
            cls: "fx",
            hit: speedIsHit(pill.key),
            segments: [
                P.targets(mask),
                P.label(pill.move, {
                    title: P.hintFor("mech", "speed"),
                    detail,
                    search: P.catQuery("mech", "speed", pill.move),
                    finds: `spells changing ${pill.move === "all" ? "every movement" : pill.move} speed`,
                }),
                P.note(pill.amount, {
                    title: P.hintFor("mech", "speed"),
                    detail,
                    search: P.catQuery("mech", "speed", `${pill.move} ${pill.amount}`),
                    finds: "spells changing it by exactly this much",
                }),
            ],
        });
    }

    /* Object-scale pill (SCALE_AURAS in build_data): how much bigger or smaller
   * the aura makes its target —
   *
   *   ( scale ( +30% ) )      ( scale ( -50% ) )
   *
   * Movement speed's twin, one axis shorter. There is only one thing these
   * auras scale, so there is no word to put beside the number and the percent
   * is the whole pill — which means the group head ("scale") carries the
   * identity and this renders as a single label, the shape desaturate and
   * transparency already have.
   *
   * Below -100% the unit does not turn inside out: the server floors the result
   * (0.1 for players, 0.01 otherwise), which is what the fourteen rows down to
   * -999% on 9.2.7 really mean. The pill still shows the change, for the same
   * reason speed does — it is what the game stores and prints.
   * @param {{pct: number, amount: string}} pill
   */
    function scaleTag(pill, mask = 0) {
        return P.pill({
            cls: "fx",
            hit: scaleIsHit(pill.pct),
            segments: [
                P.targets(mask),
                P.label(pill.amount, {
                    title: P.hintFor("fx", "scale"),
                    detail: [`Size ${pill.amount}`,
                        changeMultiplier(pill.pct, "size", "Shrinks it to nothing")],
                    search: P.catQuery("fx", "scale", pill.amount),
                    finds: "spells resizing by exactly this much",
                }),
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
                    search: P.catQuery("mech", "keybind", pill.fn),
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
        /** @type {PillSegment[]} */
        const swatches = (/** @type {[string, number, number][]} */ (
            [["fog tint", colors.fog, colors.fogAlpha],
                ["multiply", colors.mul, -1],
                ["addition", colors.add, -1]]))
            .filter(([, c]) => c >= 0)
            .map(([what, c, a]) => P.swatch(hexColor(c), {
                title: `Screen ${what} ${hexColor(c)}`, info: `screen ${what}`, alpha: a,
            }));

        /** @type {string[]} */
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
                effectAttachNote([effectRegionName(d.dissolveAttach.get(entry.dissolveId))], "dissolve"),
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
    function shapeshiftTag(entry, mask = 0, spellId) {
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
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
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

    function morphTag(entry, mask = 0, spellId) {
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
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
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
    /**
     * One gameobject-spawn pill — summon's sibling, in the same column.
     *
     * Entries the world dump does not know are dropped at build, so every pill
     * here resolved something. The LABEL prefers the object's name and falls back
     * to the model's base filename; `.lookup object` always takes the MODEL file
     * regardless, and `.gobject spawn` always takes the entry.
     * @param {number} objectId gameobject_template entry
     * @param {number} mask target bits
     */
    /**
     * Does Wowhead have a page for this gameobject? Keyed on GAMEOBJECT_TYPE,
     * not on whether we resolved a name — see CFG.wowheadObjectTypes for the
     * evidence. A pack with no types (older format) links nothing rather than
     * guessing, since a wrong link 404s.
     * @param {number} objectId
     */
    function hasWowheadPage(objectId) {
        const t = state.data.objectTypes.get(objectId);
        return t !== undefined && (CFG.wowheadObjectTypes || []).includes(t);
    }

    function objectTag(objectId, mask = 0) {
        const d = state.data;
        const name = d.objectNames.get(objectId) || "";
        const fid = d.objectFids.get(objectId) || 0;
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const base = file.base ? stripExt(file.base) : "";
        // .lookup object ALWAYS takes the MODEL file name, never the object's
        // display name (user's call, 2026-07-24 — the name form was a bad match
        // for how Epsilon's lookup actually behaves). No model, no button.
        const lookup = file.base || "";
        return P.pill({
            cls: "fx",
            hit: objectIsHit(objectId),
            segments: [
                // Wowhead only has pages for PLAYER-FACING object types — a door,
                // trap, spell-focus or ritual object has none, and linking one
                // 404s. The type decides it (CFG.wowheadObjectTypes); the name
                // does not, which is why a named GENERIC object still gets no link.
                // Those fall back to the ordinary 3D model viewer, the same
                // either/or the item route uses for a nameless item.
                hasWowheadPage(objectId) && CFG.wowheadObjectUrl && P.link(
                    wowheadUrl(CFG.wowheadObjectUrl, {id: objectId}),
                    `Open object ${objectId} on Wowhead`),
                !hasWowheadPage(objectId) && CFG.modelViewerUrl && fid && P.view(
                    fillTemplate(CFG.modelViewerUrl, {fid}),
                    `Preview ${file.base || `object #${objectId}`} in the WoW.tools model viewer (new tab)`),
                P.targets(mask),
                P.label(name || base || `object #${objectId}`, {
                    title: `${name || "(unnamed object)"} — gameobject ${objectId}`,
                    detail: [file.path || "(model unknown)"],
                    search: P.catQuery("fx", "object", name || base || objectId),
                    finds: "spells placing this object",
                }),
                P.copy("⧉", `Copy object ID: ${objectId}`, String(objectId)),
                lookup && P.cmd(".lo", CFG.objectLookupTemplate, {name: lookup, id: objectId}),
                P.cmd(".gob", CFG.objectSpawnTemplate, {id: objectId}),
            ],
        });
    }

    /**
     * One mount pill (Models column). A display-id pill like morphTag's, but the
     * display is what you RIDE, so the command is `.modify mount` rather than
     * `.morph`. Mount.db2 names every mount it ships, so the label is normally
     * the mount's name with the model file behind it in the tooltip; a nameless
     * display falls back to the model base, then to the bare id.
     * @param {number} displayId CreatureDisplayID
     * @param {number} spellId The spell the pill belongs to (drives the command).
     */
    function mountTag(displayId, spellId) {
        const d = state.data;
        const name = d.mountNames.get(displayId) || "";
        const fid = d.mountFids.get(displayId) || 0;
        const file = fid ? (d.files.get(fid) || {path: "", base: ""}) : {path: "", base: ""};
        const base = file.base ? stripExt(file.base) : "";
        return P.pill({
            cls: "model",
            hit: mountIsHit(displayId),
            segments: [
                CFG.wowheadMorphUrl && P.link(
                    fillTemplate(CFG.wowheadMorphUrl, {id: displayId, spell: spellId}),
                    `View DisplayID ${displayId} in Wowhead's model viewer`),
                P.label(name || base || `#${displayId}`, {
                    title: `${name || "(unnamed mount)"} — display ${displayId}`,
                    detail: [file.path || "(model unknown)"],
                    search: P.catQuery("model", "mount", name || base || displayId),
                    finds: "spells granting this mount",
                }),
                P.copy("⧉", `Copy display ID: ${displayId}`, String(displayId)),
                P.cmd(".mod", CFG.mountModifyTemplate, {id: displayId}),
                file.base && P.cmd(".lo", CFG.morphLookupTemplate,
                    {id: displayId, file: file.base}),
            ],
        });
    }

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
        // the help dialog is part of what a link can point at — "here is the
        // syntax" is a thing people send each other, and without this the only
        // way to share it is a sentence telling someone to click the ?
        if (helpOpen()) params.push("help=1");
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
        return {
            v: get("v"), q, only: get("only"), without: get("without"), sort: get("sort"),
            help: get("help"),
        };
    }

    /** Is the help dialog on screen? (Its own open state is the truth.) */
    const helpOpen = () =>
        !!(/** @type {HTMLDialogElement} */ ($("#help")) || {}).open;

    /**
     * Show or hide the help dialog and write that into the URL, so it survives a
     * reload, a share and the back button. `push` is false while restoring from
     * a popstate — the URL is already what it should be.
     * @param {boolean} on
     * @param {boolean} [push]
     */
    function setHelp(on, push = true) {
        const help = /** @type {HTMLDialogElement} */ ($("#help"));
        if (on === help.open) return;
        // showModal on an open dialog throws; close on a closed one is a no-op
        if (on) help.showModal(); else help.close();
        if (push) stateToUrl(true);
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

    // Un-hide every column a freshly loaded chip list searches into. This is
    // deliberately NOT inside parseQueryParts: that parser is also how the help
    // dialog draws its examples (decorateExamples), and merely rendering help
    // text must not touch the user's column choices — it used to, which is why
    // hiding a column never survived a reload.
    function ensureFieldsVisible(parts) {
        for (const p of parts) ensureFieldVisible(p.field);
    }

    // A shared link may search a field whose column is hidden here —
    // honor the link by un-hiding that column for this session.
    function ensureFieldVisible(field) {
        if (!Search.FIELDS[field] || !hiddenFields().has(field)) return;
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

    /**
     * Run a pill's query. `mode` says how it meets the search already in the bar:
     *
     *   replace   the pill's question on its own — the plain click
     *   add       narrow what is on screen by it — SHIFT-click
     *   exclude   narrow by everything BUT it — CTRL/Cmd-click
     *
     * Shift adds and Ctrl excludes, by the user's call (2026-07-29). The pairing
     * is deliberate: adding is the one you reach for while exploring, and Shift
     * is the easier chord.
     *
     * ADDING IS THE MODIFIER, NOT THE DEFAULT. A pill click is most often "show
     * me this", asked of the whole game; a click that silently kept the last
     * search would make an empty result the ordinary outcome of exploring, and
     * the counterpart pills (an invisibility channel's detectors) navigate to a
     * question the current one contradicts — they would produce nothing at all.
     *
     * BOTH MODIFIERS NARROW. Excluding used to REPLACE the query with a lone
     * exclusion, which selects nearly every spell in the game and answers
     * nothing; it now means "what I am looking at, but not that". With an empty
     * bar it still does exactly what it always did.
     * @param {string} query one chip's worth of query text
     * @param {"replace"|"add"|"exclude"} [mode]
     */
    function crossSearch(query, mode = "replace") {
        const parts = mode === "replace" ? [] : parseQueryParts(serializeQuery());
        // clicking the same pill twice must not stack the same chip twice
        const key = (p) => `${p.not ? "-" : ""}${p.field}:${p.text}`;
        const have = new Set(parts.map(key));
        for (const p of parseQueryParts(mode === "exclude" ? "-" + query : query)) {
            if (!have.has(key(p))) parts.push(p);
        }
        setChips(parts);
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
                        ensureFieldsVisible(parts); // splices chips in without setChips
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

        // the highlight backdrop scrolls with the input it sits under (a long
        // value scrolls inside #q rather than widening the pill)
        input.addEventListener("scroll", () => {
            const box = document.getElementById("qhl");
            if (box) box.scrollLeft = input.scrollLeft;
        });
        // hover behaviour for the marked words in the input: the backdrop is
        // inert, so the input answers for whatever span is under the pointer
        input.addEventListener("mousemove", barHover);
        input.addEventListener("mouseleave", barHoverOut);
        // the caret decides which capsule is lit, and it moves without the value
        // changing — so this cannot ride on syncHighlight alone
        document.addEventListener("selectionchange", () => {
            if (document.activeElement === input) markCaretCapsule();
        });
        input.addEventListener("focus", markCaretCapsule);
        input.addEventListener("blur", markCaretCapsule);

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
            else if (t.dataset.search) {
                // data-nav marks a segment that navigates rather than filters
                // (see clickHint in pills.js) — it only ever replaces
                const mode = t.dataset.nav ? "replace"
                    : e.shiftKey ? "add"
                        : (e.ctrlKey || e.metaKey) ? "exclude" : "replace";
                crossSearch(t.dataset.search, mode);
            }
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
        $("#export-csv").addEventListener("click", Export.csv);
        $("#export-json").addEventListener("click", Export.json);
        $("#export-discord").addEventListener("click", Export.discord);

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
                    localStorage.setItem("epsilook.hiddenCols.v5", JSON.stringify(state.hiddenCols));
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
        $("#help-btn").addEventListener("click", () => setHelp(true));
        $("#help-close").addEventListener("click", () => setHelp(false));
        // Esc and the form's own close bypass the handlers above, so the URL is
        // squared up here — one place, whatever closed it
        help.addEventListener("close", () => {
            if (new URLSearchParams(location.search).has("help")) stateToUrl(true);
        });
        help.addEventListener("click", (e) => {
            if (e.target === help) return setHelp(false); // backdrop click
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
        const canvas = await Texture.load(logo.fid);
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
            // the bar's marking is a property of the PACK — a word only
            // highlights where the loaded version carries that content — and the
            // bar was drawn from the URL before any of this existed. Repaint it
            // here rather than at the ten call sites that can change the pack.
            renderBar();
            decorateExamples();
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
        setHelp(!!h.help, false); // back/forward opens and closes it too
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
        // hand the leaf modules what app.js owns, before anything can call them.
        // versionId is a getter, not a value — the active pack changes underneath.
        Texture.init({versionId: () => state.version.id});
        Export.init({state, targetWordsOf, maskOf, toast, copyText, NO_SCREEN_COLORS});
        // owns no app state — it only needs to run before the header is seen
        Theme.init();
        try {
            // Take only keys we still have a column for. A retired column
            // (Commands) otherwise survives in a returning user's storage and
            // toggles a `hide-*` class that no longer matches anything — and
            // reading through the defaults keeps the storage key stable, so
            // retiring a column costs nobody their other column choices.
            const saved = JSON.parse(localStorage.getItem("epsilook.hiddenCols.v5") || "{}");
            for (const col of Object.keys(state.hiddenCols)) {
                if (typeof saved[col] === "boolean") state.hiddenCols[col] = saved[col];
            }
        } catch (e) { /* corrupted storage — defaults apply */
        }
        buildTabs();
        wireEvents();
        Texture.initHoverPreview();
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
        if (autoExport === "json") Export.json();
        else if (autoExport === "csv") Export.csv();
        // after the pack, so the examples inside it are drawn with a vocabulary.
        // The first search has already rewritten the URL by now (and dropped the
        // flag, the dialog not being open yet), so put it back.
        if (h.help) {
            setHelp(true, false);
            stateToUrl(false);
        } else qInput.focus();
    }

    void boot(); // nothing to await it — boot renders its own load errors
})();
