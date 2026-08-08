/* Leaf helpers shared by every Epsilook module — DOM-FREE, by design.
 *
 * This file is in the DATA/QUERY layer (check.py's DATA_MODULES enforces it),
 * because data.ts imports hexColor from it. The typed DOM shorthands that used
 * to live here ($, $$, el, targetClosest) moved to src/dom.ts on 2026-08-08 for
 * exactly that reason: an ES import pulls in the whole module, so one `document`
 * reference here would put the DOM on data.ts's import path.
 *
 * The bar for adding something here: no app state, NO DOM, and no dependency on
 * another Epsilook module. Anything that fails that belongs with the feature it
 * serves, not in this file - that is what keeps it from drifting into a junk
 * drawer.
 */

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
