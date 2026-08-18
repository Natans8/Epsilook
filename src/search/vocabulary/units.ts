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
import {fold} from "../text/normalize";
import {localeUnitWords, queryWordsGeneration} from "./locale-words";

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

    /**
     * The glyph a rich display surface draws for the symbol, where it differs — `×` for the factor's `x`.
     *
     * Display only: formatted queries write the symbol. Every glyph must read back, as one of {@link aliases} or
     * through typography folding, because everything displayed must be typeable.
     */
    readonly glyph?: string;

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
const UNIT_AFTER = /^([+-]?)(\d+(?:\.\d+)?|\.\d+)(.*)$/;

/** A sign, a symbol, then the number: `x2`, `-x1.5`. */
const UNIT_BEFORE = /^([+-]?)([^\d.]+)(\d+(?:\.\d+)?|\.\d+)$/;

/** {@link spellings} per notation, valid for one query-word table — readers run per candidate row, folding is not. */
const spellingCache = new WeakMap<Notation, { generation: number; spellings: string[] }>();

/**
 * Every spelling a notation answers to, folded.
 *
 * The active language's unit words join here, keyed by the symbol itself, so they read wherever the symbol does and
 * enter the same ambiguity checks — a locale word colliding with another notation's spelling refuses to parse
 * exactly as a declared alias would. Cached per notation until the language's table changes, because readers are
 * built once when a type is defined and the table arrives later.
 *
 * @param notation The notation.
 * @returns Its symbol, aliases and locale words, with the empty symbol dropped.
 */
function spellings(notation: Notation): string[] {
    const generation = queryWordsGeneration();
    const held = spellingCache.get(notation);
    if (held !== undefined && held.generation === generation) return held.spellings;
    const built = [notation.unit, ...(notation.aliases ?? []), ...localeUnitWords(notation.unit)]
        .filter((s) => s !== "").map(fold);
    spellingCache.set(notation, {generation, spellings: built});
    return built;
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
        } else if (!spellings(notation).includes(symbol)) {
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
 * Whether any two of the notations could both accept one operand, which would make that text mean two things.
 *
 * Checked when a numeric type is built, and again whenever the active language's unit words change: a locale word
 * enters {@link spellings} after the types exist, so a colliding one can only be caught by re-running this.
 *
 * @param notations The notations of one type.
 * @returns One line per colliding pair, or an empty array when every operand reads one way.
 */
export function notationProblems(notations: readonly Notation[]): string[] {
    const problems: string[] = [];
    for (let i = 0; i < notations.length; i++) {
        for (let j = i + 1; j < notations.length; j++) {
            if (overlap(notations[i], notations[j])) {
                problems.push("has two notations that would both accept one operand: "
                    + `"${notations[i].unit}" and "${notations[j].unit}"`);
            }
        }
    }
    return problems;
}

/**
 * Every notation of a spec, the display one first — the order dispatch tries them in.
 *
 * @param spec The numeric spec.
 * @returns Its notations.
 */
export function notationsOf(spec: NumericSpec): Notation[] {
    return [spec.display, ...(spec.accepts ?? [])];
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
    const all = notationsOf(spec);
    const problems = notationProblems(all);
    if (problems.length > 0) throw new Error(`numeric type ${problems[0]}`);

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
 * A notation with its per-number discriminators lifted, for reading a range's bounds as one notation: the
 * bare-number threshold opens, and a required sign becomes optional — `(-50)-10` means two changes, not a change
 * and a factor. A refused sign stays refused, because it is the notation's identity rather than a classifier.
 */
function relaxed(notation: Notation): Notation {
    const bare = typeof notation.bare === "object" ? "any" : notation.bare;
    const sign = notation.sign === "required" ? "optional" : notation.sign;
    return {...notation, bare, sign};
}

/**
 * Builds the pair reader for one numeric type: a range's two bounds read in ONE notation.
 *
 * A lone bare number is classified by its size, but a range's bounds must agree — `10-90` read independently would
 * be a factor and a proportion, an inverted nonsense range. So the bounds read together: a notation that accepts
 * both as declared wins outright, and where only the bare-number threshold splits them, the larger-magnitude bound
 * classifies the pair — the threshold classifies sizes, so the range's furthest point speaks for it. A bound that
 * carries its symbol is never reinterpreted: a written unit is what it says, and a pair no single notation can
 * read returns `null` for the caller to read bound by bound.
 *
 * @param spec The numeric spec.
 * @returns A function reading two bound texts to two stored values, or `null`.
 */
export function parseNumberPair(spec: NumericSpec): (lo: string, hi: string) => readonly [number, number] | null {
    const readers = notationsOf(spec).map((notation) => ({
        strict: readNotation(notation, spec.storage),
        lifted: readNotation(relaxed(notation), spec.storage),
    }));

    return (lo: string, hi: string): readonly [number, number] | null => {
        const l = fold(lo.trim());
        const h = fold(hi.trim());
        if (l === "" || h === "") return null;

        for (const read of readers) {
            const a = read.strict(l);
            const b = read.strict(h);
            if (a !== null && b !== null) return [a, b];
        }

        const larger = Math.abs(Number(l)) >= Math.abs(Number(h)) ? l : h;
        for (const read of readers) {
            const a = read.lifted(l);
            const b = read.lifted(h);
            if (a !== null && b !== null && read.strict(larger) !== null) return [a, b];
        }
        return null;
    };
}

/**
 * The notation whose SYMBOL a bound actually carries, or null where it carries none.
 *
 * Apart from {@link notationOf}, which answers which notation READ the text and so names the default for a bare
 * number. This asks the narrower question a range needs: did the reader spell a unit here, or leave it open?
 *
 * @param notations The type's notations.
 * @param storage Whether the type stores whole numbers.
 * @param text One bound, as written.
 * @returns The notation it wears, or null when the bound is bare.
 */
export function spelledNotation(
    notations: readonly Notation[], storage: "int" | "float", text: string,
): Notation | null {
    const folded = fold(text.trim());
    if (folded === "") return null;
    for (const notation of notations) {
        const worn = [notation.unit, ...notation.aliases ?? []].map((unit) => fold(unit)).some((unit) => unit !== ""
            && (notation.position === "before" ? folded.startsWith(unit) : folded.endsWith(unit)));
        if (worn && readNotation(notation, storage)(folded) !== null) return notation;
    }
    return null;
}

/**
 * Spells a bare bound in one notation, so it reads as the phrase's own.
 *
 * @param notation The notation to wear.
 * @param bare The bound, carrying no unit.
 * @returns The bound with the notation's symbol on its declared side.
 */
export function spellIn(notation: Notation, bare: string): string {
    return notation.position === "before" ? `${notation.unit}${bare}` : `${bare}${notation.unit}`;
}

/**
 * Writes a stored value in one notation, symbol included.
 *
 * @param notation The notation to write in.
 * @param value The stored value.
 * @param symbol What to write for the notation's symbol; the symbol itself by default. A display surface passes
 *   the notation's glyph to draw `×5` where the query writes `x5`.
 * @returns The spelling.
 */
export function writeNotation(notation: Notation, value: number, symbol: string = notation.unit): string {
    const {factor, offset, sign, position} = notation;
    const shown = Number(((value - (offset ?? 0)) / factor).toFixed(PRECISION));
    // A sign is written where the notation requires one, so that zero round-trips; where it is merely allowed,
    // only a negative carries its own.
    const plus = shown > 0 || (shown === 0 && sign === "required");
    const written = sign === "required" && plus ? `+${shown}` : String(shown);

    return position === "before" ? `${symbol}${written}` : `${written}${symbol}`;
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
    return (value: number): string => writeNotation(spec.display, value);
}

/**
 * The notation one written operand was read in, for a surface upholding the reader's own family.
 *
 * The same dispatch {@link parseNumber} runs, answering with the notation rather than the value: the first
 * notation to accept the text is the one the value arrived through. Takes the notation list rather than a spec so
 * a caller holding only a type's declared notations — display first, exactly this order — can ask.
 *
 * @param notations The notations, in dispatch order.
 * @param storage Whether the stored value is integral.
 * @param text The operand as typed.
 * @returns The notation that read it, or `null` when none did.
 */
export function notationOf(
    notations: readonly Notation[], storage: "int" | "float", text: string,
): Notation | null {
    const folded = fold(text.trim());
    if (folded.length === 0) return null;
    for (const notation of notations) {
        if (readNotation(notation, storage)(folded) !== null) return notation;
    }
    return null;
}
