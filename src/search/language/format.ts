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
import {GRAMMAR, PREFIX_OPERATORS, spelling, spellingsOf} from "./grammar";
import {doorOf, formatValue, sentinelOf, wordOf} from "../schema/kinds";
import {headWord} from "../schema/schema";
import {COMPARISONS, exact} from "../vocabulary/operators";
import type {Ask, Clause, Parsed, ParsedOperand, PropRef, ScopeTerm, ValueExpr} from "./ast";
import {propOf} from "./ast";
import {escapeRegExp} from "../text/patterns";
import {scopeShaped} from "./scan";
import type {AxisType} from "../vocabulary/value-types";
import {TYPES} from "../vocabulary/value-types";
import {notationOf, spellIn, spelledNotation} from "../vocabulary/units";

/**
 * Characters that would change a bare value's reading, whatever its position or type.
 *
 * The bind is deliberately NOT one of them: a colon inside a value has no meaning — only a comparison glues an
 * inner bind, and a value whose leading word would have bound never parses into a bare operand in the first
 * place — so `model:mount:horse` re-reads as exactly the content it carries. Quoting it would not be an escape:
 * quotes are strict, so the phrase flips the squashed substring reading to a verbatim one and changes the answer.
 */
const NEEDS_PHRASE = new RegExp(`[\\s${escapeRegExp([
    GRAMMAR.phrase, GRAMMAR.scope.open, GRAMMAR.scope.close,
    GRAMMAR.group.open, GRAMMAR.group.close, GRAMMAR.or, GRAMMAR.wildcard,
].join(""))}]`);

/** Leading characters that would open an operator, a pattern or a negation instead of text. */
const OPENS_STRUCTURE = new RegExp(`^[${escapeRegExp([...new Set([
    ...PREFIX_OPERATORS.flatMap((op) => spellingsOf(op).map((s) => s[0])), GRAMMAR.regex, GRAMMAR.negate,
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
function readingOf(operand: ParsedOperand): Reading {
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
 *   value's own text is upheld, and only where the type has spellings to uphold: a `named` type's value has one
 *   name, so a synonym that reached it (`xpac:6`) is a way in rather than a spelling, and converges here too. A
 *   BARE number wears no symbol, which is not a choice of notation either: it keeps its own digits and gains the
 *   unit of the notation that read it, so `cast:1500` writes as `1500ms` rather than as canonical's `1.5s`.
 * - `folded` is the canonical spelling lowered for comparison, because case never distinguishes two queries —
 *   matching folds it. Regex operands are the one exception: folding a pattern flips character classes (`\D` to
 *   `\d`), so patterns compare as written and rely on their own case-insensitive matching.
 */
type Spelling = "canonical" | "written" | "folded";

/**
 * One written value with the unit it was read in, or the text itself where it already wears one.
 *
 * A bare number leaves its unit implicit, and a surface writing it back leaves the reader to guess which one it
 * landed in — which a type splitting its bare numbers by size makes a real question: `cast:1500` is milliseconds
 * and `cast:2` is seconds. Writing the symbol of the notation that READ it says so without changing the number,
 * and re-reads as exactly the same value.
 *
 * Apart from converging, which is what the canonical tier does: `scale:10-90` is a pair of proportions, and this
 * writes it as `10%-90%` where canonical writes the changes those proportions are stored as.
 *
 * @param type The operand's type.
 * @param written The operand as the reader typed it.
 * @returns The spelling to write, or null where the type has no notations and there is no unit to add.
 */
function wornSpelling(type: AxisType, written: string): string | null {
    const notations = type.notations;
    if (notations === undefined) return null;
    const storage = type.storage === "float" ? "float" : "int";
    if (spelledNotation(notations, storage, written) !== null) return written;
    const read = notationOf(notations, storage, written);
    if (read === null || read.unit === "") return null;
    // A sign the notation requires is already part of what the reader typed, or absent because they left it out;
    // either way the number itself is untouched and only the symbol is added.
    return spellIn(read, written.trim());
}

/**
 * Writes one operand: the text as carried, or the stored value in its property's spelling.
 *
 * Exported for the display model, which draws the same operands this writes — one rule for what an operand
 * says, so a chip and a formatted query can never disagree about it.
 *
 * @param operand The operand from a {@link ValueExpr}.
 * @param at The property the value belongs to, when the ask names one — it holds the sentinel words.
 * @param tier The output tier, per {@link Spelling}. Only `written` and `canonical` are readable spellings.
 * @returns The operand's text in that tier.
 */
export function operandText(
    operand: ParsedOperand, at?: PropRef, tier: Spelling = "canonical",
): string {
    if ("text" in operand) return tier === "folded" ? operand.text.toLowerCase() : operand.text;
    const type = TYPES.get(operand.type);
    if (tier === "written" && operand.written !== undefined && type?.named !== true) {
        return type === undefined ? operand.written : wornSpelling(type, operand.written) ?? operand.written;
    }
    const text = at !== undefined ? formatValue(propOf(at), operand.value)
        : type?.format?.(operand.value) ?? String(operand.value);
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
 * Quotes a value whose spelling requires it.
 *
 * A VERBATIM operand keeps its quotes always: quotes are strict, so the phrase is part of what the ask means and
 * dropping it would turn a written-as-typed match back into a squashed one. The remaining branches serve operands
 * that were never quoted but cannot be spelled bare — text that would re-read as structure or as a number — where
 * the phrase is the only legal spelling at all.
 */
function bareOrPhrase(text: string, reading: Reading, verbatim = false): string {
    if (verbatim || text === "" || NEEDS_PHRASE.test(text)) return phrased(text);
    if (reading === "quantity") return text;
    if (OPENS_STRUCTURE.test(text)) return phrased(text);
    if (NUMBER_SHAPED.test(text) && (reading === "worded" || NUMBER_STRUCTURE.test(text))) return phrased(text);
    return text;
}

/** Whether an operand was quoted by the reader, so its characters are matched as written. */
const verbatimOf = (operand: ParsedOperand): boolean => operand.verbatim === true;

/** A range bound: parenthesised when a leading sign would read as the range separator. */
function bound(text: string): string {
    return text.startsWith(GRAMMAR.negate) ? `${GRAMMAR.group.open}${text}${GRAMMAR.group.close}` : text;
}

/**
 * Whether a rendering surface draws this operand quoted.
 *
 * The chip language shows a phrase's quotes at rest, and which values are phrases is the formatter's own quote
 * law — exactly the operands whose bare spelling would re-read as something else. Exported so the display layer
 * and the formatter can never disagree about where the quotes are.
 *
 * @param operand The operand from a {@link ValueExpr}.
 * @param at The property the value belongs to, when the ask names one.
 * @returns True when the spelling carries quotes.
 */
export function operandQuoted(operand: ParsedOperand, at?: PropRef): boolean {
    const text = operandText(operand, at, "written");
    return bareOrPhrase(text, readingOf(operand), verbatimOf(operand)) !== text;
}

/**
 * Writes one value expression in its canonical spelling.
 *
 * @param value The expression.
 * @param at The property it binds, when known.
 * @param tier The output tier, per {@link Spelling}.
 * @returns The canonical text of the value, including any operator symbol.
 */
/**
 * One value's spelling. `bareSafe` marks BIND position — a value glued straight to its own head — where the
 * written tier may lean on the bare readings: a quantity's missing anchor still reads exact there, and a glued
 * alternation re-reads whole. Everywhere else — scope terms, inner binds, counts — the explicit spellings are
 * load-bearing and stay.
 */
function valueText(value: ValueExpr, at?: PropRef, tier: Spelling = "canonical", bareSafe = false): string {
    switch (value.op) {
        case "present":
            return GRAMMAR.wildcard;
        case "contains":
            return bareOrPhrase(operandText(value.operand, at, tier), readingOf(value.operand),
                verbatimOf(value.operand));
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
            // In bind position a QUANTITY's bare spelling already reads exact, so the written tier — the one
            // upholding a reader who never typed the anchor — leaves it off. Everywhere else it is load-bearing:
            // a scope's bare value joins the alternation rule, and a bare count is content.
            if (bareSafe && tier === "written" && readingOf(value.operand) === "quantity") {
                return bareOrPhrase(text, readingOf(value.operand), verbatimOf(value.operand));
            }
            return `${spelling(exact)}${bareOrPhrase(text, readingOf(value.operand), verbatimOf(value.operand))}`;
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte":
            return `${spelling(COMPARISONS[value.op])}${operandText(value.operand, at, tier)}`;
        case "range":
            return `${bound(operandText(value.lo, at, tier))}${GRAMMAR.range}${operandText(value.hi, at, tier)}`;
        case "anyOf": {
            const parts = value.alternatives.map((alt) => valueText(alt, at, tier, bareSafe));
            // Digits alone write the comma list — the id idiom, and the spelling the chip itself displays.
            if (tier === "written" && bareSafe && parts.every((p) => /^\d+$/.test(p))) {
                return parts.join(GRAMMAR.numberList);
            }
            const glued = parts.join(GRAMMAR.or);
            // In bind position the glued spelling re-reads as this same alternation, so the written tier
            // spares the parentheses unless a phrase, a space or an empty spelling would split it. A scope's
            // inner bind always groups — the glued pipe re-reads the same there, but the group is what tells
            // a bind's value alternation apart from the scope's own SPACED run alternation at a glance.
            if (tier === "written" && bareSafe
                && parts.every((p) => p !== "" && !p.includes(GRAMMAR.phrase) && !p.includes(" "))) {
                return glued;
            }
            // The group spelling is only legal where it re-reads as the group: a colon at its own depth makes
            // the parser read the parentheses as a SCOPE (`(mount:horse)` binds mount), so a value the group
            // cannot carry keeps the glued spelling, which in bind position re-reads as this same alternation.
            if (bareSafe && scopeShaped(glued)) return glued;
            return `${GRAMMAR.group.open}${glued}${GRAMMAR.group.close}`;
        }
    }
    // The switch is exhaustive, narrowing `value` to never: a new variant fails to compile here until it has a
    // spelling, which is the only thing keeping this module the parser's inverse.
    return value;
}

/**
 * A scope term's content value. Alternation glues — `fire|frost` — because a term never reads a parenthesised
 * group; the grouped spelling belongs to bind values, where {@link valueText} writes it.
 */
function termValueText(value: ValueExpr, tier: Spelling, at?: PropRef): string {
    if (value.op === "anyOf") {
        return value.alternatives.map((alt) => valueText(alt, at, tier)).join(GRAMMAR.or);
    }
    return valueText(value, at, tier);
}

/**
 * The word a scope term is written with, or null for a term with nothing evaluable to write.
 *
 * @param term The term.
 * @param tier The output tier, per {@link Spelling}.
 * @param enclosing The kind whose own scope holds this term, when the scope's head IS a kind — its word is
 *   already the door overhead, so a term never repeats it.
 * @returns The term's text, or null.
 */
function termText(term: ScopeTerm, tier: Spelling, enclosing: PropRef["kind"] | null = null): string | null {
    if (term.state !== "ok" || term.ask === null) return null;
    const negate = term.not ? GRAMMAR.negate : "";
    const ask = term.ask;
    if (ask.on === "content") return `${negate}${termValueText(ask.value, tier)}`;
    if (ask.on === "kindWord") return `${negate}${wordOf(ask.kind)}`;
    if (ask.on === "count") return `${negate}${bindTo(GRAMMAR.countWord, valueText(ask.value, undefined, tier))}`;
    const ref = ask.props[0];
    const text = valueText(ask.value, ref, tier);
    if (subjectSpeaksBare(ask.value, ref, tier, text)) return `${negate}${text}`;
    // Inside the kind's OWN scope its word is already the door overhead: writing it again names a property the
    // kind does not have, and the spelling stops parsing. The subject of a ONE-property kind speaks bare —
    // every bare value the scope reads lands on that one property — and anything else binds through its name.
    if (ref.kind === enclosing) {
        const props = Object.keys(ref.kind.props);
        return props.length === 1 && props[0] === ref.prop
            ? `${negate}${termValueText(ask.value, tier, ref)}`
            : `${negate}${bindTo(ref.prop, text)}`;
    }
    // A kind's SUBJECT binds through the KIND's word — the door the reader has — never through the schema's
    // own property name: `mount:horse`, not the `name:horse` that surfaced a field nobody typed.
    const subject = Object.keys(ref.kind.props)[0] === ref.prop && ref.kind.word !== undefined
        ? ref.kind.word
        : ref.prop;
    return `${negate}${bindTo(subject, text)}`;
}

/**
 * Whether a scope term on the kind's SUBJECT writes as the bare comparison the reader types — `scale:{>50%}`,
 * never an `amount` no surface offers — because the subject property never names itself.
 *
 * Only where the bare spelling provably re-reads as the same ask: the value is one operator on a QUANTITY, and
 * the operand's type is read by exactly ONE of the kind's properties, so the bare term's dispatch lands back on
 * the subject alone. A text subject stays named — bare text dispatches to every property — and so does a
 * quantity two properties share, the way the range kind's yards and min do. Written tier only: the canonical
 * form stays fully spelled.
 */
function subjectSpeaksBare(value: ValueExpr, ref: PropRef, tier: Spelling, text: string): boolean {
    if (tier !== "written") return false;
    if (Object.keys(ref.kind.props)[0] !== ref.prop || !OPENS_OPERATOR.test(text)) return false;
    if (!("operand" in value) || "text" in value.operand) return false;
    const type = value.operand.type;
    if (TYPES.get(type)?.quantity !== true) return false;
    return Object.values(ref.kind.props)
        .filter((prop) => prop.types.some((held) => held.name === type))
        .length === 1;
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
 * A scope of one evaluable term is that term, so its spelling drops the braces — for a content or kind word,
 * whose text means the same on either side of them, and for any bound word whose value opens with an OPERATOR,
 * where the promoted spelling is the glued inner bind the parser reads back to this same one-term scope:
 * `range:min=5yd`, `sound:count>2`, `cast>2s`. Only the colon-glued bind stays braced — a second colon in a
 * value has no meaning, so `model:attach:chest` would read as content and the braces are what bind it.
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
    if (ask.on === "props" && OPENS_OPERATOR.test(valueText(ask.value, ask.props[0]))) return term;
    return null;
}

function askText(ask: Ask, tier: Spelling): string | null {
    if (ask.on === "plain") return valueText(ask.value, undefined, tier, true);
    if (ask.on === "prop") {
        const door = doorOf(ask.ref.prop, propOf(ask.ref));
        return ask.value === null ? null : bindTo(door, valueText(ask.value, ask.ref, tier, true));
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
    if (test.is === "content") return bindTo(head, valueText(test.value, undefined, tier, true));
    if (test.is === "props") {
        const ref = test.props[0];
        // The value re-reads through the head's own dispatch, so the property name needs no spelling here.
        return bindTo(head, valueText(test.value, ref, tier, true));
    }

    const enclosing = ask.on === "kind" ? ask.kind : null;
    const runs = test.terms
        .map((run) => run
            .map((term) => ({term, text: termText(term, tier, enclosing)}))
            .filter((pair): pair is { term: ScopeTerm; text: string } => pair.text !== null))
        .filter((run) => run.length > 0);
    if (runs.length === 0) return exists;
    const lone = unbracedTerm(test.terms);
    if (lone !== null && lone.ask !== null) {
        if (lone.ask.on === "count") return `${head}${valueText(lone.ask.value, undefined, tier)}`;
        const text = termText(lone, tier, enclosing);
        // A promoted BIND spells as the glued inner bind the parser reads back to this scope, converging with
        // the directly-typed form — `cast>2s`, `range:min=5yd`. Content keeps its colon: an anchored value's
        // `=` is the anchor, not a glue the head may absorb.
        if (text !== null && lone.ask.on === "props") return bindTo(head, text);
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
    const clauses = clauseTexts(parsed, tier).map((group) => group.join(" ")).join(` ${GRAMMAR.or} `);
    return [clauses, ...directiveTexts(parsed)].filter((text) => text !== "").join(" ");
}

/**
 * The directives' own spellings, after the clauses: a directive selects nothing, but a rewrite that shed one
 * would change what the reader sees — the order and how much of it — so every formatted query carries them.
 */
export function directiveTexts(parsed: Parsed): string[] {
    const out: string[] = [];
    const doors = parsed.sorts.map((sort) => `${sort.descending ? GRAMMAR.negate : ""}${headWord(sort.head)}`);
    // One door spells plainly; a sequence spells scoped, the concise form `sort:{name -cast}` reads back to.
    if (doors.length === 1) out.push(`${GRAMMAR.sortWord}${GRAMMAR.bind}${doors[0]}`);
    else if (doors.length > 1) {
        out.push(`${GRAMMAR.sortWord}${GRAMMAR.bind}${GRAMMAR.scope.open}${doors.join(" ")}${GRAMMAR.scope.close}`);
    }
    if (parsed.limit !== null) out.push(`${GRAMMAR.limitWord}${GRAMMAR.bind}${String(parsed.limit.value)}`);
    return out;
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
    const directives = directiveTexts(parsed).join(" ");
    return (directives === "" ? "" : directives + "\u0000") + clauseTexts(parsed, "folded")
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

