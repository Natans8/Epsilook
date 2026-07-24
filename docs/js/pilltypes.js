// @ts-check
/* The pill-type registry: every kind of content the app shows and searches.
 *
 * One record per type. From it follow the category word offered in
 * autocomplete, that word's description, the group head's tooltip, whether a
 * pill lights up as a search hit, and which spells a query selects — the
 * render half in app.js and the search half in search.js now read the same
 * declaration instead of two hand-written copies.
 *
 * ADDING A TYPE. Declare it here, write its renderer in app.js, give its
 * label colour a tone in app.css. Nothing else branches on it: the fx column
 * iterates this registry, so does the fx search, so does the autocomplete.
 *
 * THE AXES a token can match on (see tokenMatches in pills.js):
 *   corpus   the lowercase haystack data.js bakes per id. It already contains
 *            the category word, which is why `fx:chain` and `fx:"chain red"`
 *            are the same code path.
 *   bare     a bare number that IS the id (an invisibility type).
 *   numeric  a number the id carries. `kind: "count"` counts things (a
 *            vehicle's seats), `kind: "value"` is a measurement (a percent).
 *            `operatorOnly: true` means a bare number keeps its text/bare
 *            meaning and only `>`, `<`, `>=`, `<=`, `=` reach this axis.
 *
 * Types with neither corpus nor spells are KEYWORD-ONLY: their column matches
 * them through its own indexes (model files, animation names), and the record
 * exists so the word, its description and its availability live with all the
 * others rather than in a private map.
 */
"use strict";

(() => {
    const P = window.EpsilookPills;
    const T = P.defineType;

    /* ------------------------------------------------------------- models */

    /* Model usage categories. The pills are model FILES, matched by
     * spellsByModel against the (category, file) corpus, so these carry no
     * corpus of their own — only the word, its description and the head. */
    const modelCat = (word, hint) => T({
        key: "model:" + word, field: "model", word, hint,
        when: (d) => Object.values(d.modelCatNames || {}).includes(word),
    });
    modelCat("attached", "Model attached to the caster/target (SpellVisualKitModelAttach)");
    modelCat("attach", "Model attached to the caster/target (SpellVisualKitModelAttach)");
    modelCat("missile", "Projectile model in flight (SpellVisualMissile)");
    modelCat("ground", "Ground / area model (SpellVisualKitAreaModel)");
    modelCat("area", "Ground / area model (SpellVisualKitAreaModel)");
    modelCat("trail", "Weapon trail model (WeaponTrail)");
    modelCat("barrage", "Volley of models (BarrageEffect)");
    modelCat("display",
        "Creature display model attached to the caster/target (SpellVisualEffectName Type 2)");
    modelCat("item", "An in-game item's model, held by the caster (SpellVisualEffectName Type 1)");

    /* The equipped-weapon markers' shared meta word (SYNTHETIC_MODEL_FILES in
     * build_data). Not a model category — the markers ride the attach/missile
     * categories with a sentinel fid — so the word lives only in their synthetic
     * filenames, each of which OPENS with it ("equipped off hand"). One word for
     * the whole family is all autocomplete gets: the slots are values, and only
     * meta words are offered there, so a slot is found by typing it like any
     * other filename (`model:"equipped off hand"`, or just `model:off hand`).
     * No parentheses in the hint: updateCategorySuggest cuts it at the first " (" */
    T({
        key: "model:equipped", field: "model", word: "equipped",
        hint: "A weapon the caster already has — main hand, off hand, ranged or ammo",
        when: (d) => !!d.hasSyntheticFiles,
    });

    /* Mounts (Mount.db2 keyed by SourceSpellID). Not a model CATEGORY — the
     * pill is a display id, not a file in the model graph — so unlike the
     * modelCat() words above it carries its own corpus (mount name + display id
     * + model path), the same shape fx:morph uses one column over. */
    T({
        key: "model:mount", field: "model", word: "mount",
        hint: "Mount the spell puts you on — Mount.db2 via its display id",
        corpus: (d) => d.mountSearchL, spells: (d) => d.mountSpells,
    });

    /* --------------------------------------------------------- animations */

    /* Headless animation groups: they head on a category word where an AnimKit
     * id would otherwise sit, and that word joins their corpus in spellsByAnim. */
    /* Animation replacements (proc Type 7 + aura 312, one merged group). Headless
     * — matched in spellsByAnim's per-anim loop (like passenger), so the anim
     * names on either side of a swap join its corpus: anim:replace finds any,
     * anim:"replace stealthstand" the ones that swap into it. */
    T({
        key: "anim:replace", field: "anim", word: "replace",
        hint: "Base animation the spell swaps for another, e.g. Stand to StealthStand",
        when: (d) => d.spellReplaceAnims.size > 0,
    });
    T({
        key: "anim:passenger", field: "anim", word: "passenger",
        hint: "What a rider plays entering, sitting in and leaving a seat",
        when: (d) => d.spellPassengerAnims.size > 0,
    });

    /* --------------------------------------------------------------- fx */

    /* Every fx type below carries a real corpus, so declaration order here IS
     * the order the fx search scans them (and the order they were added). */

    T({
        key: "fx:chain", field: "fx", word: "chain",
        hint: "Chain / beam effect (SpellChainEffects)",
        corpus: (d) => d.fxSearchL, spells: (d) => d.fxSpells,
    });
    T({
        key: "fx:dissolve", field: "fx", word: "dissolve",
        hint: "Dissolve / materialize effect (DissolveEffect)",
        corpus: (d) => d.dissolveSearchL, spells: (d) => d.dissolveSpells,
    });
    T({
        key: "fx:glow", field: "fx", word: "glow",
        hint: "Edge glow / rim-light effect (EdgeGlowEffect)",
        corpus: (d) => d.glowSearchL, spells: (d) => d.glowSpells,
    });
    /* "ghost" is one word fed by two unrelated tables — ShadowyEffect rows and
     * Type-22 material recolors. Two records, one keyword: exactly the case the
     * word/key split exists for. */
    T({
        key: "fx:shadowy", field: "fx", word: "ghost",
        hint: "Ghostly recolor (ShadowyEffect / ghost material)",
        corpus: (d) => d.shadowySearchL, spells: (d) => d.shadowySpells,
    });
    T({
        key: "fx:ghostmat", field: "fx", word: "ghost",
        corpus: (d) => d.ghostMatSearchL, spells: (d) => d.ghostMatSpells,
    });
    T({
        key: "fx:tint", field: "fx", word: "tint",
        hint: "Model tint (SpellProceduralEffect)",
        corpus: (d) => d.tintSearchL, spells: (d) => d.tintSpells,
    });
    /* The percent IS the id, so the numeric axis reads the key itself. Bare
     * numbers stay a substring on the "desaturate 70%" corpus (fx:"desaturate
     * 70"); only an operator asks for a comparison. */
    T({
        key: "fx:desaturate", field: "fx", word: "desaturate",
        hint: "Model desaturation (SpellProceduralEffect)",
        corpus: (d) => d.desatSearchL, spells: (d) => d.desatSpells,
        numeric: {kind: "value", of: (d, percent) => percent, operatorOnly: true},
    });
    T({
        key: "fx:transparency", field: "fx", word: "transparency",
        hint: "Model transparency (SpellProceduralEffect)",
        corpus: (d) => d.transpSearchL, spells: (d) => d.transpSpells,
        numeric: {kind: "value", of: (d, percent) => percent, operatorOnly: true},
    });
    /* Valueless: there is no id, the category word is the whole query, and the
     * spell set matches as a block. */
    T({
        key: "fx:freeze", field: "fx", word: "freeze",
        hint: "Freeze / petrify in place (SpellProceduralEffect)",
        spells: (d) => d.spellFreezes,
    });
    T({
        key: "fx:camo", field: "fx", word: "camo",
        hint: "Camouflage / cloaking effect (SpellProceduralEffect)",
        spells: (d) => d.spellCamos,
    });
    /* Seat count is a genuine count, and bare numbers reach it (fx:"seat 8"),
     * because a vehicle's corpus is words only — nothing else could claim one. */
    T({
        key: "fx:seat", field: "fx", word: "seat",
        hint: "Seat of a rideable vehicle the caster becomes (SpellEffect SET_VEHICLE_ID)",
        corpus: (d) => d.vehicleSearchL, spells: (d) => d.vehicleSpells,
        numeric: {kind: "count", of: (d, v) => (d.vehicleSeats.get(v) || []).length},
    });
    T({
        key: "fx:screen", field: "fx", word: "screen",
        hint: "Full-screen tint / overlay while the aura holds (ScreenEffect)",
        corpus: (d) => d.screenSearchL, spells: (d) => d.screenSpells,
    });
    T({
        key: "fx:shapeshift", field: "fx", word: "shapeshift",
        hint: "Shapeshift form (SpellShapeshiftForm)",
        corpus: (d) => d.shapeshiftSearchL, spells: (d) => d.shapeshiftSpells,
    });
    T({
        key: "fx:morph", field: "fx", word: "morph",
        hint: "Morph / transform aura (CreatureDisplayInfo)",
        corpus: (d) => d.morphSearchL, spells: (d) => d.morphSpells,
    });
    T({
        key: "fx:summon", field: "fx", word: "summon",
        hint: "Summoned creature (SpellEffect SUMMON)",
        corpus: (d) => d.summonPairSearchL, spells: (d) => d.summonPairSpells,
    });
    /* Gameobject spawners — summon's sibling: one conjures a creature, this
     * places an OBJECT. The corpus is the object name plus its model file, so a
     * nameless object is still found by what it looks like. */
    T({
        key: "fx:object", field: "fx", word: "object",
        hint: "GameObject the spell places in the world — a campfire, portal, banner or chest",
        corpus: (d) => d.objectSearchL, spells: (d) => d.objectSpells,
    });
    /* The two sides of an invisibility channel. All three axes at once: the
     * category word is the corpus, the invisibility TYPE is the bare number
     * (fx:"invis 13"), and the COUNTERPART count answers only to an operator
     * (fx:"invis =0" = an invisibility nothing detects). */
    T({
        key: "fx:invis", field: "fx", word: "invis",
        hint: "Invisibility channel — hides in an invisibility type (MOD_INVISIBILITY)",
        spells: (d) => d.invisTypeSpells,
        bare: (d, type) => type,
        numeric: {
            kind: "count", operatorOnly: true,
            of: (d, type) => (d.detectTypeSpells.get(type) || []).length,
        },
    });
    T({
        key: "fx:detect", field: "fx", word: "detect",
        hint: "Sees an invisibility channel (MOD_INVISIBILITY_DETECT)",
        spells: (d) => d.detectTypeSpells,
        bare: (d, type) => type,
        numeric: {
            kind: "count", operatorOnly: true,
            of: (d, type) => (d.invisTypeSpells.get(type) || []).length,
        },
    });
    T({
        key: "fx:keybind", field: "fx", word: "keybind",
        hint: "A key that casts a spell while the aura holds (SpellKeyboundOverride)",
        corpus: (d) => d.keybindSearchL, spells: (d) => d.keybindSpells,
    });
    /* Movement speed. The id is the (movement, percent) pair, so the corpus
     * holds both — fx:"speed swim" and fx:"speed +70%" ask different questions
     * of the same pills. The percent answers to an operator only, leaving a
     * bare number its literal meaning (fx:"speed 70" finds +70%, not 70 of
     * anything); operators reach the signed value, so fx:"speed <-50" is
     * "slows worse than half". */
    T({
        key: "fx:speed", field: "fx", word: "speed",
        hint: "Movement speed change — run, mounted, swim, flight or all at once",
        corpus: (d) => d.speedSearchL, spells: (d) => d.speedSpells,
        numeric: {
            kind: "value", operatorOnly: true,
            of: (d, key) => d.speedPercents.get(key) || 0,
        },
    });
    /* Object scale — movement speed's shorter twin. There is only one thing
     * these auras scale, so the percent IS the id and the numeric axis reads it
     * directly, the way desaturate does. Operator-only for the same reason:
     * fx:"scale 30" should find +30%, not 30 of something. */
    T({
        key: "fx:scale", field: "fx", word: "scale",
        hint: "Size change — how much bigger or smaller the aura makes its target",
        corpus: (d) => d.scaleSearchL, spells: (d) => d.scaleSpells,
        numeric: {kind: "value", of: (d, pct) => pct, operatorOnly: true},
    });
})();
