/* Themes: the picker, the stored choice, and following the OS.
 *
 * A theme is a palette block in css/app.css keyed on <html data-theme="id">,
 * plus one {id, label} record in `themes` in config.ts — that registry is what
 * this file turns into the header dropdown, so a new theme needs no code here.
 *
 * Two values, deliberately not the same thing:
 *   - the PREFERENCE is what the user picked, and the only thing stored. It can
 *     be "auto", which is not a palette.
 *   - the RESOLVED theme is the palette actually applied, and the only thing
 *     data-theme ever holds. "auto" resolves through prefers-color-scheme and
 *     re-resolves whenever the OS flips, with no reload.
 *
 * index.html replays the stored preference in an inline <script> before the
 * first paint (a light theme must not flash dark); this module owns everything
 * after that, including correcting a stored id that no longer exists.
 */
import {CFG} from "./config";
import {$, el} from "./util";

/** Storage key — the inline script in index.html reads the same one. */
const THEME_KEY = "epsilook.theme";

/** The reserved id meaning "whatever the OS is set to". */
const AUTO = "auto";

const systemIsLight = () => window.matchMedia("(prefers-color-scheme: light)").matches;

/**
 * The stored preference, or the configured default when nothing valid is
 * stored (a theme that has since been removed from the registry counts as
 * nothing).
 */
function preference(): string {
    let stored: string | null = null;
    try {
        stored = localStorage.getItem(THEME_KEY);
    } catch { /* storage blocked — the default applies */
    }
    return stored !== null && CFG.themes.some((t) => t.id === stored)
        ? stored : CFG.defaultTheme;
}

/** Put a preference on <html> as a real palette id. */
function apply(pref: string): void {
    document.documentElement.dataset.theme = pref === AUTO
        ? CFG.autoTheme[systemIsLight() ? "light" : "dark"]
        : pref;
}

/** Apply the stored (or default) theme and wire the header picker. Call once, at boot. */
export function init(): void {
    const sel = $("#theme") as HTMLSelectElement;
    const pref = preference();
    apply(pref);

    for (const theme of CFG.themes) {
        const opt = el("option", "", theme.label);
        opt.value = theme.id;
        sel.appendChild(opt);
    }
    sel.value = pref;
    // one theme is not a choice — the control appears with the second one
    // (the version selector hides itself on the same rule)
    $("#theme-wrap").hidden = sel.options.length < 2;

    sel.addEventListener("change", () => {
        apply(sel.value);
        try {
            localStorage.setItem(THEME_KEY, sel.value);
        } catch { /* storage blocked — the choice lasts this page only */
        }
    });

    // the OS switching light/dark only means anything while "auto" is picked
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        if (sel.value === AUTO) apply(AUTO);
    });
}
