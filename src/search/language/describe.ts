/**
 * @file The chip display model: a parse read as what the bar draws at rest.
 *
 * The formatter's sibling, answering a different question: {@link ./format!formatQuery} writes the query's one
 * spelling, this reads the same tree as display structure — which clause is a chip, which a lane, which stays raw
 * text; what each piece of a chip's body is, so a renderer can style a vocabulary word apart from corpus text
 * without a token list of its own. The model is data all the way down, exactly as the tree is, so any surface can
 * draw it.
 *
 * The display rules it encodes, each from the chip language:
 *
 * - the chip draws the parse's meaning, not the minimal spelling — an elided count surfaces as its word;
 * - a bare number never displays bare: the notation that read it is made explicit, in the reader's own family;
 * - one condition on a row is a compact chip whatever its spelling, two or more are the lane — `{x} ≡ x`;
 * - an invalid clause never becomes a chip, and a dead term inside a healthy scope stays a raw fragment;
 * - everything displayed is typeable: every word or glyph this module emits parses back in its place.
 */
import type {Ask, Clause, Diagnostic, Parsed, ParsedOperand, PropRef, ScopeTerm, Span, ValueExpr} from "./ast";
import {propOf} from "./ast";
import {GRAMMAR, spelling} from "./grammar";
import {doorOf, wordOf} from "../schema/kinds";
import {headWord} from "../schema/schema";
import type {Kind, Prop} from "../schema/kinds";
import {operandQuoted, operandText} from "./format";
import type {Operator} from "../vocabulary/operators";
import {COMPARISONS, exact, not as notOp, range} from "../vocabulary/operators";
import {notationOf, writeNotation} from "../vocabulary/units";
import type {AxisType} from "../vocabulary/value-types";
import {bitmask, colour, enumeration, id, ordinal, TYPES} from "../vocabulary/value-types";

/**
 * One styled piece of a chip's contents. Pieces render in order, separated by single spaces; a renderer keeps a
 * swatch tight against the word that follows it, and a phrase's quotes are drawn glued by the renderer, styled as
 * the delimiters they are.
 */
export type Piece =
/** Plain value text: corpus words, sentinel words, notation-explicit numbers, identity lists, ranges. */
    | { readonly is: "value"; readonly text: string }
    /** A closed-vocabulary word — a kind word, an enum value, a role — marked distinctly from corpus text. */
    | { readonly is: "word"; readonly text: string }
    /** A word about the query rather than of the data — the any-word, a surfaced property word — drawn loud. */
    | { readonly is: "meta"; readonly text: string }
    /** An operator's display glyph. */
    | { readonly is: "op"; readonly text: string }
    /** A quoted literal, quotes not included — the renderer draws them glued. */
    | { readonly is: "phrase"; readonly text: string }
    /** A regular expression, slashes not included — the renderer draws them glued and colours the pattern. */
    | { readonly is: "regex"; readonly pattern: string }
    /** The honest display of a colour value; `colour` is CSS-ready. The value's word follows as its own piece. */
    | { readonly is: "swatch"; readonly colour: string }
    /** A dead fragment kept as raw text — the renderer slices the query and marks it. */
    | { readonly is: "dead"; readonly span: Span }
    /** The gate connective between alternatives. */
    | { readonly is: "or" };

/** A compact chip: one condition, however spelled. */
export interface ChipView {
    /** The head word, in the query's own case; display casing is the renderer's. */
    readonly head: string;
    /** The key of the column the chip constrains — its tone family. */
    readonly tone: string;
    /** Whether the clause is negated; the renderer fuses the minus into the head. */
    readonly not: boolean;
    /**
     * The property the value binds, where the chip carries one — drawn as a cell of its own between the head
     * and the value.
     *
     * A lane already gives an inner bind its own pill, so `model:{missile from:chest}` reads as cells. Collapsed
     * to the compact form the same bind became two words with a space between them, and `attach chest` read as
     * two separate things rather than one saying what the other is.
     */
    readonly sub?: string;
    readonly body: readonly Piece[];
    /** How the chip grows: a further row condition, a further value alternative, or not at all. */
    readonly grow: "term" | "alternative" | null;
}

/**
 * One item inside a lane, in written order.
 *
 * A term and a bind carry `lone`: whether they stand alone in their alternation run. The scope walk knows it
 * while it is walking; a renderer could only recover it by re-splitting the flattened list, and the per-term
 * delete rule — a lone term takes the stranded or-edge with it — needs the answer.
 */
export type LaneItem =
/** A bare term: rendered as text, not a capsule. */
    | {
    readonly is: "term"; readonly not: boolean; readonly body: readonly Piece[]; readonly span: Span;
    readonly lone: boolean
}
    /** An inner bind: a chip of its own inside the lane. */
    | {
    readonly is: "bind"; readonly not: boolean; readonly head: string; readonly body: readonly Piece[];
    readonly span: Span; readonly lone: boolean
}
    /** A dead fragment: raw squiggled text, the healthy terms around it unaffected. */
    | { readonly is: "dead"; readonly span: Span }
    /** The alternation connective between the scope's runs. */
    | { readonly is: "or" };

/** A lane: two or more conditions sharing one row, in the toned enclosure. */
export interface LaneView {
    readonly head: string;
    readonly tone: string;
    readonly not: boolean;
    readonly items: readonly LaneItem[];
}

/**
 * How one clause displays. Raw text carries no model: freeform terms are text by ruling, and an invalid clause
 * stays the text it failed as, squiggled.
 */
export type ClauseView =
    | { readonly form: "text"; readonly span: Span; readonly notes: readonly string[] }
    | { readonly form: "error"; readonly span: Span; readonly notes: readonly string[] }
    | {
    readonly form: "chip"; readonly span: Span; readonly notes: readonly string[];
    readonly warned: boolean; readonly erred: boolean; readonly chip: ChipView
}
    | {
    readonly form: "lane"; readonly span: Span; readonly notes: readonly string[];
    readonly warned: boolean; readonly erred: boolean; readonly lane: LaneView
}
    /**
     * A DIRECTIVE: it shapes the list rather than the set, so it draws apart from the ask chips — no column
     * tone, its own neutral cell. A descending sort's value keeps the minus it is spelled with.
     */
    | {
    readonly form: "directive"; readonly span: Span; readonly notes: readonly string[];
    readonly word: string; readonly value: string
};

/** The word-vocabulary types: values from a closed set, marked apart from corpus text. */
const WORDED: ReadonlySet<AxisType> = new Set<AxisType>([enumeration, ordinal, bitmask]);

/**
 * An operator's display glyph, falling back to its written symbol.
 *
 * Exported because negation is drawn by the renderer rather than emitted as a piece — a chip fuses its minus
 * into the head cell, which is layout, not content — and that glyph must still come off the registry.
 *
 * @param op The operator.
 * @returns The glyph a display surface draws for it.
 */
export const glyphOf = (op: Operator): string => op.glyph ?? spelling(op);

/** The glyph a negated head, term or lane wears — the clause operator's own, never a hyphen typed by hand. */
export const NEGATION = glyphOf(notOp);

/** Whether the storage behind a numeric type is integral, for re-running notation dispatch. */
const integral = (type: AxisType): "int" | "float" => (type.storage === "float" ? "float" : "int");

/**
 * A number's display text: the notation that read it made explicit, in the reader's own family.
 *
 * A type with no notations — a count, an id — displays its digits. Otherwise the written operand names the
 * notation and the value is respelled in it, glyph included, so `5` on a size displays `×5` and `150` displays
 * `150%`; an operand with no written spelling takes the display notation.
 */
function numberText(type: AxisType, value: number, written: string | undefined): string {
    const notations = type.notations;
    if (notations === undefined) return signed(written ?? type.format?.(value) ?? String(value));
    const read = written === undefined ? null : notationOf(notations, integral(type), written);
    const chosen = read ?? notations[0];
    return signed(writeNotation(chosen, value, chosen.glyph ?? chosen.unit));
}

/**
 * A number's own minus drawn as the true minus sign rather than the hyphen the query is written with.
 *
 * The hyphen carries three jobs in this language — negation, a sign, and a range's separator — and a range of
 * negative bounds writes all three within six characters. The glyph tells the sign apart from the separator on
 * sight, and stays typeable: the minus sign folds to a hyphen on the way in, as every typographic substitute
 * does.
 */
function signed(text: string): string {
    return text.startsWith(GRAMMAR.negate) ? NEGATION + text.slice(1) : text;
}

/** The sentinel word a typed operand resolves to under its property, or null. */
function sentinelWord(operand: ParsedOperand, at?: PropRef): string | null {
    if ("text" in operand || at === undefined || typeof operand.value !== "number") return null;
    return propOf(at).sentinels?.[operand.value] ?? null;
}

/** A textual piece, upgraded to a phrase where the spelling carries quotes. */
function texty(text: string, kind: "value" | "word", operand: ParsedOperand, at?: PropRef): Piece {
    return operandQuoted(operand, at) ? {is: "phrase", text} : {is: kind, text};
}

/**
 * One operand's pieces: the written spelling upheld, classed by the type that read it.
 */
function operandPieces(operand: ParsedOperand, at?: PropRef): Piece[] {
    if ("text" in operand) return [texty(operand.text, "value", operand, at)];

    const word = sentinelWord(operand, at);
    if (word !== null) return [{is: "value", text: word}];

    const type = TYPES.get(operand.type);
    // The formatter's own written tier: one rule for what an operand says, so the text a chip draws and the
    // text `operandQuoted` weighed for quotes are the same string.
    const written = operandText(operand, at, "written");
    if (type === undefined) return [{is: "value", text: written}];
    if (type === colour && typeof operand.value === "number") {
        return [{is: "swatch", colour: colour.format?.(operand.value) ?? written}, {is: "word", text: written}];
    }
    if (type.quantity === true && typeof operand.value === "number") {
        return [{is: "value", text: numberText(type, operand.value, operand.written)}];
    }
    return [texty(written, WORDED.has(type) ? "word" : "value", operand, at)];
}

/** One range bound's display text, notation-explicit like any lone number. */
function boundText(operand: ParsedOperand, at?: PropRef): string {
    const [piece] = operandPieces(operand, at);
    return "text" in piece && typeof piece.text === "string" ? piece.text : "";
}

/**
 * A value expression's pieces.
 *
 * An alternation over identities — ids, plain digit runs — is a list and joins with commas, identical whatever
 * separator was typed; over anything else it is a logical gate and keeps its or-connective.
 */
function exprPieces(value: ValueExpr, at?: PropRef): Piece[] {
    switch (value.op) {
        case "present":
            return [{is: "meta", text: GRAMMAR.anyWord}];
        case "contains":
            return operandPieces(value.operand, at);
        case "glob":
            return [{is: "value", text: "text" in value.operand ? value.operand.text : ""}];
        case "regex":
            return [{is: "regex", pattern: "text" in value.operand ? value.operand.text : ""}];
        case "exact": {
            // A sentinel word already means the exact ask, so the anchor adds nothing to it — and neither does
            // it to a quantity, whose bare number is already the exact ask; the glyph displays only where it
            // separates the anchored ask from the substring one.
            const operand = value.operand;
            const implied = sentinelWord(operand, at) !== null
                || (!("text" in operand) && TYPES.get(operand.type)?.quantity === true);
            if (implied) return operandPieces(operand, at);
            return [{is: "op", text: glyphOf(exact)}, ...operandPieces(operand, at)];
        }
        case "lt":
        case "lte":
        case "gt":
        case "gte":
            return [{is: "op", text: glyphOf(COMPARISONS[value.op])}, ...operandPieces(value.operand, at)];
        case "range":
            return [{is: "value", text: `${boundText(value.lo, at)}${glyphOf(range)}${boundText(value.hi, at)}`}];
        case "anyOf": {
            // Flattened first: a grown list arrives as an alternation of an alternation, and the display reads
            // the leaves — identical whatever separators built it.
            const flat = alternativesOf(value);
            const ids = flat.map(listText);
            if (ids.length > 1 && ids.every((t) => t !== null)) {
                return [{is: "value", text: ids.join(", ")}];
            }
            const gate: Piece[] = [];
            for (const alt of flat) {
                if (gate.length > 0) gate.push({is: "or"});
                gate.push(...exprPieces(alt, at));
            }
            return gate;
        }
    }
    // The switch is exhaustive, narrowing `value` to never — a new variant fails to compile until it displays.
    return value;
}

/** An alternation's leaf alternatives, nested groups flattened. */
function alternativesOf(value: ValueExpr): ValueExpr[] {
    if (value.op !== "anyOf") return [value];
    return value.alternatives.flatMap(alternativesOf);
}

/** One alternative's text when it belongs to an identity list, or null when it makes the group a gate. */
function listText(alt: ValueExpr): string | null {
    if (alt.op !== "exact" && alt.op !== "contains") return null;
    const operand = alt.operand;
    if ("text" in operand) return /^\d+$/.test(operand.text) ? operand.text : null;
    if (TYPES.get(operand.type) !== id) return null;
    return operand.written ?? String(operand.value);
}

/**
 * One scope term as a lane item.
 *
 * @param term The term.
 * @param lone Whether it stands alone in its alternation run.
 * @param under The kind the scope was opened on, or null under a column — which decides whether a property's
 *   own word has already been said by the head.
 * @returns The item.
 */
function termItem(term: ScopeTerm, lone: boolean, under: Kind | null): LaneItem {
    const ask = term.ask;
    if (term.state !== "ok" || ask === null) return {is: "dead", span: term.span};
    const at = {not: term.not, span: term.span, lone};
    if (ask.on === "content") return {is: "term", ...at, body: exprPieces(ask.value)};
    if (ask.on === "kindWord") return {is: "term", ...at, body: [{is: "word", text: wordOf(ask.kind)}]};
    if (ask.on === "count") return {is: "bind", ...at, head: GRAMMAR.countWord, body: exprPieces(ask.value)};
    const ref = ask.props[0];
    const body = exprPieces(ask.value, ref);
    // The head is the door the ask went through, and a KIND's word is the door to its subject: `scale:` means
    // the amount, so naming the amount again says nothing the head has not said. That holds only where the
    // enclosing head IS that kind — under a COLUMN the word carries no property, and dropping it turns
    // `model:{file:*}` into the different ask `model:any`. Everything else keeps its word, because without it
    // the value would not say which aspect it constrains.
    return under === ref.kind && subjectOf(ref)
        ? {is: "term", ...at, body} : {is: "bind", ...at, head: ref.prop, body};
}

/**
 * Whether a property is the one its kind's own word reaches — the first declared, which is the order a kind
 * offers its properties an operand in.
 *
 * @param ref The property reference.
 * @returns True when the kind's word is already the door to it.
 */
function subjectOf(ref: PropRef): boolean {
    return Object.keys(ref.kind.props)[0] === ref.prop;
}

/**
 * The one kind a scope's single term belongs to, or null.
 *
 * Only where the scope holds exactly one term and that term names a kind with a word of its own -- which is
 * what makes the word available as the chip's head in place of the column's.
 *
 * @param terms The scope's terms, by run.
 * @returns The kind, or null where the scope holds more than one term or names no kind.
 */
function soleKind(terms: ReadonlyArray<readonly ScopeTerm[]>): Kind | null {
    const flat = terms.flat();
    if (flat.length !== 1) return null;
    const ask = flat[0].ask;
    if (ask === null) return null;
    // A term that IS the kind word needs no promotion: `model:{display}` already reads as `model | display`, and
    // heading it with the kind would draw the word twice.
    if (ask.on !== "props") return null;
    const kinds = new Set(ask.props.map((ref) => ref.kind));
    const only = kinds.size === 1 ? [...kinds][0] : null;
    return only?.word === undefined ? null : only;
}

/**
 * A scope's lane items: terms in written order, the or-connective between non-empty runs.
 *
 * @param terms The scope's terms, by run.
 * @param under The kind the scope was opened on, or null for a column's scope — which decides whether a
 *   property's own word has already been said by the head.
 */
function scopeItems(terms: ReadonlyArray<readonly ScopeTerm[]>, under: Kind | null): LaneItem[] {
    const items: LaneItem[] = [];
    for (const run of terms) {
        if (run.length === 0) continue;
        if (items.length > 0) items.push({is: "or"});
        for (const term of run) items.push(termItem(term, run.length === 1, under));
    }
    return items;
}

/** A lone lane item folded into a compact chip's body — the `{x} ≡ x` law drawn. */
function compactBody(item: LaneItem): Piece[] {
    if (item.is === "term") return [...item.body];
    if (item.is === "bind") return [{is: "meta", text: item.head}, ...item.body];
    if (item.is === "dead") return [{is: "dead", span: item.span}];
    return [];
}

/** Whether any of a property's notations accepts alternation — what the grow-by-alternative gesture appends. */
function growsAlternative(prop: Prop): boolean {
    return prop.types.some((type) => type.accepts.some((op) => op.name === "anyOf"));
}

/** Whether a body was rendered as an identity list, whose + appends a value rather than a condition. */
const isList = (value: ValueExpr | null): boolean =>
    value !== null && value.op === "anyOf" && alternativesOf(value).length > 1
    && alternativesOf(value).every((alt) => listText(alt) !== null);

/** What one clause's ask displays as; null falls back to raw text. */
type AskView = { readonly as: "chip"; readonly chip: ChipView } | { readonly as: "lane"; readonly lane: LaneView };

/** The display view of one clause's ask; null falls back to raw text. */
function askView(ask: Ask, not: boolean): AskView | null {
    if (ask.on === "plain") return null;

    if (ask.on === "prop") {
        if (ask.value === null) return null;
        const prop = propOf(ask.ref);
        return {
            as: "chip",
            chip: {
                head: doorOf(ask.ref.prop, prop),
                tone: ask.ref.kind.column.key,
                not,
                body: exprPieces(ask.value, ask.ref),
                grow: isList(ask.value) || growsAlternative(prop) ? "alternative" : null,
            },
        };
    }

    const column = ask.on === "column" ? ask.column : ask.kind.column;
    const kind: Kind | null = ask.on === "kind" ? ask.kind : null;
    const test = ask.test;
    if (test === null) return null;
    const head = kind !== null && test.is !== "exists" ? wordOf(kind) : column.key;
    const chip = (body: Piece[], grow: ChipView["grow"] = "term"): AskView =>
        ({as: "chip", chip: {head, tone: column.key, not, body, grow}});

    if (test.is === "exists") {
        // A kind with a word of its own displays it; a wordless kind and a whole column are existence, the word.
        const word = kind?.word;
        return chip(word === undefined ? [{is: "meta", text: GRAMMAR.anyWord}] : [{is: "word", text: word}]);
    }
    if (test.is === "content") {
        return chip(exprPieces(test.value), isList(test.value) ? "alternative" : "term");
    }
    if (test.is === "props") {
        return chip(exprPieces(test.value, test.props[0]), isList(test.value) ? "alternative" : "term");
    }

    // A column's scope holding ONE term names that term's kind: the reader wrote `model:{display:2}`, and
    // heading it with the column throws the word they chose away -- leaving the term to say `id`, which is the
    // schema's own field name and not an ask anybody typed. The kind's word is the door to its subject, so
    // promoting it is also what lets the subject stop naming itself.
    const promoted = kind === null ? soleKind(test.terms) : null;
    const items = scopeItems(test.terms, kind ?? promoted);
    if (items.length === 0) return chip([{is: "meta", text: GRAMMAR.anyWord}]);
    if (items.length === 1) {
        const word = promoted === null ? head : wordOf(promoted);
        const only = items[0];
        // A bind keeps its property as a cell rather than flattening to a loud word beside the value.
        const bound = only.is === "bind" && promoted === null ? only : null;
        const body = bound === null ? compactBody(only) : [...bound.body];
        // The key is OMITTED where there is no bound property rather than set to nothing: a view is compared
        // whole, and an absent property is not the same shape as one present and empty.
        const sub = bound === null ? {} : {sub: bound.head};
        return {as: "chip", chip: {head: word, tone: column.key, not, ...sub, body, grow: "term"}};
    }
    return {as: "lane", lane: {head, tone: column.key, not, items}};
}

/**
 * Reads a parse as display structure, one view per clause, in written order.
 *
 * @param parsed A parse of final text, from {@link ./parse!parse}.
 * @returns One {@link ClauseView} per entry of `parsed.clauses`.
 */
export function describe(parsed: Parsed): ClauseView[] {
    const directives: ClauseView[] = [
        ...parsed.sorts.map((sort): ClauseView => ({
            form: "directive", span: sort.span, notes: [],
            word: GRAMMAR.sortWord,
            value: `${sort.descending ? GRAMMAR.negate : ""}${headWord(sort.head)}`,
        })),
        ...(parsed.limit === null ? [] : [{
            form: "directive" as const, span: parsed.limit.span, notes: [],
            word: GRAMMAR.limitWord, value: String(parsed.limit.value),
        }]),
    ];
    return withDirectives(parsed.clauses.map((clause: Clause, index: number): ClauseView => {
        const mine = parsed.diagnostics.filter((d: Diagnostic) => d.clause === index);
        const notes = mine.map((d) => d.message);
        const view = clause.state === "ok" && clause.ask !== null ? askView(clause.ask, clause.not) : null;
        if (view === null) {
            const form = clause.state === "invalid" ? "error" : "text";
            return {form, span: clause.span, notes};
        }
        const at = {
            span: clause.span,
            notes,
            warned: mine.some((d) => d.severity === "warning"),
            erred: mine.some((d) => d.severity === "error"),
        };
        return view.as === "lane"
            ? {form: "lane", ...at, lane: view.lane}
            : {form: "chip", ...at, chip: view.chip};
    }), directives);
}

/** The clause views and the directives merged into one span-ascending list, which is the order a bar draws. */
function withDirectives(views: ClauseView[], directives: ClauseView[]): ClauseView[] {
    if (directives.length === 0) return views;
    return [...views, ...directives].toSorted((a, b) => a.span.start - b.span.start);
}
