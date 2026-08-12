/**
 * @file The parser's inverse: a parse back to one canonical query string.
 *
 * `parse` is lenient — parens read as scopes, number lists as alternation, open ranges as comparisons — and this
 * module is where all of that lenience converges to a single spelling. Formatting the parse of a canonical string
 * returns that string unchanged, which is the invariant the tests pin: `format ∘ parse` is idempotent.
 *
 * Only the evaluable query is representable. An incomplete or invalid clause carries no value to spell — its text
 * lives in the original input, which this module deliberately does not see — so what comes back is the query that
 * would run: the same subset the groups hold. That is what a chip bar commits, a URL carries and a JSON door would
 * echo.
 */
import {GRAMMAR, PREFIX_OPERATORS, spelling} from "./grammar";
import {doorOf, formatValue, sentinelOf, wordOf} from "./kinds";
import {exact, gt, gte, lt, lte} from "./operators";
import type {Ask, Clause, Parsed, PropRef, ScopeTerm, ValueExpr} from "./parse";
import {propOf} from "./parse";
import {escapeRegExp} from "./patterns";
import {TYPES} from "./value-types";
import type {Value} from "./value-types";

/** Characters that would change a bare value's reading, whatever its position or type. */
const NEEDS_PHRASE = new RegExp(`[\\s${escapeRegExp([
    GRAMMAR.phrase, GRAMMAR.scope.open, GRAMMAR.scope.close,
    GRAMMAR.group.open, GRAMMAR.group.close, GRAMMAR.or, GRAMMAR.wildcard, GRAMMAR.bind,
].join(""))}]`);

/** Leading characters that would open an operator, a pattern or a negation instead of text. */
const OPENS_STRUCTURE = new RegExp(`^[${escapeRegExp([...new Set([
    ...PREFIX_OPERATORS.map((op) => spelling(op)[0]), GRAMMAR.regex, GRAMMAR.negate,
])].join(""))}]`);

/** Digit shapes that could re-read as a number, a number list or a range rather than text. */
const NUMBER_SHAPED = new RegExp(String.raw`^\d[\d.${escapeRegExp(GRAMMAR.numberList + GRAMMAR.range)}]*$`);

/** Characters mid-value that force the quotes even on a number-shaped text: the list and range separators. */
const NUMBER_STRUCTURE = new RegExp(`[${escapeRegExp(GRAMMAR.numberList + GRAMMAR.range)}]`);

/**
 * How a written value re-reads, which decides how much quoting keeps it itself:
 *
 * - `quantity` values are meant to re-read as numbers, so quoting one would flip it to a refused string;
 * - `worded` values are strings with a word vocabulary, where even digits must stay quoted (`kit:"150"` is a name);
 * - `raw` content text re-reads leniently, so anything shaped like structure or a number list needs the quotes.
 */
type Reading = "quantity" | "worded" | "raw";

/** The reading of one operand: raw carried text, or the declared type's side of the quote law. */
function readingOf(operand: { text: string } | { type: string; value: Value }): Reading {
    if ("text" in operand) return "raw";
    return TYPES.get(operand.type)?.quantity === true ? "quantity" : "worded";
}

/**
 * Whether text is written as the display canonical or folded to lowercase for comparison.
 *
 * Case never distinguishes two queries — matching folds it — so {@link equivalent} compares the folded spelling
 * while {@link formatQuery} keeps the case a value was written or stored with. Regex operands are the one
 * exception: folding a pattern flips character classes (`\D` to `\d`), so patterns compare as written and rely on
 * their own case-insensitive matching.
 */
type Casing = "display" | "folded";

/**
 * Writes one operand: the text as carried, or the stored value in its property's spelling.
 *
 * @param operand The operand from a {@link ValueExpr}.
 * @param at The property the value belongs to, when the ask names one — it holds the sentinel words.
 * @param casing Whether the text is folded for comparison.
 * @returns The canonical text.
 */
function operandText(
    operand: { text: string } | { type: string; value: Value }, at?: PropRef, casing: Casing = "display",
): string {
    const text = "text" in operand ? operand.text
        : at !== undefined ? formatValue(propOf(at), operand.value)
            : TYPES.get(operand.type)?.format?.(operand.value) ?? String(operand.value);
    return casing === "folded" ? text.toLowerCase() : text;
}

/** The phrase spelling of a text, its own escape and quote characters escaped. */
function phrased(text: string): string {
    const body = text
        .replaceAll(GRAMMAR.escape, `${GRAMMAR.escape}${GRAMMAR.escape}`)
        .replaceAll(GRAMMAR.phrase, `${GRAMMAR.escape}${GRAMMAR.phrase}`);
    return `${GRAMMAR.phrase}${body}${GRAMMAR.phrase}`;
}

/**
 * Quotes a value whose bare spelling would re-read as something other than itself.
 *
 * The rule errs generous: a quoted string means the same string wherever a string is legal, so an extra phrase can
 * never change an ask — an omitted one can, which is what every branch here prevents.
 */
function bareOrPhrase(text: string, reading: Reading): string {
    if (text === "" || NEEDS_PHRASE.test(text)) return phrased(text);
    if (reading === "quantity") return text;
    if (OPENS_STRUCTURE.test(text)) return phrased(text);
    if (NUMBER_SHAPED.test(text) && (reading === "worded" || NUMBER_STRUCTURE.test(text))) return phrased(text);
    return text;
}

/** A range bound: parenthesised when a leading sign would read as the range separator. */
function bound(text: string): string {
    return text.startsWith(GRAMMAR.negate) ? `${GRAMMAR.group.open}${text}${GRAMMAR.group.close}` : text;
}

/** The ordered comparisons by their expression name, for reading each spelling from the registry. */
const COMPARISONS = {lt, lte, gt, gte} as const;

/**
 * Writes one value expression in its canonical spelling.
 *
 * @param value The expression.
 * @param at The property it binds, when known.
 * @param casing Whether text operands are folded for comparison.
 * @returns The canonical text of the value, including any operator symbol.
 */
function valueText(value: ValueExpr, at?: PropRef, casing: Casing = "display"): string {
    switch (value.op) {
        case "present":
            return GRAMMAR.wildcard;
        case "contains":
            return bareOrPhrase(operandText(value.operand, at, casing), readingOf(value.operand));
        case "glob":
            return operandText(value.operand, at, casing);
        case "regex": {
            // Never folded: lowering a pattern flips character classes, and matching is case-insensitive anyway.
            const pattern = operandText(value.operand, at)
                .replaceAll(GRAMMAR.regex, `${GRAMMAR.escape}${GRAMMAR.regex}`);
            return `${GRAMMAR.regex}${pattern}${GRAMMAR.regex}`;
        }
        case "exact": {
            const text = operandText(value.operand, at, casing);
            // A bare sentinel word already means the exact ask, so the anchor adds nothing to it.
            if (at !== undefined && sentinelOf(propOf(at), text) !== null) return text;
            return `${spelling(exact)}${bareOrPhrase(text, readingOf(value.operand))}`;
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte":
            return `${spelling(COMPARISONS[value.op])}${operandText(value.operand, at, casing)}`;
        case "range":
            return `${bound(operandText(value.lo, at, casing))}${GRAMMAR.range}${operandText(value.hi, at, casing)}`;
        case "anyOf":
            // Grouped: at a bind, a glued phrase alternative would otherwise split at its own quote.
            return `${GRAMMAR.group.open}${value.alternatives.map((alt) => valueText(alt, at, casing)).join(GRAMMAR.or)}${GRAMMAR.group.close}`;
    }
    // The switch is exhaustive, narrowing `value` to never: a new variant fails to compile here until it has a
    // spelling, which is the only thing keeping this module the parser's inverse.
    return value;
}

/**
 * A scope term's content value. Alternation glues — `fire|frost` — because a term never reads a parenthesised
 * group; the grouped spelling belongs to bind values, where {@link valueText} writes it.
 */
function termValueText(value: ValueExpr, casing: Casing): string {
    if (value.op === "anyOf") {
        return value.alternatives.map((alt) => valueText(alt, undefined, casing)).join(GRAMMAR.or);
    }
    return valueText(value, undefined, casing);
}

/** The word a scope term is written with, or null for a term with nothing evaluable to write. */
function termText(term: ScopeTerm, casing: Casing): string | null {
    if (term.state !== "ok" || term.ask === null) return null;
    const negate = term.not ? GRAMMAR.negate : "";
    const ask = term.ask;
    if (ask.on === "content") return `${negate}${termValueText(ask.value, casing)}`;
    if (ask.on === "kindWord") return `${negate}${wordOf(ask.kind)}`;
    if (ask.on === "count") return `${negate}${GRAMMAR.countWord}${GRAMMAR.bind}${valueText(ask.value, undefined, casing)}`;
    const ref = ask.props[0];
    return `${negate}${ref.prop}${GRAMMAR.bind}${valueText(ask.value, ref, casing)}`;
}

/**
 * Writes one clause, or null when the clause holds nothing evaluable.
 *
 * @param clause The clause.
 * @param casing Whether text operands are folded for comparison.
 * @returns Its canonical text.
 */
function clauseText(clause: Clause, casing: Casing): string | null {
    if (clause.state !== "ok" || clause.ask === null) return null;
    const negate = clause.not ? GRAMMAR.negate : "";
    const body = askText(clause.ask, casing);
    return body === null ? null : `${negate}${body}`;
}

function askText(ask: Ask, casing: Casing): string | null {
    if (ask.on === "plain") return valueText(ask.value, undefined, casing);
    if (ask.on === "prop") {
        const door = doorOf(ask.ref.prop, propOf(ask.ref));
        return ask.value === null ? null : `${door}${GRAMMAR.bind}${valueText(ask.value, ask.ref, casing)}`;
    }

    const head = ask.on === "column" ? ask.column.key : wordOf(ask.kind);
    const test = ask.test;
    if (test === null) return null;
    if (test.is === "exists") return `${head}${GRAMMAR.bind}${GRAMMAR.wildcard}`;
    if (test.is === "content") return `${head}${GRAMMAR.bind}${valueText(test.value, undefined, casing)}`;
    if (test.is === "props") {
        const ref = test.props[0];
        // The value re-reads through the head's own dispatch, so the property name needs no spelling here.
        return `${head}${GRAMMAR.bind}${valueText(test.value, ref, casing)}`;
    }

    const runs = test.terms
        .map((run) => run
            .map((term) => ({term, text: termText(term, casing)}))
            .filter((pair): pair is { term: ScopeTerm; text: string } => pair.text !== null))
        .filter((run) => run.length > 0);
    const flat = runs.flat();
    if (flat.length === 0) return `${head}${GRAMMAR.bind}${GRAMMAR.wildcard}`;
    // A single positive term needs no brace — a scope of one clause is that clause — except a bind, whose word
    // means something different (or nothing) outside its scope.
    if (flat.length === 1) {
        const {term, text} = flat[0];
        if (!term.not && (term.ask?.on === "content" || term.ask?.on === "kindWord")) {
            return `${head}${GRAMMAR.bind}${text}`;
        }
    }
    const body = runs.map((run) => run.map((pair) => pair.text).join(" ")).join(` ${GRAMMAR.or} `);
    return `${head}${GRAMMAR.bind}${GRAMMAR.scope.open}${body}${GRAMMAR.scope.close}`;
}

/**
 * Writes a parse back as one canonical query string.
 *
 * @param parsed A parse, from {@link ./parse!parse}.
 * @returns The canonical text of its evaluable query — incomplete and invalid clauses are not part of it.
 */
export function formatQuery(parsed: Parsed): string {
    return clauseTexts(parsed, "display").map((group) => group.join(" ")).join(` ${GRAMMAR.or} `);
}

/** Every evaluable clause's canonical text, grouped as the parse groups them; empty groups are dropped. */
function clauseTexts(parsed: Parsed, casing: Casing): string[][] {
    return parsed.groups
        .map((group) => group
            .map((index) => clauseText(parsed.clauses[index], casing))
            .filter((text): text is string => text !== null))
        .filter((group) => group.length > 0);
}

/**
 * One string per parse that two equivalent queries share.
 *
 * Every clause reduces to its canonical spelling — the same convergence {@link formatQuery} performs, folded per
 * {@link Casing} because matching folds case too — so delimiter, notation and case differences vanish there. Clause
 * order never matters and neither does group order, so both sort; what remains is the multiset of canonical clauses
 * per alternation group.
 */
function normalised(parsed: Parsed): string {
    return clauseTexts(parsed, "folded")
        .map((group) => group.toSorted().join(" "))
        .toSorted()
        .join(` ${GRAMMAR.or} `);
}

/**
 * Whether two parses ask the same evaluable question.
 *
 * Equivalence is up to everything the language says does not matter: clause order, group order, delimiter, notation
 * and letter-case spellings, and anything an incomplete or invalid clause failed to say. `model:{fire}` is
 * equivalent to `model:fire` and to `model:FIRE`; `model:fire model:missile` is not equivalent to
 * `model:{fire missile}` — two rows against one. Regex patterns are the one case-sensitive spelling, per
 * {@link Casing}.
 *
 * @param a One parse.
 * @param b Another.
 * @returns Whether their evaluable queries mean the same thing.
 */
export function equivalent(a: Parsed, b: Parsed): boolean {
    return normalised(a) === normalised(b);
}
