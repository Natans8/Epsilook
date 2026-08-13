/**
 * @file The row model, and whether one row answers one ask.
 *
 * This is the evaluation side of the seam: everything above it hands DATA down — a parsed clause is plain objects all
 * the way — and this file is where a question first meets a stored value. A column yields rows, a row has a kind, a
 * kind declares properties; the shapes here say what a row IS for the evaluator that walks them, and the functions
 * decide one row at a time. Deciding whether a whole SPELL satisfies a query is the kernel's job, one level up.
 *
 * The declaring modules never import this file, and never name a row: how a query is answered must be free to change
 * without touching what a query means. The repository check `check_matcher_seam` holds that boundary.
 *
 * Matching a value dispatches by notation, exactly as parsing does: a written operand is read by the first notation
 * that accepts it, and only that notation's stored value is compared. That is what keeps `kit:150` an id and
 * `kit:fire` a name on the same property, and a quoted operand arrives already typed as text, so the dispatch never
 * sees it.
 *
 * A bare token is a substring match on anything textual and an equality test everywhere else — the same split
 * alternation uses — so a content term carries `contains` and each property maps it to its own bare reading.
 */
import type {Column} from "../schema/columns";
import type {Kind, Prop} from "../schema/kinds";
import {sentinelOf} from "../schema/kinds";
import type {Ask, ParsedOperand, PropRef, ScopeAsk, ValueExpr} from "../language/ast";
import type {AxisType, Value} from "../vocabulary/value-types";
import {flag, text} from "../vocabulary/value-types";
import {matcher} from "./value-matching";

/**
 * The values one row carries for one property.
 *
 * A scalar is the first notation's value — the common case, and the only case for a single-notation property. A
 * property with several notations stores a record keyed by type name, so a sound kit carries its id and its name as
 * one property with two readings. A row that has only a later notation's value must use the record form; a scalar
 * always means the first.
 */
export type Stored = Value | Readonly<Record<string, Value>>;

/**
 * One row of one column: an instance of a kind, carrying that kind's declared properties.
 *
 * A property absent from `props` is one this row has no value for, and it matches nothing — not even `present`. A
 * flag property is present exactly when the flag is set; the stored value itself carries no information.
 */
export interface Row {
    readonly kind: Kind;
    readonly props: Readonly<Record<string, Stored>>;
}

/** Where one column's rows come from. Spells are addressed by index, dense from zero. */
export interface RowSource {
    rows(spell: number): readonly Row[];

    /** How many rows the spell has, where counting is cheaper than materialising. Must agree with `rows`. */
    size?(spell: number): number;
}

/**
 * The plug: everything the kernel may ask of the loaded data.
 *
 * A pack loader, a test fixture, or anything else — the kernel never learns which it has.
 */
export interface Dataset {
    /** How many spells there are. Spell indexes run dense from zero to this, exclusive. */
    readonly spells: number;

    /** The row source for one column, or `null` where this dataset does not carry it. */
    source(column: Column): RowSource | null;

    /**
     * An inverted-index seed for one ask: a superset of the spells that could satisfy it, or `null` to fall back to
     * the full walk.
     *
     * Soundness is the implementation's promise — a spell left out of the seed is never verified, so an undersized
     * seed silently loses answers. The kernel verifies every seeded spell against the rows, so an oversized seed
     * costs time and never correctness.
     */
    candidates?(ask: Ask): Iterable<number> | null;
}

/** The asks that are decided one row at a time. Counting rows is the kernel's job, above this file. */
export type RowAsk = Exclude<ScopeAsk, { readonly on: "count" }>;

/**
 * Tests one row against one row-level ask.
 *
 * @param row The row.
 * @param ask A content term, a kind word, or a property test.
 * @returns Whether the row satisfies it.
 */
export function rowMatches(row: Row, ask: RowAsk): boolean {
    if (ask.on === "kindWord") return row.kind === ask.kind;
    if (ask.on === "content") return contentMatches(row, ask.value);
    return ask.props.some((ref) => propRefMatches(row, ref, ask.value));
}

/**
 * Tests one row against a content term: the union over the row's declared properties, each applying its own bare
 * reading.
 *
 * @param row The row.
 * @param expr The term's value expression.
 * @returns Whether any property of the row matches.
 */
export function contentMatches(row: Row, expr: ValueExpr): boolean {
    return Object.entries(row.kind.props).some(([name, prop]) => {
        const stored = row.props[name];
        return stored !== undefined && matchProp(name, prop, stored, expr);
    });
}

/**
 * Tests one row against one property reference.
 *
 * @param row The row.
 * @param ref The property, on the kind that declares it.
 * @param expr The value expression.
 * @returns Whether the row is of the referenced kind and its value matches.
 */
export function propRefMatches(row: Row, ref: PropRef, expr: ValueExpr): boolean {
    if (row.kind !== ref.kind) return false;
    const prop = ref.kind.props[ref.prop];
    const stored = row.props[ref.prop];
    return prop !== undefined && stored !== undefined && matchProp(ref.prop, prop, stored, expr);
}

/**
 * Tests one plain-search term against one row: the union over the properties that declare themselves plain, each
 * read through its plain notations only.
 *
 * Restricting the dispatch to the plain notations is what keeps a bare number out of every identity but the spell's
 * own id: the kit id would otherwise answer the same digits a second time.
 *
 * @param row The row.
 * @param expr The term's value expression.
 * @returns Whether any plain property of the row matches.
 */
export function plainMatches(row: Row, expr: ValueExpr): boolean {
    return Object.entries(row.kind.props).some(([name, prop]) => {
        const plain = prop.plain;
        if (plain === undefined || plain.length === 0) return false;
        const stored = row.props[name];
        return stored !== undefined && matchProp(name, prop, stored, expr, plain);
    });
}

/**
 * Tests one property's stored values against one value expression.
 *
 * @param name The property's own name, which is a set flag's matchable content.
 * @param prop The property.
 * @param stored The row's values for it.
 * @param expr The expression.
 * @param notations The notations the dispatch may read, defaulting to all of the property's.
 * @returns Whether the value matches.
 */
export function matchProp(
    name: string, prop: Prop, stored: Stored, expr: ValueExpr,
    notations: readonly AxisType[] = prop.types,
): boolean {
    switch (expr.op) {
        case "anyOf":
            return expr.alternatives.some((alt) => matchProp(name, prop, stored, alt, notations));
        case "present":
            return notations.some((type) => {
                const value = storedFor(prop, stored, type);
                return value !== undefined && runMatch("present", type, value, "");
            });
        case "range": {
            const lo = resolveOperand(prop, expr.lo, notations);
            const hi = resolveOperand(prop, expr.hi, notations);
            if (lo === null || hi === null || lo.type !== hi.type) return false;
            const value = storedFor(prop, stored, lo.type);
            return value !== undefined && runMatch("range", lo.type, value, [lo.value, hi.value]);
        }
        default: {
            if ("text" in expr.operand && matchesFlagWord(name, prop, stored, expr)) return true;
            const operand = resolveOperand(prop, expr.operand, notations);
            if (operand === null) return false;
            const op = bareReading(expr.op, operand.type);
            if (!operand.type.accepts.some((accepted) => accepted.name === op)) return false;
            const value = storedFor(prop, stored, operand.type);
            return value !== undefined && runMatch(op, operand.type, value, operand.value);
        }
    }
}

/**
 * A set flag's matchable content is its property's words: the name, the full name, the synonyms.
 *
 * That is what lets a bare `unbreakable` select the rows that carry the flag, on a type that stores no value at all.
 * The words are compared as text, so anchoring and patterns keep their usual meanings.
 */
function matchesFlagWord(
    name: string, prop: Prop, stored: Stored,
    expr: { readonly op: string; readonly operand: ParsedOperand },
): boolean {
    if (!prop.types.includes(flag) || stored === undefined) return false;
    if (!text.accepts.some((accepted) => accepted.name === expr.op)) return false;
    const words = [name, ...(prop.full === undefined ? [] : [prop.full]), ...(prop.synonyms ?? [])];
    return words.some((word) => runMatch(expr.op, text, word, textOf(expr.operand)));
}

/**
 * An operand as plain text: carried text as itself, a typed value through its default string form.
 *
 * This is the reading a textual matcher takes, shared so nothing restates it beside the dispatch it feeds.
 *
 * @param operand The operand.
 * @returns Its text.
 */
export function textOf(operand: ParsedOperand): string {
    return "text" in operand ? operand.text : String(operand.value);
}

/**
 * Resolves an operand against a property: an already-typed operand as itself, written text by dispatch.
 *
 * Dispatch is the parser's rule applied at evaluation time, where several properties each read the same text: the
 * sentinel words answer first, then the first notation whose `parse` accepts the text wins.
 *
 * Exported for simplification, which must reason over exactly the dispatch evaluation performs — a second reading
 * of the rule would drift from this one.
 *
 * @param prop The property.
 * @param operand The operand.
 * @param notations The notations the dispatch may read — a caller passes the property's own for full dispatch.
 * @returns The value and its notation, or `null` when nothing accepts the operand.
 */
export function resolveOperand(
    prop: Prop, operand: ParsedOperand, notations: readonly AxisType[],
): { readonly type: AxisType; readonly value: Value } | null {
    if ("type" in operand) {
        const type = prop.types.find((candidate) => candidate.name === operand.type);
        return type === undefined ? null : {type, value: operand.value};
    }
    const sentinel = sentinelOf(prop, operand.text);
    if (sentinel !== null && notations.includes(sentinel.type)) return sentinel;
    for (const type of notations) {
        const value = type.parse?.(operand.text);
        if (value !== null && value !== undefined) return {type, value};
    }
    return null;
}

/**
 * The operator a bare token means on one notation: substring on anything textual, equality everywhere else.
 *
 * Every other operator passes through unchanged.
 */
function bareReading(op: string, type: AxisType): string {
    if (op !== "contains") return op;
    return type.accepts.some((accepted) => accepted.name === "contains") ? "contains" : "exact";
}

/**
 * The stored value one notation compares against: the scalar for the first notation, the record entry for any.
 *
 * @returns The value, or `undefined` when the row has none for this notation.
 */
function storedFor(prop: Prop, stored: Stored, type: AxisType): Value | undefined {
    if (typeof stored === "string" || typeof stored === "number") {
        return type === prop.types[0] ? stored : undefined;
    }
    return stored[type.name];
}

/**
 * Runs one implementation from the matcher table.
 *
 * @throws If the pair has no implementation: the property's contract said the operator is accepted, so an absent body
 *   is the table and the schema disagreeing, which must surface rather than read as "no match".
 */
function runMatch(op: string, type: AxisType, stored: Value, operand: Value | readonly Value[]): boolean {
    const run = matcher(op, type.name);
    if (run === undefined) {
        throw new Error(`no matcher for operator "${op}" on type "${type.name}"`);
    }
    return run(stored, operand);
}
