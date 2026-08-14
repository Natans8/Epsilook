/**
 * @file The string registry: key resolution, interpolation, and the per-key fallback an empty locale relies on.
 *
 * The rule under test is what registering an empty locale is FOR. A locale is declared before it is written, so
 * every key must keep answering in the source language until its translation arrives - per key, not per catalog,
 * so a half-finished locale shows what it has and falls back for the rest. A whole-catalog switch would blank the
 * interface the moment a second language was declared, which is the failure this proves absent.
 */
import {strict as assert} from "node:assert";
import {describe, it} from "node:test";

import {i18n, t} from "../../../src/i18n/index";
import {resources} from "../../../src/i18n/resources";

describe("the string registry", () => {
    it("initialises synchronously, so declarations can resolve strings while their module body runs", () => {
        // Every registry in src/search/ calls `t` at import time. If init were async, those would resolve to their
        // own key text instead of the string, and nothing would fail loudly.
        assert.equal(i18n.isInitialized, true);
    });

    it("resolves a key to its string", () => {
        assert.equal(t("ui:column.spell"), "Spell");
    });

    it("interpolates without escaping, because the values reach text nodes and terminals rather than markup", () => {
        // An escaped value would show `&quot;` to the reader; the quotes here are the diagnostic's own.
        assert.equal(t("diagnostics:axis.noOrdering", {word: "name"}), "the name axis has no ordering");
    });

    it("declares Russian with empty catalogs", () => {
        assert.deepEqual(resources.ru, {diagnostics: {}, rules: {}, tooltips: {}, ui: {}});
    });
});

describe("the fallback an empty locale depends on", () => {
    it("answers in English for a key the selected language has not translated", async () => {
        await i18n.changeLanguage("ru");
        try {
            assert.equal(i18n.language, "ru");
            assert.equal(t("ui:column.spell"), "Spell");
            assert.equal(t("tooltips:column.id"), i18n.t("tooltips:column.id", {lng: "en"}));
        } finally {
            // The suite shares one instance, and the app's language is English.
            await i18n.changeLanguage("en");
        }
    });

    it("prefers the translation once the key exists in the selected language", async () => {
        // Added here rather than to the shipped catalog: the point is that a key present in `ru` wins, which is what
        // makes filling src/locales/ru/ a translation rather than dead weight.
        i18n.addResource("ru", "ui", "column.spell", "Заклинание");
        await i18n.changeLanguage("ru");
        try {
            assert.equal(t("ui:column.spell"), "Заклинание");
            // Its neighbours in the same namespace still fall back, so the fallback is per key.
            assert.equal(t("ui:column.model"), "Models");
        } finally {
            i18n.removeResourceBundle("ru", "ui");
            await i18n.changeLanguage("en");
        }
    });
});
