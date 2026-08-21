/**
 * @file Applying one operator to one stored value.
 *
 * This is the narrowest matching step in the system, and the name says which one: a VALUE is compared against an
 * operand. Deciding whether a ROW satisfies a clause, and whether a SPELL satisfies a query, is the kernel's work and
 * happens above this file.
 *
 * The rule set lives in {@link ./value-types!} as data: each type lists the operators it accepts. The
 * implementations live here. Keeping the two apart means the accepted-operator table can be read, validated and
 * rendered into help text without running any of these functions, and it is what lets a type decline an operator as a
 * declaration rather than as a missing method.
 *
 * Every function here is pure and synchronous.
 */
import {compilePattern} from "../text/patterns";
import {fold, squash} from "../text/normalize";
import type {Value} from "../vocabulary/value-types";
import {ordinalRank, ordinalSpellings, TYPES} from "../vocabulary/value-types";

/**
 * An operand as the kernel supplies it: one value, or several.
 *
 * Several means the two bounds of a range, or the alternatives of a group. Which one is decided by the operator, so
 * the shape does not have to distinguish them.
 */
export type Operand = Value | readonly Value[];

/**
 * Tests one stored value against one operand.
 *
 * The stored value and the operand are not always the same shape. A bitmask is stored as an integer and typed as the
 * name of a role; an ordinal is stored as a label and compared by its rank. Resolving that is this layer's job,
 * because it is the only layer that holds both the vocabulary and the data.
 *
 * @param stored The value carried by the row being tested.
 * @param operand The value from the query.
 * @returns Whether the row's value satisfies the operator.
 */
export type Match = (stored: Value, operand: Operand) => boolean;

const MATCHERS = new Map<string, Match>();

/**
 * Registers one implementation for each (operator, type) pair in the cross product.
 *
 * @param operators Abstract operator names.
 * @param types Type names the implementation is valid for.
 * @param run The implementation.
 */
function define(operators: readonly string[], types: readonly string[], run: Match): void {
    for (const operator of operators) {
        for (const type of types) MATCHERS.set(`${operator}:${type}`, run);
    }
}

/**
 * Looks up the implementation for one operator applied to one type.
 *
 * @param operator Abstract operator name.
 * @param type Type name.
 * @returns The implementation, or `undefined` when this pair has none.
 *
 * Composite types are matched by their shape rather than by name, so one declared after this module loads still
 * matches; everything else is a named registration.
 *
 * `undefined` means the pair is unimplemented, which is a defect rather than an answer. A type declining an operator
 * is expressed in its `accepts` list and is caught before evaluation; reaching this function with a pair that has no
 * implementation means the schema and this table disagree, and the caller must surface that rather than treat it as
 * "no match".
 */
export function matcher(operator: string, type: string): Match | undefined {
    const found = MATCHERS.get(`${operator}:${type}`);
    if (found !== undefined) return found;
    if (TYPES.get(type)?.ui === "fields") {
        if (operator === "exact") return compositeExact;
        if (operator === "present") return compositePresent;
    }
    return undefined;
}

/** Every (operator, type) pair with an implementation, sorted. */
export function coverage(): string[] {
    return [...MATCHERS.keys()].toSorted();
}

/* -------------------------------------------------------------------------- text */

/** Types whose stored value and operand are both free text. */
const TEXTUAL = ["text", "path", "enum"];

/**
 * The types whose bare reading is a substring test over stored text — the family for which a longer operand asks a
 * narrower question, which is what simplification's subsumption reasoning turns on. Declared here, beside the
 * matcher registrations that make it true.
 *
 * An ordinal is NOT one of them, though it reads as a word: every one of its operators ranks against the ladder,
 * so a longer operand asks a DIFFERENT question rather than a narrower one, and `sl` and `shadowlands` name one
 * rung while containing nothing of each other.
 */
export const SUBSTRING_TYPES: readonly string[] = Object.freeze([...TEXTUAL]);

/**
 * Reads an operand as text.
 *
 * @param value A single operand, or a range's bounds.
 * @returns The text, or `null` for a range, which no textual operator accepts.
 *
 * `null` rather than the empty string, because an empty string is not a refusal: `contains` matches every value
 * against it, so a range reaching a textual operator would silently select everything instead of nothing.
 */
const asText = (value: Operand): string | null => (Array.isArray(value) ? null : String(value));

/**
 * Compiles a glob pattern to a regular expression anchored at both ends.
 *
 * `*` is the only metacharacter; everything else is escaped, including the punctuation asset paths are full of.
 *
 * @param pattern A glob, already normalised.
 * @returns A regular expression matching the whole string.
 */
function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .split("*")
        // Each literal run is normalised on its own, so the star survives. Normalising the whole pattern first
        // would strip it along with the punctuation and turn a pattern into a plain string.
        .map((part) => squash(part).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
        .join(".*");
    return new RegExp(`^${source}$`);
}

// `exact` folds only, so `Fire Ball` and `Fireball` stay distinct: a reader who anchors a match is asking for the
// whole value as written. `contains` and `glob` squash, so punctuation a reader may not remember does not have to be
// reproduced.
// A DOOR is never matched against a spell: it types what a directive takes, and a directive selects nothing. The
// implementation exists because the coverage guard is right to insist every accepted operator has one -- a type
// whose operator silently answered nothing would be indistinguishable from a bug -- and comparing two door words
// is what `exact` means here.
define(["exact"], ["door"], (stored, operand) =>
    typeof operand !== "object" && fold(String(stored)) === fold(String(operand)));

define(["exact"], TEXTUAL, (stored, operand) => {
    const wanted = asText(operand);
    return wanted !== null && fold(String(stored)) === fold(wanted);
});
// An operand with nothing left after squashing selects NOTHING, not everything. `includes("")` is true of every
// stored value, so `name:"---"` and `name:\"` answered the whole pack — the same hazard `asText` refuses a range
// for, one step further in: punctuation is what squashing removes, so an operand made only of it has nothing to
// match on. A pattern is how punctuation is searched, and it reads the stored text as written.
define(["contains"], TEXTUAL, (stored, operand) => {
    const wanted = asText(operand);
    if (wanted === null) return false;
    const held = squash(wanted);
    return held !== "" && squash(String(stored)).includes(held);
});
define(["glob"], TEXTUAL, (stored, operand) => {
    const wanted = asText(operand);
    return wanted !== null && globToRegExp(wanted).test(squash(String(stored)));
});

/**
 * The strict reading a QUOTED operand gets: its characters matched as written, with case and typography still
 * folded and punctuation kept. The quote law says a quoted value is a STRING, and the squash that forgives
 * punctuation on a bare spelling would forgive exactly what the reader deliberately typed — `name:"-a"` means
 * the dash, and `name:"\""` is how a literal quote is searched. Dispatched by the operand's own `verbatim`
 * mark rather than registered by type, because quotedness is a fact about the operand, not about the axis.
 */
export const verbatimContains: Match = (stored, operand) => {
    const wanted = asText(operand);
    return wanted !== null && wanted !== "" && fold(String(stored)).includes(fold(wanted));
};
define(["present"], TEXTUAL, (stored) => String(stored).length > 0);

// A regex runs against the stored text as written — no folding, no squashing — because character-level control is
// what a reader reaches for one to get. Case-insensitivity comes from the flag, not from folding.
define(["regex"], ["text", "path"], (stored, operand) => {
    const wanted = asText(operand);
    if (wanted === null) return false;
    const pattern = compilePattern(wanted);
    return typeof pattern !== "string" && pattern.test(String(stored));
});

/* ----------------------------------------------------------------------- numbers */

/**
 * Types whose stored value and operand are both numeric.
 *
 * Read off the declarations rather than listed here. A quantity is something a type SAYS it is, and a hand list is a
 * second copy of that rule: it goes stale the day a type is declared, and stale here means an operator the type
 * accepts has no implementation to answer it. Identities are quantities too — what keeps them from being compared
 * for order is the operator table, which never offers them one.
 */
const NUMERIC = [...TYPES.values()].filter((type) => type.quantity === true).map((type) => type.name);

/**
 * Reads an operand as a number.
 *
 * @param value A single operand, or a range's bounds.
 * @returns The number, or NaN for a range, which fails every single-operand comparison.
 */
const asNumber = (value: Operand): number => {
    if (Array.isArray(value)) return Number.NaN;
    return typeof value === "number" ? value : Number(value);
};

define(["exact"], NUMERIC, (stored, operand) => asNumber(stored) === asNumber(operand));
define(["lt"], NUMERIC, (stored, operand) => asNumber(stored) < asNumber(operand));
define(["lte"], NUMERIC, (stored, operand) => asNumber(stored) <= asNumber(operand));
define(["gt"], NUMERIC, (stored, operand) => asNumber(stored) > asNumber(operand));
define(["gte"], NUMERIC, (stored, operand) => asNumber(stored) >= asNumber(operand));
define(["present"], NUMERIC, () => true);

// Bounds are compared after sorting, so `90-10` selects the same values as `10-90`. The grammar cannot tell the two
// apart, and returning nothing for one of them would be a query that reads correctly and behaves otherwise.
define(["range"], NUMERIC, (stored, operand) => {
    if (!Array.isArray(operand) || operand.length !== 2) return false;
    const [low, high] = operand.map(asNumber);
    const value = asNumber(stored);
    return value >= Math.min(low, high) && value <= Math.max(low, high);
});

/* ----------------------------------------------------------------------- colours */

// A colour is stored packed as 0xRRGGBB and compared channel by channel, so that "near enough" is expressible.
// Exact equality over sixteen million values answers almost nothing on its own.

/** How far apart two colours may be, per channel, and still count as the same colour. */
/** How far each channel may stray, in either direction, for a bare colour operand to match a stored colour. */
export const COLOUR_TOLERANCE = 24;

const channels = (packed: number): [number, number, number] =>
    [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];

define(["exact"], ["colour"], (stored, operand) => asNumber(stored) === asNumber(operand));
define(["present"], ["colour"], () => true);
define(["contains"], ["colour"], (stored, operand) => {
    const [r1, g1, b1] = channels(asNumber(stored));
    const [r2, g2, b2] = channels(asNumber(operand));
    return Math.abs(r1 - r2) <= COLOUR_TOLERANCE
        && Math.abs(g1 - g2) <= COLOUR_TOLERANCE
        && Math.abs(b1 - b2) <= COLOUR_TOLERANCE;
});

/* ---------------------------------------------------------------------- bitmasks */

/**
 * A named role, expressed as a test over the bits a row carries.
 *
 * `any` matches when at least one of its bits is set; `all` matches only when every one is. Both are needed: a target
 * role spans two bits that mean the same thing from a reader's point of view, while "plays on caster and target
 * together" is a conjunction that no single bit spells.
 */
export interface BitTest {
    readonly any?: number;
    readonly all?: number;
}

/** The bits the build assigns to each role, and the roles a reader can name. */
const ROLE_BITS = {caster: 1, target: 2, area: 4, notCaster: 8, missileDest: 16} as const;

/** The bits each role name answers to: any of `any`, all of `all`. Exported so a second engine reads the one mapping. */
export const ROLES: Readonly<Record<string, BitTest>> = {
    caster: {any: ROLE_BITS.caster},
    target: {any: ROLE_BITS.target | ROLE_BITS.notCaster},
    area: {any: ROLE_BITS.area | ROLE_BITS.missileDest},
    others: {any: ROLE_BITS.notCaster},
    both: {all: ROLE_BITS.caster | ROLE_BITS.target},
};

/**
 * The bits in the order a surface writes a mask, each with the word that names it alone. A surface writes a mask as
 * the words of its set bits, so "caster, target" is a mask holding both; the words are the roles' where a role is one
 * bit, and name the bit plainly where the roles read it in combination.
 */
export const ROLE_WORDS: readonly {readonly bit: number; readonly word: string}[] = Object.freeze([
    {bit: ROLE_BITS.caster, word: "caster"},
    {bit: ROLE_BITS.target, word: "target"},
    {bit: ROLE_BITS.notCaster, word: "others"},
    {bit: ROLE_BITS.area, word: "area"},
    {bit: ROLE_BITS.missileDest, word: "landing"},
]);

/** The role names a query may use. */
export function roleNames(): string[] {
    return Object.keys(ROLES).toSorted();
}

/**
 * One past the largest mask the roles can tell apart: every subset of the declared role bits lies below it.
 *
 * A bit outside every role's test cannot change any role's answer, so exhausting the masks below this bound decides
 * any role-to-role question — which is how simplification proves one role implies another without a second copy of
 * the role table. Derived from the declarations, so a new role bit widens it by itself.
 */
export const ROLE_MASK_LIMIT: number = Object.values(ROLE_BITS).reduce((all, bit) => all | bit, 0) + 1;

const roleMatches = (mask: number, role: BitTest): boolean =>
    (role.any === undefined || (mask & role.any) !== 0)
    && (role.all === undefined || (mask & role.all) === role.all);

define(["exact"], ["bitmask"], (stored, operand) => {
    const wanted = asText(operand);
    const role: BitTest | undefined = wanted === null ? undefined : ROLES[fold(wanted)];
    return role !== undefined && roleMatches(asNumber(stored), role);
});
define(["present"], ["bitmask"], (stored) => asNumber(stored) !== 0);

/* ------------------------------------------------------------------------- flags */

// A flag stores no value: a row carries the property exactly when the flag is set, so reaching this test is the test.
define(["present"], ["flag"], () => true);

/* ---------------------------------------------------------------------- ordinals */

/**
 * Finds a value's rank on the loaded ladder, the vocabulary's own rule ({@link ordinalRank}) doing the reading.
 *
 * A stored value and an operand are ranked the same way on purpose: the pack stores whichever spelling it keys the
 * expansion by, the reader writes whichever they know, and the ladder is what says those are one rung.
 *
 * @param value A rung's name, or any spelling that reaches it.
 * @returns The rank, or -1 when no rung answers to it or the operand is not a single value.
 */
const rank = (value: Operand): number => {
    const written = asText(value);
    return written === null ? -1 : ordinalRank(written);
};

/**
 * Compares two rungs, refusing rather than guessing when either is unknown.
 *
 * @param stored The row's rung.
 * @param operand The query's rung.
 * @param accept Decides the result from the sign of the comparison.
 * @returns Whether the comparison holds, and `false` when either rung is unknown to the ladder.
 */
function compareRungs(stored: Value, operand: Operand, accept: (order: number) => boolean): boolean {
    const a = rank(stored);
    const b = rank(operand);
    return a >= 0 && b >= 0 && accept(a - b);
}

define(["exact"], ["ordinal"], (stored, operand) => compareRungs(stored, operand, (o) => o === 0));
define(["lt"], ["ordinal"], (stored, operand) => compareRungs(stored, operand, (o) => o < 0));
define(["lte"], ["ordinal"], (stored, operand) => compareRungs(stored, operand, (o) => o <= 0));
define(["gt"], ["ordinal"], (stored, operand) => compareRungs(stored, operand, (o) => o > 0));
define(["gte"], ["ordinal"], (stored, operand) => compareRungs(stored, operand, (o) => o >= 0));
// A rung is NAMED, so there is no substring reading of it: `sl` and `shadowlands` are two names for one rung and
// neither contains the other, while `wo` contains nothing anybody meant. Both operators rank instead, which is
// what makes the bare spelling a reader types agree with the name the ladder gives back.
define(["contains"], ["ordinal"], (stored, operand) => compareRungs(stored, operand, (o) => o === 0));
define(["glob"], ["ordinal"], (stored, operand) => {
    const wanted = asText(operand);
    if (wanted === null) return false;
    const at = rank(stored);
    // The pattern is matched against every spelling the rung answers to, so `xpac:sh*` finds Shadowlands
    // through the key even though the ladder names it SL.
    return at >= 0 && ordinalSpellings(at).some((name) => globToRegExp(wanted).test(squash(name)));
});
define(["present"], ["ordinal"], (stored) => String(stored).length > 0);

define(["range"], ["ordinal"], (stored, operand) => {
    if (!Array.isArray(operand) || operand.length !== 2) return false;
    const [low, high] = operand.map(rank);
    const value = rank(stored);
    return value >= 0 && low >= 0 && high >= 0
        && value >= Math.min(low, high) && value <= Math.max(low, high);
});

/* ---------------------------------------------------------------------- anyOf */

/**
 * Reads an operand as a list of alternatives.
 *
 * @param value One value, or several.
 * @returns The alternatives, with a single value read as a list of one.
 */
const alternatives = (value: Operand): readonly Value[] =>
    // Narrowed on the scalar side: `Array.isArray` does not narrow a readonly array, so testing for one leaves the
    // other branch no better typed than it started.
    (typeof value === "string" || typeof value === "number") ? [value] : value;

/**
 * Registers alternation for a family, as a disjunction over the reading a bare token already has there.
 *
 * `(fire|frost)` therefore selects what `fire` and `frost` each select, which is what makes a group of alternatives
 * mean the same as writing the alternatives separately.
 *
 * @param types Type names the implementation is valid for.
 * @param operator The operator whose reading each alternative gets.
 */
function defineAnyOf(types: readonly string[], operator: string): void {
    define(["anyOf"], types, (stored, operand) => {
        const one = matcher(operator, types[0]);
        return one !== undefined && alternatives(operand).some((value) => one(stored, value));
    });
}

// A bare token is a substring match on anything textual and an equality test everywhere else, so alternation follows
// the same split rather than inventing a third reading.
defineAnyOf(TEXTUAL, "contains");
defineAnyOf(["ordinal"], "contains");
defineAnyOf(["colour"], "contains");
defineAnyOf(NUMERIC, "exact");
defineAnyOf(["bitmask"], "exact");

/* -------------------------------------------------------------------- composites */

/**
 * A composite is compared member by member, and a query may constrain fewer members than the value has.
 *
 * A blank component in the QUERY is one it does not ask about, which is the useful case: a point is normally asked
 * about one axis at a time. A blank component in the STORED value is one the row does not have, and it matches
 * nothing — otherwise an absent component would compare equal to a queried zero.
 *
 * Named functions rather than registrations, because the set of composite types is open: {@link matcher} resolves
 * them by the type's shape, so a composite declared at any time is matched without an entry here.
 */
const compositeExact: Match = (stored, operand) => {
    const wanted = asText(operand);
    if (wanted === null) return false;
    const want = wanted.split(",");
    const have = String(stored).split(",");
    return want.every((part, i) => {
        if (part.trim() === "") return true;
        const mine = have[i];
        return mine !== undefined && mine.trim() !== "" && Number(part) === Number(mine);
    });
};
const compositePresent: Match = (stored) => String(stored).length > 0;
