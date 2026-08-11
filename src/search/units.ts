/* SEARCH 2.0 — L2 vocabulary. UNITS, SENTINELS, AND THE NUMBER GRAMMAR.
 *
 * Everything about turning `1.5s`, `500ms`, `+30%` or `unlimited` into the
 * number the pack stores, and back again. `types.ts` is the only caller: the
 * numeric family is six types built from one factory, and this is that
 * factory's arithmetic.
 *
 * ⚠ THIS FILE MUST COME BEFORE `types.ts`, NOT AFTER IT. PLAN §8 lists it
 * third of six and `types.ts` second — but `numeric()` calls `parseNumber` and
 * takes a `UnitTable`, so in the written order step 2 cannot compile. Same
 * class of ordering slip as operators-before-types, which was caught earlier.
 *
 * ⭐ THREE RULES DECIDE EVERYTHING HERE, and each was a measurement:
 *
 *   1. A UNIT CONVERTS, IT DOES NOT ANNOTATE (TYPES §5.1). `casttime:500ms`
 *      is half a second and `casttime:500` is five hundred seconds. Earned:
 *      9.2.7 has 31 sub-second cast times, so a unit that only labelled would
 *      make them unaskable.
 *   2. THE QUERY CONVERTS DOWN INTO STORAGE; THE PACK IS NEVER CONVERTED UP
 *      (TYPES §5.4). Cast times are whole milliseconds in the pack and whole
 *      milliseconds here — `=` on a float that is not exact in binary is a
 *      silent wrong answer, so the comparison happens in integers.
 *   3. A SENTINEL IS CLASSIFIED BEFORE IT IS SCALED (TYPES §5.4). −1 means
 *      "unlimited", not "minus one millisecond", so it is recognised first at
 *      both ends: `format` returns the word before dividing, and `parse`
 *      matches the word before reading digits.
 *
 * ⛔ ONLY `seconds` ACTUALLY CONVERTS (TYPES §5.0, the user's call). Yards
 * never become metres — yards are WoW's native unit and no Epsilon roleplayer
 * has asked for an 18-metre range. Percent, scale, angle and rate each have
 * one canonical unit that is displayed and accepted and never converted. The
 * machinery is general because `SpellCooldowns` and durations are queued and
 * are the same shape, not because six types need it.
 */
import {fold} from "./text";

/**
 * Unit symbol -> HOW MANY STORAGE UNITS ONE OF IT IS.
 *
 * ⭐ THE FACTOR IS INTO STORAGE, NOT INTO THE CANONICAL UNIT, and that is the
 * whole reason `parseNumber` is one multiplication. TYPES §5 sketches
 * `{s: 1, ms: 0.001, m: 60}` — factors relative to SECONDS — which then needs
 * a SECOND conversion into the pack's milliseconds, i.e. one fact written
 * twice with a unit boundary between them. Declared this way, `seconds` reads
 * `{s: 1000, ms: 1, m: 60000}` and says out loud that the pack stores ms.
 *
 * A PRETTIER SYMBOL IS JUST ANOTHER KEY (TYPES §5.1 rule 7): `deg` and `°`
 * both appear, both map to 1, and nothing has to know one is display-only.
 * Measured: zero spell names contain `×` or `°`.
 */
export type UnitTable = Readonly<Record<string, number>>;

/**
 * STORED VALUE -> the word that value means.
 *
 * Not a quantity at all: `SpellCastTimes.Base` bottoms out at −1,000,000 and
 * `CreatureModelData.CollisionHeight` at −20,000,000, and neither is a
 * duration or a height. A sentinel never enters a range, a bound or a domain.
 *
 * ⚠ IT IS REACHABLE BY ITS NAME AND NEVER BY ITS NUMBER, which falls out of
 * rule 2 rather than needing a rule: typing `channeled:-1` asks for −1
 * SECONDS, which scales to −1000 storage units and matches nothing. The
 * sentinel is −1 stored. So the two cannot be confused even where the digits
 * coincide.
 */
export type Sentinels = Readonly<Record<number, string>>;

/** What a numeric type needs in order to read and write its values. */
export interface NumericSpec {
    /** `int` rounds after scaling — the pack holds integers and `=` must be
     *  exact. `float` keeps what it is given. */
    readonly storage: "int" | "float";
    /** The unit a bare number means, and the one `format` prints. */
    readonly unit: string;
    readonly units: UnitTable;
    /** Print `+` on a positive value. For quantities where the SIGN is the
     *  information — a scale aura is +30% or −30% and the difference is the
     *  whole point. Display only: it never gates what parses. */
    readonly signed?: boolean;
    readonly sentinels?: Sentinels;
}

/**
 * Decimal places kept when a stored value is divided into its display unit.
 *
 * SIX, TO KILL BINARY ARTEFACTS RATHER THAN TO LIMIT PRECISION. 1234 ms / 1000
 * is 1.234 exactly, but a float column can hold 1.2000000000000002, and a pill
 * reading `1.2000000000000002yd` is noise pretending to be data. Rounding here
 * is what makes the round-trip property hold over the IMAGE of `format` — see
 * `formatNumber`.
 */
const PRECISION = 6;

/** A signed decimal and nothing else: no exponent (`e` would be a unit), no
 *  internal space (a value cannot contain one — a tag closes on whitespace). */
const NUMBER = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/;

/**
 * Unit symbols, folded once so `MS` and `ms` are one unit.
 *
 * No longest-match rule is needed and none exists: the number pattern captures
 * the WHOLE remainder as the suffix, so `500ms` looks up `ms` and never `m`.
 * Prefix ambiguity is a problem for a scanner that stops early, and this one
 * cannot.
 */
function unitLookup(units: UnitTable): Map<string, number> {
    const out = new Map<string, number>();
    for (const [symbol, factor] of Object.entries(units)) out.set(fold(symbol), factor);
    return out;
}

/**
 * The factor for the canonical unit, or a loud failure.
 *
 * A type whose `unit` is missing from its own `units` would otherwise scale by
 * `undefined` and turn every value into NaN — a whole numeric axis silently
 * matching nothing. Registration-time, so it cannot reach a user.
 */
function canonicalFactor(spec: NumericSpec): number {
    const factor = spec.units[spec.unit];
    if (factor === undefined) {
        throw new Error(
            `numeric type declares canonical unit "${spec.unit}", absent from its own units table`);
    }
    return factor;
}

/**
 * Text -> the value the pack stores, or null when the text is not a number of
 * this type.
 *
 * ⚠ NULL IS "NOT MY SHAPE", NEVER "BAD INPUT" — it is the dispatch mechanism
 * a multi-notation property relies on (TYPES §7), so it must stay quiet. An
 * UNKNOWN UNIT therefore also returns null, and TYPES §5.1 rule 5 requires the
 * user to be told *"scale takes a percentage"* rather than nothing. That
 * sentence is not this function's to write: it is composed by the parser from
 * the axis's declared types and their hints, once no declared type has
 * accepted the operand (PHASE 3). Returning an error here instead would put a
 * diagnostic inside the dispatch path and make a legitimate fall-through look
 * like a failure.
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
        if (!folded) return null;

        /* RULE 3, the reading half: the word wins before any digit is read. */
        const sentinel = byName.get(folded);
        if (sentinel !== undefined) return sentinel;

        const match = NUMBER.exec(folded);
        if (!match) return null;

        const magnitude = Number(match[1]);
        if (!Number.isFinite(magnitude)) return null;

        const suffix = match[2];
        const factor = suffix === "" ? canonical : units.get(suffix);
        if (factor === undefined) return null;

        /* RULE 2: down into storage, and rounded there, because the pack holds
         * integers and 0.1 * 1000 is 100.00000000000001 in binary64. */
        const scaled = magnitude * factor;
        return spec.storage === "int" ? Math.round(scaled) : scaled;
    };
}

/**
 * The value the pack stores -> the string a pill prints and a query can be
 * written with.
 *
 * ⭐ THE INVARIANT IS `format(parse(s)) === s` FOR EVERY s THAT `format`
 * PRODUCED — the image of format, not every accepted spelling. `50%` and
 * `500ms` both parse and neither is canonical, which is the point: input is
 * lenient, output is one form, and *"read the pill, type what you see"* (L12)
 * is a statement about the pill.
 */
export function formatNumber(spec: NumericSpec): (value: number) => string {
    const factor = canonicalFactor(spec);

    return (value: number): string => {
        /* RULE 3, the writing half. Before the division, or −1 prints as
         * `-0.001s` and the word is lost. */
        const word = spec.sentinels?.[value];
        if (word !== undefined) return word;

        const shown = Number((value / factor).toFixed(PRECISION));
        const sign = spec.signed && shown > 0 ? "+" : "";
        return `${sign}${shown}${spec.unit}`;
    };
}
