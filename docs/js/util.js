// @ts-check
/* Leaf helpers shared by every Epsilook script.
 *
 * Two families, both dependency-free:
 *   - typed DOM shorthands ($, $$, $$inputs, el, targetClosest). The app builds
 *     its result rows by hand, so these are the vocabulary that does it, and
 *     the type assertions live here once instead of at every call site.
 *   - fillTemplate, which fills the {slot} placeholders in the URL and command
 *     templates config.js exposes.
 *
 * The bar for adding something here: no app state, no DOM the app owns, and no
 * dependency on another Epsilook module. Anything that fails that belongs with
 * the feature it serves, not in this file - that is what keeps it from
 * drifting into a junk drawer.
 */
window.EpsilookUtil = (() => {
    "use strict";

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

    /**
     * Fill {placeholder} slots in a config URL/command template.
     * Missing keys collapse to "" rather than leaving the brace text.
     * @param {string} tpl
     * @param {Record<string, string | number>} vars
     * @returns {string}
     */
    const fillTemplate = (tpl, vars) => tpl.replace(/\{(\w+)}/g, (_, k) => String(vars[k] ?? ""));

    /**
     * A packed 0xRRGGBB color as a CSS hex string. Every color in the pack —
     * chain tints, glows, ghosts, screen grades — is stored packed, so this is
     * the one place that formatting lives.
     * @param {number} packed
     * @returns {string}
     */
    const hexColor = (packed) => "#" + packed.toString(16).padStart(6, "0");

    return {$, $$, $$inputs, el, targetClosest, fillTemplate, hexColor};
})();
