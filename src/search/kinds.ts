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
 * Not every game version has every kind, and nothing here declares which: availability is measured from the loaded
 * pack when the row sources are indexed. Each pack is in essence its own version of the app, so a kind with no rows
 * in the loaded one is not part of its language at all — not suggested, not autocompleted, and not parsed as an
 * axis; the word falls back to what any unknown word is, ordinary text. Measured presence cannot drift the way a
 * declared version matrix would, and a pack that gains the data lights the kind up with no edit anywhere.
 *
 * Properties are declared in the order a reader meets them, and that order is preserved: a kind's subject comes first,
 * then what qualifies it, then who it plays on. Surfaces that present properties in sequence read the declaration
 * rather than holding a second list.
 *
 * Words are spent carefully. Every kind word works inside its own column -- `model:mount`, `fx:tint`, `mech:invis` --
 * but a word is a top-level head only where it earns one: it must be unique, name its subject with the column removed,
 * and ask a question that is meaningful alone. Most kinds do not qualify, and the column is how they are reached.
 *
 * The catalogue is expected to keep changing shape: kinds move between groups, properties gain doors, flags join and
 * leave. Every one of those is a field on a declaration here, so a reorganisation is an edit to this file and nothing
 * else.
 *
 * A kind does not name the game table or column its rows come from. Which source feeds a property varies between game
 * versions, which is why the build resolves it by declaration rather than in code; naming one source here would put a
 * per-version exception into the schema. A kind says what a row IS, and the row builder says where it came from.
 *
 * TODO: declare the pill and the incomplete-chip placeholder once the renderer and the query bar exist to read them.
 */
import type {Column} from "./columns";
import {animColumn, fxColumn, idColumn, mechColumn, modelColumn, spellColumn, soundColumn} from "./columns";
import {fold} from "./text-normalization";
import type {Sentinels} from "./units";
import type {AxisType, Value} from "./value-types";
import {
    bitmask, colour, count, enumeration, flag, id, ordinal, path, percent, percentChange, seconds, text,
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

    /**
     * The notations chipless search reads, always a subset of `types`. Absent means the property stays out of it.
     *
     * Declared per notation rather than per property because the two halves of an `[id, text]` property differ:
     * the name belongs in chipless search and the id does not, since a bare number there means the spell's own id
     * and nothing else. The one identity notation chipless search reads is the spell id's, and the schema checks
     * that it stays the only one.
     */
    readonly plain?: readonly AxisType[];

    /** The relevance tier a chipless hit on this property ranks at. Required with `plain`, meaningless without. */
    readonly tier?: number;

    /**
     * A top-level head reaching this property alone, such as `cast:` for the delivery kind's cast length.
     *
     * A door is earned, not automatic: most properties are reached through their kind and declare none.
     */
    readonly prefix?: string;

    /**
     * Alternative spellings of this property's words: its name inside the kind's scope, and its prefix door where
     * one is declared. An alias is a way in, never a second identity — chips, help and autocomplete print the
     * principal spelling.
     *
     * Plain data so the list can grow without a mechanism change — variant spellings today, localised words if a
     * locale vocabulary ever ships.
     */
    readonly aliases?: readonly string[];

    /**
     * Stored values that are not quantities, and the word each one means: a channel's -1 is `unlimited`, a cast
     * bar's 0 is `instant`.
     *
     * On the property rather than the type, because the word is this axis's vocabulary — the duration type the two
     * share knows neither. A sentinel word is read before any notation, so it can never be misread as a quantity.
     */
    readonly sentinels?: Sentinels;

    /**
     * One line describing the property, where the type's own hint is not specific enough.
     *
     * Absent means the first type's hint is used, which is the right text whenever the property adds nothing to what
     * the type already says. Read it with {@link hintOf} rather than the field.
     */
    readonly hint?: string;

    /**
     * Whether this property only refines another predicate rather than naming a subject of its own.
     *
     * A target is the first: "plays on the caster" says nothing about what kind of row is doing the playing. A scope
     * whose only positive constraint is a qualifier is legal but weak, so the parser warns on it instead of refusing
     * it.
     */
    readonly qualifier?: boolean;
}

export interface Kind {
    /** Stable identity, derived by {@link defineKind} as `column.word`. Never declared, never shown to a reader. */
    readonly id: string;

    /** The column this kind's rows appear in. A reference rather than a key, so a typo fails to compile. */
    readonly column: Column;

    /**
     * The word that names this kind inside its column, as in `model:mount` or `fx:{chain from:chest}`.
     *
     * Omitted when the column's own head already reaches this kind unambiguously.
     */
    readonly word?: string;

    /**
     * Alternative spellings of {@link word}, legal exactly where the word is: inside the column, and at the top
     * level when the kind is global. An alias is a way in, never a second identity — chips, help and autocomplete
     * print the word.
     *
     * Plain data so the list can grow without a mechanism change — variant spellings today, localised words if a
     * locale vocabulary ever ships.
     */
    readonly aliases?: readonly string[];

    /**
     * Whether the word is also a top-level head, so `missile:{from:chest}` works without naming the column.
     *
     * A top-level door is earned: the word must be unique across every column, must name its subject with the column
     * removed, and must ask a question that is meaningful alone. Kinds that fail any of those stay reachable through
     * their column, where the column supplies the missing noun.
     */
    readonly global?: boolean;

    /**
     * The cluster this kind belongs to within its column, for surfaces that present kinds grouped.
     *
     * A label, not a mechanism: moving a kind between groups is an edit to this field and nothing else.
     */
    readonly group?: string;

    /** One line describing the kind to a reader. */
    readonly hint: string;

    readonly props: Readonly<Record<string, Prop>>;
}

/** Every declared kind, by id. */
export const KINDS = new Map<string, Kind>();

export function defineKind(spec: Omit<Kind, "id">): Kind {
    const kind: Kind = {...spec, id: `${spec.column.key}.${spec.word ?? spec.column.key}`};
    if (KINDS.has(kind.id)) throw new Error(`kind "${kind.id}" already defined`);
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

/** One operand resolved against a property: the value, and the notation that accepted it. */
export interface ParsedValue {
    readonly type: AxisType;
    readonly value: Value;
}

/**
 * Reads one operand as a property's value.
 *
 * Sentinel words are read first, so a stored value that is not a quantity is reachable by its name and can never be
 * misread as one. The notations are then tried in declaration order, and the first to accept the operand wins —
 * which is the whole of multi-notation dispatch.
 *
 * @param prop The property.
 * @param written One operand, as typed.
 * @returns The value and the notation that read it, or `null` when nothing accepted the operand.
 */
export function parseValue(prop: Prop, written: string): ParsedValue | null {
    for (const [stored, word] of Object.entries(prop.sentinels ?? {})) {
        if (fold(written.trim()) === fold(word)) return {type: prop.types[0], value: Number(stored)};
    }
    for (const type of prop.types) {
        const value = type.parse?.(written);
        if (value !== null && value !== undefined) return {type, value};
    }
    return null;
}

/**
 * Writes a property's stored value the way a pill prints it.
 *
 * @param prop The property.
 * @param value The stored value.
 * @returns The sentinel's word where one is declared, otherwise the first type's spelling.
 */
export function formatValue(prop: Prop, value: Value): string {
    const word = typeof value === "number" ? prop.sentinels?.[value] : undefined;
    if (word !== undefined) return word;
    return prop.types[0].format?.(value) ?? String(value);
}

/** A property with no role in chipless search. */
const of = (...types: readonly AxisType[]): Prop => ({types});
/** A property chipless search reads through every notation, at the given relevance tier. */
const corpus = (tier: number, ...types: readonly AxisType[]): Prop =>
    ({types, plain: types, tier});
/**
 * A property naming something that has both a name and an id: a sound kit, a summoned creature, a triggered spell.
 *
 * The id is tried first, so digits select by identity and words fall through to the name. Chipless search reads the
 * name only: a bare number there means the spell's own id, so an id notation joining the union would give the same
 * digits a second answer.
 *
 * The hint is stated here rather than inherited: falling back to the first type would describe the property as an id
 * alone, which is the notation a reader is least likely to have.
 *
 * @param what The thing being named, as it appears in the hint.
 * @param tier The relevance tier for chipless search, or omitted to keep the property out of it.
 * @returns The property declaration.
 */
const named = (what: string, tier?: number): Prop => {
    const hint = `the ${what}, by name or by id`;
    return tier === undefined
        ? {types: [id, text], hint}
        : {types: [id, text], plain: [text], tier, hint};
};

/** Which participants a row plays on. */
const target = (): Prop => ({
    types: [bitmask],
    hint: "who it plays on — caster, target, both, area, others",
    qualifier: true,
});

/** A point on a model that something attaches to. */
const attachPoint = (hint: string): Prop => ({types: [enumeration], hint});

/* The spell itself: what it is called, says and shows, and how it goes off. Name, desc and icon are top-level words. */

export const name = defineKind({
    column: spellColumn, word: "name", global: true,
    hint: "the spell's name",
    props: {text: corpus(TIER.name, text)},
});

export const description = defineKind({
    column: spellColumn, word: "desc", global: true, aliases: ["description"],
    hint: "what the spell says it does — its in-game description",
    props: {text: corpus(TIER.description, text)},
});

/** The art on a spell's button. The file id stays out of chipless search, where a lone number means a spell id. */
export const icon = defineKind({
    column: spellColumn, word: "icon", global: true,
    hint: "the art on the spell's button — 272,900 spells share 9,846 icons",
    props: {
        name: corpus(TIER.asset, text),
        fid: {types: [id], hint: "the icon's file id — the number the ⧉ copies"},
    },
});

/**
 * How the spell goes off. One row per spell: at once, behind a cast bar, as a channel, or both bar and channel.
 *
 * One kind rather than five, because the pack ships delivery as one record and the pieces qualify each other: a
 * channel's duration, whether moving breaks it, whether the caster can act during it. The valueless pieces are flag
 * properties — the flag type's first customers — and a set flag contributes its own word to the row's matchable
 * content, so `spell:breaksmove` and `spell:unbreakable` stay plain words. The two lengths carry the doors a reader
 * types: `cast:>2`, `channel:unlimited` — and `cast:instant` is the one spelling for a spell with no bar at all.
 *
 * Wordless: the doors and the flag words carry every real question, and a word selecting "spells with a delivery
 * row" would select nearly everything, so none is spent.
 */
export const delivery = defineKind({
    column: spellColumn,
    hint: "how the spell goes off — at once, behind a cast bar, or as a channel",
    props: {
        cast: {
            types: [seconds], prefix: "cast", sentinels: {0: "instant"},
            hint: "the cast bar's length in seconds, or instant for no bar at all"
        },
        channel: {
            types: [seconds], prefix: "channel", sentinels: {[-1]: "unlimited"},
            hint: "the channel's length in seconds, or unlimited"
        },
        breaksmove: {types: [flag], hint: "the cast or channel breaks if the caster moves"},
        unbreakable: {types: [flag], hint: "the channel persists — moving and acting do not break it"},
        unhindered: {
            types: [flag],
            hint: "the caster can act during the channel (the usual interrupts still break it)"
        },
    },
});

/* Identity: the spell's number, and when it arrived. */

/** A spell's own number. Reached through the column head; the kind needs no separate word. */
export const spellId = defineKind({
    column: idColumn,
    hint: "the spell's own number — what .cast takes",
    props: {value: corpus(TIER.id, id)},
});

export const expansion = defineKind({
    column: idColumn, word: "xpac", global: true, aliases: ["expansion"],
    hint: "the expansion that introduced it — legion, >wotlk, <=mop",
    props: {rung: of(ordinal)},
});

/* Models: what a spell draws. */

export const missile = defineKind({
    column: modelColumn, word: "missile", global: true, group: "projectile",
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

export const barrage = defineKind({
    column: modelColumn, word: "barrage", group: "projectile",
    hint: "a volley of models fired at once",
    props: {
        file: corpus(TIER.asset, path),
        attach: attachPoint("where the volley is fired from"),
        target: target(),
    },
});

export const ground = defineKind({
    column: modelColumn, word: "ground", group: "world",
    hint: "a ground or area model laid on the world",
    props: {file: corpus(TIER.asset, path), target: target()},
});

export const attached = defineKind({
    column: modelColumn, word: "attached", group: "worn",
    hint: "a model stuck to the caster or the target",
    props: {
        file: corpus(TIER.asset, path),
        attach: attachPoint("where on the body it sits"),
        target: target(),
    },
});

export const trail = defineKind({
    column: modelColumn, word: "trail", group: "worn",
    hint: "a weapon trail that follows a swing",
    props: {file: corpus(TIER.asset, path), target: target()},
});

export const display = defineKind({
    column: modelColumn, word: "display", group: "worn",
    hint: "a creature display model attached to the caster or target",
    props: {
        id: {types: [id], hint: "the CreatureDisplayInfo id"},
        name: corpus(TIER.asset, text),
        file: corpus(TIER.asset, path),
        target: target(),
    },
});

export const item = defineKind({
    column: modelColumn, word: "item", group: "worn",
    hint: "an in-game item's model, held by the caster",
    props: {
        file: corpus(TIER.asset, path),
        id: {types: [id], hint: "the item's own id"},
        target: target(),
    },
});

/** A weapon the caster already carries, identified by its slot rather than by a model file. */
export const equipped = defineKind({
    column: modelColumn, word: "equipped", group: "worn",
    hint: "a weapon the caster already has — main hand, off hand, ranged or ammo",
    props: {
        slot: {types: [enumeration], hint: "which slot — main hand, off hand, ranged, ammo"},
        target: target(),
    },
});

export const mount = defineKind({
    column: modelColumn, word: "mount", group: "ridden",
    hint: "the mount the spell puts you on",
    props: {
        name: corpus(TIER.asset, text),
        file: corpus(TIER.asset, path),
        target: target(),
    },
});

/* Sounds: what a spell plays. */

/** A sound file, and the kit it belongs to. Reached through the column head. */
export const sound = defineKind({
    column: soundColumn,
    hint: "a sound file the spell plays",
    props: {
        file: corpus(TIER.asset, path),
        kit: named("sound kit", TIER.asset),
        target: target(),
    },
});

/* Animations: how a character moves. */

export const animKit = defineKind({
    column: animColumn, word: "kit", group: "played",
    hint: "an animation played through an AnimKit — the numbered bundles",
    props: {
        id: {types: [id], hint: "the AnimKit's own id"},
        anim: corpus(TIER.asset, enumeration),
        boneset: {types: [enumeration], hint: "which bones it drives — head, spine, arms"},
        target: target(),
    },
});

export const loose = defineKind({
    column: animColumn, word: "loose", group: "played",
    hint: "an animation the spell's visual kit plays directly, in no AnimKit",
    props: {
        anim: corpus(TIER.asset, enumeration),
        boneset: {types: [enumeration], hint: "which bones it drives — head, spine, arms"},
        target: target(),
    },
});

export const replace = defineKind({
    column: animColumn, word: "replace", group: "replaced",
    hint: "an animation the spell swaps for another — Stand becomes StealthStand",
    props: {
        from: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: "the animation being replaced"
        },
        to: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: "what it is replaced with"
        },
        target: target(),
    },
});

/** Holds a character's pose by suppressing the spell's own animation. */
export const pose = defineKind({
    column: animColumn, word: "pose", group: "replaced",
    hint: "holds the character's pose — the spell suppresses its own animation",
    props: {},
});

export const passenger = defineKind({
    column: animColumn, word: "passenger", group: "vehicle",
    hint: "what a rider plays entering, sitting in and leaving a seat",
    props: {
        enter: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: "the animation played climbing in"
        },
        sit: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: "the animation held in the seat"
        },
        exit: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: "the animation played climbing out"
        },
    },
});

/* Effects: what a spell looks like. */

export const chain = defineKind({
    column: fxColumn, word: "chain", global: true, group: "beam",
    hint: "a chain or beam effect held between two points",
    props: {
        texture: corpus(TIER.asset, path),
        from: attachPoint("where the beam starts"),
        to: attachPoint("where the beam ends"),
        colour: {types: [colour], aliases: ["color"], hint: "the beam's tint"},
        target: target(),
    },
});

export const dissolve = defineKind({
    column: fxColumn, word: "dissolve", group: "overlay",
    hint: "a dissolve or materialise effect",
    props: {
        attach: attachPoint("where on the body it plays"),
        texture: corpus(TIER.asset, path),
        target: target(),
    },
});

/**
 * A translucent shadow pass over the model.
 *
 * Kept apart from {@link ghost}: the two materials render differently in game, so one word would blur a distinction
 * a reader can see.
 */
export const shadowy = defineKind({
    column: fxColumn, word: "shadowy", group: "overlay",
    hint: "a translucent shadow pass over the model",
    props: {
        attach: attachPoint("where on the body it plays"),
        target: target(),
    },
});

/** A material recolour that renders the model as a ghost. */
export const ghost = defineKind({
    column: fxColumn, word: "ghost", group: "overlay",
    hint: "a ghost material swapped onto the model",
    props: {
        attach: attachPoint("where on the body it plays"),
        target: target(),
    },
});

/** An edge glow or rim light around the model. */
export const glow = defineKind({
    column: fxColumn, word: "glow", group: "overlay",
    hint: "an edge glow or rim light around the model",
    props: {
        colour: {types: [colour], aliases: ["color"], hint: "the glow colour"},
        target: target(),
    },
});

/** A colour wash over the model. */
export const tint = defineKind({
    column: fxColumn, word: "tint", group: "overlay",
    hint: "a colour wash over the model",
    props: {
        colour: {types: [colour], aliases: ["color"], hint: "the colour applied"},
        target: target(),
    },
});

export const transparency = defineKind({
    column: fxColumn, word: "transparency", group: "overlay",
    hint: "how see-through the model becomes",
    props: {percent: of(percent)},
});

export const desaturate = defineKind({
    column: fxColumn, word: "desaturate", group: "overlay",
    hint: "how much colour is drained from the model",
    props: {percent: of(percent)},
});

export const freeze = defineKind({
    column: fxColumn, word: "freeze", group: "overlay",
    hint: "freezes or petrifies the model in place",
    props: {},
});

export const camo = defineKind({
    column: fxColumn, word: "camo", group: "overlay", aliases: ["camouflage"],
    hint: "a camouflage or cloaking effect",
    props: {},
});

export const morph = defineKind({
    column: fxColumn, word: "morph", global: true, group: "transform",
    hint: "a morph or transform aura — the caster becomes something else",
    props: {display: named("creature display", TIER.asset), target: target()},
});

export const shapeshift = defineKind({
    column: fxColumn, word: "shapeshift", group: "transform",
    hint: "a shapeshift form the caster takes",
    props: {form: corpus(TIER.asset, enumeration)},
});

export const scale = defineKind({
    column: fxColumn, word: "scale", global: true, group: "transform",
    hint: "a size change the aura applies",
    props: {
        amount: {
            types: [percentChange],
            hint: "how much bigger or smaller: +50, x1.5 or 2 as a factor, 150 as a proportion",
        },
        target: target(),
    },
});

export const summon = defineKind({
    column: fxColumn, word: "summon", global: true, group: "spawn",
    hint: "a creature the spell summons",
    props: {creature: named("summoned creature", TIER.asset), target: target()},
});

export const gameObject = defineKind({
    column: fxColumn, word: "object", group: "spawn", aliases: ["gameobject"],
    hint: "a gameobject the spell places — campfire, portal, banner, chest",
    props: {object: named("gameobject", TIER.asset), target: target()},
});

/** A full-screen effect. Searched by its textures; the effect-type words are not part of the vocabulary. */
export const screen = defineKind({
    column: fxColumn, word: "screen", group: "screen",
    hint: "a full-screen tint or overlay while the aura holds",
    props: {
        texture: corpus(TIER.asset, path),
        target: target(),
    },
});

/** The caster stays turned toward the target for the whole channel. */
export const tracking = defineKind({
    column: fxColumn, word: "tracking", group: "behaviour",
    hint: "caster stays facing the target for the whole channel",
    props: {},
});

/* Mechanics: what a spell does. A row here renders nothing; anything visible belongs to the effects column. */

export const effect = defineKind({
    column: mechColumn, word: "effect", group: "action",
    hint: "one of the spell's effects — what it actually does",
    props: {
        name: {types: [enumeration], hint: "the effect's name — SCHOOL_DAMAGE, JUMP_DEST"},
        target: target(),
    },
});

export const aura = defineKind({
    column: mechColumn, word: "aura", group: "action",
    hint: "an aura the spell applies — what it does while it holds",
    props: {
        name: {types: [enumeration], hint: "the aura's name — MOD_SCALE, MOD_INVISIBILITY"},
        target: target(),
    },
});

/* Spell-to-spell links, one kind per direction. */
export const triggers = defineKind({
    column: mechColumn, word: "triggers", global: true, group: "link",
    hint: "another spell this one casts, ticks, procs or removes",
    props: {spell: named("spell it triggers")},
});

export const origin = defineKind({
    column: mechColumn, word: "origin", global: true, group: "link",
    hint: "a spell that casts, ticks, procs or removes this one",
    props: {spell: named("spell that triggers it")},
});

/** Where a spell refuses to cast. Named by area, since an area id is not a number a reader would know. */
export const location = defineKind({
    column: mechColumn, word: "location", global: true, group: "gate",
    hint: "where the spell refuses to cast — Epsilon enforces this gate on .cast",
    props: {area: of(text)},
});

/* Invisibility has two sides: what hides in a channel, and what can see into it. */
export const invis = defineKind({
    column: mechColumn, word: "invis", group: "stealth", aliases: ["invisibility"],
    hint: "the invisibility channel the aura hides in",
    props: {channel: {types: [id], hint: "the channel's number"}},
});

export const detect = defineKind({
    column: mechColumn, word: "detect", group: "stealth",
    hint: "sees an invisibility channel",
    props: {
        channel: {types: [id], hint: "the channel it can see"},
        count: {types: [count], hint: "how many spells hide in that channel"},
    },
});

export const seats = defineKind({
    column: mechColumn, word: "seats", global: true, group: "vehicle",
    hint: "the seats of the vehicle the caster becomes",
    props: {
        count: {types: [count], hint: "how many seats the vehicle has"},
        attach: attachPoint("where the seat sits on the vehicle"),
    },
});

export const speed = defineKind({
    column: mechColumn, word: "speed", global: true, group: "movement",
    hint: "a movement-speed change — run, mounted, swim, flight or all at once",
    props: {
        amount: {
            types: [percentChange],
            hint: "how much faster or slower: +70, x1.7 or 2 as a factor, 170 as a proportion",
        },
        mode: {types: [enumeration], hint: "which movement: run, walk, fly or swim"},
        target: target(),
    },
});

export const keybind = defineKind({
    column: mechColumn, word: "keybind", group: "ui",
    hint: "a key that casts a spell while the aura holds",
    props: {key: of(text)},
});

export const debuff = defineKind({
    column: mechColumn, word: "debuff", group: "ui",
    hint: "aura that shows in the red debuff frame",
    props: {},
});
