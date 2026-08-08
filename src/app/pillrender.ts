/* Pill RENDERING — the GUI half of the pill system.
 *
 * Split out of pills.ts on 2026-08-08. pills.ts describes a pill as plain data
 * (the segment vocabulary, the type registry, the numeric grammar, the match
 * scan); this file is the only thing that turns that data into DOM. The seam is
 * the `Segment` interface: everything above it is data the query layer shares,
 * everything here is markup the GUI owns.
 *
 * That is what makes the two layers mutually replaceable — a non-browser
 * consumer (a CLI, a worker, a test) imports pills.ts and never reaches this
 * file, and a different presentation layer replaces this file without touching
 * a line of matching logic. check.py's DATA_MODULES enforces the direction:
 * pills.ts may not import from here.
 */
import {el} from "../dom";
import type {PillSlot, Segment} from "../pills";
import {KINDS, TARGET_ICONS} from "../pills";

/** The keys that make a segment interactive, and the ones that fill it. */
const ACTION_KEYS = ["search", "copy", "href", "play"] as const;
const CONTENT_KEYS = ["text", "svg", "img", "mask"] as const;

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
        // An EMPTY src is "no image yet", not "no image": assigning "" makes the
        // browser re-request the PAGE. Leaving the attribute off instead lets a
        // segment ship its alt text while its src is unknown — which is what an
        // image segment with an unresolved source has to do.
        if (seg.img.src) img.src = seg.img.src;
        img.alt = seg.img.alt || "";
        img.loading = "lazy";
        if (!imgOnly) node.appendChild(img);
    } else if (seg.svg) {
        node.innerHTML = seg.svg;
    } else if (seg.mask !== undefined) {
        // The one content form the GUI expands rather than receives: a target
        // segment carries the MASK as data, and the glyphs for it are markup,
        // so building them here is what keeps pills.ts free of elements.
        for (const n of targetIconNodes(seg.mask)) node.appendChild(n);
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
