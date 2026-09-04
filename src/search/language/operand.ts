/**
 * @file Reading one operand: what a written value means once the head it binds to is known.
 *
 * The parser decides where a value starts and ends; this decides what it says. The two are separable because a head
 * resolves to exactly one of three things — a column, a kind, or a property — and each reads an operand its own way:
 * a property reads through its declared notations in order, a kind offers its properties the operand in declaration
 * order and falls back to counting its rows, a column dispatches across its kinds, and free text at the top level
 * reads everything as content. {@link ValueCtx} is that choice made once, so the parser walks segments without ever
 * asking what kind of axis it is walking them for.
 *
 * Nothing here knows about positions. A reader is handed the operand's text and returns an {@link Interp} — a value,
 * a refusal, or an emptiness — and the parser turns that into a clause with a span. Findings raised along the way go
 * into the {@link Pending} list the caller owns, because a diagnostic needs a clause index that does not exist yet.
 *
 * Refusals carry their own fix. An axis that cannot answer an operator offers the clause without the symbol; a
 * quoted quantity offers it without the quotes. Both are the quote law and the operator registry speaking, never a
 * message written by hand at the site.
 */
// The instance rather than the bare `t`, because several value-reading closures here take a parameter named `t`
// and would shadow the import.
import {i18n} from "../../i18n";
import type {ClausePart, Fix, ParsedOperand, PropRef, Severity, Sublanguage, ValueExpr} from "./ast";
import {anyOfExpr, COUNT_PROP, propOf} from "./ast";
import type {Column} from "../schema/columns";
import {GRAMMAR, PREFIX_OPERATORS} from "./grammar";
import type {Kind, ParsedValue, Prop} from "../schema/kinds";
import {flagWord, hintOf, parseValue, sentinelOf, wordOf} from "../schema/kinds";
import {spelledNotation, spellIn} from "../vocabulary/units";
import type {Operator} from "../vocabulary/operators";
import {ORDERING} from "../vocabulary/operators";
import {compilePattern, escapeRegExp} from "../text/patterns";
import type {Head} from "../schema/schema";
import {headWord, kindIn, kindsOf} from "../schema/schema";
import {fold, squash} from "../text/normalize";
import type {AxisType, Value} from "../vocabulary/value-types";
import {count as countType, path as pathType} from "../vocabulary/value-types";

/** How one position reads an operand. Implementations differ by what the head resolved to. */
export interface ValueCtx {
    /**
     * Whether the wildcard's word synonym reads as the wildcard here.
     *
     * True wherever a bound value is being read; false at the top level, where a bare word is plain search
     * content whatever it spells — quoting stays the escape for a bound value that IS the word.
     */
    readonly wordStar: boolean;

    operator(op: Operator, operand: string, opts: { readonly whole: string; readonly phrase?: boolean }): Interp;

    /** Reads `lo-hi`, or null when nothing in this position orders. */
    range(text: string): Interp | null;

    /** Reads a range whose bounds arrive already split, as in `(-50)-10`. */
    rangeParts(lo: string, hi: string): Interp | null;

    glob(pattern: string): Interp;

    /** `alone` is false inside alternation, where a kind word reads as content rather than as a kind test. */
    bare(word: string, alone: boolean): Interp;

    phrase(text: string): Interp;

    regex(pattern: string): Interp;

    star(): Interp;

    /**
     * Re-spells a value's bare alternatives in the notation the phrase names, where one of them names it.
     *
     * A unit written anywhere in a value is the default for the whole of it: `200|500ms` is two millisecond
     * readings, not one of each. The same rule a range's bounds follow, over alternatives instead of bounds.
     *
     * @param parts The alternatives, as written.
     * @returns The alternatives, bare ones respelled; the same list where none names a notation.
     */
    unify(parts: readonly string[]): readonly string[];
}

/** What an operand resolved to, before it is shaped into a clause or a scope term. */
export type Interp =
    | { readonly r: "content"; readonly value: ValueExpr }
    | { readonly r: "props"; readonly props: readonly PropRef[]; readonly value: ValueExpr }
    | { readonly r: "count"; readonly value: ValueExpr }
    | { readonly r: "kindWord"; readonly kind: Kind }
    | { readonly r: "exists" }
    | { readonly r: "empty"; readonly why: string }
    | {
    readonly r: "fail";
    readonly message: string;
    /** A symbol whose removal is the offered fix. */
    readonly fixDrop?: string;
    /** Offer removing the quotes as the fix. */
    readonly fixQuotes?: true;
    /** Corrections already spelled out as whole queries, where the refusal knows the reading it would take. */
    readonly fixes?: readonly Fix[];
    /** The sublanguage at fault, where it is not the query language. */
    readonly about?: Sublanguage;
    /**
     * A further keystroke could still change the verdict — the value did not parse, but more characters might
     * complete a word that does. Such a failure is held quietly while typing and reported only in final text,
     * where declined operators and structural impossibilities stay errors in both modes.
     */
    readonly rescuable?: true;
};

/** A finding collected while a clause is still being interpreted, attached once its index exists. */
export interface Pending {
    readonly severity: Severity;
    readonly message: string;
    readonly fixes?: readonly Fix[];
    readonly about?: Sublanguage;
    readonly at?: ClausePart;
}

/** The operators that require an order, by name — the ones whose refusal message says "no ordering". */
export const ORDERING_NAMES: ReadonlySet<string> = new Set(ORDERING.map((op) => op.name));

/** The comparisons written before a value, by name — the operators the count desugar answers. */
export const COMPARABLE: ReadonlySet<string> = new Set(PREFIX_OPERATORS.map((op) => op.name));

/**
 * The prefix operators the expression tree can shape.
 *
 * A prefix operator outside this set would be recognised by the scanner — the grammar derives its spellings from the
 * registry — pass every acceptance check, and then have no {@link ValueExpr} variant to become. Declaring one
 * therefore starts by extending the union; until then the declaration fails here, at import, where it was made.
 */
const EXPRESSIBLE_PREFIX: ReadonlySet<string> = new Set(["exact", "lt", "lte", "gt", "gte"]);
for (const op of PREFIX_OPERATORS) {
    if (!EXPRESSIBLE_PREFIX.has(op.name)) {
        throw new Error(`prefix operator "${op.name}" has no shape in the expression tree`);
    }
}

export const accepts = (type: AxisType, opName: string): boolean =>
    type.accepts.some((op) => op.name === opName);

/**
 * Whether a type's values are quantities rather than strings.
 *
 * The quote rule turns on this: a phrase is a literal string value, and a quantity has no string reading, so a
 * quoted number is refused where a quoted word is read. Decided from the declarations — a type measuring in
 * notations, or edited as a bare number, holds quantities; everything read from words or text does not.
 */
export const quantity = (type: AxisType): boolean => type.quantity === true;

/**
 * A range's bounds re-spelled so both read in the notation the PHRASE names, or null where none is named.
 *
 * A unit written anywhere in the range is the default for the whole of it, even when it stands on the other
 * bound: `2-5ms` is two milliseconds to five. A bound that carries its own symbol is never reinterpreted, so
 * only the bare side is respelled; with both bare there is nothing to take, and a type's own pair reader
 * classifies them together.
 *
 * @param type The type reading the range.
 * @param lo The lower bound, as written.
 * @param hi The upper bound, as written.
 * @returns Both bounds spelled in the phrase's notation, or null when neither bound spells one.
 */
function wornPair(type: AxisType, lo: string, hi: string): { lo: string; hi: string } | null {
    const [a, b] = wornParts(type, [lo, hi]);
    return a === lo && b === hi ? null : {lo: a, hi: b};
}

/**
 * Every part of one value respelled in the notation the value names, where exactly some of them name it.
 *
 * A part carrying its own symbol is never reinterpreted; a bare part has no notation of its own and takes the
 * one its neighbours spell. With none spelled — or all of them — there is nothing to carry across, and the
 * parts come back untouched.
 *
 * @param type The type reading them.
 * @param parts The bounds of a range, or the alternatives of a value, as written.
 * @returns The parts, bare ones respelled.
 */
export function wornParts(type: AxisType, parts: readonly string[]): readonly string[] {
    const notations = type.notations;
    if (notations === undefined) return parts;
    const storage = type.storage === "float" ? "float" : "int";
    const spelled = parts.map((part) => spelledNotation(notations, storage, part));
    const worn = spelled.find((notation) => notation !== null) ?? null;
    if (worn === null || spelled.every((notation) => notation !== null)) return parts;
    return parts.map((part, at) => (spelled[at] === null ? spellIn(worn, part) : part));
}

/**
 * Why a pattern will not compile, or null when it will.
 *
 * Validation goes through the evaluator's own compiler, so a pattern that validates always runs.
 *
 * @param pattern A regular expression's source, as written between the slashes.
 * @returns The engine's own complaint, or null.
 */
function patternProblem(pattern: string): string | null {
    const compiled = compilePattern(pattern);
    return typeof compiled === "string" ? compiled : null;
}

/**
 * The pattern's compile failure as an interpretation, or null when it compiles.
 *
 * Rescuable, because a pattern is broken on most keystrokes of the way to being written.
 */
export function badPattern(pattern: string): Interp | null {
    const problem = patternProblem(pattern);
    if (problem === null) return null;
    return {r: "fail", rescuable: true, about: "regex", message: i18n.t("diagnostics:pattern.invalid", {problem})};
}

/** Whether any of the types is the path type, whose glued names make patterns weak — the warning turns on this. */
export const pathTyped = (types: readonly AxisType[]): boolean => types.includes(pathType);

/** The content interpretation of a value expression, the shape plain search and column content share. */
export const content = (value: ValueExpr): Interp => ({r: "content", value});

/** The refusal for an operator an axis cannot answer, with the drop-the-symbol fix. */
export function declined(word: string, op: Operator): Interp {
    return {
        r: "fail",
        message: ORDERING_NAMES.has(op.name)
            ? i18n.t("diagnostics:axis.noOrdering", {word})
            : i18n.t("diagnostics:axis.cannotAnswer", {word, operator: op.symbol ?? op.name}),
        fixDrop: op.symbol ?? undefined,
    };
}

/** The refusal for an operand the axis cannot read; rescuable, because the next keystroke may finish a word. */
export function illTyped(word: string, prop: Prop): Interp {
    return {r: "fail", rescuable: true, message: i18n.t("diagnostics:axis.takes", {word, hint: hintOf(prop)})};
}

/** The refusal for a quoted quantity, with the drop-the-quotes fix. */
export function quotedQuantity(word: string, prop: Prop): Interp {
    return {
        r: "fail", rescuable: true, fixQuotes: true,
        message: i18n.t("diagnostics:axis.takesQuoted", {word, hint: hintOf(prop)}),
    };
}

/** A pattern on a file path is honest but weak, and the warning says why — once per clause. */
export function warnPathGlob(pend: Pending[]): void {
    const message = i18n.t("diagnostics:pattern.pathWeak");
    if (!pend.some((p) => p.message === message)) {
        pend.push({severity: "warning", about: "regex", at: "value", message});
    }
}

/**
 * Merges the interpretations of a value's alternatives into one.
 *
 * Alternatives must resolve the same way — all content, all one property family, all counts — because a single chip
 * carries one question. A failure in any alternative is the whole value's failure.
 */
export function combineAlternatives(parts: readonly Interp[]): Interp {
    const failed = parts.find((p) => p.r === "fail");
    if (failed !== undefined) return failed;
    const real = parts.filter((p) => p.r !== "empty");
    if (real.length === 0) return {r: "empty", why: i18n.t("diagnostics:why.noValue")};
    if (real.length === 1) return real[0];

    if (real.every((p) => p.r === "content")) {
        return {r: "content", value: anyOfExpr(real.map((p) => (p as { value: ValueExpr }).value))};
    }
    if (real.every((p) => p.r === "props")) {
        const props: PropRef[] = [];
        for (const p of real as ReadonlyArray<{ props: readonly PropRef[] }>) {
            for (const ref of p.props) {
                if (!props.some((have) => have.kind === ref.kind && have.prop === ref.prop)) props.push(ref);
            }
        }
        return {r: "props", props, value: anyOfExpr(real.map((p) => (p as { value: ValueExpr }).value))};
    }
    if (real.every((p) => p.r === "count")) {
        return {r: "count", value: anyOfExpr(real.map((p) => (p as { value: ValueExpr }).value))};
    }
    return {r: "fail", message: i18n.t("diagnostics:value.differentQuestions")};
}

export function ctxFor(head: Head, pend: Pending[]): ValueCtx {
    if (head.role === "column") return columnCtx(head.column, pend);
    if (head.role === "kind") return kindCtx(head.kind, true, pend);
    return propCtx([{kind: head.kind, prop: head.name}], headWord(head), pend);
}

/** An operand read against one property, or one word shared by several kinds' properties. */
export function propCtx(refs: readonly PropRef[], word: string, pend: Pending[]): ValueCtx {
    return typedCtx(propOf(refs[0]), word, pend, (value) => ({r: "props", props: refs, value}));
}

/** The count word: cardinality reads operands exactly as a numeric axis does. */
export function countCtx(pend: Pending[]): ValueCtx {
    return typedCtx(COUNT_PROP, GRAMMAR.countWord, pend, (value) => ({r: "count", value}));
}

/** The shared reader over a property's declared notations. */
export function typedCtx(prop: Prop, word: string, pend: Pending[], done: (value: ValueExpr) => Interp): ValueCtx {
    /** Whether the quoted text is one of the property's sentinel words, which are strings and stay reachable. */
    const isSentinel = (t: string): boolean => sentinelOf(prop, t) !== null;
    /** The string reading of a quoted operand: the first textual type answering `opName` that parses it. */
    const stringReading = (t: string, opName: string): ParsedValue | null => {
        for (const type of prop.types) {
            if (quantity(type) || !accepts(type, "contains") || !accepts(type, opName)) continue;
            const value = type.parse?.(t);
            if (value !== null && value !== undefined) return {type, value};
        }
        return null;
    };
    /** Whether anything this property reads is a string, which is the only thing quotes can select. */
    const worded = prop.types.some((type) => !quantity(type));

    /**
     * The quote law's refusal: a quoted operand that is neither a sentinel word nor readable as anything but a
     * quantity is refused, because a quantity has no string reading.
     *
     * Only where the axis HAS a string reading, though. Quotes say "read this as a string", so on an axis that
     * reads nothing but quantities they select no alternative and carry no information — refusing them there
     * would be refusing a value whose meaning is not in doubt. Where both readings exist the refusal stands and
     * is load-bearing: `kit:150` is an id and `kit:"150"` is a name.
     */
    const refusesQuote = (t: string): boolean => {
        if (isSentinel(t) || !worded) return false;
        const pv = parseValue(prop, t);
        return pv !== null ? quantity(pv.type) : prop.types.some(quantity);
    };
    // A substring match squashes punctuation away, so an operand made of nothing else has nothing left to
    // match on. It selects nought rather than everything (the matcher refuses it), and says so here rather
    // than leaving the reader with an empty answer and no reason: a PATTERN reads the text as written. Fired
    // for the quoted spelling too — `name:"\""` is the same dead ask said with an escape.
    const punctuationSignpost = (t: string): void => {
        if (t === "" || squash(t) !== "") return;
        pend.push({
            severity: "warning",
            at: "value",
            message: i18n.t("diagnostics:value.punctuationOnly"),
            fixes: [{
                label: i18n.t("diagnostics:fix.asPattern"),
                query: `${word}${GRAMMAR.bind}${GRAMMAR.regex}${escapeRegExp(t)}${GRAMMAR.regex}`,
            }],
        });
    };
    const bareValue = (t: string): Interp => {
        const pv = parseValue(prop, t);
        if (pv === null) return illTyped(word, prop);
        const op = accepts(pv.type, "contains") ? "contains" as const : "exact" as const;
        if (op === "contains") punctuationSignpost(t);
        return done({op, operand: {type: pv.type.name, value: pv.value, written: t}});
    };
    const openBound = (bound: string, op: "gte" | "lte"): Interp | null => {
        for (const type of prop.types) {
            if (!accepts(type, "range") || !accepts(type, op) || !type.parse) continue;
            const value = type.parse(bound);
            if (value !== null) return done({op, operand: {type: type.name, value, written: bound}});
        }
        return null;
    };
    const rangeParts = (lo: string, hi: string): Interp | null => {
        if (lo === GRAMMAR.wildcard && hi !== GRAMMAR.wildcard) return openBound(hi, "lte");
        if (hi === GRAMMAR.wildcard && lo !== GRAMMAR.wildcard) return openBound(lo, "gte");
        for (const type of prop.types) {
            if (!accepts(type, "range")) continue;
            // A unit written anywhere in the range is the phrase's default, so a bare bound beside a spelled
            // one takes it: `2-5ms` is two MILLISECONDS to five, where reading the bare bound alone made it two
            // seconds -- an inverted range nobody asked for, reported as nothing. Each bound is recorded as the
            // PHRASE spelled it rather than as it was typed, since the sibling's unit is the notation the bare
            // one chose and the one it has to wear to read back as itself.
            const worn = wornPair(type, lo, hi);
            const [loText, hiText] = [worn?.lo ?? lo, worn?.hi ?? hi];
            // Bounds written without units read together, in one notation — never half factor, half proportion.
            const pair = type.parsePair?.(lo, hi);
            if (pair !== null && pair !== undefined) {
                const both = sharedNotation(type, loText, hiText, pair);
                return done({
                    op: "range",
                    lo: {type: type.name, value: pair[0], written: both?.[0] ?? loText},
                    hi: {type: type.name, value: pair[1], written: both?.[1] ?? hiText},
                });
            }
            if (!type.parse) continue;
            const a = type.parse(loText);
            const b = type.parse(hiText);
            if (a !== null && b !== null) {
                return done({
                    op: "range",
                    lo: {type: type.name, value: a, written: loText},
                    hi: {type: type.name, value: b, written: hiText},
                });
            }
        }
        return null;
    };
    return {
        wordStar: true,
        operator: (op, operand, opts): Interp => {
            if (opts.phrase === true) {
                const read = stringReading(operand, op.name);
                if (read !== null) {
                    return done(opExpr(op.name,
                        {type: read.type.name, value: read.value, written: operand, verbatim: true}));
                }
                // A quoted operand is a string. Sentinel words are strings; a quantity is not, so an operator
                // applied to a quoted number is refused rather than read as the number it looks like.
                if (refusesQuote(operand)) return quotedQuantity(word, prop);
            }
            const pv = parseValue(prop, operand);
            if (pv === null) return illTyped(word, prop);
            if (!accepts(pv.type, op.name)) return declined(word, op);
            return done(opExpr(op.name, {type: pv.type.name, value: pv.value, written: operand}));
        },
        range: (t): Interp | null => {
            if (!prop.types.some((type) => accepts(type, "range"))) return null;
            if (t.endsWith(GRAMMAR.range) && t.length > 1) {
                const open = openBound(t.slice(0, -1), "gte");
                if (open !== null) {
                    // The trailing shorthand is the one open form whose reading is not on the page.
                    pend.push({
                        severity: "note",
                        message: i18n.t("diagnostics:value.trailingRange",
                            {written: t, bound: t.slice(0, -1), wildcard: GRAMMAR.wildcard}),
                    });
                    return open;
                }
            }
            for (let k = 1; k < t.length - 1; k++) {
                if (t[k] !== GRAMMAR.range) continue;
                const ranged = rangeParts(t.slice(0, k), t.slice(k + 1));
                if (ranged !== null) return ranged;
            }
            return null;
        },
        rangeParts,
        glob: (pattern): Interp => {
            const globbing = prop.types.find((type) => accepts(type, "glob"));
            if (globbing === undefined) {
                // Rescuable: `*-` is a keystroke away from the open range `*-10`, which is no pattern at all.
                return {r: "fail", rescuable: true, about: "regex", message: i18n.t("diagnostics:axis.noPatterns", {word})};
            }
            if (pathTyped([globbing])) warnPathGlob(pend);
            return done({op: "glob", operand: {text: pattern}});
        },
        bare: bareValue,
        regex: (pattern): Interp => {
            if (!prop.types.some((type) => accepts(type, "regex"))) {
                return {r: "fail", about: "regex", message: i18n.t("diagnostics:axis.noRegex", {word})};
            }
            return badPattern(pattern) ?? done({op: "regex", operand: {text: pattern}});
        },
        phrase: (t): Interp => {
            const read = stringReading(t, "contains");
            if (read !== null) {
                // Quotes are STRICT: the characters are matched as written, so quoted punctuation is exactly
                // how punctuation is searched and no signpost stands here.
                return done({
                    op: "contains",
                    operand: {type: read.type.name, value: read.value, written: t, verbatim: true},
                });
            }
            // A phrase is a string value. Word vocabularies — sentinels, roles, rungs — are strings, so
            // quoting one of their words is harmless; a quantity has no string reading, and refusing says
            // what the quotes did rather than silently reading the number they wrap.
            if (refusesQuote(t)) return quotedQuantity(word, prop);
            return bareValue(t);
        },
        star: (): Interp => done({op: "present"}),
        unify: (parts) => {
            // The one position that knows which type reads the value, so the one that can carry a
            // notation across it.
            for (const type of prop.types) {
                const worn = wornParts(type, parts);
                if (worn !== parts) return worn;
            }
            return parts;
        },
    };
}

export function opExpr(op: string, operand: ParsedOperand): ValueExpr {
    if (op === "exact") return {op: "exact", operand};
    if (op === "lt" || op === "lte" || op === "gt" || op === "gte") return {op, operand};
    // Unreachable: every prefix operator is checked against EXPRESSIBLE_PREFIX at import.
    throw new Error(`operator "${op}" has no expression shape`);
}

/**
 * A bare pair of bounds, spelled in the one notation that reads them as the pair reader did.
 *
 * The bounds of a bare range are classified TOGETHER, by the further of the two, so they cannot be spelled apart
 * afterwards: read one at a time, `10-90` is a factor beside a proportion. Rather than restating the rule that
 * classified them, this finds the notation that reproduces both values and hands back their spellings in it.
 *
 * @param type The type reading the range.
 * @param lo The lower bound, as the phrase spelled it.
 * @param hi The upper bound, as the phrase spelled it.
 * @param pair The values the pair reader produced.
 * @returns The two spellings, or null where either bound already wears a unit or no notation reproduces the pair.
 */
function sharedNotation(
    type: AxisType, lo: string, hi: string, pair: readonly [Value, Value],
): [string, string] | null {
    const notations = type.notations;
    const read = type.parse;
    if (notations === undefined || read === undefined) return null;
    const storage = type.storage === "float" ? "float" : "int";
    if (spelledNotation(notations, storage, lo) !== null || spelledNotation(notations, storage, hi) !== null) {
        return null;
    }
    for (const notation of notations) {
        if (notation.unit === "") continue;
        const [a, b] = [spellIn(notation, lo), spellIn(notation, hi)];
        if (read(a) === pair[0] && read(b) === pair[1]) return [a, b];
    }
    return null;
}

/**
 * An operand read against a kind: its properties claim it in declaration order — the subject first — and a
 * comparison no property claims falls back to counting the kind's rows, when the operand is a count and the
 * position allows one.
 */
export function kindCtx(kind: Kind, countFallback: boolean, pend: Pending[]): ValueCtx {
    const word = wordOf(kind);
    const refs = Object.keys(kind.props).map((prop): PropRef => ({kind, prop}));
    const subject = refs.length > 0 ? propOf(refs[0]) : COUNT_PROP;
    // A qualifier refines a row rather than naming a subject of its own, so a comparison written on the KIND's word
    // was never about it: `attach>2` asks how many models a spell attaches, not how big one of them is drawn. It
    // stays reachable by name, which is where a reader who meant it says so. Without this a kind's count meaning
    // would be taken by whichever qualifier happened to be declared first and happened to accept the operator.
    const comparable = refs.filter((ref) => propOf(ref).qualifier !== true);
    const countValue = (op: Operator, operand: string): Interp | null => {
        if (!countFallback || !COMPARABLE.has(op.name)) return null;
        const value = countType.parse?.(operand);
        if (value === null || value === undefined) return null;
        return {r: "count", value: opExpr(op.name, {type: countType.name, value, written: operand})};
    };
    return {
        wordStar: true,
        operator: (op, operand, opts): Interp => {
            let claimed = false;
            for (const ref of comparable) {
                const pv = parseValue(propOf(ref), operand);
                if (pv === null) continue;
                claimed = true;
                if (accepts(pv.type, op.name)) {
                    return propCtx([ref], word, pend).operator(op, operand, opts);
                }
            }
            // A quoted operand is a string, which the count question refuses like any quantity.
            const counted = opts.phrase === true ? null : countValue(op, operand);
            if (counted !== null) return counted;
            if (claimed) return declined(word, op);
            return illTyped(word, subject);
        },
        range: (t): Interp | null => {
            for (const ref of comparable) {
                const ranged = propCtx([ref], word, pend).range(t);
                if (ranged !== null) return ranged;
            }
            if (countFallback) return countCtx(pend).range(t);
            return null;
        },
        rangeParts: (lo, hi): Interp | null => {
            for (const ref of comparable) {
                const ranged = propCtx([ref], word, pend).rangeParts(lo, hi);
                if (ranged !== null) return ranged;
            }
            if (countFallback) return countCtx(pend).rangeParts(lo, hi);
            return null;
        },
        glob: (pattern): Interp => {
            const globbing = refs.filter((ref) => propOf(ref).types.some((type) => accepts(type, "glob")));
            if (globbing.length === 0) {
                return {r: "fail", rescuable: true, about: "regex", message: i18n.t("diagnostics:axis.noPatterns", {word})};
            }
            if (globbing.some((ref) => pathTyped(propOf(ref).types))) warnPathGlob(pend);
            return {r: "props", props: globbing, value: {op: "glob", operand: {text: pattern}}};
        },
        bare: (t): Interp => {
            // A flag stores no value, so no notation reads an operand into one: what selects the rows carrying it
            // is the property's own word, and that is what the matcher compares against too. Claimed before the
            // notations, since a word is never also a quantity.
            const flags = refs.filter((ref) => flagWord(ref.prop, propOf(ref), t));
            if (flags.length > 0) {
                return {r: "props", props: flags, value: {op: "contains", operand: {text: t}}};
            }
            const claimants = refs.filter((ref) => parseValue(propOf(ref), t) !== null);
            if (claimants.length === 0) return illTyped(word, subject);
            if (claimants.length === 1) {
                return propCtx(claimants, word, pend).bare(t, false);
            }
            // Several properties claim it. Where they all read it as one value of one type, the operand IS that
            // value — which is what lets a bare number carry its unit into every surface that writes it back.
            // Only a value they read differently stays raw text, since there is then nothing single to carry.
            const readings = claimants.map((ref) => parseValue(propOf(ref), t));
            const first = readings[0];
            if (first !== null && readings.every((pv) =>
                pv !== null && pv.type === first.type && pv.value === first.value)) {
                const op = accepts(first.type, "contains") ? "contains" as const : "exact" as const;
                return {
                    r: "props", props: claimants,
                    value: {op, operand: {type: first.type.name, value: first.value, written: t}},
                };
            }
            return {r: "props", props: claimants, value: {op: "contains", operand: {text: t}}};
        },
        regex: (pattern): Interp => {
            const takers = refs.filter((ref) => propOf(ref).types.some((type) => accepts(type, "regex")));
            if (takers.length === 0) {
                return {r: "fail", about: "regex", message: i18n.t("diagnostics:axis.noRegex", {word})};
            }
            return badPattern(pattern)
                ?? {r: "props", props: takers, value: {op: "regex", operand: {text: pattern}}};
        },
        phrase: (t): Interp => {
            const textual = refs.filter((ref) => propOf(ref).types.some((type) => {
                if (quantity(type) || !accepts(type, "contains")) return false;
                const value = type.parse?.(t);
                return value !== null && value !== undefined;
            }));
            // A single claimant reads through its own property, so a typed operand — a colour, say — is
            // carried as its value; several claimants share one text operand, and are all textual.
            if (textual.length === 1) return propCtx(textual, word, pend).phrase(t);
            if (textual.length > 0) {
                return {r: "props", props: textual, value: {op: "contains", operand: {text: t, verbatim: true}}};
            }
            // No textual property reads it, so the string falls to the word vocabularies: sentinels and
            // word-valued properties take a quoted word; a quantity refuses a quoted number.
            const wordy = refs.filter((ref) => {
                const prop = propOf(ref);
                if (sentinelOf(prop, t) !== null) return true;
                const pv = parseValue(prop, t);
                return pv !== null && !quantity(pv.type);
            });
            if (wordy.length > 0) return propCtx(wordy, word, pend).phrase(t);
            // Same rule one level up, and by this point it is already established: neither a textual property
            // nor a word vocabulary reads this operand, so the quotes select nothing. Where something can
            // still read it as a quantity, they are inert rather than an error.
            const readable = refs.filter((ref) => parseValue(propOf(ref), t) !== null);
            if (readable.length > 0) return propCtx(readable, word, pend).bare(t, false);
            const numeric = refs.some((ref) => parseValue(propOf(ref), t) !== null
                || propOf(ref).types.some(quantity));
            if (numeric) return quotedQuantity(word, subject);
            return illTyped(word, subject);
        },
        // Existence ON A KIND is the kind word: `model:{display:*}` says the row is a display row,
        // which is exactly what `model:{display}` says. Answering a bare existence dropped WHICH kind
        // was named, so the scope term fell back to content and `model:{display:any}` asked for any
        // model row at all -- 130,512 of them, where the ask names 955.
        star: (): Interp => ({r: "kindWord", kind}),
        // Nothing to carry: these positions dispatch over many properties, so no one notation is
        // the value's own.
        unify: (parts) => parts,
    };
}

/**
 * An operand read against a whole column.
 *
 * A comparison whose operand is a count is the count question — the desugar `model:>4` means `model:{count:>4}`,
 * whatever properties exist. Any other operator token is ordinary content, because spell and file names carry
 * operators of their own; the anchor `=` alone keeps its meaning on content. A lone word naming one of the
 * column's kinds tests the kind; a phrase never does, which is how content spelled like a kind word stays
 * reachable.
 */
export function columnCtx(column: Column, pend: Pending[]): ValueCtx {
    const kinds = kindsOf(column);
    return {
        wordStar: true,
        operator: (op, operand, opts): Interp => {
            // A quoted operand is a string, so it can neither be the count question nor carry a live wildcard.
            const value = opts.phrase !== true && COMPARABLE.has(op.name) ? countType.parse?.(operand) : null;
            if (value !== null && value !== undefined) {
                return {r: "count", value: opExpr(op.name, {type: countType.name, value, written: operand})};
            }
            if (op.name === "exact") {
                if (opts.phrase !== true && operand.includes(GRAMMAR.wildcard)) {
                    return {
                        r: "fail",
                        message: i18n.t("diagnostics:value.exactPattern"),
                        fixDrop: op.symbol ?? undefined
                    };
                }
                return content({op: "exact", operand: {text: operand}});
            }
            return content({op: "contains", operand: {text: opts.whole}});
        },
        range: (t): Interp | null => countCtx(pend).range(t),
        rangeParts: (lo, hi): Interp | null => countCtx(pend).rangeParts(lo, hi),
        glob: (pattern): Interp => {
            if (kinds.some((k) => Object.values(k.props).some((p) => pathTyped(p.types)))) {
                warnPathGlob(pend);
            }
            return content({op: "glob", operand: {text: pattern}});
        },
        bare: (t, alone): Interp => {
            if (alone) {
                const named = kindIn(column, fold(t));
                if (named !== undefined) return {r: "kindWord", kind: named};
            }
            return content({op: "contains", operand: {text: t}});
        },
        phrase: (t): Interp => content({op: "contains", operand: {text: t, verbatim: true}}),
        regex: (pattern): Interp => badPattern(pattern) ?? content({op: "regex", operand: {text: pattern}}),
        star: (): Interp => ({r: "exists"}),
        // Nothing to carry: these positions dispatch over many properties, so no one notation is
        // the value's own.
        unify: (parts) => parts,
    };
}

/**
 * A bare term at the top level: plain search.
 *
 * Operator characters are inert here — spell names carry lone operators as tokens, and there is no row set for a
 * count to measure — so everything except the lone wildcard and a pattern is content.
 */
export function topCtx(): ValueCtx {
    return {
        wordStar: false,
        operator: (op, operand, opts): Interp => content({op: "contains", operand: {text: opts.whole}}),
        range: (): Interp | null => null,
        rangeParts: (): Interp | null => null,
        glob: (pattern): Interp => content({op: "glob", operand: {text: pattern}}),
        bare: (t): Interp => content({op: "contains", operand: {text: t}}),
        phrase: (t): Interp => content({op: "contains", operand: {text: t, verbatim: true}}),
        // Unreachable by scanning — a slash in free text is data — and defensively literal if ever called.
        regex: (pattern): Interp => content({
            op: "contains",
            operand: {text: `${GRAMMAR.regex}${pattern}${GRAMMAR.regex}`},
        }),
        star: (): Interp => content({op: "present"}),
        // Nothing to carry: these positions dispatch over many properties, so no one notation is
        // the value's own.
        unify: (parts) => parts,
    };
}
