/**
 * @file The kind catalogue: what a row can be, and what each kind carries.
 *
 * A column yields rows; a row has a kind; a kind declares properties; a property has a type. A kind is a noun naming
 * what a row IS -- a chain, a missile, a morph -- and its properties are what that thing HAS.
 *
 * Naming both ends of a pair matters. A beam carries a source attachment and a destination attachment, and they
 * differ on two thirds of the rows that have them, so a single unioned attachment cannot say which end a reader
 * meant. Two properties sharing one type is the whole mechanism; there is no separate notion of a role.
 *
 * One declaration feeds every surface: matching, autocomplete, generated help, the query bar, and the rendered pill.
 *
 * A property is declared only where the data can answer it. An axis that returns nothing forever is worse than an
 * absent one, because a reader cannot tell "no spells match" from "this does not work". Adding a property once its
 * data lands is one line.
 *
 * Properties are declared in the order a reader meets them, and that order is preserved: a kind's subject comes first,
 * then what qualifies it, then who it plays on. Surfaces that present properties in sequence read the declaration
 * rather than holding a second list.
 *
 * A kind does not name the game table or column its rows come from. Which source feeds a property varies between game
 * versions, which is why the build resolves it by declaration rather than in code; naming one source here would put a
 * per-version exception into the schema. A kind says what a row IS, and the row builder says where it came from.
 *
 * TODO: declare the pill, the incomplete-chip placeholder and the per-property global prefix once the renderer, the
 * query bar and the union-axis door exist to read them.
 */
import type {Column} from "./columns";
import {animColumn, fxColumn, idColumn, mechColumn, modelColumn, textColumn, soundColumn} from "./columns";
import type {AxisType} from "./value-types";
import {
    bitmask, colour, count, enumeration, id, length, multiplier, ordinal, path, percent, seconds, text,
} from "./value-types";

/**
 * Relevance tiers for chipless search. Only the order matters: the best tier a spell matched in decides its rank.
 *
 * Without tiers a description-only hit ranks alongside an exact name match, with nothing to separate them.
 */
export const TIER = {
    /** The spell's own name. */
    name: 0,
    /** Its id, typed exactly. */
    id: 1,
    /** An asset it uses: a model, a sound, an animation, an icon. */
    asset: 2,
    /** What it says it does. */
    description: 3,
} as const;

/** One property of one kind. */
export interface Prop {
    /**
     * The notations this property accepts, in order. The first whose `parse` accepts an operand wins, so a thing
     * with both a name and an id declares `[id, text]`.
     *
     * A control offers only the operators every notation accepts, since an operator only one notation could answer
     * would behave differently depending on what the operand happened to look like. Matching is decided separately,
     * by dispatch: a bare word on an `[id, text]` property still matches the name, because the word dispatches to
     * `text`.
     */
    readonly types: readonly AxisType[];

    /** Whether chipless search reads this property, and how hard it ranks. */
    readonly plain?: boolean;
    readonly tier?: number;

    /**
     * One line describing the property, where the type's own hint is not specific enough.
     *
     * Absent means the first type's hint is used, which is the right text whenever the property adds nothing to what
     * the type already says. Read it with {@link hintOf} rather than the field.
     */
    readonly hint?: string;
}

export interface Kind {
    /** Stable identity, formed as `column.word`. Never shown to a reader. */
    readonly id: string;

    /** The column this kind's rows appear in. A reference rather than a key, so a typo fails to compile. */
    readonly column: Column;

    /**
     * The word a query writes, as in `missile:{from:chest}` or `fx:chain`.
     *
     * A kind word is reachable on its own because a kind belongs to exactly one column, so there is nothing to
     * disambiguate. Omitted when the column's own head already reaches this kind unambiguously.
     */
    readonly word?: string;

    /** One line describing the kind to a reader. */
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
 * The operators a property offers a reader.
 *
 * @param prop The property.
 * @returns The operator names every one of the property's notations accepts.
 */
export function operatorsOf(prop: Prop): string[] {
    const [first, ...rest] = prop.types;
    return first.accepts
        .filter((op) => rest.every((type) => type.accepts.includes(op)))
        .map((op) => op.name);
}

/**
 * The line describing a property to a reader.
 *
 * @param prop The property.
 * @returns The property's own hint, or its first type's when it declares none.
 */
export function hintOf(prop: Prop): string {
    return prop.hint ?? prop.types[0].hint;
}

/** A property with no role in chipless search. */
const of = (...types: readonly AxisType[]): Prop => ({types});
/** A property chipless search reads, at the given relevance tier. */
const corpus = (tier: number, ...types: readonly AxisType[]): Prop =>
    ({types, plain: true, tier});
/**
 * A property naming something that has both a name and an id: a sound kit, a summoned creature, a triggered spell.
 *
 * The id is tried first, so digits select by identity and words fall through to the name. Putting an id into a
 * substring corpus instead makes six-digit numbers match unrelated rows.
 *
 * @param tier The relevance tier for chipless search, or omitted to keep the property out of it.
 * @returns The property declaration.
 */
const named = (tier?: number): Prop =>
    (tier === undefined ? {types: [id, text]} : {types: [id, text], plain: true, tier});

/** Which participants a row plays on. */
const target = (): Prop => ({
    types: [bitmask],
    hint: "who it plays on — caster, target, both, area, others",
});

/** A point on a model that something attaches to. */
const attachPoint = (hint: string): Prop => ({types: [enumeration], hint});

/** A spell's own name. */
export const name = defineKind({
    id: "text.name", column: textColumn, word: "name",
    hint: "the spell's name",
    props: {text: corpus(TIER.name, text)},
});

export const description = defineKind({
    id: "text.desc", column: textColumn, word: "desc",
    hint: "what the spell says it does — its in-game description",
    props: {text: corpus(TIER.description, text)},
});

/** The art on a spell's button. The file id is not read by chipless search, where a lone number means a spell id. */
export const icon = defineKind({
    id: "text.icon", column: textColumn, word: "icon",
    hint: "the art on the spell's button — 272,900 spells share 9,846 icons",
    props: {
        name: corpus(TIER.asset, text),
        fid: {types: [id], hint: "the icon's file id — the number the ⧉ copies"},
    },
});

/** A spell's own number. Reached through the column head; the kind needs no separate word. */
export const spellId = defineKind({
    id: "id.id", column: idColumn,
    hint: "the spell's own number — what .cast takes",
    props: {value: corpus(TIER.id, id)},
});

export const expansion = defineKind({
    id: "id.xpac", column: idColumn, word: "xpac",
    hint: "the expansion that introduced it — legion, >wotlk, <=mop",
    props: {rung: of(ordinal)},
});

/* Models: what a spell draws. */

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

/** A weapon the caster already carries, identified by its slot rather than by a model file. */
export const equipped = defineKind({
    id: "model.equipped", column: modelColumn, word: "equipped",
    hint: "a weapon the caster already has — main hand, off hand, ranged or ammo",
    props: {
        slot: {types: [enumeration], hint: "which slot — main hand, off hand, ranged, ammo"},
        target: target(),
    },
});

/* Sounds: what a spell plays. */

/** A sound file, and the kit it belongs to. Reached through the column head. */
export const sound = defineKind({
    id: "sound.sound", column: soundColumn,
    hint: "a sound file the spell plays",
    props: {
        file: corpus(TIER.asset, path),
        kit: named(TIER.asset),
        target: target(),
    },
});

/* Animations: how a character moves. */

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

/** Holds a character's pose by suppressing the spell's own animation. */
export const pose = defineKind({
    id: "anim.pose", column: animColumn, word: "pose",
    hint: "holds the character's pose — the spell suppresses its own animation",
    props: {},
});

/* Effects: what a spell looks like. */

export const chain = defineKind({
    id: "fx.chain", column: fxColumn, word: "chain",
    hint: "a chain or beam effect held between two points",
    props: {
        texture: corpus(TIER.asset, path),
        from: attachPoint("where the beam starts"),
        to: attachPoint("where the beam ends"),
        colour: {types: [colour], hint: "the beam's tint"},
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

/** A translucent shadow overlay. */
export const shadowy = defineKind({
    id: "fx.shadowy", column: fxColumn, word: "shadowy",
    hint: "a translucent shadow pass over the model",
    props: {
        attach: attachPoint("where on the body it plays"),
        target: target(),
    },
});

/** A material recolour that renders the model as a ghost. */
export const ghost = defineKind({
    id: "fx.ghost", column: fxColumn, word: "ghost",
    hint: "a ghost material swapped onto the model",
    props: {
        attach: attachPoint("where on the body it plays"),
        target: target(),
    },
});

/** An edge glow or rim light around the model. */
export const glow = defineKind({
    id: "fx.glow", column: fxColumn, word: "glow",
    hint: "an edge glow or rim light around the model",
    props: {
        colour: {types: [colour], hint: "the glow colour"},
        target: target(),
    },
});

/** A colour wash over the model. */
export const tint = defineKind({
    id: "fx.tint", column: fxColumn, word: "tint",
    hint: "a colour wash over the model",
    props: {
        colour: {types: [colour], hint: "the colour applied"},
        target: target(),
    },
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


export const scale = defineKind({
    id: "fx.scale", column: fxColumn, word: "scale",
    hint: "a size change the aura applies",
    props: {
        amount: {
            types: [percent, multiplier],
            hint: "how much bigger or smaller, as a percentage such as 30 or -30, or a multiplier such as 2x",
        },
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

/** The caster stays turned toward the target for the whole channel. */
export const tracking = defineKind({
    id: "fx.tracking", column: fxColumn, word: "tracking",
    hint: "caster stays facing the target for the whole channel",
    props: {},
});

/* Mechanics: what a spell does. A row here renders nothing; anything visible belongs to the effects column. */

export const effect = defineKind({
    id: "mech.effect", column: mechColumn, word: "effect",
    hint: "one of the spell's effects — what it actually does",
    props: {
        name: {types: [enumeration], hint: "the effect's name — SCHOOL_DAMAGE, JUMP_DEST"},
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

/** Where a spell refuses to cast. Named by area, since an area id is not a number a reader would know. */
export const location = defineKind({
    id: "mech.location", column: mechColumn, word: "location",
    hint: "where the spell refuses to cast — Epsilon enforces this gate on .cast",
    props: {area: of(text)},
});

/* Spell-to-spell links, one kind per direction. */
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

/** How far a spell reaches. */
export const range = defineKind({
    id: "mech.range", column: mechColumn, word: "range",
    hint: "how far the spell reaches, in yards",
    props: {yards: {types: [length], hint: "the maximum distance, or unlimited"}},
});

export const seat = defineKind({
    id: "mech.seat", column: mechColumn, word: "seat",
    hint: "a seat of the vehicle the caster becomes",
    props: {
        count: {types: [count], hint: "how many seats the vehicle has"},
        attach: attachPoint("where the seat sits on the vehicle"),
    },
});

/* Invisibility has two sides: what hides in a channel, and what can see into it. */
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
        amount: {
            types: [percent, multiplier],
            hint: "how much faster or slower, as a percentage such as 70 or -50, or a multiplier such as 2x",
        },
        mode: {types: [enumeration], hint: "which movement: run, walk, fly or swim"},
        target: target(),
    },
});

/* Attribute bits. Membership is the whole payload, so these kinds carry no properties.
 *
 * The wording describes what these flags do on Epsilon, which is not always what retail documents. */

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

