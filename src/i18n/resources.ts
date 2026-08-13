/**
 * @file The string registry's catalogs and their binding to i18next's type system.
 *
 * Every user-facing string lives in `src/locales/<locale>/<namespace>.json` and is reached through {@link ../i18n!t}
 * by key, never written inline. The namespaces divide by function, not by module: `diagnostics` is what the engine
 * tells a reader about their query, `tooltips` the one-line hint prose declarations carry, `ui` labels and chrome,
 * `rules` the simplification rule bible. A string's home is decided by what kind of thing it says.
 *
 * The module augmentation below is what makes every `t` call key-checked: a key missing from the English catalog is
 * a compile error at the call site. It lives here, in an imported module, rather than in an ambient `.d.ts` so that
 * both tsc targets see it through the import graph — an ambient file is only in a program its tsconfig includes.
 */
import diagnostics from "../locales/en/diagnostics.json";
import rules from "../locales/en/rules.json";
import tooltips from "../locales/en/tooltips.json";
import ui from "../locales/en/ui.json";
import ruDiagnostics from "../locales/ru/diagnostics.json";
import ruRules from "../locales/ru/rules.json";
import ruTooltips from "../locales/ru/tooltips.json";
import ruUi from "../locales/ru/ui.json";

/** The namespace an unprefixed key resolves in. Every call in this repository writes the prefix out. */
export const defaultNS = "ui";

/**
 * Every catalog of every bundled locale. English is the source language and always complete.
 *
 * Russian is registered with empty catalogs: a locale is declared here before it is written, so that the fallback
 * path is exercised rather than assumed, and so the translation tooling has a second column to fill. Every key
 * therefore resolves to its English string until the Russian one is supplied, which is i18next's per-key fallback
 * rather than a whole-catalog switch - a half-translated locale shows its translated keys and nothing breaks.
 *
 * Only the source language types the keys, in the augmentation below. A translation that is missing a key is a
 * legitimate state, so requiring the shapes to match would make an in-progress locale a compile error.
 */
export const resources = {
    en: {diagnostics, rules, tooltips, ui},
    ru: {diagnostics: ruDiagnostics, rules: ruRules, tooltips: ruTooltips, ui: ruUi},
} as const;

declare module "i18next" {
    interface CustomTypeOptions {
        defaultNS: typeof defaultNS;
        resources: (typeof resources)["en"];
    }
}
