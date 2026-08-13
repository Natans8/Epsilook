/**
 * @file The kernel: a parsed query in, the set of matching spells out.
 *
 * The interpreter over the query tree, in the query-object convention of Django's Q objects and Lucene's Query
 * classes: {@link ./parse!} produces plain data, this file executes it against a {@link Dataset}, and nothing in
 * between is a callback. The kernel branches on structure only — no column name, no kind name, no type name — so a
 * new axis reaches it as a declaration, never as an edit here.
 *
 * The algebra is disjunctive normal form over clauses: within a group, clauses conjoin; groups union. A negated
 * clause is the complement of its positive reading — "no row matches", the negated existential — which is why a
 * query of nothing but exclusions starts from every spell.
 *
 * Each positive clause narrows the set the group has so far, so later clauses are only verified on the survivors of
 * earlier ones. A dataset may offer {@link Dataset.candidates} as an inverted-index seed; the kernel verifies every
 * seeded spell against the rows, so a seed changes cost and never answers.
 *
 * Inside a row scope, terms are again alternation groups of conjunctions, and one row must satisfy a whole
 * conjunction — that binding is the scope's meaning. A count term is the exception: it asks about the set of rows the
 * conjunction's row-level terms leave, so it is lifted out and tested against that set's size. A conjunction with no
 * row-level terms therefore counts every row, and one with neither counts nor terms is satisfied by any row at all,
 * which is how `model:{}` and `model:*` come to agree.
 */
import {COLUMNS} from "../schema/columns";
import type {Kind} from "../schema/kinds";
import type {Ask, Clause, Parsed, RowTest, ScopeTerm, ValueExpr} from "../language/ast";
import type {Dataset, Row, RowAsk, RowSource} from "./rows";
import {plainMatches, rowMatches} from "./rows";
import type {Value} from "../vocabulary/value-types";
import {count} from "../vocabulary/value-types";
import {matcher} from "./value-matching";

/**
 * Evaluates a parsed query.
 *
 * @param parsed The parse. Only its evaluable structure runs: incomplete and invalid clauses are already outside
 *   `groups`.
 * @param dataset The loaded data.
 * @returns The matching spell indexes. A query that constrains nothing — empty, or nothing evaluable — returns every
 *   spell, because an empty conjunction is true.
 */
export function run(parsed: Parsed, dataset: Dataset): Set<number> {
    if (parsed.groups.length === 0) return everySpell(dataset);

    const result = new Set<number>();
    for (const group of parsed.groups) {
        for (const spell of groupSet(parsed.clauses, group, dataset)) result.add(spell);
    }
    return result;
}

/** Every spell index, dense from zero. */
function everySpell(dataset: Dataset): Set<number> {
    const all = new Set<number>();
    for (let spell = 0; spell < dataset.spells; spell++) all.add(spell);
    return all;
}

/**
 * Evaluates one conjunction of clauses.
 *
 * Positive clauses run first, each narrowing the set so far; negated clauses then subtract their matches from the
 * survivors. The order within each half does not change the answer — only how much work later clauses see.
 */
function groupSet(clauses: readonly Clause[], group: readonly number[], dataset: Dataset): Set<number> {
    const members = group.map((index) => clauses[index]);
    let survivors: Set<number> | null = null;

    for (const clause of members.filter((c) => !c.not)) {
        survivors = clauseSet(clause.ask, dataset, survivors);
        if (survivors.size === 0) return survivors;
    }
    const negated = members.filter((c) => c.not);
    survivors ??= everySpell(dataset);
    for (const clause of negated) {
        for (const spell of clauseSet(clause.ask, dataset, survivors)) survivors.delete(spell);
    }
    return survivors;
}

/**
 * The spells matching one clause's positive reading, within a domain.
 *
 * @param ask The clause's ask. `null` marks a clause the parser kept for display only; those never reach `groups`,
 *   so it constrains nothing here.
 * @param dataset The loaded data.
 * @param domain The spells still in play, or `null` for all of them. A seed from the dataset narrows it further.
 * @returns The matching subset, always a fresh set.
 */
function clauseSet(ask: Ask | null, dataset: Dataset, domain: ReadonlySet<number> | null): Set<number> {
    if (ask === null) return domain === null ? everySpell(dataset) : new Set(domain);

    const seed = dataset.candidates?.(ask) ?? null;
    const matched = new Set<number>();
    if (seed !== null) {
        for (const spell of seed) {
            if ((domain === null || domain.has(spell)) && askMatches(ask, dataset, spell)) matched.add(spell);
        }
        return matched;
    }
    for (const spell of domain ?? spellRange(dataset)) {
        if (askMatches(ask, dataset, spell)) matched.add(spell);
    }
    return matched;
}

function* spellRange(dataset: Dataset): Generator<number> {
    for (let spell = 0; spell < dataset.spells; spell++) yield spell;
}

/**
 * Tests one spell against one ask.
 *
 * @param ask The ask.
 * @param dataset The loaded data.
 * @param spell The spell's index.
 * @returns Whether the spell satisfies it.
 */
export function askMatches(ask: Ask, dataset: Dataset, spell: number): boolean {
    if (ask.on === "plain") return plainAskMatches(ask.value, dataset, spell);
    if (ask.on === "column") {
        const source = dataset.source(ask.column);
        return source !== null && testMatches(ask.test, source, spell, null);
    }
    if (ask.on === "kind") {
        const source = dataset.source(ask.kind.column);
        return source !== null && testMatches(ask.test, source, spell, ask.kind);
    }
    const source = dataset.source(ask.ref.kind.column);
    if (source === null) return false;
    const rows = kindRows(source, spell, ask.ref.kind);
    const value = ask.value;
    if (value === null) return rows.length > 0;
    return rows.some((row) => rowMatches(row, {on: "props", props: [ask.ref], value}));
}

/** Chipless search: the union over every column's rows of the properties that declare themselves plain. */
function plainAskMatches(value: ValueExpr, dataset: Dataset, spell: number): boolean {
    for (const column of COLUMNS.values()) {
        const source = dataset.source(column);
        if (source === null) continue;
        if (source.rows(spell).some((row) => plainMatches(row, value))) return true;
    }
    return false;
}

/** The rows one spell has of one kind, or all of its rows in the column when no kind narrows them. */
function kindRows(source: RowSource, spell: number, kind: Kind | null): readonly Row[] {
    const rows = source.rows(spell);
    return kind === null ? rows : rows.filter((row) => row.kind === kind);
}

/**
 * Tests one spell's rows against a clause's row test.
 *
 * @param test The test. `null` accompanies an incomplete head and asks nothing beyond existence.
 * @param source The column's rows.
 * @param spell The spell's index.
 * @param kind The kind narrowing the rows, or `null` for the whole column.
 * @returns Whether the rows satisfy the test.
 */
function testMatches(test: RowTest | null, source: RowSource, spell: number, kind: Kind | null): boolean {
    if (test === null || test.is === "exists") {
        if (kind === null && source.size !== undefined) return source.size(spell) > 0;
        return kindRows(source, spell, kind).length > 0;
    }
    const rows = kindRows(source, spell, kind);
    if (test.is === "content") return rows.some((row) => rowMatches(row, {on: "content", value: test.value}));
    if (test.is === "props") {
        return rows.some((row) => rowMatches(row, {on: "props", props: test.props, value: test.value}));
    }
    return test.terms.some((conjunction) => conjunctionMatches(conjunction, rows));
}

/**
 * Tests one scope conjunction: one row must satisfy every row-level term, and the set of rows that do must satisfy
 * every count term.
 *
 * Incomplete terms are display-only and skipped. A negated row-level term negates per row; a negated count term
 * negates the comparison.
 */
function conjunctionMatches(conjunction: readonly ScopeTerm[], rows: readonly Row[]): boolean {
    const rowTerms: { readonly not: boolean; readonly ask: RowAsk }[] = [];
    const countTerms: { readonly not: boolean; readonly value: ValueExpr }[] = [];
    for (const term of conjunction) {
        if (term.state !== "ok" || term.ask === null) continue;
        if (term.ask.on === "count") countTerms.push({not: term.not, value: term.ask.value});
        else rowTerms.push({not: term.not, ask: term.ask});
    }

    const satisfying = rows.filter((row) => rowTerms.every((term) => rowMatches(row, term.ask) !== term.not));
    if (countTerms.length === 0) return satisfying.length > 0;
    return countTerms.every((term) => countMatches(term.value, satisfying.length) !== term.not);
}

/** Tests a row count against a count expression. The operands arrive already typed by the parser's desugar. */
function countMatches(expr: ValueExpr, size: number): boolean {
    switch (expr.op) {
        case "anyOf":
            return expr.alternatives.some((alt) => countMatches(alt, size));
        case "present":
            return size > 0;
        case "range": {
            const bounds = [expr.lo, expr.hi].map((bound) => ("type" in bound ? bound.value : Number(bound.text)));
            return runCount("range", size, bounds);
        }
        default: {
            const operand = "type" in expr.operand ? expr.operand.value : Number(expr.operand.text);
            return runCount(expr.op, size, operand);
        }
    }
}

/** Runs one count comparison through the matcher table, so a count and a stored number cannot diverge. */
function runCount(op: string, size: number, operand: Value | readonly Value[]): boolean {
    const test = matcher(op, count.name);
    if (test === undefined) throw new Error(`no matcher for operator "${op}" on type "${count.name}"`);
    return test(size, operand);
}
