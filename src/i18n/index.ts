/**
 * @file The string registry: one i18next instance, initialised synchronously from the bundled catalogs.
 *
 * Serves the search engine today and is meant to absorb the rest of the app's strings; a module that shows a reader
 * any prose imports {@link t} rather than writing the string inline. Keys are compile-checked against the English
 * catalogs through the augmentation in {@link ./resources!}.
 *
 * The language is the reader's, chosen before anything resolves a string. In a browser the detector's convention
 * decides: the `?lng=` query overrides, the stored choice persists, the browser language is the first-visit
 * default, and anything without a bundled catalog falls back to English. A terminal has none of those signals, so
 * the `EPSILOOK_LANG` environment variable is the whole mechanism there. Because registry declarations resolve
 * their strings at import time, a language switch re-evaluates nothing — a change means a reload.
 *
 * The language chosen here also selects the query-word table the search schema folds in, so one setting speaks
 * both the chrome and the syntax. The loaded pack's language is deliberately not this one: an English interface
 * over a Russian pack is a supported pairing, and each knob is set on its own.
 */
import i18next from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import {defaultNS, resources} from "./resources";

/** The registry's own instance, so app code can never be affected by another library initialising i18next. */
export const i18n = i18next.createInstance();

/** The languages a catalog is bundled for; detection never lands outside this set. */
const LANGUAGES = Object.keys(resources);

// Read without the platform's own types: this module compiles under both tsc targets, and neither declares the
// other environment's globals. The pack-style spelling (ruRU) folds to the catalog style (ru), because a reader
// who sets both knobs will reach for one spelling — and a silent mismatch would select English without a word.
const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.EPSILOOK_LANG;
const env = raw?.replace(/^([a-z]{2})[A-Z]{2}$/, "$1");
const browser = (globalThis as { document?: unknown }).document !== undefined;
// An undefined language is exactly the case the detector decides, so the two stay one condition.
const lng = env ?? (browser ? undefined : "en");
if (lng === undefined) i18n.use(LanguageDetector);

// Synchronous by design: the catalogs are bundled, so nothing needs to load, and `initAsync: false` makes init
// complete before the first `t` call. Interpolated values are plain text for DOM text nodes and terminals alike,
// never markup, so i18next's HTML escaping would corrupt them.
void i18n.init({
    lng,
    fallbackLng: "en",
    supportedLngs: LANGUAGES,
    nonExplicitSupportedLngs: true,
    defaultNS,
    ns: Object.keys(resources.en),
    resources,
    initAsync: false,
    // An empty string means "not translated yet", not "say nothing". A translation skeleton carries every key of
    // the source language with empty values, so without this the interface would go blank for a language nobody
    // had finished rather than falling back key by key.
    returnEmptyString: false,
    interpolation: {escapeValue: false},
    detection: {caches: ["localStorage"]},
});

/**
 * Translates a key from the catalogs, `namespace:dotted.key` form, resolving in the current language.
 *
 * Keys are checked at compile time; interpolation values are the `{{name}}` placeholders the catalog entry names.
 */
export const t = i18n.t.bind(i18n);
