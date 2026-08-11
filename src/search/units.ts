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
    readonly sentinels?: Sentinels;
}

/**
 * Decimal places kept when a stored value is divided into its display unit.
 *
 * Enough to preserve any value this data holds, and few enough to absorb binary representation error: a float column
 * can hold 1.2000000000000002, which is noise rather than precision.
 */
const PRECISION = 6;

/** A signed decimal, with no exponent and no internal space. */
const NUMBER = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/;

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

        const match = NUMBER.exec(folded);
        if (!match) return null;

        const magnitude = Number(match[1]);
        if (!Number.isFinite(magnitude)) return null;

        const suffix = match[2];
        const factor = suffix === "" ? canonical : units.get(suffix);
        if (factor === undefined) return null;

        const scaled = magnitude * factor;
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

        const shown = Number((value / factor).toFixed(PRECISION));
        const sign = spec.signed && shown > 0 ? "+" : "";
        return `${sign}${shown}${spec.unit}`;
    };
}
