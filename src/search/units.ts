/**
 * @file Reading and writing numeric values: notations, units, and sentinels.
 *
 * A unit is not a suffix character. It is a NOTATION — one way of writing a quantity — carrying a symbol, the side of
 * the number that symbol sits on, the scale it implies, the zero it measures from, and whether a sign is part of it.
 * `x1.5`, `150%` and `+50%` are three notations of one stored value.
 *
 * The two directions are not symmetric, which is why they are declared apart:
 *
 * - READING is one-to-many. Several notations are accepted, and they must be mutually exclusive or the same text
 *   would mean two things. `parseNumber` refuses to build a parser whose notations could collide.
 * - WRITING is many-to-one. A stored value has exactly one spelling, so exactly one notation is marked for display.
 *
 * Three rules hold across both. A unit converts rather than annotates, so `500ms` is half a second and `500` is five
 * hundred seconds. A query converts down into storage and stored values are never converted up, so equality compares
 * the integers the data holds rather than binary fractions. A sentinel is recognised before it is scaled, so a stored
 * -1 meaning "unlimited" is never read as minus one millisecond.
 */
import {fold} from "./text-normalization";

/**
 * Which numbers written without a symbol a notation claims.
 *
 * `"any"` claims them all and `"never"` claims none. The bounded forms split the number line at a threshold, so two
 * notations that differ by a factor of a hundred can share the bare numbers between them: one takes everything up to
 * the threshold inclusive, the other everything above it. The threshold is compared against the written magnitude,
 * before any sign or scaling.
 */
export type BareClaim = "any" | "never" | { readonly atMost: number } | { readonly above: number };

/**
 * One way of writing a quantity.
 *
 * Notations of one quantity are told apart by three things, in the order a reader notices them: which symbol is
 * written, whether a sign is written, and — for a number written with no symbol at all — its size.
 */
export interface Notation {
    /** The symbol written with the number. Empty for a notation that is only ever a bare number. */
    readonly unit: string;

    /** Further spellings of the same symbol, accepted on input and never written. */
    readonly aliases?: readonly string[];

    /** Which side of the number the symbol is written on. Defaults to after it. */
    readonly position?: "before" | "after";

    /** Storage units per one unit of this notation. */
    readonly factor: number;

    /**
     * Storage units added after scaling, for a notation measuring from a different zero.
     *
     * A size change is stored as the change itself, so a proportion of the original converts with an offset of -100:
     * a hundred percent is no change at all.
     */
    readonly offset?: number;

    /**
     * Whether an explicit leading sign is part of this notation.
     *
     * The discriminator that lets two notations share a symbol: a signed percentage is a change, an unsigned one is a
     * proportion. On the display notation it also decides whether a sign is written.
     */
    readonly sign?: "required" | "refused" | "optional";

    /**
     * Which numbers written without the symbol this notation claims. Defaults to all of them.
     *
     * The last discriminator, and the one that makes a bare number unambiguous where two notations differ by a factor
     * of a hundred: each claims one side of a declared threshold, so the size of the number says which notation it is
     * written in. `never` belongs to an alternate that would otherwise capture a bare number from the display
     * notation.
     */
    readonly bare?: BareClaim;
}

/**
 * Stored values that are not quantities, and the word each one means.
 *
 * Declared on a property rather than on a type, because the word is the axis's vocabulary: a channel's stored -1
 * means unlimited and a cast bar's stored 0 means instant, while the duration type they share knows neither word.
 * A sentinel is classified before any scaling, so it can never be misread as that many display units.
 */
export type Sentinels = Readonly<Record<number, string>>;

/** What a numeric type needs in order to read and write its values. */
export interface NumericSpec {
    /** `int` rounds after scaling, because the data holds integers and equality must be exact. */
    readonly storage: "int" | "float";

    /** The notation a value is written in. Accepted on input as well. */
    readonly display: Notation;

    /** Further notations accepted on input and never written. */
    readonly accepts?: readonly Notation[];
}

/**
 * Decimal places kept when a stored value is converted into its display notation.
 *
 * Enough to preserve any value this data holds, and few enough to absorb binary representation error: a float column
 * can hold 1.2000000000000002, which is noise rather than precision.
 */
const PRECISION = 6;

/** A sign, a decimal with no exponent, then an optional symbol. */
const UNIT_AFTER = /^([+-]?)((?:\d+(?:\.\d+)?|\.\d+))(.*)$/;

/** A sign, a symbol, then the number: `x2`, `-x1.5`. */
const UNIT_BEFORE = /^([+-]?)([^\d.]+)((?:\d+(?:\.\d+)?|\.\d+))$/;

/**
 * Every spelling a notation answers to, folded.
 *
 * @param notation The notation.
 * @returns Its symbol and aliases, with the empty symbol dropped.
 */
function spellings(notation: Notation): string[] {
    return [notation.unit, ...(notation.aliases ?? [])].filter((s) => s !== "").map(fold);
}

/**
 * Whether two notations could both accept one operand.
 *
 * Safe when no text satisfies both. A notation whose sign and bare form are both unconstrained is told apart by its
 * symbol alone, so two such notations must not share one.
 *
 * @param a One notation.
 * @param b Another.
 * @returns Whether an operand exists that both would accept.
 */
function overlap(a: Notation, b: Notation): boolean {
    const bySign = (a.sign === "required" && b.sign === "refused")
        || (a.sign === "refused" && b.sign === "required");
    if (bySign) return false;

    const shareSymbol = spellings(a).some((s) => spellings(b).includes(s));
    return shareSymbol || sharesBare(a, b);
}

/**
 * Whether two notations both claim some number written without a symbol.
 *
 * @param a One notation.
 * @param b Another.
 * @returns Whether a bare number exists that both would accept.
 */
function sharesBare(a: Notation, b: Notation): boolean {
    const one = a.bare ?? "any";
    const other = b.bare ?? "any";
    if (one === "never" || other === "never") return false;
    if (one === "any" || other === "any") return true;

    // Two bounded claims are disjoint only when one takes everything up to a threshold and the other everything
    // above one at least as large; two claims on the same side always share numbers.
    if ("atMost" in one && "above" in other) return one.atMost > other.above;
    if ("above" in one && "atMost" in other) return other.atMost > one.above;
    return true;
}

/**
 * Builds a reader for one notation.
 *
 * @param notation The notation.
 * @param storage Whether the stored value is integral.
 * @returns A function converting text to a stored value, or `null` when the text is not written in this notation.
 */
function readNotation(notation: Notation, storage: "int" | "float"): (text: string) => number | null {
    const accepted = spellings(notation);
    const before = notation.position === "before";

    return (text: string): number | null => {
        // A notation written before its number still accepts a bare one, which only the other pattern matches.
        const led = before ? UNIT_BEFORE.exec(text) : null;
        const parts = led ?? UNIT_AFTER.exec(text);
        if (!parts) return null;

        const [, sign, a, b] = parts;
        const [digits, symbol] = led ? [b, a] : [a, b];

        if (symbol === "") {
            const bare = notation.bare ?? "any";
            if (bare === "never") return null;
            if (typeof bare === "object") {
                const size = Number(digits);
                if ("atMost" in bare ? size > bare.atMost : size <= bare.above) return null;
            }
        } else if (!accepted.includes(symbol)) {
            return null;
        }

        if (notation.sign === "required" && sign === "") return null;
        if (notation.sign === "refused" && sign !== "") return null;

        const magnitude = Number(`${sign}${digits}`);
        if (!Number.isFinite(magnitude)) return null;

        const scaled = magnitude * notation.factor + (notation.offset ?? 0);
        return storage === "int" ? Math.round(scaled) : scaled;
    };
}

/**
 * Builds the parser for one numeric type.
 *
 * @param spec The numeric spec.
 * @returns A function converting query text to a stored value, or `null` when the text is not a number of this type.
 * @throws If two of the spec's notations could accept one operand, which would make that text mean two things.
 *
 * `null` covers both "not numeric" and "carries a unit this type does not have". Both are the same answer to the
 * caller, which tries the property's next type and produces a diagnostic only once every one has refused.
 */
export function parseNumber(spec: NumericSpec): (text: string) => number | null {
    const all = [spec.display, ...(spec.accepts ?? [])];
    for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
            if (overlap(all[i], all[j])) {
                throw new Error(
                    "numeric type has two notations that would both accept one operand: "
                    + `"${all[i].unit}" and "${all[j].unit}"`);
            }
        }
    }

    const readers = all.map((notation) => readNotation(notation, spec.storage));

    return (text: string): number | null => {
        const folded = fold(text.trim());
        if (folded.length === 0) return null;

        for (const read of readers) {
            const value = read(folded);
            if (value !== null) return value;
        }
        return null;
    };
}

/**
 * Builds the formatter for one numeric type.
 *
 * @param spec The numeric spec.
 * @returns A function converting a stored value to its one spelling.
 *
 * That spelling is what a pill prints, so a value read off the screen can be typed back into a query.
 * `format(parse(s)) === s` holds for every `s` this function produced; the other notations parse but are never
 * written.
 */
export function formatNumber(spec: NumericSpec): (value: number) => string {
    const {unit, factor, offset, sign, position} = spec.display;

    return (value: number): string => {
        const shown = Number(((value - (offset ?? 0)) / factor).toFixed(PRECISION));
        // A sign is written where the notation requires one, so that zero round-trips; where it is merely allowed,
        // only a negative carries its own.
        const plus = shown > 0 || (shown === 0 && sign === "required");
        const written = sign === "required" && plus ? `+${shown}` : String(shown);

        return position === "before" ? `${unit}${written}` : `${written}${unit}`;
    };
}
