/* The app's own tooltip.
 *
 * Every hoverable thing in this app already composes a careful tooltip —
 * pills.ts §tip() builds "what it is", then details, then the gestures that
 * act on it — and then hands the whole thing to `title`, where the OS renders
 * it as an unstyled box after a one-second wait. That threw away the structure
 * the composer had just built, and it left the page speaking two tooltip
 * languages: hover a spell name and you get Wowhead's real in-game tooltip,
 * hover anything else and you get a Windows rectangle.
 *
 * So this is a panel in the app's own tones. It is deliberately NOT a copy of
 * the game tooltip: the genuine article is a few pixels away on the same row,
 * and a near-miss beside it reads as a bad imitation. What it borrows instead
 * is the pill's own `--tone`, so a model tooltip is blue and a mechanic
 * tooltip is orange — something the OS box can never say.
 *
 * ONE delegated listener, no call-site changes. Every surface in the app is
 * already `[title]`, so the command strip, the field buttons, the sort headers
 * and the help dialog all inherit this for free — the same reasoning as the
 * delegated middle-click handler in events.ts.
 *
 * `title` stays the source of truth. It is hoisted to `data-tip` on first
 * hover (an attribute cannot be shown by us AND suppressed in the browser),
 * and re-hoisted whenever a fresh one appears, so an element that rewrites its
 * own title keeps working.
 */
import {KEY_LINE_RE, KEY_LINE_SEP} from "../pills";
import {el, targetClosest} from "../dom";

/**
 * Surfaces whose hover belongs to something else. Both are exclusions of
 * ownership, not of taste:
 *
 *   - a wowhead.com link already shows WOWHEAD'S tooltip, which is the real
 *     in-game one. Ours must never stack on top of it.
 *   - `#q`'s title is rewritten on every mousemove by highlight.ts §barHover,
 *     which hit-tests the bar's backdrop spans and copies the matched span's
 *     title onto the input. That attribute is the bar's mechanism; hoisting it
 *     away would fight a subsystem whose metrics are off-limits anyway.
 */
const NOT_OURS = '#q, [href*="wowhead.com"], .wowhead-tooltip';

/** Long enough to sweep a pointer across a dense row without flicker. */
const SHOW_DELAY = 140;
/** …but a second pill right after the first is instant, as native tips are. */
const WARM_FOR = 400;
/** Gap between the anchor and the panel, and the panel and the viewport. */
const GAP = 6;
const MARGIN = 8;

let panel: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let showTimer = 0;
let hiddenAt = 0;

/**
 * Whether the panel can join the TOP LAYER.
 *
 * A modal `<dialog>` renders in the top layer, which no z-index can reach over
 * — so the help dialog was covering its own tooltips, which is where a
 * generated word's description now lives. A popover is promoted to that same
 * layer, and the top layer stacks in promotion order, so a tooltip opened while
 * the dialog is up paints above it.
 *
 * Feature-detected rather than assumed: where it is missing the panel keeps its
 * z-index and behaves exactly as before, which is right everywhere except over
 * a modal.
 */
const CAN_POPOVER = typeof HTMLElement !== "undefined"
    && typeof HTMLElement.prototype.showPopover === "function";

/** Is the panel on screen? Popover state and `hidden` answer differently. */
const isOpen = (): boolean => !!panel
    && (CAN_POPOVER ? panel.matches(":popover-open") : !panel.hidden);

/** Move `title` out of the browser's reach, once, and answer with its text. */
function hoist(node: HTMLElement): string {
    const title = node.getAttribute("title");
    if (title) {
        node.removeAttribute("title");
        node.dataset.tip = title;
        // For a glyph-only, text-less element (a target icon, a colour swatch)
        // the title WAS the accessible name. Taking it away without putting
        // one back would make the pill unreadable to a screen reader.
        if (!node.getAttribute("aria-label") && !(node.textContent || "").trim()) {
            node.setAttribute("aria-label", title.split("\n")[0]);
        }
    }
    return node.dataset.tip || "";
}

/**
 * Split a composed tooltip into its two halves. The gesture lines are always
 * trailing (see pills.ts §clickHint), so walking back from the end is exact
 * rather than a guess about where prose stops.
 */
function split(text: string): { body: string[]; keys: [string, string][] } {
    const lines = text.split("\n");
    let cut = lines.length;
    while (cut > 0 && KEY_LINE_RE.test(lines[cut - 1])) cut--;
    const keys: [string, string][] = [];
    for (const line of lines.slice(cut)) {
        // one line can carry two gestures ("Shift-click: add · Ctrl-click: exclude")
        for (const part of line.split(KEY_LINE_SEP)) {
            const at = part.indexOf(": ");
            if (at > 0) keys.push([part.slice(0, at), part.slice(at + 2)]);
        }
    }
    return {body: lines.slice(0, cut), keys};
}

/**
 * One line with every occurrence of every term wrapped in `<mark>`.
 *
 * Overlaps are merged rather than nested: two terms that touch ("blood" and
 * "bloodpool") would otherwise open a second mark inside the first and paint
 * the shared run twice as dark. Same merge the name column's highlighter does,
 * and for the same reason — but built here over a DocumentFragment, because
 * this text is prose the user never typed and must never reach innerHTML.
 */
function markUp(line: string, terms: string[]): DocumentFragment {
    const low = line.toLowerCase();
    const spans: [number, number][] = [];
    for (const t of terms) {
        for (let i = low.indexOf(t); i !== -1; i = low.indexOf(t, i + 1)) {
            spans.push([i, i + t.length]);
        }
    }
    spans.sort((a, b) => a[0] - b[0]);
    const frag = document.createDocumentFragment();
    let at = 0;
    for (const [from, to] of spans) {
        if (to <= at) continue;               // wholly inside the previous mark
        const start = Math.max(from, at);     // overlapping: keep the new tail
        if (start > at) frag.append(line.slice(at, start));
        frag.append(el("mark", undefined, line.slice(start, to)));
        at = to;
    }
    frag.append(line.slice(at));
    return frag;
}

/**
 * Draw the panel. The gesture half becomes a real two-column map rather than
 * the run-on sentence `title` forced it to be — it always WAS a key→action
 * mapping, and a description list is what that is.
 */
/**
 * A line holding only this splits the body into LABELLED SECTIONS, and the
 * first line of each section is its label.
 *
 * A record separator rather than a visible sentinel: `title` is still the
 * source of the text, and if this panel never opens the browser's own tooltip
 * shows the same string — an invisible control character degrades to a line
 * break there, where `---` or `##` would degrade to litter.
 *
 * One section means NO label is drawn: a heading over the only thing in the
 * box labels nothing, and the caller says so by sending no separator at all.
 */
export const SECTION = "\u001e";

/** Body lines grouped into sections; `label` is unset when there is only one. */
function sections(body: string[]): { label?: string; lines: string[] }[] {
    const at = body.indexOf(SECTION);
    if (at < 0) return [{lines: body}];
    const out: { label?: string; lines: string[] }[] = [];
    let start = 0;
    for (let i = 0; i <= body.length; i++) {
        if (i !== body.length && body[i] !== SECTION) continue;
        const part = body.slice(start, i);
        if (part.length) out.push({label: part[0], lines: part.slice(1)});
        start = i + 1;
    }
    return out;
}

function fill(text: string): void {
    const {body, keys} = split(text);
    // WHICH WORDS TO MARK IS THE ANCHOR'S TO SAY, not this module's. An anchor
    // that wants its matched terms picked out lists them in `data-tip-hl`
    // (tab-separated, already lowercased); everything else renders as before.
    // Kept as an attribute rather than a second content channel so `title`
    // stays the single source of the TEXT — see the header note.
    const marks = (anchor?.dataset.tipHl || "").split("\t").filter(Boolean);
    panel!.textContent = "";
    // ⚠ `.tip-what` IS FOR THE FIRST LINE OF A ONE-SECTION TIP AND NOTHING
    // ELSE. Every other tooltip in the app opens with "what this is" and then
    // details it, so bolding line 0 is right there. A SECTIONED tip has no
    // such line — its opening line is a label — and bolding it made the
    // dungeon-journal note look like the spell's headline whenever the spell
    // had no description of its own. The label carries the emphasis instead.
    for (const part of sections(body)) {
        const box = el("div", "tip-section");
        if (part.label) box.append(el("p", "tip-label", part.label));
        part.lines.forEach((line, i) => {
            const p = el("p", !part.label && i === 0 ? "tip-what" : "tip-detail");
            p.append(marks.length ? markUp(line, marks) : document.createTextNode(line));
            box.append(p);
        });
        panel!.append(box);
    }
    if (!keys.length) return;
    const list = el("dl", "tip-keys");
    for (const [key, action] of keys) {
        const row = el("div");
        row.append(el("dt", undefined, key), el("dd", undefined, action));
        list.append(row);
    }
    panel!.append(list);
}

/**
 * Anchor to the element's box, not the pointer: it holds still while the
 * pointer moves inside a pill, and it is the only option on keyboard focus.
 * Below by default, flipped above when the viewport runs out — OR when the
 * anchor is a wide block, which is the rule below.
 */
function place(): void {
    const a = anchor!.getBoundingClientRect();
    const p = panel!.getBoundingClientRect();
    const above = Math.max(MARGIN, a.top - p.height - GAP);
    let top = a.bottom + GAP;
    if (top + p.height > window.innerHeight - MARGIN || coversWhatFollows(a, p)) {
        top = above;
    }
    const left = Math.max(MARGIN, Math.min(a.left, window.innerWidth - p.width - MARGIN));
    panel!.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

/**
 * How much wider than the panel an anchor must be to count as a "block".
 * Two panel widths is the point past which the panel can no longer sit clear
 * of the anchor's own column, so below is guaranteed to land on whatever
 * follows rather than beside it.
 */
const BLOCK_RATIO = 2;

/**
 * Would placing below bury the content this anchor leads INTO?
 *
 * Reported by the user on the help dialog's specimen: the query at the top of
 * the band is a full-width button, so its tooltip landed exactly on the legend
 * row explaining the mark under the pointer — it covered the one thing the
 * reader was looking at.
 *
 * The signal is the anchor's WIDTH, not its identity. A pill in a table row is
 * narrow, so its panel hangs beside most of what is beneath it and below stays
 * the predictable default; a wide block is a paragraph-shaped thing, and what
 * follows a block is nearly always its continuation. Above it sits over the
 * lead-in instead — text already read on the way down.
 *
 * Only when there is genuinely room above: a wide anchor at the top of the
 * viewport keeps the old behaviour rather than being clamped over itself.
 */
function coversWhatFollows(a: DOMRect, p: DOMRect): boolean {
    return a.width > p.width * BLOCK_RATIO && a.top - p.height - GAP >= MARGIN;
}

function show(node: HTMLElement, text: string): void {
    if (!panel) return;
    anchor = node;
    // the pill's own colour family, so the panel says which column it came
    // from before a word of it is read. Untoned surfaces resolve to --text.
    const tone = getComputedStyle(node).getPropertyValue("--tone").trim();
    panel.style.setProperty("--tone", tone || "var(--text-dim)");
    fill(text);
    if (CAN_POPOVER) {
        // showPopover throws if it is already open, and a re-anchor without a
        // close in between is an ordinary path (sweeping across two pills)
        if (!panel.matches(":popover-open")) panel.showPopover();
    } else {
        panel.hidden = false;
    }
    place();
    panel.classList.add("show");
    node.setAttribute("aria-describedby", "tip");
}

function hide(): void {
    clearTimeout(showTimer);
    if (!panel || !isOpen()) return;
    panel.classList.remove("show");
    if (CAN_POPOVER) panel.hidePopover();
    else panel.hidden = true;
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
    hiddenAt = Date.now();
}

/** Hover and focus share everything except which event opened them. */
function open(node: HTMLElement, instant: boolean): void {
    if (node === anchor) return;
    const text = hoist(node);
    if (!text) return;
    hide();
    const delay = instant || Date.now() - hiddenAt < WARM_FOR ? 0 : SHOW_DELAY;
    if (!delay) return show(node, text);
    showTimer = window.setTimeout(() => show(node, text), delay);
}

function candidate(e: Event): HTMLElement | null {
    const node = targetClosest(e, "[title], [data-tip]");
    return node && !node.closest(NOT_OURS) ? node : null;
}

export function initTooltips(): void {
    panel = el("div", "", "");
    panel.id = "tip";
    panel.setAttribute("role", "tooltip");
    // "manual" because this is driven entirely by hover and focus: the light
    // dismiss of "auto" would close it on the very click the app is explaining,
    // and auto popovers close each other, which a tooltip must never do
    if (CAN_POPOVER) panel.setAttribute("popover", "manual");
    else panel.hidden = true;
    document.body.append(panel);

    document.addEventListener("pointerover", (e) => {
        if (e.pointerType === "touch") return; // no hover to speak of
        const node = candidate(e);
        if (node) open(node, false);
        else if (anchor) hide();
    });
    document.addEventListener("pointerout", (e) => {
        // delegation means this also fires moving BETWEEN a pill's own
        // segments; only a pointer that has actually left the anchor closes it
        const to = e.relatedTarget;
        if (anchor && to instanceof Node && anchor.contains(to)) return;
        hide();
    });

    // keyboard parity: a tooltip nobody can reach by Tab is a tooltip half the
    // users never see. Escape closes it without leaving the control.
    document.addEventListener("focusin", (e) => {
        const node = e.target instanceof HTMLElement ? e.target : null;
        if (node && node.matches("[title], [data-tip]") && !node.closest(NOT_OURS)) {
            open(node, true);
        } else if (anchor) hide();
    });
    document.addEventListener("focusout", hide);
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hide();
    });

    // the panel is fixed, so anything that moves the anchor invalidates it
    document.addEventListener("scroll", hide, {capture: true, passive: true});
    window.addEventListener("resize", hide);
    // a click has answered whatever the tooltip was explaining
    document.addEventListener("pointerdown", hide, true);
}
