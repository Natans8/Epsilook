// @ts-check
/* Pill library — the vocabulary every result-cell pill is built from.
 *
 * A PILL is one piece of content in a results column: a model file, a sound,
 * a summoned creature, an invisibility channel. A pill is written as an
 * ordered list of SEGMENTS, left to right, exactly as it renders:
 *
 *   pill({ cls: "model", hit, segments: [
 *     P.view({ href, title }),                       // 3D cube
 *     P.label(name, { title, search, finds }),       // the clickable name
 *     P.targets(mask),                               // who it plays on
 *     P.note(point, { title, search }),              // attachment point
 *     P.cmd(".lo", command),                         // copy button
 *   ]})
 *
 * Falsy segments are dropped, so a conditional section is `cond && P.x(...)`
 * rather than an if/appendChild. Nested arrays flatten, so a variable run of
 * segments (a screen effect's three colour swatches) is just an array.
 *
 * ---------------------------------------------------------------------------
 * Anatomy of a segment
 *
 *   KIND      what it looks like — its class, its content form, which side (if
 *             any) carries a divider. Declared once via defineSegment();
 *             everything below is derived. New kinds are a data entry, not code.
 *   CONTENT   text | img | svg | nodes. Any kind accepts any of them, so an
 *             icon-only variant of a text segment needs no new kind.
 *   ACTION    at most one of search / copy / href / play. The action decides
 *             the element (button / anchor / inert span), composes the tooltip's
 *             closing line, and supplies the accessible name.
 *
 * That split is what keeps the vocabulary small: ten kinds × four content
 * forms × four actions covers every pill in the app, and a genuinely new
 * shape is one defineSegment() call.
 *
 * ---------------------------------------------------------------------------
 * Ordering is a CONVENTION, not a rule the code enforces — see PILLS.md
 * ("Segment order"). Briefly: leading actions, then target icons, then
 * swatch/icon, then the label, then qualifying notes, then copy buttons.
 * The builder renders the array as written, so a pill that needs a different
 * order simply writes one; nothing silently reshuffles it.
 *
 * This file depends only on config.js (for nothing but template filling) and
 * must NOT reach into app.js — pills receive data, they do not fetch it. That
 * is what lets search.js share the type registry below without a cycle.
 */
"use strict";

window.EpsilookPills = (() => {

    /* --------------------------------------------------------------- helpers */

    /**
     * Create an element, optionally with a class and text content.
     * (Local copy: pills.js loads before app.js and must not depend on it.)
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

    /** `{name}` slots in a config template. @type {(tpl: string, vars: Record<string, any>) => string} */
    const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)}/g, (_, k) => vars[k] ?? "");

    /**
     * Join tooltip lines, dropping the empty ones. Every pill tooltip is
     * "what it is" then details then the action hint, so composing it here
     * keeps ~25 hand-written strings from drifting apart.
     * @param {(string | false | 0 | null | undefined)[]} lines
     * @returns {string}
     */
    const tip = (lines) => lines.filter(Boolean).join("\n");

    /**
     * A search value as a chip query: `field:value`, quoted when the value has
     * spaces. Quotes inside the value are dropped — a tag value cannot carry
     * them, and the substring match does not need them.
     * @param {string} field
     * @param {string | number} value
     * @returns {string}
     */
    const query = (field, value) => {
        const v = String(value).replace(/"/g, "");
        return /\s/.test(v) ? `${field}:"${v}"` : `${field}:${v}`;
    };

    /**
     * As `query`, but always quoted. Values taken from game data (file names,
     * creature names, attachment pairs) quote unconditionally: whether today's
     * value happens to contain a space is not a property worth leaking into the
     * shared URL a user copies.
     * @param {string} field
     * @param {string | number} value
     * @returns {string}
     */
    const quoted = (field, value) => `${field}:"${String(value).replace(/"/g, "")}"`;

    /**
     * A search value scoped to a category word — `fx:"chain lightning"`.
     * @param {string} field
     * @param {string} word category word ("" = unscoped)
     * @param {string | number} [value]
     * @returns {string}
     */
    const catQuery = (field, word, value) =>
        query(field, value === undefined || value === "" ? word : `${word} ${value}`.trim());

    /* ------------------------------------------------------- segment kinds */

    /**
     * @typedef {Object} SegmentKind
     * @property {string} cls          class on the rendered element
     * @property {"action"|"content"|"meta"} role  what it is for (see PILLS.md)
     * @property {"none"|"left"|"right"} sep  which side carries a divider
     * @property {string} [wrapCls]    class of the anchor wrapper an interactive
     *                                 image content gets (bare content otherwise)
     * @property {boolean} [inert]     never becomes a button, even with a search
     */

    /** @type {Map<string, SegmentKind>} */
    const KINDS = new Map();

    /**
     * Declare a segment kind. This is the extension point for new pill parts:
     * one entry here plus one CSS rule for `cls`, and every pill can use it.
     * @param {string} kind
     * @param {SegmentKind} spec
     */
    function defineSegment(kind, spec) {
        if (KINDS.has(kind)) throw new Error(`segment kind "${kind}" already defined`);
        KINDS.set(kind, spec);
    }

    /** The built-in vocabulary. Order of declaration = the conventional render order. */
    defineSegment("link", {cls: "wowhead", role: "action", sep: "none"});
    defineSegment("view", {cls: "tag-view", role: "action", sep: "right"});
    defineSegment("play", {cls: "tag-play", role: "action", sep: "right"});
    defineSegment("targets", {cls: "ticons", role: "meta", sep: "none", inert: true});
    defineSegment("swatch", {cls: "fx-swatch", role: "meta", sep: "none", inert: true});
    defineSegment("icon", {cls: "item-icon", role: "content", sep: "none", wrapCls: "item-icon-link"});
    defineSegment("label", {cls: "tag-label", role: "content", sep: "none"});
    defineSegment("note", {cls: "tag-attach", role: "meta", sep: "left"});
    defineSegment("aside", {cls: "tag-ctrl", role: "meta", sep: "none"});
    defineSegment("copy", {cls: "tag-copy", role: "action", sep: "left"});

    /* ------------------------------------------------------- segment render */

    /**
     * One segment, as plain data. Exactly one CONTENT key and at most one
     * ACTION key; everything else is optional decoration.
     * @typedef {Object} Segment
     * @property {string} kind
     * @property {string} [text]    content: a text run
     * @property {string} [svg]     content: inline markup (trusted, ours)
     * @property {{src: string, alt?: string}} [img]  content: an image
     * @property {Node[]} [nodes]   content: pre-built children
     * @property {string} [search]  action: chip query for data-search (may be "")
     * @property {string} [copy]    action: clipboard value for data-copy
     * @property {string} [href]    action: link target (opens in a new tab)
     * @property {string} [play]    action: audio URL for data-play
     * @property {string} [title]   tooltip (already composed)
     * @property {string} [aria]    accessible name, when the content is a glyph
     * @property {boolean} [hit]    matched by the current query
     * @property {string} [cls]     extra classes
     * @property {string} [bg]      background colour (swatches)
     * @property {Record<string, string|number>} [data]  extra data-* attributes
     */

    /** The keys that make a segment interactive, and the ones that fill it. */
    const ACTION_KEYS = ["search", "copy", "href", "play"];
    const CONTENT_KEYS = ["text", "svg", "img", "nodes"];

    /**
     * Render one segment. Attributes are applied in a fixed order (class,
     * sep/role, type, link attrs, title, aria, then data-*) so the markup is
     * predictable to read and to diff.
     *
     * The two invariants — one content form, at most one action — are checked
     * rather than assumed: a segment with two actions has no sensible element,
     * and one with two contents would silently drop whichever the if-chain
     * reaches second. Both are mistakes a new pill type can easily make, so
     * they fail loudly at the call site instead of rendering something odd.
     * @param {Segment} seg
     * @returns {HTMLElement}
     */
    function renderSegment(seg) {
        const kind = KINDS.get(seg.kind);
        if (!kind) throw new Error(`unknown segment kind "${seg.kind}"`);

        const actions = ACTION_KEYS.filter((k) => seg[k] !== undefined);
        if (actions.length > 1) {
            throw new Error(`segment "${seg.kind}" has several actions: ${actions.join(", ")}`);
        }
        const contents = CONTENT_KEYS.filter((k) => seg[k] !== undefined);
        if (contents.length > 1) {
            throw new Error(`segment "${seg.kind}" has several contents: ${contents.join(", ")}`);
        }

        const interactive = !kind.inert && actions.length > 0;

        /* Image content is the one case where the element itself varies: an inert
         * image IS the segment, while a clickable one needs an anchor around it.
         * Which of the two carries the kind's class is a per-kind call — the
         * Wowhead favicon styles its anchor and leaves the <img> bare, an item
         * icon styles the <img> and gives its anchor a wrapper class — so a kind
         * declaring `wrapCls` is saying "style the image, not the link". */
        const imgOnly = seg.img && !interactive;
        const wrapped = seg.img && interactive && !!kind.wrapCls;
        /** @type {any} */
        const tag = imgOnly ? "img" : (!interactive ? "span"
            : (seg.href !== undefined ? "a" : "button"));

        const node = el(tag, wrapped ? kind.wrapCls : kind.cls);
        if (seg.cls) node.className += " " + seg.cls;
        if (seg.hit) node.classList.add("hit");
        // The divider between sections is a property of the KIND, not of the pill
        // that happens to use it — so it is declared once (sep/role) and drawn by
        // two CSS rules, rather than a border repeated on every segment class.
        if (kind.sep !== "none") node.dataset.sep = kind.sep;
        node.dataset.role = kind.role;

        if (node.tagName === "BUTTON") /** @type {HTMLButtonElement} */ (node).type = "button";
        if (seg.href !== undefined) {
            const a = /** @type {HTMLAnchorElement} */ (node);
            a.href = seg.href;
            a.target = "_blank";
            a.rel = "noopener";
        }
        if (seg.title) node.title = seg.title;
        if (seg.aria) node.setAttribute("aria-label", seg.aria);
        if (seg.search !== undefined) node.dataset.search = seg.search;
        if (seg.copy !== undefined) node.dataset.copy = seg.copy;
        if (seg.play !== undefined) node.dataset.play = seg.play;
        if (seg.bg) node.style.background = seg.bg;
        for (const [k, v] of Object.entries(seg.data || {})) {
            if (v !== undefined && v !== null && v !== "") node.dataset[k] = String(v);
        }

        // content
        if (seg.img) {
            const img = imgOnly ? /** @type {HTMLImageElement} */ (node)
                : el("img", wrapped ? kind.cls : undefined);
            img.src = seg.img.src;
            img.alt = seg.img.alt || "";
            img.loading = "lazy";
            if (!imgOnly) node.appendChild(img);
        } else if (seg.svg) {
            node.innerHTML = seg.svg;
        } else if (seg.nodes) {
            for (const n of seg.nodes) node.appendChild(n);
        } else if (seg.text !== undefined) {
            node.textContent = seg.text;
        }
        return node;
    }

    /* ---------------------------------------------------------------- pills */

    /**
     * @typedef {Object} PillSpec
     * @property {string} [cls]   classes after "tag" ("model", "fx flat", ...)
     * @property {boolean} [hit]  matched by the current query
     * @property {string} [title] tooltip on the pill body itself
     * @property {(Segment | false | null | undefined | any[])[]} segments
     */

    /**
     * Build one pill from its segments, in the order written. Falsy entries and
     * nested arrays are the conditional/variable-length forms.
     * @param {PillSpec} spec
     * @returns {HTMLElement}
     */
    function pill(spec) {
        const tag = el("span", "tag" + (spec.cls ? " " + spec.cls : ""));
        if (spec.hit) tag.classList.add("hit");
        if (spec.title) tag.title = spec.title;
        for (const seg of spec.segments.flat(2)) {
            if (seg) tag.appendChild(renderSegment(/** @type {Segment} */ (seg)));
        }
        return tag;
    }

    /* --------------------------------------------------------------- groups */

    /**
     * A GROUP is a pill-shaped container of other pills: a SoundKit and its
     * files, an AnimKit and its animations, an fx category and its effects. It
     * has one head (itself a pill) and zero or more items.
     *
     * THE ITEM COUNT DECIDES THE SHAPE, and that is the whole point of the
     * abstraction. A group holding one item (or none) renders as a single
     * inline pill — head dimmed, the lone item fused into it — instead of a
     * full-width strip. Everything else about it is identical, so a group that
     * is usually one-of-a-kind and occasionally many needs one renderer, not
     * two, and no caller has to predict which it will be.
     *
     * This is unconditional on purpose. It used to be opt-in, and only the two
     * columns whose author added it passed the flag — so a SoundKit with one
     * file and an AnimKit with one animation (56–98% of them, depending on the
     * query) stretched across a full strip while an identically-sized fx
     * category sat inline. A rule that describes the shape of a group cannot
     * be something each caller remembers separately.
     * @param {{head: HTMLElement, items: HTMLElement[]}} spec
     * @returns {HTMLElement}
     */
    function group(spec) {
        const box = el("div", "kit-group");
        if (spec.items.length <= 1) box.classList.add("compact");
        if (spec.head.classList.contains("hit")) box.classList.add("hit");

        const head = el("div", "kit-head");
        head.appendChild(spec.head);
        box.appendChild(head);

        if (spec.items.length) {
            const items = el("div", "kit-files");
            for (const item of spec.items) items.appendChild(item);
            box.appendChild(items);
        }
        return box;
    }

    /* ------------------------------------------------------- target icons */

    /* Who a piece of content plays on, from SpellVisualEvent.TargetType (see
     * TARGET_BITS in build_data.py). Every type is marked — there is no unmarked
     * default — and a row whose mask has several bits renders one icon per bit
     * rather than a fused glyph: the mixes are common (16.5% of model rows are
     * caster+target on 9.2.7) and the rarer ones (caster+area) have no sensible
     * single glyph. Masters live in build/icons/*.svg with a preview page at
     * build/target_icons.html. */
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
            title: (/** @type {number} */ mask) => (mask & TARGET_AREA
                ? "In the spell's area of effect"
                : "Where the missile lands"),
        },
    ];

    /**
     * The icon glyphs for a target mask, as segment children.
     * @param {number} mask
     * @returns {HTMLElement[]}
     */
    function targetIconNodes(mask) {
        const out = [];
        for (const icon of TARGET_ICONS) {
            if (!(mask & icon.bits)) continue;
            const span = el("span", `ticon ${icon.cls}`);
            span.title = icon.title(mask);
            span.innerHTML = icon.svg;
            out.push(span);
        }
        return out;
    }

    /* --------------------------------------------------- segment shorthands */

    /* One constructor per kind, so a pill reads as a list of named parts rather
     * than a list of {kind: "..."} literals. Each is a thin wrapper: it composes
     * the tooltip and the accessible name from the same conventions, and returns
     * plain data (nothing is rendered until pill() runs). */

    /** Wowhead favicon link. */
    const link = (href, title) => ({
        kind: "link", href, title,
        img: {src: "https://wow.zamimg.com/images/logos/favicon-standard.png", alt: "WH"},
    });

    /* wireframe cube (the universal 3D-preview glyph); stroke inherits
     * currentColor so the gold hover tint applies */
    const CUBE_SVG =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        + 'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'
        + '<path d="M12 2.5 21 7.5v9l-9 5-9-5v-9z"/>'
        + '<path d="M12 12.2 21 7.5M12 12.2v9.3M12 12.2 3 7.5"/></svg>';

    /** 3D model-viewer link (glyph-only, hence the explicit accessible name). */
    const view = (href, title) => ({kind: "view", href, title, aria: title, svg: CUBE_SVG});

    /** ▶ sound playback. */
    const play = (url, title) => ({kind: "play", play: url, title, aria: title, text: "▶"});

    /** Target-type icons. Renders nothing for an empty mask. */
    const targets = (mask) => (mask
        ? {kind: "targets", nodes: targetIconNodes(mask)}
        : null);

    /**
     * Colour dot.
     * @param {string} hex
     * @param {{title?: string, info?: string, alpha?: number}} [opts] `info`
     *   names the colour for the hover panel; `alpha` rides along where the
     *   source has a real opacity byte.
     */
    const swatch = (hex, opts = {}) => ({
        kind: "swatch", bg: hex, title: opts.title,
        data: {
            color: opts.info === undefined ? undefined : hex,
            colorInfo: opts.info,
            alpha: opts.alpha >= 0 ? opts.alpha : undefined,
        },
    });

    /** Inventory icon, optionally linking out. */
    const icon = (src, opts = {}) => ({
        kind: "icon", img: {src}, href: opts.href, title: opts.title,
        aria: opts.href ? opts.title : undefined, data: opts.data,
    });

    /**
     * What every text segment accepts. The tooltip is always composed the same
     * way — what it is, then details, then the action line — so no renderer
     * hand-writes one.
     * @typedef {Object} SegmentOpts
     * @property {string} [title]   first tooltip line: what this is
     * @property {(string|false|0)[]} [detail]  further lines, falsy ones dropped
     * @property {string} [search]  chip query to run on click ("" = inert click
     *                              target, absent = not a button at all)
     * @property {string} [finds]   completes "Click: find <finds>"
     * @property {string} [click]   replaces the whole action phrase
     * @property {boolean} [hit]    matched by the current query
     * @property {Record<string, any>} [data]  extra data-* attributes
     * @property {string} [cls]     extra class on the segment element
     */

    /**
     * The pill's name — its main clickable text.
     * @param {string} text
     * @param {SegmentOpts} [opts]
     */
    const label = (text, opts = {}) => textSegment("label", text, opts);

    /** A dim qualifier after the label (attachment point, counterpart count). */
    const note = (text, opts = {}) => textSegment("note", text, opts);

    /** A dim word beside the label (a summon's control type). */
    const aside = (text, opts = {}) => textSegment("aside", text, opts);

    /**
     * The three text segments differ only in kind — one body, so a tooltip or
     * action convention can never apply to some of them and not others.
     * @param {string} kind
     * @param {string} text
     * @param {SegmentOpts} opts
     * @returns {Segment}
     */
    function textSegment(kind, text, opts) {
        return {
            kind, text, search: opts.search, hit: opts.hit, data: opts.data, cls: opts.cls,
            title: tip([opts.title, ...(opts.detail || []), clickHint(opts)]),
        };
    }

    /**
     * Copy button. The glyph is "⧉" for an id, or the command itself (".lo",
     * ".morph", "/") — so the accessible name has to spell out what it copies.
     */
    const copy = (glyph, title, value) => ({
        kind: "copy", text: glyph, copy: value, aria: title,
        title: `${title}\nShift-click: copy wrapped in \`backticks\``,
    });

    /** Copy button for a filled command template. */
    const cmd = (glyph, template, vars) => {
        const text = fillTemplate(template, vars);
        return copy(glyph, `Copy:  ${text}`, text);
    };

    /**
     * The closing line of a clickable segment's tooltip. Composed here so all
     * ~25 of them stay identically worded: `finds` fills the usual "find X"
     * phrasing, `click` replaces the whole action for the rare segment that
     * navigates rather than filters ("show the 3 counterparts").
     * @param {{search?: string, finds?: string, click?: string}} opts
     */
    function clickHint(opts) {
        const action = opts.click || (opts.finds && `find ${opts.finds}`);
        if (opts.search === undefined || !action) return "";
        return `Click: ${action} · Shift-click: exclude`;
    }

    /* ==================================================================== */
    /* PILL-TYPE REGISTRY                                                    */
    /* ==================================================================== */

    /* One record per kind of content the app can show and search: what it is
     * called, how it renders, and — crucially — how a query token decides
     * whether it matches. app.js reads it to light a pill up (`.hit`) and to
     * offer its word in autocomplete; search.js reads the SAME record to select
     * spells. Those two used to be hand-written twins in different files, kept
     * in step by comments saying "keep in lockstep with…" — the drift they
     * warned about is now structurally impossible.
     *
     * MATCHING. Every token must satisfy at least one axis of the type:
     *
     *   text     the id's corpus (a lowercase haystack baked by data.js), or,
     *            for a type with no per-id corpus, the category word itself
     *   bare     a bare number that IS the id's identity (an invisibility type)
     *   numeric  a number the id CARRIES — a count of things (a vehicle's seats)
     *            or a value (a desaturation percent). `operatorOnly` reserves
     *            bare numbers for the other axes: without an operator the token
     *            keeps its text/bare meaning, which is what lets fx:"invis 13"
     *            mean type 13 while fx:"invis =0" means "nothing detects it".
     *
     * KEYWORDS. A type with a `word` contributes it to its field's autocomplete,
     * with `hint` as the description, gated by `when(data)` so a pack that
     * lacks the content never offers the word. Several types may share one word
     * (ghost is fed by two unrelated tables); the word is offered once.
     */

    /**
     * @typedef {Object} PillNumericAxis
     * @property {"count"|"value"} kind  what the number means, for the docs
     * @property {(data: any, id: any) => number} of
     * @property {boolean} [operatorOnly] bare numbers are NOT this axis
     */

    /**
     * @typedef {Object} PillType
     * @property {string} key      unique id of the type
     * @property {string} field    the search field / column it belongs to
     * @property {string} [word]   its category word; absent = no keyword
     * @property {string} [hint]   one-line description (autocomplete + tooltip)
     * @property {(data: any) => Map<any, string>} [corpus] id -> lowercase text
     * @property {(data: any) => Map<any, number[]> | Set<number>} [spells]
     * @property {PillNumericAxis} [numeric]
     * @property {(data: any, id: any) => number|string} [bare]
     * @property {(data: any) => boolean} [when] does this pack carry it?
     */

    /** @type {Map<string, PillType>} */
    const TYPES = new Map();

    /**
     * Register a content type. This plus a renderer is the whole of "add a new
     * pill type": hit-highlighting, the search scan, the category head, the
     * autocomplete word and its description all follow from this record.
     * @param {PillType} type
     */
    function defineType(type) {
        if (TYPES.has(type.key)) throw new Error(`pill type "${type.key}" already defined`);
        TYPES.set(type.key, type);
    }

    /** Every registered type of one field, in declaration order. */
    const typesFor = (field) => [...TYPES.values()].filter((t) => t.field === field);

    /**
     * The haystack a token is matched against. A type with no per-id corpus
     * (freeze, the invisibility channels) is matched on its category word —
     * which is exactly what its corpus would contain if it had one.
     * @param {PillType} type
     * @param {any} data
     * @param {any} id
     * @returns {string}
     */
    function corpusOf(type, data, id) {
        if (!type.corpus) return type.word || "";
        return type.corpus(data).get(id) || "";
    }

    /**
     * Does one query token match this id of this type? The one place the axes
     * are combined — every caller, in both files, goes through here.
     * @param {PillType} type
     * @param {any} data
     * @param {any} id
     * @param {string} corpusL  precomputed corpusOf (hoisted out of the loop)
     * @param {{text: string}} token
     * @returns {boolean}
     */
    function tokenMatches(type, data, id, corpusL, token) {
        const text = token.text;
        if (corpusL.includes(text)) return true;
        const operator = /^[<>=]/.test(text);
        if (type.bare && !operator && String(type.bare(data, id)) === text) return true;
        if (type.numeric && !(type.numeric.operatorOnly && !operator)) {
            // the value may be signed (a movement-speed change is negative when
            // it slows), so a comparison may name a negative bound: "<-50"
            const m = /^(<=|>=|<|>|=)?(-?\d+(?:\.\d+)?)$/.exec(text);
            if (m) {
                const n = type.numeric.of(data, id), v = Number(m[2]);
                switch (m[1]) {
                    case "<":
                        return n < v;
                    case ">":
                        return n > v;
                    case "<=":
                        return n <= v;
                    case ">=":
                        return n >= v;
                    default:
                        return n === v;
                }
            }
        }
        return false;
    }

    /**
     * Does this id satisfy a whole chip? (Every token must match — the group
     * semantics the rest of the search uses.)
     * @param {PillType} type
     * @param {any} data
     * @param {any} id
     * @param {{text: string}[]} tokens
     * @returns {boolean}
     */
    function idMatches(type, data, id, tokens) {
        const corpusL = corpusOf(type, data, id);
        for (const t of tokens) {
            if (!tokenMatches(type, data, id, corpusL, t)) return false;
        }
        return true;
    }

    /**
     * Add every spell reached by a type's matching ids to `out`. This is the
     * search side; app.js's hit test is idMatches on a single id.
     * @param {PillType} type
     * @param {any} data
     * @param {{text: string}[]} tokens
     * @param {Set<number>} out
     */
    function scanType(type, data, tokens, out) {
        if (!type.spells) return;
        const spells = type.spells(data);
        // a Set is the valueless shape (freeze/camo): no ids, the word is the
        // whole query, and every spell in the set matches or none does
        if (spells instanceof Set) {
            if (idMatches(type, data, null, tokens)) for (const s of spells) out.add(s);
            return;
        }
        for (const [id, ids] of spells) {
            if (idMatches(type, data, id, tokens)) for (const s of ids) out.add(s);
        }
    }

    /**
     * The category words a field offers in autocomplete, with descriptions.
     * Deduped by word (ghost has two feeding types) and filtered by `when`, so
     * a pack without the content never suggests it.
     * @param {string} field
     * @param {any} data
     * @returns {{words: string[], titles: Record<string, string>}}
     */
    function keywordsFor(field, data) {
        const words = [];
        /** @type {Record<string, string>} */
        const titles = {};
        for (const type of typesFor(field)) {
            if (!type.word || (type.when && !type.when(data))) continue;
            if (!words.includes(type.word)) words.push(type.word);
            if (type.hint && !titles[type.word]) titles[type.word] = type.hint;
        }
        return {words, titles};
    }

    /** Description of one category word, for a head pill's tooltip. */
    const hintFor = (field, word) =>
        (typesFor(field).find((t) => t.word === word) || {}).hint || "";

    return {
        // builders
        pill, group, defineSegment, renderSegment,
        // segment constructors
        link, view, play, targets, swatch, icon, label, note, aside, copy, cmd,
        // pill-type registry
        defineType, typesFor, idMatches, scanType, keywordsFor, hintFor, TYPES,
        // composition helpers
        tip, query, quoted, catQuery, fillTemplate, el,
        // target-mask vocabulary
        TARGET_CASTER, TARGET_TARGET, TARGET_AREA, TARGET_NOT_CASTER,
        TARGET_MISSILE_DEST, TARGET_ICONS, targetIconNodes, CUBE_SVG,
        KINDS,
    };
})();
