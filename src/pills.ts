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
 * Ordering is a CONVENTION, not a rule the code enforces — see docs/PILLS.md
 * ("Segment order"). Briefly: leading actions, then target icons, then
 * swatch/icon, then the label, then qualifying notes, then copy buttons.
 * The builder renders the array as written, so a pill that needs a different
 * order simply writes one; nothing silently reshuffles it.
 *
 * This module must NOT reach into the app modules — pills receive data, they
 * do not fetch it. That is what lets search.ts share the type registry below
 * without a cycle.
 */
import type {SpellData} from "./data";
import {el, fillTemplate} from "./util";

export {fillTemplate};

/* --------------------------------------------------------------- helpers */

/**
 * Join tooltip lines, dropping the empty ones. Every pill tooltip is
 * "what it is" then details then the action hint, so composing it here
 * keeps ~25 hand-written strings from drifting apart.
 */
export const tip = (lines: (string | false | 0 | null | undefined)[]): string =>
    lines.filter(Boolean).join("\n");

/**
 * One chip's value as query text — THE canonical rule, and the only one.
 * A bare word stays bare; a value with spaces takes "grouping quotes"; a
 * value that already contains phrase quotes takes (parens) instead, so the
 * two kinds of quote never collide.
 *
 * It lives here because both sides need it: every pill query is built through
 * this, and the app serializes its chips through it too. They used to
 * disagree — pills DELETED inner quotes, which silently broke any query
 * carrying a quoted keyword value (`boneset "Upper Body"` came back as
 * `boneset Upper Body`, a different search). One rule is what makes a pill
 * click round-trip through the URL.
 */
export const tagValue = (text: string): string =>
    text.includes('"') ? `(${text})` : /\s/.test(text) ? `"${text}"` : text;

/** A whole chip as query text, optionally negated. */
export const tagQuery = (field: string, text: string, not?: boolean): string =>
    `${not ? "-" : ""}${field}:${tagValue(text)}`;

/** A search value as a chip query: `field:value`, grouped when it needs it. */
export const query = (field: string, value: string | number): string =>
    tagQuery(field, String(value));

/**
 * As `query`, but a value with no spaces is still quoted. Values taken from
 * game data (file names, creature names, attachment pairs) quote
 * unconditionally: whether today's value happens to contain a space is not a
 * property worth leaking into the shared URL a user copies. A value carrying
 * phrase quotes still takes the paren form — that is not optional.
 */
export const quoted = (field: string, value: string | number): string => {
    const v = String(value);
    return v.includes('"') ? `${field}:(${v})` : `${field}:"${v}"`;
};

/** A search value scoped to a category word — `fx:"chain lightning"`. */
export const catQuery = (field: string, word: string, value?: string | number): string =>
    query(field, value === undefined || value === "" ? word : `${word} ${value}`.trim());

/* ------------------------------------------------------- segment kinds */

export interface SegmentKind {
    /** class on the rendered element */
    cls: string;
    /** what it is for (see docs/PILLS.md) */
    role: "action" | "content" | "meta";
    /** which side carries a divider */
    sep: "none" | "left" | "right";
    /** class of the anchor wrapper an interactive image content gets
     *  (bare content otherwise) */
    wrapCls?: string;
    /** never becomes a button, even with a search */
    inert?: boolean;
}

export const KINDS = new Map<string, SegmentKind>();

/**
 * Declare a segment kind. This is the extension point for new pill parts:
 * one entry here plus one CSS rule for `cls`, and every pill can use it.
 */
export function defineSegment(kind: string, spec: SegmentKind): void {
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
// a note that clamps harder: missile flight-path names run to 40+ characters
// ("5.2 Legendary Scenario - Throw Axes") and a note's 14rem is wide enough to
// push the copy button out of the Models column. Same role and divider as a
// note — only the width budget differs, which is why it is a kind and not a
// second meaning for `note`.
defineSegment("motion", {cls: "tag-motion", role: "meta", sep: "left"});
defineSegment("aside", {cls: "tag-ctrl", role: "meta", sep: "none"});
defineSegment("copy", {cls: "tag-copy", role: "action", sep: "left"});

/* ------------------------------------------------------- segment render */

/**
 * One segment, as plain data. Exactly one CONTENT key and at most one
 * ACTION key; everything else is optional decoration.
 */
export interface Segment {
    kind: string;
    /** content: a text run */
    text?: string;
    /** content: inline markup (trusted, ours) */
    svg?: string;
    /** content: an image */
    img?: { src: string; alt?: string };
    /** content: pre-built children */
    nodes?: Node[];
    /** action: chip query for data-search (may be "") */
    search?: string;
    /** action: clipboard value for data-copy */
    copy?: string;
    /** action: link target (opens in a new tab) */
    href?: string;
    /** action: audio URL for data-play */
    play?: string;
    /** tooltip (already composed) */
    title?: string;
    /** accessible name, when the content is a glyph */
    aria?: string;
    /** matched by the current query */
    hit?: boolean;
    /** extra classes */
    cls?: string;
    /** background colour (swatches) */
    bg?: string;
    /** extra data-* attributes; undefined/null/"" entries are dropped */
    data?: Record<string, unknown>;
}

/** A segment slot: falsy entries are dropped, arrays flatten. */
export type PillSlot = Segment | false | null | undefined | "" | 0 | PillSlot[];

/** The keys that make a segment interactive, and the ones that fill it. */
const ACTION_KEYS = ["search", "copy", "href", "play"] as const;
const CONTENT_KEYS = ["text", "svg", "img", "nodes"] as const;

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
 */
export function renderSegment(seg: Segment): HTMLElement {
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
    const tag: "img" | "span" | "a" | "button" = imgOnly ? "img" : (!interactive ? "span"
        : (seg.href !== undefined ? "a" : "button"));

    const node: HTMLElement = el(tag, wrapped ? kind.wrapCls : kind.cls);
    if (seg.cls) node.className += " " + seg.cls;
    if (seg.hit) node.classList.add("hit");
    // The divider between sections is a property of the KIND, not of the pill
    // that happens to use it — so it is declared once (sep/role) and drawn by
    // two CSS rules, rather than a border repeated on every segment class.
    if (kind.sep !== "none") node.dataset.sep = kind.sep;
    node.dataset.role = kind.role;

    if (node instanceof HTMLButtonElement) {
        node.type = "button";
    }
    if (seg.href !== undefined) {
        const a = node as HTMLAnchorElement;
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
        const img = imgOnly ? node as HTMLImageElement
            : el("img", wrapped ? kind.cls : undefined);
        // An EMPTY src is "not resolved yet", not "no image": assigning "" makes
        // the browser re-request the page itself. The expansion logo renders
        // this way — its art is decoded asynchronously and written in later —
        // so leaving the attribute off keeps the alt text showing meanwhile.
        if (seg.img.src) img.src = seg.img.src;
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

export interface PillSpec {
    /** classes after "tag" ("model", "fx flat", ...) */
    cls?: string;
    /** matched by the current query */
    hit?: boolean;
    /** tooltip on the pill body itself */
    title?: string;
    segments: PillSlot[];
}

/**
 * Build one pill from its segments, in the order written. Falsy entries and
 * nested arrays are the conditional/variable-length forms.
 */
export function pill(spec: PillSpec): HTMLElement {
    const tag = el("span", "tag" + (spec.cls ? " " + spec.cls : ""));
    if (spec.hit) tag.classList.add("hit");
    if (spec.title) tag.title = spec.title;
    for (const seg of spec.segments.flat(2) as (Segment | false | null | undefined | "" | 0)[]) {
        if (seg) tag.appendChild(renderSegment(seg));
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
 */
/**
 * Does this pill or group hold a search hit anywhere inside it?
 *
 * THE ONE ANSWER to "did the query hit this thing" for the code that ranks a
 * cell's contents. It reads the `.hit` class THIS module writes — the pill's
 * own, one segment's, or an item's inside a group — so what is gold and what
 * floats to the top of a cell cannot disagree.
 *
 * It exists because they did disagree, twice, the same way. A segment with its
 * own hit test lit up gold while its cell went on ranking by the file corpus
 * alone, so the row that was asked for sank to the BOTTOM of its cell — where
 * clampCell hides it behind "+N more". `attach` did it first and `motion`
 * repeated it, because the rank was re-derived beside the cell instead of read
 * off the pill. Anything a future segment kind can light, this can see.
 */
export function holdsHit(el: HTMLElement): boolean {
    return el.classList.contains("hit") || el.querySelector(".hit") !== null;
}

export function group(spec: { head: HTMLElement; items: HTMLElement[] }): HTMLElement {
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
export const TARGET_CASTER = 1, TARGET_TARGET = 2, TARGET_AREA = 4,
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
export const TARGET_ICONS: { bits: number; cls: string; svg: string; title(mask: number): string }[] = [
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
        title: (mask: number) => (mask & TARGET_AREA
            ? "In the spell's area of effect"
            : "Where the missile lands"),
    },
];

/** The icon glyphs for a target mask, as segment children. */
function targetIconNodes(mask: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const icon of TARGET_ICONS) {
        if ((mask & icon.bits) === 0) continue;
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
export const link = (href: string, title: string): Segment => ({
    kind: "link", href, title,
    img: {src: "https://wow.zamimg.com/images/logos/favicon-standard.png", alt: "WH"},
});

/* wireframe cube (the universal 3D-preview glyph); stroke inherits
 * currentColor so the gold hover tint applies */
export const CUBE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">'
    + '<path d="M12 2.5 21 7.5v9l-9 5-9-5v-9z"/>'
    + '<path d="M12 12.2 21 7.5M12 12.2v9.3M12 12.2 3 7.5"/></svg>';

/** 3D model-viewer link (glyph-only, hence the explicit accessible name). */
export const view = (href: string, title: string): Segment =>
    ({kind: "view", href, title, aria: title, svg: CUBE_SVG});

/** ▶ sound playback. */
export const play = (url: string, title: string): Segment =>
    ({kind: "play", play: url, title, aria: title, text: "▶"});

/** Target-type icons. Renders nothing for an empty mask. */
export const targets = (mask: number, hit = false): Segment | null => (mask
    ? {kind: "targets", nodes: targetIconNodes(mask), hit}
    : null);

/**
 * Colour dot. `info` names the colour for the hover panel; `alpha` rides
 * along where the source has a real opacity byte.
 */
export const swatch = (hex: string, opts: { title?: string; info?: string; alpha?: number } = {}): Segment => ({
    kind: "swatch", bg: hex, title: opts.title,
    data: {
        color: opts.info === undefined ? undefined : hex,
        colorInfo: opts.info,
        alpha: opts.alpha !== undefined && opts.alpha >= 0 ? opts.alpha : undefined,
    },
});

/** Inventory icon, optionally linking out. */
export const icon = (src: string, opts: {
    href?: string; title?: string; data?: Record<string, unknown>;
} = {}): Segment => ({
    kind: "icon", img: {src}, href: opts.href, title: opts.title,
    aria: opts.href ? opts.title : undefined, data: opts.data,
});

/**
 * What every text segment (label / note / aside) accepts. The tooltip is
 * always composed the same way — what it is, then details, then the action
 * line — so no renderer hand-writes one.
 */
export interface SegmentOpts {
    /** first tooltip line: what this is */
    title?: string;
    /** further lines, falsy ones dropped */
    detail?: (string | false | 0 | undefined)[];
    /** chip query to run on click ("" = inert click target,
     *  absent = not a button at all) */
    search?: string;
    /** completes "Click: find <finds>" */
    finds?: string;
    /** replaces the whole action phrase */
    click?: string;
    /** matched by the current query */
    hit?: boolean;
    /** extra data-* attributes */
    data?: Record<string, unknown>;
    /** extra class on the segment element */
    cls?: string;
}

/**
 * Any kind, with an IMAGE where its text would go — the documented "ten kinds ×
 * four content forms" crossing, which until the expansion logo only existed for
 * the `icon` kind's own helper. `alt` is what the segment reads as while the
 * image is loading or if it never arrives, so it must be the real short name
 * rather than "".
 */
export const imageOf = (kind: string, img: { src: string; alt?: string },
                        opts: SegmentOpts = {}): Segment =>
    ({...textSegment(kind, "", opts), text: undefined, img});

/** The pill's name — its main clickable text. */
export const label = (text: string, opts: SegmentOpts = {}): Segment =>
    textSegment("label", text, opts);

/** A dim qualifier after the label (attachment point, counterpart count). */
export const note = (text: string, opts: SegmentOpts = {}): Segment =>
    textSegment("note", text, opts);

/** A note with a tighter width budget (a missile's flight path). */
export const motion = (text: string, opts: SegmentOpts = {}): Segment =>
    textSegment("motion", text, opts);

/** A dim word beside the label (a summon's control type). */
export const aside = (text: string, opts: SegmentOpts = {}): Segment =>
    textSegment("aside", text, opts);

/**
 * The three text segments differ only in kind — one body, so a tooltip or
 * action convention can never apply to some of them and not others.
 */
function textSegment(kind: string, text: string, opts: SegmentOpts): Segment {
    return {
        kind, text, search: opts.search, hit: opts.hit, cls: opts.cls,
        // `click` marks a segment that NAVIGATES — it asks a different
        // question from the one on screen, so the click handler must not offer
        // to fold it into the current search. That distinction already existed
        // for the tooltip's sake; data-nav just lets the handler read it.
        data: opts.click && opts.search !== undefined
            ? {...opts.data, nav: 1} : opts.data,
        title: tip([opts.title, ...(opts.detail || []), clickHint(opts)]),
    };
}

/**
 * Copy button. The glyph is "⧉" for an id, or the command itself (".lo",
 * ".morph", "/") — so the accessible name has to spell out what it copies.
 */
export const copy = (glyph: string, title: string, value: string, cls?: string): Segment => ({
    kind: "copy", text: glyph, copy: value, aria: title, cls,
    title: `${title}\nShift-click: copy wrapped in \`backticks\``,
});

/**
 * Copy button for a filled command template. `glyph` is what the button SHOWS,
 * which is routinely an abbreviation (`.lo`, `.mod`) of the command it copies —
 * the tooltip carries the real thing, so the pill spends width on the value and
 * not on the label.
 */
export const cmd = (glyph: string, template: string, vars: Record<string, string | number>): Segment => {
    const text = fillTemplate(template, vars);
    return copy(glyph, `Copy:  ${text}`, text);
};

/**
 * The closing line of a clickable segment's tooltip. Composed here so all
 * ~25 of them stay identically worded: `finds` fills the usual "find X"
 * phrasing, `click` replaces the whole action for the rare segment that
 * navigates rather than filters ("show the 3 counterparts").
 */
function clickHint(opts: { search?: string; finds?: string; click?: string }): string {
    const action = opts.click || (opts.finds && `find ${opts.finds}`);
    if (opts.search === undefined || !action) return "";
    // The middle-click is on BOTH branches: it asks the segment's own question
    // in a new tab, which a navigating segment has just as much as a filtering
    // one. The modifiers are what it does not get — those narrow what is on
    // screen, and a new tab has nothing on screen yet to narrow.
    const newTab = "Middle-click: open in a new tab";
    // a navigating segment replaces the search and nothing else: narrowing
    // by "the counterpart of what is on screen" is a query for no spell
    if (opts.click) return `Click: ${action}\n${newTab}`;
    return `Click: ${action}\nShift-click: add to search · Ctrl-click: exclude\n${newTab}`;
}

/**
 * Every gesture the app can put in a tooltip, and the ONLY things `tooltip.ts`
 * lifts out of the prose into its key map.
 *
 * AN EXPLICIT LIST, NOT "any line with a colon", and the counter-example is in
 * the app already: `cmd` writes "Copy:  .lookup object x.m2", which is a
 * description of what lands on the clipboard rather than an instruction. A
 * colon rule would demote it to a keycap. Conversely "Click to sort by count"
 * has no colon and is prose, which is why the format below is `Gesture: action`
 * everywhere and why the headers were rewritten to match rather than left to
 * their own phrasing.
 *
 * Adding a gesture to the app means adding it here — one line, and the panel,
 * the keycaps and the accessible name all follow.
 */
const GESTURES = ["Click", "Shift-click", "Ctrl-click", "Alt-click", "Middle-click",
    "Double-click", "Drag", "Hover", "Alt + ← →", "Esc"];

/**
 * Does a tooltip line map a GESTURE to an action, rather than describe the
 * thing? The trailing lines of every tooltip do, and `app/tooltip.ts` renders
 * them as a two-column key map instead of prose — so this test has to agree
 * with what `clickHint` and `copy` above actually write, which is why it lives
 * beside them and is not respelled there.
 */
export const KEY_LINE_RE = new RegExp(
    // ESCAPED, because the gestures are prose: "Alt + ← →" carries a `+`, which
    // as a raw quantifier makes that alternative match nothing — and since the
    // scan walks BACK from the last line, one unmatchable gesture at the bottom
    // stops the walk and silently demotes EVERY key line above it to prose.
    `^(?:${GESTURES.map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}): `);

/** Where a key line packs two gestures onto one row. */
export const KEY_LINE_SEP = " · ";

/* ==================================================================== */
/* PILL-TYPE REGISTRY                                                    */
/* ==================================================================== */

/* One record per kind of content the app can show and search: what it is
 * called, how it renders, and — crucially — how a query token decides
 * whether it matches. The app reads it to light a pill up (`.hit`) and to
 * offer its word in autocomplete; search.ts reads the SAME record to select
 * spells. Those two used to be hand-written twins in different files, kept
 * in step by comments saying "keep in lockstep with…" — the drift they
 * warned about is now structurally impossible.
 *
 * MATCHING. Every token must satisfy at least one axis of the type:
 *
 *   text     the id's corpus (a lowercase haystack baked by data.ts), or,
 *            for a type with no per-id corpus, the category word itself
 *   bare     a bare number that IS the id's identity (an invisibility type)
 *   numeric  a number the id CARRIES — a count of things (a vehicle's seats)
 *            or a value (a desaturation percent). `operatorOnly` reserves a
 *            LOOSE bare number for the other axes: standing on its own the
 *            token keeps its text/bare meaning, which is what lets
 *            fx:"invis 13" mean type 13 and fx:"speed run 70" stay a search
 *            of the corpus the pill prints.
 *
 * THE ARGUMENT (bindNumeric, below). Saying the word first is what makes a
 * bare number a NUMBER: `fx:"scale 50"` asks the scale axis for exactly 50,
 * the same question as `fx:"scale =50"`, and `operatorOnly` does not apply
 * because the number is no longer loose.
 *
 * KEYWORDS. A type with a `word` contributes it to its field's autocomplete,
 * with `hint` as the description, gated by `when(data)` so a pack that
 * lacks the content never offers the word. Several types may share one word
 * (ghost is fed by two unrelated tables); the word is offered once.
 */

/* A pill id varies by type — a fid, a percent, a "move|pct" string key — so
 * the registry's id slot is deliberately untyped. Each type's own `corpus` /
 * `spells` / `of` agree on what its ids are; nothing outside a type ever
 * manufactures one. */

/** A number a pill type carries: a count of things, or a measured value. */
export interface PillNumericAxis {
    /** what the number means, for the docs */
    kind: "count" | "value";

    of(data: SpellData, id: any): number;

    /** a LOOSE bare number is not this axis (one written against the word still is) */
    operatorOnly?: boolean;
}

/**
 * One kind of content the app shows and searches — the record the app
 * renders from and search.ts selects with. See pilltypes.ts.
 */
export interface PillType {
    /** unique id of the type */
    key: string;
    /** the search field / column it belongs to */
    field: string;
    /** its category word; absent = no keyword */
    word?: string;
    /** one-line description (autocomplete + tooltip) */
    hint?: string;

    /** id -> lowercase haystack; absent = matched on `word` alone */
    corpus?(data: SpellData): Map<any, string>;

    /** id -> spell ids, or a plain Set of spells for a valueless type */
    spells?(data: SpellData): Map<any, number[]> | Set<number>;

    numeric?: PillNumericAxis;

    /** a bare number that IS the id's identity (an invisibility type) */
    bare?(data: SpellData, id: any): number | string;

    /**
     * spell id -> this type's id -> target mask, for the target-type words.
     *
     * The one axis keyed by (spell, id) rather than by id alone, and it has to
     * be: "who does it play on" is a fact about the ROW, so the same chain can
     * be caster-side on one spell and target-side on another. Absent means the
     * content carries no mask at all (a tint, a desaturation) — which is not
     * the same as a mask of zero, and is why scanType makes such a type answer
     * NOTHING to a target word rather than answering everything.
     */
    targets?(data: SpellData): Map<number, Map<any, number>>;

    /** does the loaded pack carry this content at all? */
    when?(data: SpellData): boolean;
}

export const TYPES = new Map<string, PillType>();

/**
 * Register a content type. This plus a renderer is the whole of "add a new
 * pill type": hit-highlighting, the search scan, the category head, the
 * autocomplete word and its description all follow from this record.
 */
export function defineType(type: PillType): void {
    if (TYPES.has(type.key)) throw new Error(`pill type "${type.key}" already defined`);
    TYPES.set(type.key, type);
}

/** Every registered type of one field, in declaration order. */
export const typesFor = (field: string): PillType[] =>
    [...TYPES.values()].filter((t) => t.field === field);

/**
 * The haystack a token is matched against. A type with no per-id corpus
 * (freeze, the invisibility channels) is matched on its category word —
 * which is exactly what its corpus would contain if it had one.
 */
function corpusOf(type: PillType, data: SpellData, id: any): string {
    if (!type.corpus) return type.word || "";
    return type.corpus(data).get(id) || "";
}

/* THE NUMERIC GRAMMAR LIVES HERE, AND NOWHERE ELSE.
 *
 * A value is an optional comparison and a number. The number may be signed,
 * because the values are — a movement-speed change is negative when it
 * slows, so a bound may be negative too ("<-50").
 *
 * The two halves are named separately because the TOKENIZER needs them
 * apart: it recognises a comparison however it is spaced (`seat >2` =
 * `seat > 2` = `seat>2`), which means splitting a lone operator from its
 * number and a word from a comparison glued onto it. Composing its patterns
 * out of these (see query.ts) is what keeps one alphabet. Both files used to
 * claim in a comment to be the single home of this and neither was: the
 * whole grammar was spelled five times, twice as byte-identical functions. */
export const CMP_OPS = "<=|>=|<|>|=";
export const NUM_SRC = "-?\\d+(?:\\.\\d+)?";
const VALUE_RE = new RegExp(`^(${CMP_OPS})?(${NUM_SRC})$`);

/**
 * Does this token read as a numeric word's value? The search bar asks, so
 * that the capsule it draws covers exactly what binds below — one regex,
 * one home, and no way for the drawing and the matching to disagree.
 */
export const isValue = (text: string): boolean => VALUE_RE.test(text);

/**
 * True when a token carries a comparison operator — i.e. it asks for a
 * numeric match rather than a value/word match. A bare number is NOT an
 * operator: standing loose in a chip it keeps its per-field literal
 * meaning. (Written against a numeric word it does ask for a comparison —
 * see bindNumeric — but that is decided by the pair, not by the token, so
 * it is not a question this predicate can answer.)
 *
 * Deliberately looser than VALUE_RE: it asks only how the token OPENS, so
 * `>` half-typed is already a comparison. "A comparison with its number",
 * which two callers want, is `isValue(t) && hasOperator(t)`.
 */
export const hasOperator = (text: string): boolean => /^[<>=]/.test(text);

/**
 * A value token as a test on a number, or null when it is not one.
 *
 * A BARE number is the `=` case — an operator you did not have to type —
 * rather than a form of its own. That is the whole of "a plain number is a
 * synonym for equals": there is one comparison grammar, and omitting the
 * operator picks its default. Absolute value was the alternative and is
 * NOT what this does: the sign is meaningful on every axis that has one
 * (a scale of -50% shrinks), and folding it away would leave no way to ask
 * for one direction while `scale >0` and `scale <0` already say it.
 */
export function numericTest(text: string): ((n: number) => boolean) | null {
    const m = VALUE_RE.exec(text);
    if (!m) return null;
    const v = Number(m[2]);
    switch (m[1]) {
        case "<":
            return (n) => n < v;
        case ">":
            return (n) => n > v;
        case "<=":
            return (n) => n <= v;
        case ">=":
            return (n) => n >= v;
        default:
            return (n) => n === v; // "=", or a bare number
    }
}

/** True when `text` is a numeric-comparison token satisfied by `n`. */
export function matchNumeric(text: string, n: number): boolean {
    const test = numericTest(text);
    return test ? test(n) : false;
}

/**
 * Bind a numeric word's ARGUMENT: the one token after the word, taken out
 * of the chip's text and asked of the type's numeric axis instead.
 *
 *   fx:"scale 50"    fx:"scale >50"    mech:"seat 8"    fx:"speed <-50"
 *
 * ONE TOKEN AFTER THE WORD — the same arity a meta keyword has, so there is
 * a single rule for every value in the language and the bar can draw a
 * single capsule shape. A number that is NOT written against its word stays
 * loose and keeps the meaning it always had (`operatorOnly` decides whether
 * it reaches this axis at all), which is exactly what the capsule's absence
 * says on screen.
 *
 * Binding is what makes a bare number precise. `tokenMatches` tries the
 * corpus first, so a loose `50` matched `+150%` as a substring long before
 * it could be tested as a number; bound, it never reaches the corpus.
 *
 * A type with a `bare` axis is left alone: there the number after the word
 * is the id ITSELF (`fx:"invis 13"` is channel 13, and its numeric axis
 * counts something else entirely — the detectors on the other side). It is
 * still the word's argument, just bound to identity, which `tokenMatches`
 * already answers per token.
 */
function bindNumeric(type: PillType, tokens: { text: string }[]):
    { tokens: { text: string }[]; tests: ((n: number) => boolean)[] } {
    if (!type.numeric || !type.word || type.bare) return {tokens, tests: []};
    const rest: { text: string }[] = [];
    const tests: ((n: number) => boolean)[] = [];
    for (let i = 0; i < tokens.length; i++) {
        rest.push(tokens[i]);
        const next = tokens[i + 1];
        const test = tokens[i].text === type.word && next && numericTest(next.text);
        if (!test) continue;
        tests.push(test);
        i++;
    }
    return {tokens: rest, tests};
}

/**
 * Does one query token match this id of this type? The one place the axes
 * are combined — every caller, in both files, goes through here.
 * `corpusL` is the precomputed corpusOf (hoisted out of the loop).
 */
function tokenMatches(type: PillType, data: SpellData, id: any, corpusL: string,
                      token: { text: string }): boolean {
    const text = token.text;
    if (corpusL.includes(text)) return true;
    const operator = hasOperator(text);
    if (type.bare && !operator && String(type.bare(data, id)) === text) return true;
    if (type.numeric && !(type.numeric.operatorOnly && !operator)) {
        const test = numericTest(text);
        if (test) return test(type.numeric.of(data, id));
    }
    return false;
}

/**
 * Does this id satisfy a chip whose argument is already bound? Every
 * remaining token must match, and every bound value must hold — the group
 * semantics the rest of the search uses.
 */
function matchesBound(type: PillType, data: SpellData, id: any,
                      tokens: { text: string }[], tests: ((n: number) => boolean)[]): boolean {
    if (tests.length) {
        // bindNumeric only produces tests for a type with a numeric axis
        const n = type.numeric!.of(data, id);
        for (const test of tests) {
            if (!test(n)) return false;
        }
    }
    const corpusL = corpusOf(type, data, id);
    for (const t of tokens) {
        if (!tokenMatches(type, data, id, corpusL, t)) return false;
    }
    return true;
}

/**
 * Does this id satisfy a whole chip? The single-id entry point — the app
 * lights a pill up through it, so a pill can only ever glow under a query
 * that also selects its spell.
 */
export function idMatches(type: PillType, data: SpellData, id: any,
                          tokens: { text: string }[]): boolean {
    const {tokens: rest, tests} = bindNumeric(type, tokens);
    return matchesBound(type, data, id, rest, tests);
}

/**
 * Add every spell reached by a type's matching ids to `out`. This is the
 * search side; the app's hit test is idMatches on a single id.
 *
 * `maskOk` is the target-type question, when the chip asked one. It is passed
 * as a plain predicate rather than the caller's mask tests so this file needs
 * no vocabulary of bits — search.ts owns what `caster` means, pills.ts owns
 * where the mask for a (spell, id) row lives, and neither has to know the
 * other's half.
 */
export function scanType(type: PillType, data: SpellData, tokens: { text: string }[],
                         out: Set<number>, maskOk?: (mask: number) => boolean): void {
    if (!type.spells) return;
    /* A type with no mask cannot answer "who does it play on", so it must
     * contribute NOTHING — the alternative, letting it through untested, is how
     * a target word silently degrades into ordinary corpus text and selects
     * spells that have no targeting information at all. */
    const masks = maskOk && type.targets?.(data);
    if (maskOk && !masks) return;
    const spells = type.spells(data);
    // the argument depends on the chip and the type, never on the id, so it
    // binds once for the whole scan rather than per row
    const {tokens: rest, tests} = bindNumeric(type, tokens);
    // a Set is the valueless shape (freeze/camo): no ids, the word is the
    // whole query, and every spell in the set matches or none does
    if (spells instanceof Set) {
        if (matchesBound(type, data, null, rest, tests)) for (const s of spells) out.add(s);
        return;
    }
    for (const [id, ids] of spells) {
        if (!matchesBound(type, data, id, rest, tests)) continue;
        for (const s of ids) {
            // the mask is per (spell, id): the same chain plays on the caster
            // for one spell and on the target for another
            if (!masks || maskOk!(masks.get(s)?.get(id) || 0)) out.add(s);
        }
    }
}

/**
 * The category words a field offers in autocomplete, with descriptions.
 * Deduped by word (ghost has two feeding types) and filtered by `when`, so
 * a pack without the content never suggests it.
 */
export function keywordsFor(field: string, data: SpellData):
    { words: string[]; titles: Record<string, string> } {
    const words: string[] = [];
    const titles: Record<string, string> = {};
    for (const type of typesFor(field)) {
        if (!type.word || (type.when && !type.when(data))) continue;
        if (!words.includes(type.word)) words.push(type.word);
        if (type.hint && !titles[type.word]) titles[type.word] = type.hint;
    }
    return {words, titles};
}

/** Description of one category word, for a head pill's tooltip. */
export const hintFor = (field: string, word: string): string =>
    typesFor(field).find((t) => t.word === word)?.hint || "";
