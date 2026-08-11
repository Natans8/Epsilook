/**
 * @file Reading and writing numeric values: units, sentinels, and the number grammar.
 *
 * Three rules govern everything here.
 *
 * A unit converts rather than annotates. `500ms` is half a second and `500` is five hundred seconds, because this
 * data contains cast times below a second alongside cooldowns measured in minutes.
 *
 * A query converts down into storage; stored values are never converted up. Durations are whole milliseconds in the
 * data and whole milliseconds here, so equality compares integers rather than binary fractions.
 *
 * A sentinel is recognised before it is scaled. A stored -1 meaning "unlimited" is not minus one millisecond, so it
 * is matched by name at both ends before any arithmetic happens.
 */
import {fold} from "./text-normalization";

/**
 * Unit symbol to the number of storage units one of it represents.
 *
 * Factors are into storage, not into the canonical unit, so parsing is a single multiplication. A duration stored in
 * milliseconds and written in seconds declares `{s: 1000, ms: 1}`, which also states the storage unit plainly.
 *
 * A prettier symbol is another key with the same factor, so nothing needs to know which spelling is display-only.
 */
export type UnitTable = Readonly<Record<string, number>>;

/**
 * Stored values that are not quantities, and the word each one means.
 *
 * Reachable by name and never by number: typing the sentinel's digits asks for that many display units, which scales
 * to a different stored value and matches nothing. The two cannot be confused even where the digits coincide.
 */
export type Sentinels = Readonly<Record<number, string>>;

/** What a numeric type needs in order to read and write its values. */
export interface NumericSpec {
    /** `int` rounds after scaling, because the data holds integers and equality must be exact. */
    readonly storage: "int" | "float";
    /** The unit a bare number means, and the one `format` writes. */
    readonly unit: string;
    readonly units: UnitTable;
    /** Write a leading `+` on positive values, for quantities where the sign is the information. */
    readonly signed?: boolean;

    /**
     * Storage units added after scaling, for a notation measured from a different zero.
     *
     * A size change is stored as the change itself, so a value written as a proportion of the original converts with
     * an offset: `150%` and `1.5x` are both a change of `+50`. Without this the two notations would be compared
     * against the stored value on different baselines.
     */
    readonly offset?: number;

    /**
     * Whether an explicit leading sign is required or refused.
     *
     * What lets two notations of one quantity be told apart by the shape of the operand: a signed operand is a
     * change, an unsigned one is a proportion. Stated on both so each declines what the other reads, rather than
     * relying on the order they happen to be tried in.
     *
     * Omitted where a sign is simply allowed.
     */
    readonly sign?: "required" | "refused";

    /**
     * Where `format` writes the unit. Defaults to after the number.
     *
     * Both positions are accepted on input whatever this says, in keeping with input being lenient and output being
     * one form. A factor is conventionally written before the number, a measurement after it.
     */
    readonly unitPosition?: "before" | "after";

    readonly sentinels?: Sentinels;
}

/**
 * Decimal places kept when a stored value is divided into its display unit.
 *
 * Enough to preserve any value this data holds, and few enough to absorb binary representation error: a float column
 * can hold 1.2000000000000002, which is noise rather than precision.
 */
const PRECISION = 6;

/** A signed decimal, with no exponent and no internal space, followed by an optional unit. */
const NUMBER = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/;

/** A sign, a unit written before the number, and the rest: `x2`, `-x1.5`. */
const UNIT_FIRST = /^([+-]?)([^\d.+-]+)(.*)$/;

/**
 * Indexes a unit table by folded symbol.
 *
 * @param units The type's unit table.
 * @returns The table keyed by folded symbol, so `MS` and `ms` are one unit.
 */
function unitLookup(units: UnitTable): Map<string, number> {
    const out = new Map<string, number>();
    for (const [symbol, factor] of Object.entries(units)) out.set(fold(symbol), factor);
    return out;
}

/**
 * Resolves the factor for a spec's canonical unit.
 *
 * @param spec The numeric spec.
 * @returns The number of storage units the canonical unit represents.
 * @throws If the canonical unit is missing from the spec's own table, which would otherwise scale every value by
 *   `undefined` and make the whole axis match nothing.
 */
function canonicalFactor(spec: NumericSpec): number {
    const factor: number | undefined = spec.units[spec.unit];
    if (factor === undefined) {
        throw new Error(
            `numeric type declares canonical unit "${spec.unit}", absent from its own units table`);
    }
    return factor;
}

/**
 * Builds the parser for one numeric type.
 *
 * @param spec The numeric spec.
 * @returns A function converting query text to a stored value, or `null` when the text is not a number of this type.
 *
 * `null` covers both "not numeric" and "carries a unit this type does not have". Both are the same answer to the
 * caller, which tries the property's next notation and produces a diagnostic only once every notation has refused.
 */
export function parseNumber(spec: NumericSpec): (text: string) => number | null {
    const canonical = canonicalFactor(spec);
    const units = unitLookup(spec.units);
    const byName = new Map<string, number>();
    for (const [value, word] of Object.entries(spec.sentinels ?? {})) {
        byName.set(fold(word), Number(value));
    }

    return (text: string): number | null => {
        const folded = fold(text.trim());
        if (folded.length === 0) return null;

        const sentinel = byName.get(folded);
        if (sentinel !== undefined) return sentinel;

        // A unit may be written before the number as well as after it, so `x2` and `2x` are one factor. Only
        // rearranged when the leading run is a unit this type actually has, which leaves any other text to be
        // refused by the number pattern below.
        const first = UNIT_FIRST.exec(folded);
        const text2 = first && units.has(first[2]) ? `${first[1]}${first[3]}${first[2]}` : folded;

        const match = NUMBER.exec(text2);
        if (!match) return null;

        const signed = /^[+-]/.test(match[1]);
        if (spec.sign === "required" && !signed) return null;
        if (spec.sign === "refused" && signed) return null;

        const magnitude = Number(match[1]);
        if (!Number.isFinite(magnitude)) return null;

        const suffix = match[2];
        const factor = suffix === "" ? canonical : units.get(suffix);
        if (factor === undefined) return null;

        const scaled = magnitude * factor + (spec.offset ?? 0);
        return spec.storage === "int" ? Math.round(scaled) : scaled;
    };
}

/**
 * Builds the formatter for one numeric type.
 *
 * @param spec The numeric spec.
 * @returns A function converting a stored value to its canonical spelling.
 *
 * The canonical spelling is what a pill prints, so a value read off the screen can be typed back into a query.
 * `format(parse(s)) === s` holds for every `s` this function produced; other spellings such as `50` or `500ms` parse
 * but are not canonical.
 */
export function formatNumber(spec: NumericSpec): (value: number) => string {
    const factor = canonicalFactor(spec);

    return (value: number): string => {
        const word = spec.sentinels?.[value];
        if (word !== undefined) return word;

        const shown = Number(((value - (spec.offset ?? 0)) / factor).toFixed(PRECISION));
        // Zero takes a sign only where one is required, so that what `format` writes is always something `parse`
        // accepts. Elsewhere `+0%` would be noise.
        const plus = shown > 0 || (shown === 0 && spec.sign === "required");
        const sign = spec.signed && plus ? "+" : "";
        return spec.unitPosition === "before"
            ? `${sign}${spec.unit}${shown}`
            : `${sign}${shown}${spec.unit}`;
    };
}
