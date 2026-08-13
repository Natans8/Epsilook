/**
 * @file The parser's inverse: a parse back to one canonical query string.
 *
 * `parse` is lenient — parens read as scopes, number lists as alternation, open ranges as comparisons — and this
 * module is where all of that lenience converges to a single spelling. Formatting the parse of a canonical string
 * returns that string unchanged, which is the invariant the tests pin: `format ∘ parse` is idempotent. A second
 * tier, `written`, converges the structure while upholding each value's typed spelling — see {@link Spelling}.
 *
 * Only the evaluable query is representable. An incomplete or invalid clause carries no value to spell — its text
 * lives in the original input, which this module deliberately does not see — so what comes back is the query that
 * would run: the same subset the groups hold. That is what a chip bar commits, a URL carries and a JSON door would
 * echo.
 */
import {GRAMMAR, PREFIX_OPERATORS, spelling} from "./grammar";
import {doorOf, formatValue, sentinelOf, wordOf} from "../schema/kinds";
import {exact, gt, gte, lt, lte} from "../vocabulary/operators";
import type {Ask, Clause, Parsed, PropRef, ScopeTerm, ValueExpr} from "./ast";
import {propOf} from "./ast";
import {escapeRegExp} from "../text/patterns";
import {TYPES} from "../vocabulary/value-types";
import type {Value} from "../vocabulary/value-types";

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

/** Leading characters that spell a prefix operator, which every reader binds to its head without a colon. */
const OPENS_OPERATOR = new RegExp(`^[${escapeRegExp([...new Set(
    PREFIX_OPERATORS.map((op) => spelling(op)[0]),
)].join(""))}]`);

/**
 * Joins a head to its value: a prefix operator binds on its own, so the colon drops where one opens the value —
 * the convention comparison queries are written in, and the spelling the parser's implied colon reads back.
 */
function bindTo(head: string, text: string): string {
    return OPENS_OPERATOR.test(text) ? `${head}${text}` : `${head}${GRAMMAR.bind}${text}`;
}

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
 * How a value's text is spelled, which is what tells the module's three outputs apart:
 *
 * - `canonical` converges every value onto its one display spelling — the form a URL carries and two spellings of
 *   one question share. What {@link formatQuery} writes by default.
 * - `written` upholds the spelling the reader chose where the parse recorded one — `x1.5` stays `x1.5` rather than
 *   converging to `=+50%` — which is what a rendering surface echoes back. Structure still converges; only the
 *   value's own text is upheld.
 * - `folded` is the canonical spelling lowered for comparison, because case never distinguishes two queries —
 *   matching folds it. Regex operands are the one exception: folding a pattern flips character classes (`\D` to
 *   `\d`), so patterns compare as written and rely on their own case-insensitive matching.
 */
type Spelling = "canonical" | "written" | "folded";

/**
 * Writes one operand: the text as carried, or the stored value in its property's spelling.
 *
 * @param operand The operand from a {@link ValueExpr}.
 * @param at The property the value belongs to, when the ask names one — it holds the sentinel words.
 * @param tier The output tier, per {@link Spelling}.
 * @returns The operand's text in that tier.
 */
function operandText(
    operand: { text: string } | { type: string; value: Value; written?: string },
    at?: PropRef, tier: Spelling = "canonical",
): string {
    if ("text" in operand) return tier === "folded" ? operand.text.toLowerCase() : operand.text;
    if (tier === "written" && operand.written !== undefined) return operand.written;
    const text = at !== undefined ? formatValue(propOf(at), operand.value)
        : TYPES.get(operand.type)?.format?.(operand.value) ?? String(operand.value);
    return tier === "folded" ? text.toLowerCase() : text;
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
 * @param tier The output tier, per {@link Spelling}.
 * @returns The canonical text of the value, including any operator symbol.
 */
function valueText(value: ValueExpr, at?: PropRef, tier: Spelling = "canonical"): string {
    switch (value.op) {
        case "present":
            return GRAMMAR.wildcard;
        case "contains":
            return bareOrPhrase(operandText(value.operand, at, tier), readingOf(value.operand));
        case "glob":
            return operandText(value.operand, at, tier);
        case "regex": {
            // Never folded: lowering a pattern flips character classes, and matching is case-insensitive anyway.
            const pattern = operandText(value.operand, at)
                .replaceAll(GRAMMAR.regex, `${GRAMMAR.escape}${GRAMMAR.regex}`);
            return `${GRAMMAR.regex}${pattern}${GRAMMAR.regex}`;
        }
        case "exact": {
            const text = operandText(value.operand, at, tier);
            // A bare sentinel word already means the exact ask, so the anchor adds nothing to it.
            if (at !== undefined && sentinelOf(propOf(at), text) !== null) return text;
            return `${spelling(exact)}${bareOrPhrase(text, readingOf(value.operand))}`;
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte":
            return `${spelling(COMPARISONS[value.op])}${operandText(value.operand, at, tier)}`;
        case "range":
            return `${bound(operandText(value.lo, at, tier))}${GRAMMAR.range}${operandText(value.hi, at, tier)}`;
        case "anyOf":
            // Grouped: at a bind, a glued phrase alternative would otherwise split at its own quote.
            return `${GRAMMAR.group.open}${value.alternatives.map((alt) => valueText(alt, at, tier)).join(GRAMMAR.or)}${GRAMMAR.group.close}`;
    }
    // The switch is exhaustive, narrowing `value` to never: a new variant fails to compile here until it has a
    // spelling, which is the only thing keeping this module the parser's inverse.
    return value;
}

/**
 * A scope term's content value. Alternation glues — `fire|frost` — because a term never reads a parenthesised
 * group; the grouped spelling belongs to bind values, where {@link valueText} writes it.
 */
function termValueText(value: ValueExpr, tier: Spelling): string {
    if (value.op === "anyOf") {
        return value.alternatives.map((alt) => valueText(alt, undefined, tier)).join(GRAMMAR.or);
    }
    return valueText(value, undefined, tier);
}

/** The word a scope term is written with, or null for a term with nothing evaluable to write. */
function termText(term: ScopeTerm, tier: Spelling): string | null {
    if (term.state !== "ok" || term.ask === null) return null;
    const negate = term.not ? GRAMMAR.negate : "";
    const ask = term.ask;
    if (ask.on === "content") return `${negate}${termValueText(ask.value, tier)}`;
    if (ask.on === "kindWord") return `${negate}${wordOf(ask.kind)}`;
    if (ask.on === "count") return `${negate}${bindTo(GRAMMAR.countWord, valueText(ask.value, undefined, tier))}`;
    const ref = ask.props[0];
    return `${negate}${bindTo(ref.prop, valueText(ask.value, ref, tier))}`;
}

/**
 * Writes one clause, or null when the clause holds nothing evaluable.
 *
 * @param clause The clause.
 * @param tier The output tier, per {@link Spelling}.
 * @returns Its canonical text.
 */
function clauseText(clause: Clause, tier: Spelling): string | null {
    if (clause.state !== "ok" || clause.ask === null) return null;
    const negate = clause.not ? GRAMMAR.negate : "";
    const body = askText(clause.ask, tier);
    return body === null ? null : `${negate}${body}`;
}

/**
 * The lone positive term a scope's spelling promotes out of the braces, or null when the braces stay.
 *
 * A scope of one evaluable term is that term, so its spelling drops the braces — for a content or kind word, whose
 * text means the same on either side of them, and for a count whose value opens with an operator, where the
 * promoted spelling is the column-form desugar inverted and re-reads as this same scope. Every other bound word
 * stays braced: outside its scope it would mean something different, or nothing.
 *
 * Exported for the simplifier, whose unwrapping rewrites and round-trip guard must agree with the formatter on
 * exactly which scopes shed their braces — both read the decision here. The decision is tier-independent: which
 * characters open a value never depends on the value's own spelling.
 *
 * @param terms A scope test's runs.
 * @returns The term the spelling promotes, or null.
 */
export function unbracedTerm(terms: ReadonlyArray<readonly ScopeTerm[]>): ScopeTerm | null {
    const flat = terms.flat().filter((t) => t.state === "ok" && t.ask !== null);
    if (flat.length !== 1 || flat[0].not) return null;
    const [term] = flat;
    const ask = term.ask;
    if (ask === null) return null;
    if (ask.on === "content" || ask.on === "kindWord") return term;
    if (ask.on === "count" && OPENS_OPERATOR.test(valueText(ask.value))) return term;
    return null;
}

function askText(ask: Ask, tier: Spelling): string | null {
    if (ask.on === "plain") return valueText(ask.value, undefined, tier);
    if (ask.on === "prop") {
        const door = doorOf(ask.ref.prop, propOf(ask.ref));
        return ask.value === null ? null : bindTo(door, valueText(ask.value, ask.ref, tier));
    }

    const head = ask.on === "column" ? ask.column.key : wordOf(ask.kind);
    const test = ask.test;
    if (test === null) return null;
    // A kind with a word of its own spells bare existence through its column — `model:missile` over `missile:*` —
    // a spelling that re-reads even for a kind whose word opens no tag. A wordless kind IS its column's head.
    const exists = ask.on === "kind" && ask.kind.word !== undefined
        ? `${ask.kind.column.key}${GRAMMAR.bind}${ask.kind.word}`
        : `${head}${GRAMMAR.bind}${GRAMMAR.wildcard}`;
    if (test.is === "exists") return exists;
    if (test.is === "content") return bindTo(head, valueText(test.value, undefined, tier));
    if (test.is === "props") {
        const ref = test.props[0];
        // The value re-reads through the head's own dispatch, so the property name needs no spelling here.
        return bindTo(head, valueText(test.value, ref, tier));
    }

    const runs = test.terms
        .map((run) => run
            .map((term) => ({term, text: termText(term, tier)}))
            .filter((pair): pair is { term: ScopeTerm; text: string } => pair.text !== null))
        .filter((run) => run.length > 0);
    if (runs.length === 0) return exists;
    const lone = unbracedTerm(test.terms);
    if (lone !== null && lone.ask !== null) {
        if (lone.ask.on === "count") return `${head}${valueText(lone.ask.value, undefined, tier)}`;
        const text = termText(lone, tier);
        if (text !== null) return `${head}${GRAMMAR.bind}${text}`;
    }
    const body = runs.map((run) => run.map((pair) => pair.text).join(" ")).join(` ${GRAMMAR.or} `);
    return `${head}${GRAMMAR.bind}${GRAMMAR.scope.open}${body}${GRAMMAR.scope.close}`;
}

/**
 * Writes a parse back as one query string.
 *
 * Two spellings, per {@link Spelling}: `canonical` converges every value onto its display notation, and `written`
 * upholds the notation the reader chose — the form a rendering surface echoes. Both write the same structure;
 * equivalence reads neither, comparing through its own folded tier.
 *
 * @param parsed A parse, from {@link ./parse!parse}.
 * @param tier Which of the two readable tiers to write.
 * @returns The text of its evaluable query — incomplete and invalid clauses are not part of it.
 */
export function formatQuery(parsed: Parsed, tier: "canonical" | "written" = "canonical"): string {
    return clauseTexts(parsed, tier).map((group) => group.join(" ")).join(` ${GRAMMAR.or} `);
}

/** Every evaluable clause's canonical text, grouped as the parse groups them; empty groups are dropped. */
function clauseTexts(parsed: Parsed, tier: Spelling): string[][] {
    return parsed.groups
        .map((group) => group
            .map((index) => clauseText(parsed.clauses[index], tier))
            .filter((text): text is string => text !== null))
        .filter((group) => group.length > 0);
}

/**
 * One string per parse that two same-question queries share — the whole-query counterpart of {@link clauseKey}.
 *
 * Every clause reduces to its canonical spelling — the same convergence {@link formatQuery} performs, folded per
 * {@link Spelling} because matching folds case too — so delimiter, notation and case differences vanish there. Clause
 * order never matters and neither does group order, so both sort; what remains is the multiset of canonical clauses
 * per alternation group.
 *
 * This is the raw textual tier: spellings converge here, structure never does. Equivalence proper compares this
 * key over SIMPLIFIED forms and lives with the simplifier; the simplifier's own round-trip guard compares it raw,
 * which is what keeps the two from recursing into each other.
 *
 * @param parsed A parse, from {@link ./parse!parse}.
 * @returns The folded canonical text of its evaluable query, order normalised.
 */
export function queryKey(parsed: Parsed): string {
    return clauseTexts(parsed, "folded")
        .map((group) => group.toSorted().join(" "))
        .toSorted()
        .join(` ${GRAMMAR.or} `);
}

/**
 * One clause's folded canonical text — the identity equivalence compares clauses by — or null when the clause
 * holds nothing evaluable. Two clauses with one key ask the same question, whatever their spelling.
 *
 * @param clause The clause.
 * @returns Its folded canonical text, or null.
 */
export function clauseKey(clause: Clause): string | null {
    return clauseText(clause, "folded");
}

/**
 * One scope term's folded canonical text, the term-level counterpart of {@link clauseKey}, or null for a term with
 * nothing evaluable to write.
 *
 * @param term The term.
 * @returns Its folded canonical text, or null.
 */
export function termKey(term: ScopeTerm): string | null {
    return termText(term, "folded");
}

