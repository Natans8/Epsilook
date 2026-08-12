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
 * {@link ./value-matching!}. An operator missing from `accepts` is declined, and a declined operator
 * is reported to the reader as an error rather than silently matching nothing.
 *
 * Adding a type is one `defineType` call. Nothing else in the system changes.
 */
import {COLOUR_NAMES} from "./colour-names";
import type {Operator} from "./operators";
import {anyOf, contains, exact, glob, OPERATORS, ORDERING, present, regex} from "./operators";
import {fold, squash} from "./text-normalization";
import type {Notation, NumericSpec} from "./units";
import {formatNumber, parseNumber, parseNumberPair} from "./units";

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
    parse?(this: void, text: string): V | null;

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
    format?(this: void, value: V): string;

    /** The operators this type accepts. An operator not listed here is declined. */
    readonly accepts: readonly Operator[];

    /**
     * Every way this type's values may be written, the first being the one they are written AS.
     *
     * Present only on types that take a unit. Read by generated help and by the query surface, so the spellings a
     * reader is offered come from the same declaration that parses them.
     */
    readonly notations?: readonly Notation[];

    /** One line describing the type to a reader, used by generated help and by diagnostics. */
    readonly hint: string;

    /**
     * Whether this type's values are numerals rather than words. The quote law reads it: a quoted operand is a
     * string, so a quantity refuses one while a worded type reads it. Implied by declaring notations.
     */
    readonly quantity?: boolean;

    /**
     * Reads a range's two bounds as one coherent notation — `10-90` must not read half factor, half proportion.
     * Declared by types with more than one way to write a bare number; a `null` sends the caller to `parse`,
     * bound by bound, which is the right reading when a bound carries its own symbol.
     */
    parsePair?(this: void, lo: string, hi: string): readonly [V, V] | null;

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

    // A notation scales a quantity, and a quantity that cannot be ordered is not one. Without this, a unit could be
    // declared on free text, where the percent sign in a spell name would start behaving like one.
    if (type.notations && !ORDERING.every((op) => type.accepts.includes(op))) {
        throw new Error(`type "${type.name}" declares notations but does not accept an order`);
    }

    const declared = type.notations !== undefined ? {...type, quantity: true} : type;
    TYPES.set(declared.name, declared);
    return declared;
}

/* ---------------------------------------------------------------------------- text */

/** Human-written prose and names: spell names, descriptions, sound kit names, icon names, area names. */
export const text = defineType<string>({
    name: "text",
    storage: "string",
    parse: (s) => s,
    format: (s) => s,
    accepts: [exact, contains, glob, present, anyOf, regex],
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
    accepts: [exact, contains, glob, present, anyOf, regex],
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
    accepts: [exact, contains, glob, present, anyOf],
    hint: "one of a fixed list of names; pick one, or type part of it",
    ui: "picker",
});

/**
 * The ordered vocabulary ordinal values live in, lowest rank first.
 *
 * A declaration-side slot for data the pack supplies: the set of expansions differs between game versions, so the
 * ladder is loaded, never hard-coded. Parsing and matching both read it — the parser to refuse a rung the loaded
 * pack does not have, the matcher to compare by rank — which keeps the vocabulary one fact in one place while no
 * function crosses the seam.
 */
let ladder: readonly string[] = [];

/**
 * Sets the ordered vocabulary ordinal values are parsed and compared within.
 *
 * @param rungs The vocabulary, lowest rank first. Compared case-insensitively.
 */
export function setOrdinalLadder(rungs: readonly string[]): void {
    ladder = rungs.map(fold);
}

/** The loaded ordinal vocabulary, lowest rank first, folded. Empty when no data has been loaded. */
export function ordinalRungs(): readonly string[] {
    return ladder;
}

/**
 * A named value from an ordered set, such as the expansion a spell was introduced in.
 *
 * Differs from {@link enumeration} only in accepting comparison and ranges. Once a ladder is loaded, an operand no
 * rung contains is refused at parse, so an unknown expansion is a diagnostic rather than a silent empty result; with
 * no ladder loaded there is nothing to refuse against, and any text is accepted.
 */
export const ordinal = defineType<string>({
    name: "ordinal",
    storage: "int",
    parse: (s) => {
        if (ladder.length === 0) return s;
        return ladder.some((rung) => squash(rung).includes(squash(s))) ? s : null;
    },
    format: (s) => s,
    accepts: [exact, contains, glob, present, anyOf, ...ORDERING],
    hint: "a rung on a ladder; name one, or compare with < and >",
    ui: "picker",
});

/* -------------------------------------------------------------------------- numbers */

/**
 * Reads a whole, non-negative number.
 *
 * @param written One operand, as typed.
 * @returns The number, or `null` when the operand is not one, including when it is too large to survive a round trip.
 */
function wholeNumber(written: string): number | null {
    if (!/^\d+$/.test(written)) return null;
    const n = Number(written);
    return Number.isSafeInteger(n) ? n : null;
}

/**
 * An identity: a spell id, a sound kit id, an icon file id.
 *
 * Accepts equality only. Ids have no order a reader means anything by, and matching part of an id is how a six-digit
 * number comes to select hundreds of rows instead of one.
 */
export const id = defineType<number>({
    name: "id",
    storage: "int",
    parse: wholeNumber,
    format: (n) => String(n),
    accepts: [exact, present, anyOf],
    hint: "the exact id, matched whole",
    quantity: true,
    ui: "number",
});

/** A cardinality: how many rows of something a spell has. Derived at query time, never stored. */
export const count = defineType<number>({
    name: "count",
    storage: "int",
    parse: wholeNumber,
    format: (n) => String(n),
    accepts: [exact, present, anyOf, ...ORDERING],
    hint: "how many, as a whole number or a comparison such as >4",
    quantity: true,
    ui: "number",
});

/**
 * Builds one member of the numeric family.
 *
 * @param spec Storage, the notations it reads and writes, and optional sentinels, plus the type's name and hint.
 * @returns The registered type.
 */
function numeric(spec: NumericSpec & { name: string; hint: string; ui?: Affordance }): AxisType<number> {
    return defineType<number>({
        name: spec.name,
        storage: spec.storage,
        parse: parseNumber(spec),
        parsePair: parseNumberPair(spec),
        format: formatNumber(spec),
        accepts: [exact, present, anyOf, ...ORDERING],
        notations: [spec.display, ...(spec.accepts ?? [])],
        hint: spec.hint,
        ui: spec.ui ?? "range",
    });
}

/**
 * A duration, stored in milliseconds and written in seconds.
 *
 * Durations in this data span three orders of magnitude — cast times below a second, cooldowns running to minutes —
 * so the smaller and larger units are worth accepting. Both require their symbol, leaving a bare number to mean
 * seconds.
 *
 * Words such as `unlimited` and `instant` are not here: a stored value that is not a quantity is the axis's
 * vocabulary, declared as a sentinel on the property.
 */
export const seconds = numeric({
    name: "seconds",
    storage: "int",
    display: {unit: "s", factor: 1000},
    accepts: [
        {unit: "ms", factor: 1, bare: "never"},
        {unit: "m", factor: 60_000, bare: "never"},
    ],
    hint: "a duration in seconds, such as 1.5, 500ms, or 2-5",
});

/**
 * A proportion of a whole: how transparent a model is, how much colour is drained from it.
 *
 * Absolute rather than relative, so `50` is half and there is no baseline to measure from — which is also why a sign
 * is refused: a proportion has no direction, and accepting `-50` would parse a value that means nothing here.
 * Distinct from {@link percentChange}, which is a change measured from a hundred and carries its sign.
 */
export const percent = numeric({
    name: "percent",
    storage: "float",
    display: {unit: "%", factor: 1, sign: "refused"},
    hint: "a percentage, such as 50 or 7.5, or a range like 10-90",
});

/**
 * A change in size or speed, stored as the change itself: `+50` is half again as big, `-50` is half.
 *
 * Three notations of one value, because a reader may think in any of them and the game itself uses more than one. Its
 * own description template for a size aura is `+$m1% Scale`, while its commands are written as a factor.
 *
 * - `+50%` — the change, signed. What a value is written as.
 * - `x1.5` — the same, as a factor. Written before the number, and `1.5x` is accepted too.
 * - `150%` — the same, as a proportion of the original. Offset by a hundred, since a hundred percent is no change.
 *
 * A bare number splits at ten, the ceiling of the game's own scale command: up to ten it is a factor, so a number in
 * command range means what the command means — `2` is double, exactly as `.mod scale 2` is — and above ten it is a
 * proportion, so `150` is half again. A small percentage therefore carries its symbol or its sign: `7.5%` or `+7.5`.
 *
 * The change is what is stored and printed because these auras accumulate by addition: two spells at +50% leave a
 * character at +100%, not at 2.25 times its size. Changes add, factors do not, so a factor is a way of writing one
 * value rather than the form the quantity composes in.
 */
export const percentChange = numeric({
    name: "percentChange",
    storage: "float",
    display: {unit: "%", factor: 1, sign: "required"},
    accepts: [
        {
            unit: "x", aliases: ["×"], position: "before", factor: 100, offset: -100,
            sign: "refused", bare: {atMost: 10}
        },
        {unit: "%", factor: 1, offset: -100, sign: "refused", bare: {above: 10}},
    ],
    hint: "a change such as +50, a factor such as 2 or x1.5, or 150 as a proportion of the original",
});

/** A distance in yards, the unit the game and its players use. */
export const length = numeric({
    name: "length",
    storage: "float",
    display: {unit: "yd", factor: 1},
    hint: "a distance in yards, such as 5 or 10-40",
});

/** An angle in degrees, edited with a dial rather than a slider because it wraps. */
export const angle = numeric({
    name: "angle",
    storage: "float",
    display: {unit: "deg", factor: 1, aliases: ["°"]},
    hint: "an angle in degrees, such as 60 or 27-60",
    ui: "dial",
});

/* -------------------------------------------------------------------------- others */

/**
 * A colour, stored packed as 0xRRGGBB.
 *
 * Written as a hex triplet or as a CSS colour name, and edited with a colour picker, which is the only practical way
 * to choose one: nobody knows a tint's packed value, so the control is what makes the axis usable. A bare token
 * matches approximately, by channel distance, because "about this colour" is the question a reader actually has —
 * which is also what makes a name useful, since nobody's tint is exactly pure red; `=` matches the exact value for a
 * reader who copied one. Names are read and never written: a stored colour prints as its hex triplet.
 */
export const colour = defineType<number>({
    name: "colour",
    storage: "int",
    parse: (s) => {
        const written = s.trim();
        const hex = /^#?([0-9a-f]{6})$/i.exec(written);
        if (hex) return Number.parseInt(hex[1], 16);
        return COLOUR_NAMES[fold(written)] ?? null;
    },
    format: (packed) => `#${packed.toString(16).padStart(6, "0")}`,
    accepts: [exact, contains, present, anyOf],
    hint: "a colour as #rrggbb or a name such as red; a bare colour matches nearby shades too",
    ui: "colour",
});

/**
 * Builds a type whose value has several named members, each with a type of its own.
 *
 * A composite is one measurement taken together rather than several separate ones: a missile's cast offset is a
 * single point, not three unrelated distances, so it is one property a reader constrains rather than three they must
 * combine. That is what separates it from a kind, whose properties describe different aspects of a row.
 *
 * Parsing and formatting delegate to the members, so a member's units, sentinels and notation work inside a composite
 * exactly as they do alone. The value is carried as comma-separated storage numbers to keep it a JSON scalar; a blank
 * component is one the query does not constrain, so `z=3` and `,,3` both ask only about the third member.
 *
 * The control is a field set, one control per member, each drawn by the member's own type.
 *
 * @param spec The type's name and hint, and its members in the order they are written.
 * @returns The registered type.
 * @throws If a member's type has no value to read or write, which leaves that component unreachable.
 */
export function composite(spec: {
    name: string;
    members: Readonly<Record<string, AxisType<number>>>;
    hint: string;
}): AxisType<string> {
    const members = Object.entries(spec.members).map(([name, type]) => {
        if (!type.parse || !type.format) {
            throw new Error(
                `composite "${spec.name}" member "${name}" has type "${type.name}", which carries no value`);
        }
        return {name, parse: type.parse, format: type.format};
    });

    return defineType<string>({
        name: spec.name,
        storage: "float",
        parse: (s) => {
            const parts = s.split(",");
            if (parts.length > members.length) return null;

            const slots: (string | null)[] = members.map(() => null);
            let seenNamed = false;

            for (const [i, part] of parts.entries()) {
                const written = part.trim();
                if (written === "") continue;

                const named = /^(\w+)\s*=\s*(.*)$/.exec(written);
                // Positional components are read by position, so one after a named component has no position left to
                // mean. The same rule as a function call, and for the same reason.
                if (named) seenNamed = true;
                else if (seenNamed) return null;

                const at = named
                    ? members.findIndex((member) => member.name.toLowerCase() === named[1].toLowerCase())
                    : i;
                // An unknown member, or one already given a value: both would otherwise be discarded in silence.
                if (at < 0 || slots[at] !== null) return null;

                const value = members[at].parse(named ? named[2] : written);
                if (value === null) return null;
                slots[at] = String(value);
            }

            return slots.some((slot) => slot !== null)
                ? slots.map((slot) => slot ?? "").join(",")
                : null;
        },
        // A component with no member to format it is passed through as written. Stored values come from the game data,
        // where a later version adding a component should degrade to showing it rather than failing to render.
        format: (value) => value
            .split(",")
            .map((slot, i) => {
                const member = members[i];
                return slot === "" || member === undefined ? slot : member.format(Number(slot));
            })
            .join(","),
        // A composite declines alternation: its own components are comma-separated, so a group of alternatives
        // inside one would need a second level of delimiter to be read unambiguously.
        accepts: [exact, present],
        hint: spec.hint,
        ui: "fields",
    });
}

/**
 * A point relative to whatever the value belongs to: where a missile launches or lands, where an attached model sits
 * against its attachment point.
 *
 * TODO: attach to the missile kind's cast and impact offsets and the attached kind's offset once the build ships
 * those columns; each is three separate fields in the game data and none reaches the pack today.
 */
export const offset = composite({
    name: "offset",
    members: {x: length, y: length, z: length},
    hint: "a point as x,y,z in yards; name one member such as z=3, or leave a component blank to ignore it",
});

/**
 * The role names a target mask answers to. The type's own vocabulary, so parsing can refuse a word that is not one;
 * which bits realise each role is the evaluator's mapping, and a test holds the two lists together.
 */
export const TARGET_ROLES: readonly string[] = Object.freeze(["area", "both", "caster", "others", "target"]);

/**
 * Several bits on one row, where the reader names a role rather than a number.
 *
 * The roles are not one bit each: a target spans two bits that mean the same thing to a reader, and `both` is a
 * conjunction no single bit spells. The names are this type's closed vocabulary and anything else is refused at
 * parse, so a mistyped role is a diagnostic rather than a silently empty result; the bit mapping is held by the
 * evaluator, which is the layer that sees the stored integers.
 */
export const bitmask = defineType<string>({
    name: "bitmask",
    storage: "int",
    parse: (s) => {
        const role = fold(s.trim());
        return TARGET_ROLES.includes(role) ? role : null;
    },
    format: (s) => s,
    accepts: [exact, present, anyOf],
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
