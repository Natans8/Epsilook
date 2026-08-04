/* Leaf helpers shared by every Epsilook module.
 *
 * Two families, both dependency-free:
 *   - typed DOM shorthands ($, $$, el, targetClosest). The app builds
 *     its result rows by hand, so these are the vocabulary that does it, and
 *     the type assertions live here once instead of at every call site.
 *   - fillTemplate, which fills the {slot} placeholders in the URL and command
 *     templates config.ts exposes.
 *
 * The bar for adding something here: no app state, no DOM the app owns, and no
 * dependency on another Epsilook module. Anything that fails that belongs with
 * the feature it serves, not in this file - that is what keeps it from
 * drifting into a junk drawer.
 */

/**
 * querySelector shorthand — for elements that provably exist in
 * index.html (hence the non-null HTMLElement return).
 */
export const $ = (sel: string): HTMLElement =>
    document.querySelector(sel) as HTMLElement;

/** querySelectorAll shorthand, typed for HTML elements. */
export const $$ = (sel: string, root: ParentNode = document): NodeListOf<HTMLElement> =>
    root.querySelectorAll(sel);

/** Create an element, optionally with a class and text content. */
export const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

/**
 * The closest ancestor of an event's target matching sel, or null —
 * the typed form of `e.target.closest(sel)`.
 */
export const targetClosest = (e: Event, sel: string): HTMLElement | null =>
    e.target instanceof Element ? e.target.closest(sel) : null;

/**
 * Fill {placeholder} slots in a config URL/command template.
 * Missing keys collapse to "" rather than leaving the brace text.
 */
export const fillTemplate = (tpl: string, vars: Record<string, string | number>): string =>
    tpl.replace(/\{(\w+)}/g, (_, k: string) => String(vars[k] ?? ""));

/**
 * A packed 0xRRGGBB color as a CSS hex string. Every color in the pack —
 * chain tints, glows, ghosts, screen grades — is stored packed, so this is
 * the one place that formatting lives.
 */
export const hexColor = (packed: number): string =>
    "#" + packed.toString(16).padStart(6, "0");
