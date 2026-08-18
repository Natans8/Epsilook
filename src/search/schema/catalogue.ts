/**
 * @file The kind catalogue: every kind the engine declares, and what each one carries.
 *
 * A column yields rows; a row has a kind; a kind declares properties; a property has a type. A kind is a noun naming
 * what a row IS -- a chain, a missile, a morph -- and its properties are what that thing HAS. The SHAPE of a
 * declaration is `kinds.ts`; this file is the declarations, and adding an axis is an edit here and nowhere else.
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
 * Declaring a kind registers it, so a module that reads the registry depends on this file rather than on an import
 * order: `schema.ts` names it, and everything downstream reaches the catalogue through the assembled schema.
 */
import {t} from "../../i18n";
import {animColumn, fxColumn, idColumn, mechColumn, modelColumn, soundColumn, spellColumn} from "./columns";
import type {Prop} from "./kinds";
import {defineKind, TIER} from "./kinds";
import type {AxisType} from "../vocabulary/value-types";
import {
    bitmask, colour, count, enumeration, flag, id, ordinal, path, percent, percentChange, seconds, text,
} from "../vocabulary/value-types";

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
 * @param hint One line naming the thing, a whole sentence so a locale can phrase it its own way.
 * @param tier The relevance tier for chipless search, or omitted to keep the property out of it.
 * @returns The property declaration.
 */
const named = (hint: string, tier?: number): Prop => {
    return tier === undefined
        ? {types: [id, text], hint}
        : {types: [id, text], plain: [text], tier, hint};
};

/** Which participants a row plays on. */
const target = (): Prop => ({
    types: [bitmask],
    hint: t("tooltips:target"),
    qualifier: true,
});

/** A point on a model that something attaches to. */
const attachPoint = (hint: string): Prop => ({types: [enumeration], hint});

/* The spell itself: what it is called, says and shows, and how it goes off. Name, desc and icon are top-level words. */

export const name = defineKind({
    column: spellColumn, word: "name", global: true,
    hint: t("tooltips:kind.name.hint"),
    props: {text: corpus(TIER.name, text)},
});

export const description = defineKind({
    column: spellColumn, word: "desc", global: true, full: "description",
    hint: t("tooltips:kind.description.hint"),
    props: {text: corpus(TIER.description, text)},
});

/** The art on a spell's button. The file id stays out of chipless search, where a lone number means a spell id. */
export const icon = defineKind({
    column: spellColumn, word: "icon", global: true,
    hint: t("tooltips:kind.icon.hint"),
    props: {
        name: corpus(TIER.asset, text),
        fid: {types: [id], hint: t("tooltips:kind.icon.props.fid")},
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
    column: spellColumn, single: true,
    hint: t("tooltips:kind.delivery.hint"),
    props: {
        cast: {
            types: [seconds], prefix: "cast", sentinels: {0: "instant"},
            hint: t("tooltips:kind.delivery.props.cast")
        },
        channel: {
            types: [seconds], prefix: "channel", sentinels: {[-1]: "unlimited"},
            hint: t("tooltips:kind.delivery.props.channel")
        },
        breaksmove: {types: [flag], hint: t("tooltips:kind.delivery.props.breaksmove")},
        unbreakable: {types: [flag], hint: t("tooltips:kind.delivery.props.unbreakable")},
        unhindered: {
            types: [flag],
            hint: t("tooltips:kind.delivery.props.unhindered")
        },
    },
});

/* Identity: the spell's number, and when it arrived. */

/** A spell's own number. Reached through the column head; the kind needs no separate word. */
export const spellId = defineKind({
    column: idColumn, single: true,
    hint: t("tooltips:kind.spellId.hint"),
    props: {value: corpus(TIER.id, id)},
});

export const expansion = defineKind({
    column: idColumn, word: "xpac", global: true, full: "expansion", single: true,
    hint: t("tooltips:kind.expansion.hint"),
    props: {rung: of(ordinal)},
});

/* Models: what a spell draws. */

export const missile = defineKind({
    column: modelColumn, word: "missile", global: true, group: "projectile",
    hint: t("tooltips:kind.missile.hint"),
    props: {
        file: corpus(TIER.asset, path),
        from: attachPoint(t("tooltips:kind.missile.props.from")),
        to: attachPoint(t("tooltips:kind.missile.props.to")),
        motion: {
            types: [enumeration],
            hint: t("tooltips:kind.missile.props.motion"),
        },
        projectiles: {
            types: [count],
            hint: t("tooltips:kind.missile.props.projectiles"),
        },
        target: target(),
    },
});

export const barrage = defineKind({
    column: modelColumn, word: "barrage", group: "projectile",
    hint: t("tooltips:kind.barrage.hint"),
    props: {
        file: corpus(TIER.asset, path),
        attach: attachPoint(t("tooltips:kind.barrage.props.attach")),
        target: target(),
    },
});

export const ground = defineKind({
    column: modelColumn, word: "ground", group: "world",
    hint: t("tooltips:kind.ground.hint"),
    props: {file: corpus(TIER.asset, path), target: target()},
});

export const attached = defineKind({
    column: modelColumn, word: "attached", group: "worn",
    hint: t("tooltips:kind.attached.hint"),
    props: {
        file: corpus(TIER.asset, path),
        attach: attachPoint(t("tooltips:kind.attached.props.attach")),
        target: target(),
    },
});

export const trail = defineKind({
    column: modelColumn, word: "trail", group: "worn",
    hint: t("tooltips:kind.trail.hint"),
    props: {file: corpus(TIER.asset, path), target: target()},
});

export const display = defineKind({
    column: modelColumn, word: "display", group: "worn",
    hint: t("tooltips:kind.display.hint"),
    props: {
        id: {types: [id], hint: t("tooltips:kind.display.props.id")},
        name: corpus(TIER.asset, text),
        file: corpus(TIER.asset, path),
        attach: attachPoint(t("tooltips:kind.display.props.attach")),
        target: target(),
    },
});

export const item = defineKind({
    column: modelColumn, word: "item", group: "worn",
    hint: t("tooltips:kind.item.hint"),
    props: {
        file: corpus(TIER.asset, path),
        id: {types: [id], hint: t("tooltips:kind.item.props.id")},
        name: corpus(TIER.asset, text),
        attach: attachPoint(t("tooltips:kind.item.props.attach")),
        target: target(),
    },
});

/** A weapon the caster already carries, identified by its slot rather than by a model file. */
export const equipped = defineKind({
    column: modelColumn, word: "equipped", group: "worn",
    hint: t("tooltips:kind.equipped.hint"),
    props: {
        slot: {types: [enumeration], hint: t("tooltips:kind.equipped.props.slot")},
        attach: attachPoint(t("tooltips:kind.equipped.props.attach")),
        target: target(),
    },
});

export const mount = defineKind({
    column: modelColumn, word: "mount", group: "ridden",
    hint: t("tooltips:kind.mount.hint"),
    props: {
        name: corpus(TIER.asset, text),
        file: corpus(TIER.asset, path),
    },
});

/* Sounds: what a spell plays. */

/** A sound file, and the kit it belongs to. Reached through the column head. */
export const sound = defineKind({
    column: soundColumn,
    hint: t("tooltips:kind.sound.hint"),
    props: {
        file: corpus(TIER.asset, path),
        kit: named(t("tooltips:kind.sound.props.kit"), TIER.asset),
        target: target(),
    },
});

/* Animations: how a character moves. */

export const animKit = defineKind({
    column: animColumn, word: "kit", group: "played",
    hint: t("tooltips:kind.animKit.hint"),
    props: {
        id: {types: [id], hint: t("tooltips:kind.animKit.props.id")},
        anim: corpus(TIER.asset, enumeration),
        boneset: {types: [enumeration], hint: t("tooltips:kind.animKit.props.boneset")},
        target: target(),
    },
});

export const loose = defineKind({
    column: animColumn, word: "loose", group: "played",
    hint: t("tooltips:kind.loose.hint"),
    props: {
        anim: corpus(TIER.asset, enumeration),
        boneset: {types: [enumeration], hint: t("tooltips:kind.loose.props.boneset")},
        target: target(),
    },
});

export const replace = defineKind({
    column: animColumn, word: "replace", group: "replaced",
    hint: t("tooltips:kind.replace.hint"),
    props: {
        from: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: t("tooltips:kind.replace.props.from")
        },
        to: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: t("tooltips:kind.replace.props.to")
        },
        target: target(),
    },
});

/** Holds a character's pose by suppressing the spell's own animation. */
export const pose = defineKind({
    column: animColumn, word: "pose", group: "replaced",
    hint: t("tooltips:kind.pose.hint"),
    props: {},
});

export const passenger = defineKind({
    column: animColumn, word: "passenger", group: "vehicle",
    hint: t("tooltips:kind.passenger.hint"),
    props: {
        enter: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: t("tooltips:kind.passenger.props.enter")
        },
        sit: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: t("tooltips:kind.passenger.props.sit")
        },
        exit: {
            types: [enumeration], plain: [enumeration], tier: TIER.asset,
            hint: t("tooltips:kind.passenger.props.exit")
        },
    },
});

/* Effects: what a spell looks like. */

export const chain = defineKind({
    column: fxColumn, word: "chain", global: true, group: "beam",
    hint: t("tooltips:kind.chain.hint"),
    props: {
        texture: corpus(TIER.asset, path),
        from: attachPoint(t("tooltips:kind.chain.props.from")),
        to: attachPoint(t("tooltips:kind.chain.props.to")),
        colour: {types: [colour], synonyms: ["color"], hint: t("tooltips:kind.chain.props.colour")},
        target: target(),
    },
});

export const dissolve = defineKind({
    column: fxColumn, word: "dissolve", group: "overlay",
    hint: t("tooltips:kind.dissolve.hint"),
    props: {
        attach: attachPoint(t("tooltips:kind.dissolve.props.attach")),
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
    hint: t("tooltips:kind.shadowy.hint"),
    props: {
        attach: attachPoint(t("tooltips:kind.shadowy.props.attach")),
        colour: {types: [colour], synonyms: ["color"], hint: t("tooltips:kind.shadowy.props.colour")},
        target: target(),
    },
});

/** A material recolour that renders the model as a ghost. */
export const ghost = defineKind({
    column: fxColumn, word: "ghost", group: "overlay",
    hint: t("tooltips:kind.ghost.hint"),
    props: {
        colour: {types: [colour], synonyms: ["color"], hint: t("tooltips:kind.ghost.props.colour")},
        target: target(),
    },
});

/** An edge glow or rim light around the model. */
export const glow = defineKind({
    column: fxColumn, word: "glow", group: "overlay",
    hint: t("tooltips:kind.glow.hint"),
    props: {
        colour: {types: [colour], synonyms: ["color"], hint: t("tooltips:kind.glow.props.colour")},
        target: target(),
    },
});

/** A colour wash over the model. */
export const tint = defineKind({
    column: fxColumn, word: "tint", group: "overlay",
    hint: t("tooltips:kind.tint.hint"),
    props: {
        colour: {types: [colour], synonyms: ["color"], hint: t("tooltips:kind.tint.props.colour")},
        target: target(),
    },
});

export const transparency = defineKind({
    column: fxColumn, word: "transparency", group: "overlay",
    hint: t("tooltips:kind.transparency.hint"),
    props: {percent: of(percent), target: target()},
});

export const desaturate = defineKind({
    column: fxColumn, word: "desaturate", group: "overlay",
    hint: t("tooltips:kind.desaturate.hint"),
    props: {percent: of(percent), target: target()},
});

export const freeze = defineKind({
    column: fxColumn, word: "freeze", group: "overlay",
    hint: t("tooltips:kind.freeze.hint"),
    props: {},
});

export const camo = defineKind({
    column: fxColumn, word: "camo", group: "overlay", full: "camouflage",
    hint: t("tooltips:kind.camo.hint"),
    props: {},
});

export const morph = defineKind({
    column: fxColumn, word: "morph", global: true, group: "transform",
    hint: t("tooltips:kind.morph.hint"),
    props: {display: named(t("tooltips:kind.morph.props.display"), TIER.asset), target: target()},
});

export const shapeshift = defineKind({
    column: fxColumn, word: "shapeshift", group: "transform",
    hint: t("tooltips:kind.shapeshift.hint"),
    props: {form: corpus(TIER.asset, enumeration), target: target()},
});

export const scale = defineKind({
    column: fxColumn, word: "scale", global: true, group: "transform",
    hint: t("tooltips:kind.scale.hint"),
    props: {
        amount: {
            types: [percentChange],
            hint: t("tooltips:kind.scale.props.amount"),
        },
        target: target(),
    },
});

export const summon = defineKind({
    column: fxColumn, word: "summon", global: true, group: "spawn",
    hint: t("tooltips:kind.summon.hint"),
    props: {
        creature: named(t("tooltips:kind.summon.props.creature"), TIER.asset),
        control: corpus(TIER.asset, enumeration),
        target: target(),
    },
});

export const gameObject = defineKind({
    column: fxColumn, word: "object", group: "spawn", full: "gameobject",
    hint: t("tooltips:kind.gameObject.hint"),
    props: {object: named(t("tooltips:kind.gameObject.props.object"), TIER.asset), target: target()},
});

/** A full-screen effect. Searched by its textures; the effect-type words are not part of the vocabulary. */
export const screen = defineKind({
    column: fxColumn, word: "screen", group: "screen",
    hint: t("tooltips:kind.screen.hint"),
    props: {
        texture: corpus(TIER.asset, path),
        target: target(),
    },
});

/** The caster stays turned toward the target for the whole channel. */
export const tracking = defineKind({
    column: fxColumn, word: "tracking", group: "behaviour",
    hint: t("tooltips:kind.tracking.hint"),
    props: {},
});

/* Mechanics: what a spell does. A row here renders nothing; anything visible belongs to the effects column. */

export const effect = defineKind({
    column: mechColumn, word: "effect", group: "action",
    hint: t("tooltips:kind.effect.hint"),
    props: {
        name: {types: [enumeration], hint: t("tooltips:kind.effect.props.name")},
        target: target(),
    },
});

export const aura = defineKind({
    column: mechColumn, word: "aura", group: "action",
    hint: t("tooltips:kind.aura.hint"),
    props: {
        name: {types: [enumeration], hint: t("tooltips:kind.aura.props.name")},
        target: target(),
    },
});

/* Spell-to-spell links, one kind per direction. */
export const triggers = defineKind({
    column: mechColumn, word: "triggers", global: true, group: "link",
    hint: t("tooltips:kind.triggers.hint"),
    props: {
        spell: named(t("tooltips:kind.triggers.props.spell")),
        how: of(enumeration),
        target: target(),
    },
});

export const origin = defineKind({
    column: mechColumn, word: "origin", global: true, group: "link",
    hint: t("tooltips:kind.origin.hint"),
    props: {
        spell: named(t("tooltips:kind.origin.props.spell")),
        how: of(enumeration),
        target: target(),
    },
});

/** Where a spell refuses to cast. Named by area, since an area id is not a number a reader would know. */
export const location = defineKind({
    column: mechColumn, word: "location", global: true, group: "gate",
    hint: t("tooltips:kind.location.hint"),
    props: {area: of(text)},
});

/* Invisibility has two sides: what hides in a channel, and what can see into it. */
export const invis = defineKind({
    column: mechColumn, word: "invis", group: "stealth", full: "invisibility",
    hint: t("tooltips:kind.invis.hint"),
    props: {
        channel: {types: [id], hint: t("tooltips:kind.invis.props.channel")},
        target: target(),
    },
});

export const detect = defineKind({
    column: mechColumn, word: "detect", group: "stealth",
    hint: t("tooltips:kind.detect.hint"),
    props: {
        channel: {types: [id], hint: t("tooltips:kind.detect.props.channel")},
        count: {types: [count], hint: t("tooltips:kind.detect.props.count")},
        target: target(),
    },
});

export const vehicle = defineKind({
    column: mechColumn, word: "vehicle", global: true, group: "vehicle",
    hint: t("tooltips:kind.vehicle.hint"),
    props: {
        seats: {types: [count], hint: t("tooltips:kind.vehicle.props.seats")},
        attach: attachPoint(t("tooltips:kind.vehicle.props.attach")),
        target: target(),
    },
});

export const speed = defineKind({
    column: mechColumn, word: "speed", global: true, group: "movement",
    hint: t("tooltips:kind.speed.hint"),
    props: {
        amount: {
            types: [percentChange],
            hint: t("tooltips:kind.speed.props.amount"),
        },
        mode: {types: [enumeration], hint: t("tooltips:kind.speed.props.mode")},
        target: target(),
    },
});

export const keybind = defineKind({
    column: mechColumn, word: "keybind", group: "ui",
    hint: t("tooltips:kind.keybind.hint"),
    props: {key: of(text), target: target()},
});

export const debuff = defineKind({
    column: mechColumn, word: "debuff", group: "ui",
    hint: t("tooltips:kind.debuff.hint"),
    props: {},
});
