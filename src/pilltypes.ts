/* The pill-type registry: every kind of content the app shows and searches.
 *
 * One record per type. From it follow the category word offered in
 * autocomplete, that word's description, the group head's tooltip, whether a
 * pill lights up as a search hit, and which spells a query selects — the
 * render half (app modules) and the search half (search.ts) read the same
 * declaration instead of two hand-written copies.
 *
 * ADDING A TYPE. Declare it here, write its renderer in render.ts, give its
 * label colour a tone in app.css. Nothing else branches on it: the fx column
 * iterates this registry, so does the fx search, so does the autocomplete.
 *
 * THE AXES a token can match on (see tokenMatches in pills.ts):
 *   corpus   the lowercase haystack data.ts bakes per id. It already contains
 *            the category word, which is why `fx:chain` and `fx:"chain red"`
 *            are the same code path.
 *   bare     a bare number that IS the id (an invisibility type).
 *   numeric  a number the id carries. `kind: "count"` counts things (a
 *            vehicle's seats), `kind: "value"` is a measurement (a percent).
 *            Written against the word it is that word's ARGUMENT and always
 *            reaches this axis, bare or not — fx:"scale 50" is fx:"scale =50".
 *            `operatorOnly: true` governs a number standing LOOSE in the chip:
 *            without an operator it keeps its text/bare meaning instead.
 *
 * Types with neither corpus nor spells are KEYWORD-ONLY: their column matches
 * them through its own indexes (model files, animation names), and the record
 * exists so the word, its description and its availability live with all the
 * others rather than in a private map.
 *
 * This module is all side effects (registrations) — main.ts imports it for
 * them, and forgetting that import would fail tools/build.mjs's reachability
 * guard rather than silently dropping every category word.
 */
import {defineType as T} from "./pills";

/* ------------------------------------------------------------- models */

/* Model usage categories. The pills are model FILES, matched by
 * spellsByModel against the (category, file) corpus, so these carry no
 * corpus of their own — only the word, its description and the head. */
const modelCat = (word: string, hint: string) => T({
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
    hint: "Weapon the caster already has — main hand, off hand, ranged or ammo",
    when: (d) => d.hasSyntheticFiles,
});

/* Mounts (Mount.db2 keyed by SourceSpellID). Not a model CATEGORY — the
 * pill is a display id, not a file in the model graph — so unlike the
 * modelCat() words above it carries its own corpus (mount name + display id
 * + model path), the same shape fx:morph uses one column over. */
T({
    key: "model:mount", field: "model", word: "mount",
    hint: "Mount the spell puts you on",
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
/* WHERE an animation comes from, which is the one thing the Animations column
 * draws plainly and the search could not ask about. An anim either arrives
 * through an AnimKit — the numbered boxes, a named bundle the client plays as a
 * unit, and the only source that carries bonesets — or the spell's visual kit
 * plays it directly, which is the loose pills above them. On 9.2.7 that is
 * 31,259 spells against 82,009, with 11,168 carrying both, so it genuinely
 * partitions the column rather than naming a corner of it.
 *
 * HEADLESS, like replace and passenger, and matched the same way: the word
 * joins the corpus of the anims from that source (spellsByAnim), so `anim:kit`
 * is every kit-borne animation and `anim:"kit dance"` is a dance that came from
 * one. That uniformity is the point — four sources, four words, one rule — and
 * it is why `loose` still finds Attack2HLoosePierce by name, the same
 * documented overlap as fx:glow matching beam_webglowwhite.
 *
 * They describe a ROW's origin, so they are not `count`-like axes and not
 * target words; nothing else in the anim column branches on which source a pill
 * came from, and nothing has to. */
T({
    key: "anim:kit", field: "anim", word: "kit",
    hint: "Animation played through an AnimKit — the numbered bundles",
    when: (d) => d.animKitSpells.size > 0,
});
T({
    key: "anim:loose", field: "anim", word: "loose",
    hint: "Animation the spell's visual kit plays directly, in no AnimKit",
    when: (d) => d.visualAnimSpells.size > 0,
});

/* ------------------------------------------------------- fx and mech

 * `field` is the whole of "which column is this?" — the cell renderer, the
 * search dispatch, the autocomplete vocabulary and the hit test all read
 * it, so moving a type between columns is the one-word change below.
 *
 * THE LINE BETWEEN THE TWO COLUMNS IS "can you see it?". fx is what the
 * spell LOOKS like; mech is what it DOES. So seat/invis/detect/keybind/
 * speed sit in mech — a vehicle seat, an invisibility channel, a bound key
 * and a movement-speed change render nothing — while scale stays in fx
 * despite being an aura exactly like speed, because a size change is
 * visible. Same reason summon, object, freeze and camo stay: you can see
 * all four.
 *
 * Every fx type below carries a real corpus, so declaration order here IS
 * the order the fx search scans them (and the order they were added). */

T({
    key: "fx:chain", field: "fx", word: "chain",
    hint: "Chain / beam effect (SpellChainEffects)",
    corpus: (d) => d.fxSearchL, spells: (d) => d.fxSpells,
    targets: (d) => d.fxTargets,
});
T({
    key: "fx:dissolve", field: "fx", word: "dissolve",
    hint: "Dissolve / materialize effect (DissolveEffect)",
    corpus: (d) => d.dissolveSearchL, spells: (d) => d.dissolveSpells,
    targets: (d) => d.dissolveTargets,
});
T({
    key: "fx:glow", field: "fx", word: "glow",
    hint: "Edge glow / rim-light effect (EdgeGlowEffect)",
    corpus: (d) => d.glowSearchL, spells: (d) => d.glowSpells,
    targets: (d) => d.glowTargets,
});
/* "ghost" is one word fed by two unrelated tables — ShadowyEffect rows and
 * Type-22 material recolors. Two records, one keyword: exactly the case the
 * word/key split exists for. */
T({
    key: "fx:shadowy", field: "fx", word: "ghost",
    hint: "Ghostly recolor (ShadowyEffect / ghost material)",
    corpus: (d) => d.shadowySearchL, spells: (d) => d.shadowySpells,
    targets: (d) => d.shadowyTargets,
});
T({
    key: "fx:ghostmat", field: "fx", word: "ghost",
    corpus: (d) => d.ghostMatSearchL, spells: (d) => d.ghostMatSpells,
    targets: (d) => d.ghostMatTargets,
});
T({
    key: "fx:tint", field: "fx", word: "tint",
    hint: "Model tint (SpellProceduralEffect)",
    corpus: (d) => d.tintSearchL, spells: (d) => d.tintSpells,
});
/* The percent IS the id, so the numeric axis reads the key itself.
 * fx:"desaturate 70" asks it for exactly 70%; a number loose in the chip
 * stays a substring on the "desaturate 70%" corpus. */
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
/* Seat count is a genuine count, and mech:"seat 8" asks it for exactly 8.
 * No operatorOnly: a vehicle's corpus is attachment names, so a loose
 * number has nothing else here it could have meant. */
T({
    key: "fx:seat", field: "mech", word: "seat",
    hint: "Seat of the vehicle the caster becomes (SpellEffect SET_VEHICLE_ID)",
    corpus: (d) => d.vehicleSearchL, spells: (d) => d.vehicleSpells,
    numeric: {kind: "count", of: (d, v) => (d.vehicleSeats.get(v) || []).length},
});
T({
    key: "fx:screen", field: "fx", word: "screen",
    hint: "Full-screen tint / overlay while the aura holds (ScreenEffect)",
    corpus: (d) => d.screenSearchL, spells: (d) => d.screenSpells,
    targets: (d) => d.screenTargets,
});
T({
    key: "fx:shapeshift", field: "fx", word: "shapeshift",
    hint: "Shapeshift form (SpellShapeshiftForm)",
    corpus: (d) => d.shapeshiftSearchL, spells: (d) => d.shapeshiftSpells,
    targets: (d) => d.shapeshiftTargets,
});
T({
    key: "fx:morph", field: "fx", word: "morph",
    hint: "Morph / transform aura (CreatureDisplayInfo)",
    corpus: (d) => d.morphSearchL, spells: (d) => d.morphSpells,
    targets: (d) => d.morphTargets,
});
T({
    key: "fx:summon", field: "fx", word: "summon",
    hint: "Summoned creature (SpellEffect SUMMON)",
    corpus: (d) => d.summonPairSearchL, spells: (d) => d.summonPairSpells,
    targets: (d) => d.summonTargets,
});
/* Gameobject spawners — summon's sibling: one conjures a creature, this
 * places an OBJECT. The corpus is the object name plus its model file, so a
 * nameless object is still found by what it looks like. */
T({
    key: "fx:object", field: "fx", word: "object",
    hint: "GameObject the spell places — campfire, portal, banner, chest",
    corpus: (d) => d.objectSearchL, spells: (d) => d.objectSpells,
    targets: (d) => d.objectTargets,
});
/* The two sides of an invisibility channel. All three axes at once: the
 * category word is the corpus, the invisibility TYPE is the bare number
 * (mech:"invis 13"), and the COUNTERPART count answers only to an operator
 * (mech:"invis =0" = an invisibility nothing detects).
 *
 * The ONE pair whose argument is not the numeric axis: a number after the
 * word is the channel, because that is what its number IS. Declaring `bare`
 * is the whole of saying so — bindNumeric leaves such a type alone. */
T({
    key: "fx:invis", field: "mech", word: "invis",
    hint: "Invisibility channel the aura hides in (MOD_INVISIBILITY)",
    spells: (d) => d.invisTypeSpells,
    bare: (d, type) => type,
    numeric: {
        kind: "count", operatorOnly: true,
        of: (d, type) => (d.detectTypeSpells.get(type) || []).length,
    },
});
T({
    key: "fx:detect", field: "mech", word: "detect",
    hint: "Sees an invisibility channel (MOD_INVISIBILITY_DETECT)",
    spells: (d) => d.detectTypeSpells,
    bare: (d, type) => type,
    numeric: {
        kind: "count", operatorOnly: true,
        of: (d, type) => (d.invisTypeSpells.get(type) || []).length,
    },
});
T({
    key: "fx:keybind", field: "mech", word: "keybind",
    hint: "Key that casts a spell while the aura holds (SpellKeyboundOverride)",
    corpus: (d) => d.keybindSearchL, spells: (d) => d.keybindSpells,
});
/* Movement speed. The id is the (movement, percent) pair, so the corpus
 * holds both — fx:"speed swim" and fx:"speed +70%" ask different questions
 * of the same pills. fx:"speed 70" is the percent, exactly +70%; the axis
 * is signed, so fx:"speed <-50" is "slows worse than half". Loose numbers
 * stay corpus text (fx:"speed run 70" reads the pill's own label). */
T({
    key: "fx:speed", field: "mech", word: "speed",
    hint: "Movement speed change — run, mounted, swim, flight or all at once",
    corpus: (d) => d.speedSearchL, spells: (d) => d.speedSpells,
    numeric: {
        kind: "value", operatorOnly: true,
        of: (d, key) => d.speedPercents.get(key) || 0,
    },
});
/* Spell -> spell links (SpellEffect.EffectTriggerSpell). The one edge in the
 * data that joins two spell ROWS, so unlike every other type here the pill's
 * id is a Spell::ID and clicking it filters to that spell's own row.
 *
 * MECH, NOT FX, by this file's own rule two screens up: fx is what the spell
 * LOOKS like and mech is what it DOES. A link renders nothing in game — the
 * thing you can see is on the OTHER row, which is the whole reason the chip
 * needs to get you there.
 *
 * TWO TYPES, ONE EDGE SET, because direction is the first thing you want to
 * ask: `triggers` is what this spell reaches, `origin` what reaches it. The
 * corpus of each is the linked spell's NAME plus every word the two are joined
 * by, so mech:"triggers fireball" and mech:"triggers periodically" are the same
 * code path.
 *
 * THE ID ANSWERS THROUGH `bare`, NEVER THROUGH THE CORPUS — the distinction is
 * the whole reason `mech:"triggers 133"` can exist at all. A corpus is matched
 * by SUBSTRING, and putting a 6-digit id in one was measured out (data.ts:
 * `mech:"speed 70"` 76 -> 85, `mech:"invis 13"` 11 -> 47). `bare` is EQUALITY
 * against the id the chip stands for, so 133 means spell 133 and nothing else —
 * the same mechanism invis/detect already use for their channel number, and the
 * reason declaring it here is two lines rather than a new axis. Generalise that
 * before adding any other id-bearing search: the corpus is for words.
 *
 * `origin` replaced `triggeredby` on 2026-07-30 (user: "not aesthetic"). Every
 * other category word in this app is one plain word; a run-together compound
 * was the odd one out, and it read no better as a group head than in the bar.
 * The pair is a verb and a noun on purpose — "what it triggers" and "where it
 * came from" are the two questions, and the Mechanics column's other heads
 * (speed, seat, invis, keybind) are nouns already. No legacy alias, per the
 * standing norm on renames.
 *
 * Neither word collides with an effect/aura NAME the mech column already
 * matches — verified zero on 9.2.7, because those are singular
 * (`PROC_TRIGGER_SPELL`), so `mech:trigger` still finds the enum rows. The
 * corpus's name half can still match, exactly as every other category word in
 * this app matches filenames: `mech:triggers` is 49,216 against 49,209 link
 * sources, the 7 extra being spells reached from ones literally named
 * "... Area Triggers". Documented substring behaviour, not a leak. */
T({
    key: "mech:triggers", field: "mech", word: "triggers",
    hint: "Another spell this one casts, ticks, procs or removes — by name or id",
    corpus: (d) => d.triggersSearchL, spells: (d) => d.triggersSpells,
    bare: (d, id) => id,
    when: (d) => d.triggersSpells.size > 0,
});
T({
    key: "mech:origin", field: "mech", word: "origin",
    hint: "A spell that casts, ticks, procs or removes this one — by name or id",
    corpus: (d) => d.originSearchL, spells: (d) => d.originSpells,
    bare: (d, id) => id,
    when: (d) => d.originSpells.size > 0,
});

/* The area gate (SpellCastingRequirements.RequiredAreasID) — the only type here
 * whose subject is a RESTRICTION rather than something the spell does, which is
 * why its group head reads `only in` and not the word below. See docs/PILLS.md
 * "Choosing the keyword" for both halves of that.
 *
 * THE WORD IS `location`, AND `area` IS SPENT THREE TIMES OVER. It is a target
 * word, it was already taken from the model column once (area -> ground), and
 * 37,548 spells carry an implicit-target name containing it (UNIT_SRC_AREA_ENEMY
 * and 21 more), so `mech:area` would answer ~49,066 for a feature with 12,375
 * real members. `location` collides with nothing — measured 0 on 9.2.7. `zone`
 * also measures 0 and lost on meaning: half these gates name a SUBZONE
 * (Meredil, Shal'Aran), which is not a zone.
 *
 * MECH, NOT FX, by this file's own rule: fx is what a spell looks like, mech is
 * what it does. Where it may be cast renders nothing at all.
 *
 * No `bare` axis, unlike the link types above. An area id is a number nobody has
 * a way to know — it is not `.cast`'s argument the way a spell id is — so there
 * is no id-shaped question to answer and the corpus stays words only. */
T({
    key: "mech:location", field: "mech", word: "location",
    hint: "Where the spell refuses to cast — Epsilon enforces this gate on .cast",
    corpus: (d) => d.areaSearchL, spells: (d) => d.areaSpells,
    when: (d) => d.areaSpells.size > 0,
});

/* ------------------------------------------------- attribute flags */

/* SpellMisc attribute bits. Valueless like fx:freeze — membership IS the
 * payload — but they come from ONE open-ended pack section keyed by handler,
 * so shipping another flag is a `handler` tag in
 * build/enums/spell_attributes.json plus one line here. Nothing branches on
 * which flag it is, in this file or in data.ts.
 *
 * THE WORDING DESCRIBES WHAT EPSILON DOES, not what retail documents. Roughly
 * half the flags tested did not survive contact with Epsilon, so every one
 * below was confirmed in game by the user before it shipped and the phrasing
 * is theirs — see docs/DECISIONS.md "EPSILON BEHAVIOUR". `when` is what keeps
 * a pre-format-37 pack (and a build too old to have the bit) from offering the
 * word at all. */
export interface AttrFlag {
    /** pack key: the `handler` in build/enums/spell_attributes.json */
    handler: string;
    /** the column it renders in */
    field: string;
    /** its category word, which IS the whole pill */
    word: string;
    /** the pill type's key, for the hit test */
    key: string;
    /** Does it render as a pill in its column? False for the delivery flags,
     *  which are INHERENT to every spell and so are stated once on the Name
     *  cell's delivery line instead of repeated as pills in Mechanics. They
     *  stay fully searchable — this is a display flag, not a registration one.
     *  Both render sites read this list, so it cannot go out of step with the
     *  search half the way the fx column's target masks once did. */
    draw: boolean;
}

/** Every shipped flag, in declaration order. render.ts draws the cells from
 *  THIS, so a flag cannot be registered as a search word and then forgotten by
 *  the renderer (or vice versa) — the two halves read one list. */
export const ATTR_FLAGS: AttrFlag[] = [];

const attrFlag = (key: string, field: string, word: string, handler: string, hint: string,
                  draw = true) => {
    T({
        key, field, word, hint,
        spells: (d) => d.spellAttrs.get(handler) || new Set<number>(),
        when: (d) => (d.spellAttrs.get(handler)?.size ?? 0) > 0,
    });
    ATTR_FLAGS.push({handler, field, word, key, draw});
};

/* HOW THE SPELL IS DELIVERED. Derived in data.ts from the spellDelivery values
 * rather than shipped as lists, so the word and the number on the delivery line
 * cannot disagree.
 *
 * NOT A PARTITION — `casttime` and `channeled` OVERLAP on 3,148 spells that
 * cast and then channel (verified in game; see docs/DECISIONS.md). Only
 * `instant` is exclusive with both, being the complement. Do not "fix" the
 * counts into summing to the pack.
 *
 * `draw: false` on all three: they are inherent to every spell, so the Name
 * cell's delivery line states them once instead of Mechanics repeating them as
 * pills (the user's call — "remove the unnecessary garbage from the mech
 * column then").
 *
 * THE WORDS ARE WOWHEAD'S, on the user's call ("Match the wowhead convention"):
 * Wowhead's own row label is `Cast time`, so the axis is `casttime` — a bare
 * `cast` measures 216,457 and is unusable, "on cast" being a spell-link word
 * carried by the whole mech corpus. And it is `channeled` with ONE l, because
 * that is how Wowhead, the client and Blizzard spell it: the British spelling
 * shipped for one day and made `mech:channeled` return 4 spells instead of
 * 14,228, i.e. it failed exactly the person who read the word on Wowhead and
 * typed it here. `instant` measures 35 on a 216k base. */
attrFlag("mech:instant", "mech", "instant", "instant",
    "Goes off at once — no cast bar, no channel", false);
attrFlag("mech:casttime", "mech", "casttime", "casttime",
    "Has a cast bar before it goes off", false);
attrFlag("mech:channeled", "mech", "channeled", "channeled",
    "Channeled — held rather than cast once", false);

/* The channel group: three ways a channelled beam behaves, which is the most
 * scene-relevant cluster in the whole attribute sweep. */
attrFlag("mech:unbreakable", "mech", "unbreakable", "unbreakablechannel",
    "Channel that persists — the caster can still move and act while it holds");
/* IT IS THE CASTER'S FACING, NOT THE BEAM (user's correction): the caster stays
 * turned toward the target for the whole channel, locked in its direction. The
 * beam merely follows from that. fx rather than mech is the user's call and
 * survives the correction — a character being turned is what the spell LOOKS
 * like, not a rule about what it does. The move also cut the word's corpus
 * noise 175 -> 8, the fx corpus being filenames rather than aura/link names.
 * Sibling not shipped: bit 22 `TrackTargetInCastPlayerOnly`, the cast-time
 * equivalent. */
attrFlag("fx:tracking", "fx", "tracking", "tracktargetinchannel",
    "Caster stays facing the target for the whole channel");
/* Shipped as the INTERSECTION with IsChannelled, in the pack. The flag alone
 * samples spells that are not channels at all, which made its examples
 * meaningless — the build does the AND so the word cannot lie here. */
/* NOT `actions`: that word substring-matches the aura name `MOD_NO_ACTIONS`,
 * dragging in 342 spells that mean the OPPOSITE. Every category word in this
 * app also matches names, so a word has to be checked against the corpus it
 * will live in — `unhindered` measures zero collisions where `actions` measured
 * +497. The hint is what separates it from `unbreakable` next door. */
attrFlag("mech:unhindered", "mech", "unhindered", "actionsduringchannel",
    "Channel the caster can act during (still breaks on the usual interrupts)");
attrFlag("mech:debuff", "mech", "debuff", "auraisdebuff",
    "Aura that shows in the red debuff frame");
/* The RP body-pose library, and the reason this feature exists: these spells
 * have no distinguishing model, sound or animation, so before the flag they
 * were unfindable. Permanent Feign Death, Cosmetic Dead Hanging and friends. */
attrFlag("anim:pose", "anim", "pose", "preventsanim",
    "Holds the character's pose — the spell suppresses its own animation");

/* Object scale — movement speed's shorter twin. There is only one thing
 * these auras scale, so the percent IS the id and the numeric axis reads it
 * directly, the way desaturate does. fx:"scale 30" is exactly +30%, and
 * -30% is written as it reads: fx:"scale -30". */
T({
    key: "fx:scale", field: "fx", word: "scale",
    hint: "Size change the aura applies",
    corpus: (d) => d.scaleSearchL, spells: (d) => d.scaleSpells,
    targets: (d) => d.scaleTargets,
    numeric: {kind: "value", of: (d, pct) => pct, operatorOnly: true},
});
