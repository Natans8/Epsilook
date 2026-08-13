/**
 * @file The string registry: one i18next instance, initialised synchronously from the bundled catalogs.
 *
 * Serves the search engine today and is meant to absorb the rest of the app's strings; a module that shows a reader
 * any prose imports {@link t} rather than writing the string inline. Keys are compile-checked against the English
 * catalogs through the augmentation in {@link ./resources!}.
 *
 * The language is fixed to English: locale selection is a UI concern and nothing selects one yet. Because registry
 * declarations resolve their strings at import time, a future language switch re-evaluates nothing — selection must
 * happen before the registries load, which for a bundled page means before boot, and a change means a reload.
 */
import i18next from "i18next";
import {defaultNS, resources} from "./resources";

/** The registry's own instance, so app code can never be affected by another library initialising i18next. */
export const i18n = i18next.createInstance();

// Synchronous by design: the catalogs are bundled, so nothing needs to load, and `initAsync: false` makes init
// complete before the first `t` call. Interpolated values are plain text for DOM text nodes and terminals alike,
// never markup, so i18next's HTML escaping would corrupt them.
void i18n.init({
    lng: "en",
    fallbackLng: "en",
    defaultNS,
    ns: Object.keys(resources.en),
    resources,
    initAsync: false,
    interpolation: {escapeValue: false},
});

/**
 * Translates a key from the catalogs, `namespace:dotted.key` form, resolving in the current language.
 *
 * Keys are checked at compile time; interpolation values are the `{{name}}` placeholders the catalog entry names.
 */
export const t = i18n.t.bind(i18n);
