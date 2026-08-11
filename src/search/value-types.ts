/**
 * @file The value types: what a searchable value means, how it is written, and which control edits it.
 *
 * A type answers four questions about a value and knows nothing about which property uses it, which kind that
 * property belongs to, or what the value is called. A property says "cast time is measured in seconds"; the
 * `seconds` type says what a second is, that `ms` is a thousandth of one, and that a number line is the right
 * control.
 *
 * The type is also what selects the UI affordance. A colour gets a colour picker, an angle gets a dial, an enum gets
 * a list of its values, a number gets a slider. That is why a value with a distinct editing experience earns a type
 * even when its matching rules resemble another's.
 *
 * Each type lists the operators it accepts as data; the implementations live in
 * {@link ./value-matching value-matching.ts}. An operator missing from `accepts` is declined, and a declined operator
 * is reported to the reader as an error rather than silently matching nothing.
 *
 * Adding a type is one `defineType` call. Nothing else in the system changes.
 */
import type {Operator} from "./operators";
import {contains, exact, glob, OPERATORS, ORDERING, present} from "./operators";
import type {NumericSpec, UnitTable} from "./units";
import {formatNumber, parseNumber} from "./units";

/**
 * What a parsed value may be.
 *
 * A JSON scalar. Values travel from the parser to the evaluator as plain data, so a value that cannot be serialised
 * would confine the query to the process that built it. Composite values are carried as their canonical text.
 */
export type Value = string | number;

/** The base types the game data declares. Read from the source, never chosen. */
export type Storage = "int" | "float" | "string" | "locstring";

/**
 * The control a reader edits this value with.
 *
 * A default: a property whose measured value set is small enough may present a list where its type asks for a
 * slider. Cardinality decides the affordance; the type decides the starting point.
 */
export type Affordance =
    | "text"
    | "number"
    | "range"
    | "picker"
    | "toggle"
    | "glyphs"
    | "colour"
    | "dial"
    | "fields";

/** One value type. */
export interface AxisType<V extends Value = Value> {
    /** Registry key, and the word a diagnostic uses when naming the type to a reader. */
    readonly name: string;

    /** What the game data holds, or `null` when the type has no value to store. */
    readonly storage: Storage | null;

    /**
     * Converts query text to a value.
     *
     * @param text One operand, as typed.
     * @returns The value, or `null` when the text is not of this type.
     *
     * Returning `null` is how a property with several notations dispatches: the notations are tried in order and the
     * first to accept the operand wins. `null` therefore means "not my shape", never "malformed"; a diagnostic is
     * produced by the caller once no notation has accepted the operand.
     *
     * Absent when the type has no values at all.
     */
    parse?(text: string): V | null;

    /**
     * Converts a value to the text that represents it.
     *
     * @param value A value of this type.
     * @returns The canonical spelling.
     *
     * `format(parse(s)) === s` holds for every `s` that `format` itself produced. Input is lenient and output is one
     * form, so a value read off the screen can be typed back into a query.
     *
     * Absent when the type has no values at all.
     */
    format?(value: V): string;

    /** The operators this type accepts. An operator not listed here is declined. */
    readonly accepts: readonly Operator[];

    /** Unit symbols and their factors, when the type takes units. */
    readonly units?: UnitTable;

    /** One line describing the type to a reader, used by generated help and by diagnostics. */
    readonly hint: string;

    readonly ui: Affordance;
}

/** Every declared type, keyed by name. */
export const TYPES = new Map<string, AxisType>();

/**
 * Registers a value type.
 *
 * @param type The type to register.
 * @returns The registered type.
 * @throws If the name is taken, if `accepts` names an unregistered operator, if a type accepting a value-bearing
 *   operator cannot read or write a value, or if a type declares units without accepting an order.
 */
export function defineType<V extends Value>(type: AxisType<V>): AxisType<V> {
    if (TYPES.has(type.name)) throw new Error(`type "${type.name}" already defined`);

    for (const op of type.accepts) {
        if (OPERATORS.get(op.name) !== op) {
            throw new Error(`type "${type.name}" accepts unregistered operator "${op.name}"`);
        }
    }

    const valued = type.accepts.some((op) => op !== present);
    if (valued && !(type.parse && type.format)) {
        throw new Error(
            `type "${type.name}" accepts an operator that takes a value but cannot parse or format one`);
    }

    // Units scale a quantity, and a quantity that cannot be ordered is not one. Without this, a unit could be
    // declared on free text, where the percent sign in a spell name would start behaving like a unit.
    if (type.units && !ORDERING.every((op) => type.accepts.includes(op))) {
        throw new Error(`type "${type.name}" declares units but does not accept an order`);
    }

    TYPES.set(type.name, type);
    return type;
}

/* ---------------------------------------------------------------------------- text */

/** Human-written prose and names: spell names, descriptions, sound kit names, icon names, area names. */
export const text = defineType<string>({
    name: "text",
    storage: "string",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present],
    hint: "words, matched anywhere in the text unless anchored with =",
    ui: "text",
});

/**
 * Asset file paths: models, sound files, textures.
 *
 * Distinct from {@link text} because a path cannot be anchored to a word boundary. Asset names run words together
 * (`beecreature.m2`, `beerfest_keg01.m2`), so splitting on punctuation yields tokens matching neither `bee` nor
 * `beer`. Matching is unanchored substring because the corpus permits nothing better, and the type exists so a hint
 * can say so and a future anchoring proposal has somewhere to be refused.
 */
export const path = defineType<string>({
    name: "path",
    storage: "string",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present],
    hint: "part of a file path; file names run words together, so bee also finds beer",
    ui: "text",
});

/**
 * A named value from a closed set: effect names, aura names, implicit target names, attachment points.
 *
 * The value is the name. Readers type the name, not the underlying integer, and the picker exists so the vocabulary
 * can be browsed rather than guessed.
 *
 * TODO: accept the underlying integer as a second notation once the UI offers value pickers that carry ids, so a
 * control can round-trip its selection without translating.
 */
export const enumeration = defineType<string>({
    name: "enum",
    storage: "int",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present],
    hint: "one of a fixed list of names; pick one, or type part of it",
    ui: "picker",
});

/**
 * A named value from an ordered set, such as the expansion a spell was introduced in.
 *
 * Differs from {@link enumeration} only in accepting comparison and ranges. The order itself is data: the vocabulary
 * is supplied to the evaluator by whatever loads the game data, because the set of expansions differs between game
 * versions.
 */
export const ordinal = defineType<string>({
    name: "ordinal",
    storage: "int",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present, ...ORDERING],
    hint: "a rung on a ladder; name one, or compare with < and >",
    ui: "picker",
});

/* -------------------------------------------------------------------------- numbers */

/**
 * An identity: a spell id, a sound kit id, an icon file id.
 *
 * Accepts equality only. Ids have no order a reader means anything by, and matching part of an id is how a six-digit
 * number comes to select hundreds of rows instead of one.
 */
export const id = defineType<number>({
    name: "id",
    storage: "int",
    parse: (s) => {
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        // Beyond the safe integer range the value no longer survives a round trip, so it is not an id of ours.
        return Number.isSafeInteger(n) ? n : null;
    },
    format: (n) => String(n),
    accepts: [exact, present],
    hint: "the exact id, matched whole",
    ui: "number",
});

/** A cardinality: how many rows of something a spell has. Derived at query time, never stored. */
export const count = defineType<number>({
    name: "count",
    storage: "int",
    parse: (s) => {
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return Number.isSafeInteger(n) ? n : null;
    },
    format: (n) => String(n),
    accepts: [exact, present, ...ORDERING],
    hint: "how many, as a whole number or a comparison such as >4",
    ui: "number",
});

/**
 * Builds one member of the numeric family.
 *
 * @param spec Storage, canonical unit, unit table and optional sentinels, plus the type's name and hint.
 * @returns The registered type.
 */
function numeric(spec: NumericSpec & {name: string; hint: string; ui?: Affordance}): AxisType<number> {
    return defineType<number>({
        name: spec.name,
        storage: spec.storage,
        parse: parseNumber(spec),
        format: formatNumber(spec),
        accepts: [exact, present, ...ORDERING],
        units: spec.units,
        hint: spec.hint,
        ui: spec.ui ?? "range",
    });
}

/**
 * A duration. Stored in milliseconds and written in seconds.
 *
 * The only type that converts between units, because durations in this data span three orders of magnitude: cast
 * times below a second, cooldowns running to minutes.
 */
export const seconds = numeric({
    name: "seconds",
    storage: "int",
    unit: "s",
    units: {s: 1000, ms: 1, m: 60000},
    sentinels: {[-1]: "unlimited"},
    hint: "a duration in seconds, such as 1.5, 500ms, 2-5, or unlimited",
});

/**
 * A proportional change, signed.
 *
 * The default notation for size and speed, because that is how the game presents them and how Epsilon's own commands
 * are written. The sign carries meaning: an aura at +30% and one at -30% are opposite effects, so a formatted value
 * always states it.
 */
export const percent = numeric({
    name: "percent",
    storage: "int",
    unit: "%",
    units: {"%": 1},
    signed: true,
    hint: "a percentage, such as 50, +30, -30, or a range like 10-90",
});

/**
 * A bare factor, offered alongside {@link percent} wherever a reader thinks in multiples rather than percentages.
 *
 * Never the default. Where both notations apply, percent is tried first, so an unqualified number is read the way the
 * game states it and `2x` selects this notation explicitly.
 */
export const multiplier = numeric({
    name: "multiplier",
    storage: "float",
    unit: "x",
    units: {x: 1, "×": 1},
    hint: "a multiplier, where 2 is twice and 0.5 is half",
});

/** A distance in yards, the unit the game and its players use. */
export const length = numeric({
    name: "length",
    storage: "float",
    unit: "yd",
    units: {yd: 1},
    hint: "a distance in yards, such as 5 or 10-40",
});

/** An angle in degrees, edited with a dial rather than a slider because it wraps. */
export const angle = numeric({
    name: "angle",
    storage: "float",
    unit: "deg",
    units: {deg: 1, "°": 1},
    hint: "an angle in degrees, such as 60 or 27-60",
    ui: "dial",
});

/* -------------------------------------------------------------------------- others */

/**
 * A colour, stored packed as 0xRRGGBB.
 *
 * Written as a hex triplet and edited with a colour picker, which is the only practical way to choose one: nobody
 * knows a tint's packed value, so the control is what makes the axis usable. A bare token matches approximately, by
 * channel distance, because "about this colour" is the question a reader actually has; `=` matches the exact value
 * for a reader who copied one.
 */
export const colour = defineType<number>({
    name: "colour",
    storage: "int",
    parse: (s) => {
        const hex = /^#?([0-9a-f]{6})$/i.exec(s.trim());
        return hex ? Number.parseInt(hex[1], 16) : null;
    },
    format: (packed) => `#${packed.toString(16).padStart(6, "0")}`,
    accepts: [exact, contains, present],
    hint: "a colour as #rrggbb; a bare colour matches nearby shades too",
    ui: "colour",
});

/**
 * A fixed-length tuple of numbers, such as a position or an offset.
 *
 * Carried as its canonical text so that a value stays a JSON scalar. A query may constrain fewer components than the
 * value has, leaving the rest blank: `1,,3` asks about the first and third only. The control presents one numeric
 * field per component.
 */
export const vector = defineType<string>({
    name: "vector",
    storage: "float",
    parse: (s) => (/^-?[\d.]*(,-?[\d.]*)+$/.test(s.trim()) ? s.trim() : null),
    format: (v) => v,
    accepts: [exact, present],
    hint: "components separated by commas, such as 0,0,1; leave one blank to ignore it",
    ui: "fields",
});

/**
 * Several bits on one row, where the reader names a role rather than a number.
 *
 * The roles are `caster`, `target`, `area`, `others` and `both`. They are not one bit each: a target spans two bits
 * that mean the same thing to a reader, and `both` is a conjunction no single bit spells. The mapping is held by the
 * evaluator, which is the layer that sees the stored integers.
 */
export const bitmask = defineType<string>({
    name: "bitmask",
    storage: "int",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, present],
    hint: "who it plays on: caster, target, both, area or others",
    ui: "glyphs",
});

/**
 * A bit on a spell, carrying no value of its own.
 *
 * Presence is the whole question. Requiring, excluding and ignoring are expressed by the query language rather than
 * by the type, so there is no third state to model here.
 */
export const flag = defineType<never>({
    name: "flag",
    storage: null,
    accepts: [present],
    hint: "either the spell has it or it does not",
    ui: "toggle",
});
