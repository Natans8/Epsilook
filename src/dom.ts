/* Typed DOM shorthands — the GUI layer's vocabulary for building markup.
 *
 * Split out of util.ts on 2026-08-08 so that the data/query layer can import
 * the pure helpers (fillTemplate, hexColor) without dragging `document` in
 * with them. util.ts is now DOM-free and lives in the data/query layer; this
 * file is GUI and is named in check.py's GUI_MODULES.
 *
 * The bar for adding something here: it touches the DOM, it owns no app state,
 * and it depends on no other Epsilook module.
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
