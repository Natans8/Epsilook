/* SEARCH 2.0 — L3 schema. THE KIND CATALOGUE.
 *
 *     A COLUMN yields ROWS. A ROW has a KIND. A KIND declares its PROPERTIES.
 *     An AXIS asks about one property.
 *
 * A KIND is what 1.0 called a pill type, and it is the missing middle term.
 * `chain`, `missile`, `dissolve`, `morph`, `seat` are kinds — nouns naming
 * WHAT A ROW IS. `from`, `to`, `scale`, `target`, `texture` are properties —
 * what that thing HAS.
 *
 * ⭐ WHY THE MIDDLE TERM HAD TO EXIST, MEASURED: `BeamEffect` carries a
 * `SourceAttachID` AND a `DestAttachID`, and **2,014 of 2,997 rows have
 * different ones — 67%**. So 1.0's `attach:chest` on a chain means *"the chest
 * is at one end, and I cannot tell you which"*. No amount of scoping fixes it,
 * because both ends are on the same row. Two properties sharing one type is
 * the whole answer, and it needs no "role" mechanism (SEARCH.md L5.2).
 *
 * ⭐ ONE DECLARATION, EVERY SURFACE. Search, autocomplete, the help row, the
 * bar capsule, the hit highlight, the filter affordance and the export column
 * all read this record. The build plan used to list "declare the axis" and
 * "declare the pill" as two steps; a kind is ONE (L11).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS DECLARED HERE AND WHAT IS DELIBERATELY ABSENT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ⛔ THE RULE THIS FILE FOLLOWS: A PROPERTY IS DECLARED ONLY WHERE THE PACK
 * CAN ANSWER IT TODAY. TYPES §8 marks many properties `?` (provisional) or
 * bold (does not exist in 1.0), and several of those are float columns the
 * build has never read — `BarrageEffect.ConeAngle`, `AnimKitSegment.Speed`,
 * `CastOffset_0/1/2`, `DecayTimeAfterImpact`. Declaring them would put an axis
 * in the autocomplete that returns nothing forever, which is worse than not
 * having it: the user cannot tell "no spells match" from "this does not work".
 * Each is ONE LINE when its row source lands, which is the extension contract
 * doing its job rather than a shortcut being taken.
 *
 * ⚠ NO `prefix` ON A PROPERTY YET. Under L5.2 a KIND word is already global —
 * a kind belongs to exactly one column, so there is no union to justify and
 * `missile:{from:chest}` needs no `model:`. What a property prefix would buy
 * is a UNION axis across kinds (`attach` over `from` and `to`, `target` over
 * everything), and a union needs the row sources to mean anything. PHASE 5.
 *
 * ⚠ NO `when` YET. SEARCH.md §2.2 sketches `when?(d: SpellData): boolean` —
 * absent data, absent word, everywhere. It gates on what the loaded pack
 * CONTAINS, which is the row source's world and not the schema's; and the
 * sketch's signature takes a `SpellData`, which the declarative core must not
 * import (PLAN §3.1). PHASE 5 decides its shape against a real pack.
 */
import type {Column} from "./columns";
import {animColumn, fxColumn, idColumn, mechColumn, modelColumn, nameColumn, soundColumn} from "./columns";
import type {AxisType} from "./types";
import {bitmask, count, enumeration, id, ordinal, percent, path, seconds, text} from "./types";

/**
 * L7's relevance tiers — BEST TIER WINS, and only the ORDER matters.
 *
 * 1.0 ranks chipless search on the spell NAME alone, so a description-only hit
 * sits in the same bucket as an exact name match with nothing to sink it. That
 * is the known cost of shipping descriptions and icons into plain search, and
 * these tiers are the fix.
 */
export const TIER = {
    /** the spell's own title */
    title: 0,
    /** its id, typed exactly */
    id: 1,
    /** an asset it uses — a model, a sound, an animation, an icon */
    asset: 2,
    /** what it SAYS it does */
    description: 3,
} as const;

/** One property of one kind. */
export interface Prop {
    /**
     * ORDERED (TYPES §7): the first type whose `parse` accepts the operand
     * wins, so a thing with an id and a name declares `[id, text]`. Most
     * properties declare exactly one.
     *
     * ⚠ AN OPERATOR IS OFFERED ONLY IF EVERY LISTED TYPE ACCEPTS IT — the
     * INTERSECTION, never the union (TYPES §7 rule 2). `kit:>5` is a static
     * error because `id` and `text` both decline ordering. That rule governs
     * what the UI OFFERS; what MATCHES is decided by dispatch — see `named`.
     */
    readonly types: readonly AxisType[];

    /** L7: does chipless search read it, and how hard does it rank? */
    readonly plain?: boolean;
    readonly tier?: number;

    /** L11. Absent falls back to the first type's own hint, which is usually
     *  the honest answer — `from` on a missile IS "an attachment point". */
    readonly hint?: string;
}

export interface Kind {
    /** Stable identity, `column.word`. Never shown; it is what an export
     *  column, a saved query and a bug report can agree on. */
    readonly id: string;

    /** A REFERENCE, not a key: a typo is then a compile error rather than a
     *  kind that silently belongs to no column. */
    readonly column: Column;

    /**
     * The word a query writes. `missile:{from:chest}`, `fx:chain`.
     *
     * ⭐ A KIND WORD IS GLOBAL BY CONSTRUCTION, because a kind belongs to
     * exactly one column — there is nothing to union and no column to repeat.
     * ⚠ THIS SUPERSEDES L5.1's "scoped only" VERDICTS for the model/anim/fx
     * category words (`missile`, `ground`, `replace`, `loose`, `attached`…),
     * which were written before L5.2 gave a kind its own scope the same day.
     * G1 uniqueness still governs, and is enforced in `schema.ts`.
     *
     * OMITTED = reachable only through its column's head, which is right when
     * the word would be the column's own (`id`, `name`).
     */
    readonly word?: string;

    /** L11: one line, in the user's terms. */
    readonly hint: string;

    readonly props: Readonly<Record<string, Prop>>;
}

/** Every declared kind, by id. */
export const KINDS = new Map<string, Kind>();

export function defineKind(kind: Kind): Kind {
    if (KINDS.has(kind.id)) throw new Error(`kind "${kind.id}" already defined`);
    const expected = `${kind.column.key}.${kind.word ?? kind.column.key}`;
    if (kind.id !== expected) {
        throw new Error(`kind "${kind.id}" should be named "${expected}" — id is column.word`);
    }
    KINDS.set(kind.id, kind);
    return kind;
}

/**
 * The operators a property actually offers: the INTERSECTION of its types'
 * (TYPES §7 rule 2).
 *
 * Derived rather than declared, because it is a consequence and not a choice —
 * a multi-notation property that offered an operator only one of its notations
 * could answer would give a different result depending on which notation the
 * operand happened to look like, which is L12 (3).
 */
export function operatorsOf(prop: Prop): string[] {
    const [first, ...rest] = prop.types;
    return first.accepts
        .filter((op) => rest.every((type) => type.accepts.includes(op)))
        .map((op) => op.name);
}

/* Shorthands. `p([path])` is noise at this length; a named helper per shape is
 * not, because the SHAPE is the information — a plain property, a searchable
 * corpus, a thing with a name and an id. */
const of = (...types: readonly AxisType[]): Prop => ({types});
const corpus = (tier: number, ...types: readonly AxisType[]): Prop =>
    ({types, plain: true, tier});
/**
 * A thing with both a NAME and an ID — six properties are this shape
 * (TYPES §8.7): sound kit, morph display, summon creature, gameobject, area,
 * triggered spell. It is a pattern, not a special case.
 *
 * ID FIRST, so digits dispatch to the id and words fall through to the text.
 * That is the measured rule, not a preference: putting a 6-digit id into a
 * substring CORPUS was tried and reverted, because `mech:"speed 70"` went from
 * 76 to 85 and `mech:"invis 13"` from 11 to 47. An id answers by EQUALITY.
 *
 * ⚠ AND THE INTERSECTION RULE (TYPES §7 rule 2) IS ABOUT WHAT THE UI OFFERS,
 * NOT ABOUT WHAT MATCHES. `operatorsOf` gives [exact, present] here because
 * `id` declines substring — so autocomplete must not offer `>` — while a bare
 * word still matches the NAME, because dispatch picks `text` for it and `text`
 * accepts `contains`. Reading rule 2 as a matching rule would delete
 * `sound:"kit frostbolt"`, which is 69 real spells today.
 *
 * Omit the tier to keep it out of chipless search.
 */
const named = (tier?: number): Prop =>
    (tier === undefined ? {types: [id, text]} : {types: [id, text], plain: true, tier});

/** WHO IT PLAYS ON. The most-shared property in the app — TYPES §8.7 counts it
 *  on ~25 of ~35 kinds, which is why it read like a universal axis and why it
 *  is not one: it is a property most kinds happen to have. Declared only where
 *  1.0 has a mask to answer from. */
const target = (): Prop => ({
    types: [bitmask],
    hint: "who it plays on — caster, target, both, area, others",
});

/** An M2 attachment point. `from`/`to` where a row has two ends, `attach`
 *  where it has one — and naming them apart is the 67% finding above. */
const attachPoint = (hint: string): Prop => ({types: [enumeration], hint});

/* ══════════════════════════════════════════════════════ name ══════════
 *
 * ⚠ THE KIND IS `title`, NOT `name`, AND THAT IS A NEW WORD. `name:` is the
 * COLUMN, and a column head searches every kind in it — title, description and
 * icon — which is exactly what 1.0's `name:` does. So a kind also called
 * `name` would make one spelling mean two different questions depending on
 * which head won, and that is L12 (3). Naming the kind `title` keeps the
 * column head behaving as it always has AND makes the title-only question
 * sayable for the first time, which 1.0 cannot express at all.
 */

export const title = defineKind({
    id: "name.title", column: nameColumn, word: "title",
    hint: "the spell's own name, and nothing else",
    props: {text: corpus(TIER.title, text)},
});

export const description = defineKind({
    id: "name.desc", column: nameColumn, word: "desc",
    hint: "what the spell says it does — its in-game description",
    props: {text: corpus(TIER.description, text)},
});

/* THE ICON'S fid IS DELIBERATELY NOT `plain`. Plain search already spends a
 * lone number on an exact SPELL-ID lookup, and letting the fid join would take
 * `135812` from one spell to 295. Reachable as `icon:135812`, where the head
 * says which number is meant. (§3y — the rule is per-axis, not a house rule.) */
export const icon = defineKind({
    id: "name.icon", column: nameColumn, word: "icon",
    hint: "the art on the spell's button — 272,900 spells share 9,846 icons",
    props: {
        name: corpus(TIER.asset, text),
        fid: {types: [id], hint: "the icon's file id — the number the ⧉ copies"},
    },
});

/* ══════════════════════════════════════════════════════ id ════════════ */

/* NO `word`: the column head IS the spelling (`id:133`), and a kind also
 * called `id` would be the same collision `title` avoids one column over. */
export const spellId = defineKind({
    id: "id.id", column: idColumn,
    hint: "the spell's own number — what .cast takes",
    props: {value: corpus(TIER.id, id)},
});

/* ⭐ `ordinal` EXISTS FOR THIS ONE KIND, and it is what makes `xpac` ordinary.
 * 1.0 handles it with a private second operator alphabet (`XPAC_VALUE`) —
 * exactly the duplication L1 forbids. The ladder itself ships in the pack
 * (`pack.expansions`, oldest first), so the ORDER is data and not a constant
 * here; see the `ordinal` card in types.ts. */
export const expansion = defineKind({
    id: "id.xpac", column: idColumn, word: "xpac",
    hint: "the expansion that introduced it — legion, >wotlk, <=mop",
    props: {rung: of(ordinal)},
});

/* ══════════════════════════════════════════════════════ model ═════════
 *
 * ⚠ THE CATEGORY WORD IS `attached`, NOT `attach` — and this is a live 1.0
 * DEFECT rather than a 2.0 choice. 1.0 registers `attach` BOTH as a model
 * category word and as the attachment keyword, so inside one column it already
 * means two things: `model:attach` is 16 (substring) against
 * `model:{attach:chest}` at 51,581 (keyword). Gate G1 fails today. `attached`
 * already exists in 1.0 as its twin and is the better noun. TYPES §8.6 (3).
 */

export const missile = defineKind({
    id: "model.missile", column: modelColumn, word: "missile",
    hint: "a projectile model in flight",
    props: {
        file: corpus(TIER.asset, path),
        from: attachPoint("where the missile launches from"),
        to: attachPoint("where the missile lands"),
        motion: {
            types: [enumeration],
            hint: "the trajectory it flies — parabola, forward spin, follow ground",
        },
        target: target(),
    },
});

export const ground = defineKind({
    id: "model.ground", column: modelColumn, word: "ground",
    hint: "a ground or area model laid on the world",
    props: {file: corpus(TIER.asset, path), target: target()},
});

export const trail = defineKind({
    id: "model.trail", column: modelColumn, word: "trail",
    hint: "a weapon trail that follows a swing",
    props: {file: corpus(TIER.asset, path), target: target()},
});

export const barrage = defineKind({
    id: "model.barrage", column: modelColumn, word: "barrage",
    hint: "a volley of models fired at once",
    props: {
        file: corpus(TIER.asset, path),
        attach: attachPoint("where the volley is fired from"),
        target: target(),
    },
});

export const attached = defineKind({
    id: "model.attached", column: modelColumn, word: "attached",
    hint: "a model stuck to the caster or the target",
    props: {
        file: corpus(TIER.asset, path),
        attach: attachPoint("where on the body it sits"),
        target: target(),
    },
});

export const display = defineKind({
    id: "model.display", column: modelColumn, word: "display",
    hint: "a creature display model attached to the caster or target",
    props: {
        id: {types: [id], hint: "the CreatureDisplayInfo id"},
        name: corpus(TIER.asset, text),
        file: corpus(TIER.asset, path),
        target: target(),
    },
});

export const item = defineKind({
    id: "model.item", column: modelColumn, word: "item",
    hint: "an in-game item's model, held by the caster",
    props: {
        file: corpus(TIER.asset, path),
        itemId: {types: [id], hint: "the item's own id"},
        target: target(),
    },
});

export const mount = defineKind({
    id: "model.mount", column: modelColumn, word: "mount",
    hint: "the mount the spell puts you on",
    props: {
        name: corpus(TIER.asset, text),
        file: corpus(TIER.asset, path),
        target: target(),
    },
});

/* The equipped-weapon markers. Not a model file in the graph — the slot IS the
 * information — so the slot is an enum and there is no path to search. */
export const equipped = defineKind({
    id: "model.equipped", column: modelColumn, word: "equipped",
    hint: "a weapon the caster already has — main hand, off hand, ranged or ammo",
    props: {
        slot: {types: [enumeration], hint: "which slot — main hand, off hand, ranged, ammo"},
        target: target(),
    },
});

/* ══════════════════════════════════════════════════════ sound ═════════ */

/* ⭐ `kit` IS THE CANONICAL MULTI-NOTATION PROPERTY (TYPES §7): one kit, two
 * spellings. The discriminator is decidable — `kit:85701` and
 * `kit:SPELL_MA_Revamp_Frostbolt_Precast` name the SAME row, where `invis:13`
 * and `invis:>0` name unrelated populations, which is why one is two notations
 * and the other is two axes.
 *
 * MEASURED: of 84,351 kit names on the 8.3.0 table, exactly THREE are all
 * digits ("0", "9", "150"), all placeholder junk, and NOT ONE equals its own
 * id. So a number reads as the id and nothing real is lost — and `check.py`
 * must keep asserting that, because a pack rebuild could introduce a collision
 * and silently change a bookmarked query. */
/* NO `word`, LIKE `id.id` AND FOR THE SAME REASON: `sound:` is the COLUMN, and
 * a kind also called `sound` would make one spelling mean two questions. The
 * column has exactly one kind, so the head is unambiguous and nothing is lost.
 * ⭐ THE G1 GUARD CAUGHT THIS ONE — it was declared with `word: "sound"` and
 * the schema refused to build. */
export const sound = defineKind({
    id: "sound.sound", column: soundColumn,
    hint: "a sound file the spell plays",
    props: {
        file: corpus(TIER.asset, path),
        kit: named(TIER.asset),
        target: target(),
    },
});

/* ══════════════════════════════════════════════════════ anim ══════════ */

export const replace = defineKind({
    id: "anim.replace", column: animColumn, word: "replace",
    hint: "an animation the spell swaps for another — Stand becomes StealthStand",
    props: {
        from: {types: [enumeration], hint: "the animation being replaced"},
        to: {types: [enumeration], hint: "what it is replaced with"},
        target: target(),
    },
});

export const passenger = defineKind({
    id: "anim.passenger", column: animColumn, word: "passenger",
    hint: "what a rider plays entering, sitting in and leaving a seat",
    props: {
        enter: of(enumeration),
        sit: of(enumeration),
        exit: of(enumeration),
    },
});

export const animKit = defineKind({
    id: "anim.kit", column: animColumn, word: "kit",
    hint: "an animation played through an AnimKit — the numbered bundles",
    props: {
        id: {types: [id], hint: "the AnimKit's own id"},
        anim: corpus(TIER.asset, enumeration),
        boneset: {types: [enumeration], hint: "which bones it drives — head, spine, arms"},
        target: target(),
    },
});

export const loose = defineKind({
    id: "anim.loose", column: animColumn, word: "loose",
    hint: "an animation the spell's visual kit plays directly, in no AnimKit",
    props: {
        anim: corpus(TIER.asset, enumeration),
        boneset: {types: [enumeration], hint: "which bones it drives — head, spine, arms"},
        target: target(),
    },
});

/* The RP body-pose library, and the reason the attribute-flag feature exists:
 * these spells have no distinguishing model, sound or animation, so before the
 * flag they were unfindable. Permanent Feign Death, Cosmetic Dead Hanging. */
export const pose = defineKind({
    id: "anim.pose", column: animColumn, word: "pose",
    hint: "holds the character's pose — the spell suppresses its own animation",
    props: {},
});

/* ══════════════════════════════════════════════════════ fx ════════════ */

/* ⚠ `tint` HAS NO COLOUR PROPERTY, AND THAT IS THE `colour` TYPE BEING
 * BLOCKED RATHER THAN AN OVERSIGHT (TYPES §4). Tints ship as packed 0xRRGGBB,
 * nobody knows a tint's exact packed value, and exact equality over 16.7M
 * values is not a question anyone asks. `fx:tint` still works as an existence
 * test; the colour becomes searchable when a MATCHING SEMANTIC is decided —
 * nearest-colour distance, or named buckets. The same holds for `chain`'s tint
 * and `glow`'s colour. */

export const chain = defineKind({
    id: "fx.chain", column: fxColumn, word: "chain",
    hint: "a chain or beam effect held between two points",
    props: {
        texture: corpus(TIER.asset, path),
        from: attachPoint("where the beam starts"),
        to: attachPoint("where the beam ends"),
        target: target(),
    },
});

export const dissolve = defineKind({
    id: "fx.dissolve", column: fxColumn, word: "dissolve",
    hint: "a dissolve or materialise effect",
    props: {
        attach: attachPoint("where on the body it plays"),
        texture: corpus(TIER.asset, path),
        target: target(),
    },
});

/* ⚠ ONE WORD, TWO SOURCES, AND THE MERGE IS AN OPEN QUESTION (TYPES §8.6 (4)).
 * 1.0 registers `ghost` TWICE — `fx:shadowy` (ShadowyEffect rows) and
 * `fx:ghostmat` (Type-22 material recolours) — under one word. G1 forbids two
 * kinds claiming one word, so they are ONE kind here. Whether they should
 * instead be one kind with a `material` property telling them apart, or two
 * words, changes what a user can ASK and is therefore the user's call, not a
 * transcription decision. Declared as the union until they rule. */
export const ghost = defineKind({
    id: "fx.ghost", column: fxColumn, word: "ghost",
    hint: "a ghostly recolour — translucent shadow materials",
    props: {
        attach: attachPoint("where on the body it plays"),
        target: target(),
    },
});

export const glow = defineKind({
    id: "fx.glow", column: fxColumn, word: "glow",
    hint: "an edge glow or rim light around the model",
    props: {target: target()},
});

export const tint = defineKind({
    id: "fx.tint", column: fxColumn, word: "tint",
    hint: "a colour wash over the model",
    props: {},
});

export const screen = defineKind({
    id: "fx.screen", column: fxColumn, word: "screen",
    hint: "a full-screen tint or overlay while the aura holds",
    props: {
        type: corpus(TIER.asset, enumeration),
        target: target(),
    },
});

export const shapeshift = defineKind({
    id: "fx.shapeshift", column: fxColumn, word: "shapeshift",
    hint: "a shapeshift form the caster takes",
    props: {form: corpus(TIER.asset, enumeration)},
});

export const morph = defineKind({
    id: "fx.morph", column: fxColumn, word: "morph",
    hint: "a morph or transform aura — the caster becomes something else",
    props: {display: named(TIER.asset), target: target()},
});

export const summon = defineKind({
    id: "fx.summon", column: fxColumn, word: "summon",
    hint: "a creature the spell summons",
    props: {creature: named(TIER.asset), target: target()},
});

export const gameObject = defineKind({
    id: "fx.object", column: fxColumn, word: "object",
    hint: "a gameobject the spell places — campfire, portal, banner, chest",
    props: {object: named(TIER.asset), target: target()},
});

/* THE SIGNED-PERCENT FAMILY. The percent IS the row's identity, so it is the
 * property rather than a modifier on one, and the sign carries the meaning:
 * +30% and -30% are opposite effects. */

export const scale = defineKind({
    id: "fx.scale", column: fxColumn, word: "scale",
    hint: "a size change the aura applies",
    props: {
        percent: {types: [percent], hint: "how much bigger or smaller — 30, -30, 10-90"},
        target: target(),
    },
});

export const transparency = defineKind({
    id: "fx.transparency", column: fxColumn, word: "transparency",
    hint: "how see-through the model becomes",
    props: {percent: of(percent)},
});

export const desaturate = defineKind({
    id: "fx.desaturate", column: fxColumn, word: "desaturate",
    hint: "how much colour is drained from the model",
    props: {percent: of(percent)},
});

export const freeze = defineKind({
    id: "fx.freeze", column: fxColumn, word: "freeze",
    hint: "freezes or petrifies the model in place",
    props: {},
});

export const camo = defineKind({
    id: "fx.camo", column: fxColumn, word: "camo",
    hint: "a camouflage or cloaking effect",
    props: {},
});

/* IT IS THE CASTER'S FACING, NOT THE BEAM (the user's correction, and the
 * canonical example of not describing a mechanism from its name): the caster
 * stays turned toward the target for the whole channel. The beam merely
 * follows from that. fx rather than mech because a character being turned is
 * what the spell LOOKS like. */
export const tracking = defineKind({
    id: "fx.tracking", column: fxColumn, word: "tracking",
    hint: "caster stays facing the target for the whole channel",
    props: {},
});

/* ══════════════════════════════════════════════════════ mech ══════════
 *
 * ⚠ FOUR KINDS SIT HERE THAT TYPES §8.4 PUTS UNDER `fx`, AND THE SHIPPED APP
 * IS RIGHT: `seat`, `invis`, `detect` and `speed` all carry `field: "mech"` in
 * 1.0's registry, which also states the rule out loud — *fx is what the spell
 * LOOKS like, mech is what it DOES*. A vehicle seat, an invisibility channel
 * and a movement-speed change render nothing. §8.4 also omits `keybind`
 * entirely. Transcription slips in the doc, corrected here and recorded.
 */

export const effect = defineKind({
    id: "mech.effect", column: mechColumn, word: "effect",
    hint: "one of the spell's effects — what it actually does",
    props: {
        name: {types: [enumeration], hint: "the effect's name — SCHOOL_DAMAGE, JUMP_DEST"},
        /* ⚠ THE MASK IS NOT IN THE PACK TODAY — the PHASE 1 spike derived it,
         * and measured `mech:{JUMP_DEST target:target}` at 758 against 1.0's
         * 362. The extra ~400 are the L4 fix: `target` typed as a MASK instead
         * of substring-matching the enum name `TARGET_DEST_TARGET_BACK`, which
         * merely CONTAINS "target". PHASE 5 owes the derivation in the row
         * source (or a pack field). Declared because it is measured, not
         * because it is hoped for. */
        target: target(),
    },
});

export const aura = defineKind({
    id: "mech.aura", column: mechColumn, word: "aura",
    hint: "an aura the spell applies — what it does while it holds",
    props: {
        name: {types: [enumeration], hint: "the aura's name — MOD_SCALE, MOD_INVISIBILITY"},
        target: target(),
    },
});

export const castTime = defineKind({
    id: "mech.casttime", column: mechColumn, word: "casttime",
    hint: "has a cast bar before it goes off — its length in seconds",
    props: {seconds: of(seconds)},
});

export const channeled = defineKind({
    id: "mech.channeled", column: mechColumn, word: "channeled",
    hint: "channeled rather than cast once — its seconds, or unlimited",
    props: {seconds: of(seconds)},
});

/* NO id NOTATION, UNLIKE THE LINK KINDS BELOW. An area id is a number nobody
 * has a way to know — it is not `.cast`'s argument the way a spell id is — so
 * there is no id-shaped question to answer and the vocabulary stays words. */
export const location = defineKind({
    id: "mech.location", column: mechColumn, word: "location",
    hint: "where the spell refuses to cast — Epsilon enforces this gate on .cast",
    props: {area: of(text)},
});

/* TWO KINDS, ONE EDGE SET, because direction is the first thing you want to
 * ask. `triggers` is what this spell reaches, `origin` what reaches it. */
export const triggers = defineKind({
    id: "mech.triggers", column: mechColumn, word: "triggers",
    hint: "another spell this one casts, ticks, procs or removes",
    props: {spell: named()},
});

export const origin = defineKind({
    id: "mech.origin", column: mechColumn, word: "origin",
    hint: "a spell that casts, ticks, procs or removes this one",
    props: {spell: named()},
});

export const seat = defineKind({
    id: "mech.seat", column: mechColumn, word: "seat",
    hint: "a seat of the vehicle the caster becomes",
    props: {
        count: {types: [count], hint: "how many seats the vehicle has"},
        attach: attachPoint("where the seat sits on the vehicle"),
    },
});

/* ⚠ TWO KINDS, NOT ONE — TYPES §8.6 (1). 1.0's single `invis` word carries a
 * channel id AND a detector count, told apart by whether an operator was
 * typed (`operatorOnly`). Two QUANTITIES on one word is two axes, and the
 * discriminator is decidable: `invis:13` and `invis:>0` name unrelated
 * populations, where two NOTATIONS of one subject would name the same row. */
export const invis = defineKind({
    id: "mech.invis", column: mechColumn, word: "invis",
    hint: "the invisibility channel the aura hides in",
    props: {channel: {types: [id], hint: "the channel's number"}},
});

export const detect = defineKind({
    id: "mech.detect", column: mechColumn, word: "detect",
    hint: "sees an invisibility channel",
    props: {
        channel: {types: [id], hint: "the channel it can see"},
        count: {types: [count], hint: "how many spells hide in that channel"},
    },
});

export const keybind = defineKind({
    id: "mech.keybind", column: mechColumn, word: "keybind",
    hint: "a key that casts a spell while the aura holds",
    props: {key: of(text)},
});

export const speed = defineKind({
    id: "mech.speed", column: mechColumn, word: "speed",
    hint: "a movement-speed change — run, mounted, swim, flight or all at once",
    props: {
        percent: {types: [percent], hint: "how much faster or slower — 70, -50"},
        mode: {types: [enumeration], hint: "which movement — run, walk, fly, swim"},
        target: target(),
    },
});

/* THE ATTRIBUTE BITS. Valueless: membership IS the payload, so the kind has no
 * properties at all and its existence is the whole answer.
 *
 * ⚠ THE WORDING DESCRIBES WHAT EPSILON DOES, not what retail documents.
 * Roughly half the flags tested did not survive contact with Epsilon, so every
 * one below was confirmed in game by the user before it shipped and the
 * phrasing is theirs (docs/DECISIONS.md → EPSILON BEHAVIOUR). Do not
 * "improve" it from a wiki.
 *
 * ⚠ AND `flag` THE TYPE IS NOT USED BY ANY OF THEM, WHICH IS A DOC CORRECTION
 * RATHER THAN A GAP. TYPES §8.7 reads "three kinds are pure flags, so `flag`
 * earns its place as a type with no value" — but under L5.2 valuelessness
 * lives on the KIND (no properties), not on a property that has no value. The
 * type is right and its customer is a future valueless PROPERTY; the two are
 * different levels and §8.7 conflates them. */

export const instant = defineKind({
    id: "mech.instant", column: mechColumn, word: "instant",
    hint: "goes off at once — no cast bar, no channel",
    props: {},
});

export const unbreakable = defineKind({
    id: "mech.unbreakable", column: mechColumn, word: "unbreakable",
    hint: "channel that persists — the caster can still move and act while it holds",
    props: {},
});

export const unhindered = defineKind({
    id: "mech.unhindered", column: mechColumn, word: "unhindered",
    hint: "channel the caster can act during (still breaks on the usual interrupts)",
    props: {},
});

export const debuff = defineKind({
    id: "mech.debuff", column: mechColumn, word: "debuff",
    hint: "aura that shows in the red debuff frame",
    props: {},
});

/* ⛔ NOT DECLARED, AND EACH FOR A STATED REASON — so the next session does not
 * spend a pass rediscovering them:
 *
 *   the `range` kind      a NEW SOURCE (`SpellRange`): build reader + TABLES
 *                         entry + pack section + format bump + eleven packs.
 *                         `unlimited` is a sentinel exactly like a channel's.
 *   `cooldown`, `cost`    the same, from `SpellCooldowns` and `SpellPower`.
 *                         All three are on wago at 9.2.7 and none is fetched.
 *   missile offsets       `CastOffset_0/1/2` are a 3-VECTOR, and the type
 *                         system has no answer for one yet (TYPES §9.0). Three
 *                         properties, or one composite type — decide before
 *                         touching missiles, do not invent one speculatively.
 *   `coneAngle`, `range`  float columns on `BarrageEffect` the build has never
 *   on barrage            read. 3 and 4 distinct values — the throwaway-axis
 *                         test of PHASE 5 uses exactly this.
 *   anim kit `speed`      `AnimKitSegment.Speed`, same: a float not in the pack.
 *   aura `stacks`         `SpellAuraOptions.CumulativeAura` IS downloaded, but
 *                         it is not in the pack; 7,750 spells genuinely stack.
 *   `type` on sound       `SoundKit.SoundType` — designed, parked, and waiting
 *                         on the user for examples rather than on work.
 */
