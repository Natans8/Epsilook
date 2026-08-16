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

/** One catalog's leaves, in declaration order, as dotted key and text. */
function leaves(node: unknown, prefix = ""): [string, string][] {
    if (typeof node !== "object" || node === null) return [];
    return Object.entries(node).flatMap(([name, value]) => {
        const key = prefix === "" ? name : `${prefix}.${name}`;
        return typeof value === "string" ? [[key, value] as [string, string]] : leaves(value, key);
    });
}

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

    it("declares Russian as a skeleton: English's keys, none of them translated yet", () => {
        // What `npm run translate -- --lang=ru --write` produces. Its keys are English's, so a translator sees
        // every string there is to say; its values are empty, which is the "not yet" state the fallback below
        // depends on. A key Russian carries that English does not is caught by check.py rather than here.
        for (const namespace of Object.keys(resources.en) as (keyof typeof resources.en)[]) {
            assert.deepEqual(leaves(resources.ru[namespace]).map(([key]) => key),
                leaves(resources.en[namespace]).map(([key]) => key), namespace);
            const said = leaves(resources.ru[namespace]).filter(([, text]) => text !== "");
            assert.deepEqual(said, [], `${namespace} carries a translation this test does not expect yet`);
        }
    });
});

describe("the fallback a skeleton locale depends on", () => {
    it("answers in English for a key whose translation is still the skeleton's empty value", async () => {
        // The key EXISTS in Russian and holds "". Without `returnEmptyString: false` i18next would treat that as a
        // translation and render nothing, so a skeleton would blank the interface rather than fall back.
        assert.equal(i18n.getResource("ru", "ui", "column.spell"), "");
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
