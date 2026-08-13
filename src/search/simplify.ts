/**
 * @file Query simplification: meaning-preserving rewrites of the parse tree, as a guarded fixpoint.
 *
 * The shape query engines use for this — Lucene's `BooleanQuery.rewrite`, the SQL optimizer's predicate
 * simplification — is a fixpoint of small, local, meaning-preserving rewrites, and that is the shape here: each rule
 * takes the whole tree and returns a rewritten tree or `null`, the driver loops until no rule fires, and every
 * accepted rewrite is round-trip guarded. Truth-table minimisation is deliberately absent: the atoms here carry
 * implication structure — substrings, intervals, bit roles — that independent-variable minimisers cannot see.
 *
 * Three design commitments hold the module together:
 *
 * - **The rules are data.** {@link RULES} and {@link KEPT} carry each rule's law and examples as records, so the rule
 *   set can be printed, tested fixture-by-fixture, and audited without running a rewrite. A rule that rewrites also
 *   carries its `apply` function; the format-tier rules carry none, because their rewrite is a spelling and lives in
 *   the formatter.
 * - **Implication grounds in the live machinery.** Whether one value ask implies another is decided by running the
 *   registered matchers over the other side's operand, resolving operands through the evaluator's own dispatch
 *   ({@link resolveOperand}), and exhausting the bit universe for masks — never by a second copy of any matching
 *   rule. Everything the machinery cannot certify is left untouched: undecided means untouched.
 * - **Every rewrite is round-trip guarded.** A rewritten tree is formatted, re-parsed, and compared both textually
 *   and structurally; a rewrite whose spelling does not re-read as the same question abandons itself. The structural
 *   half is load-bearing where the textual half is blind: a kind without a top-level word formats its existence ask
 *   to a spelling that re-reads as plain text, and both structures format to the same string — only the shapes
 *   disagree.
 *
 * The engine names no axis. It branches on declarations only — `quantity`, {@link SUBSTRING_TYPES}, `prop.prefix`,
 * the operator and matcher registries — so a new axis, kind or type is simplified correctly with zero edits here.
 *
 * Simplification is explicit-only: no surface calls this unprompted. The command line (`npm run simplify`) is the
 * one door until the interface grows its button. The rules also stand alone: {@link suggestions} runs each by
 * itself, so a surface can offer every applicable rewrite as its own one-click suggestion rather than the whole
 * fixpoint at once. And {@link equivalent} lives here rather than beside the formatter because equivalence reads
 * through simplification: two queries ask the same question exactly when their simplified canonical forms agree.
 */
// The instance rather than the bare `t`, because several closures here take a parameter named `t` and would shadow
// the import.
import {i18n} from "../i18n";
import type {Column} from "./columns";
import {clauseKey, formatQuery, queryKey, termKey, unbracedTerm} from "./format";
import type {Kind, Prop} from "./kinds";
import {sentinelOf} from "./kinds";
import type {
    Ask, Clause, Parsed, ParsedOperand, PropRef, RowTest, ScopeAsk, ScopeTerm, Span, ValueExpr,
} from "./parse";
import {anyOfExpr, COUNT_PROP, parse, propOf} from "./parse";
import {resolveOperand, textOf} from "./rows";
import {kindsOf} from "./schema";
import type {AxisType} from "./value-types";
import {matcher, ROLE_MASK_LIMIT, SUBSTRING_TYPES} from "./value-matching";

/* ----------------------------------------------------------------- the public surface */

/** What {@link simplify} returns: the simplified parse, the rules that fired, and anything worth telling the user. */
export interface Simplified {
    /**
     * The simplified query — or the input, untouched, when nothing rewrote. A rewritten parse is synthetic: its
     * clauses carry no positions in any typed text, but they do carry the input's own value spellings wherever a
     * value survived, so the written tier survives simplification exactly as the notation boundary promises.
     */
    readonly parsed: Parsed;

    /** The ids of the rules that fired, in first-fired order, each listed once. */
    readonly applied: readonly string[];

    /** Findings in the reader's words: a query that constrains nothing, or one whose every alternative is dead. */
    readonly notes: readonly string[];
}

/** Which layer of the pipeline owns a rule: lenient reading, canonical spelling, or tree rewriting. */
export type RuleTier = "parse" | "format" | "simplify";

/** One worked example of a rule: the query as written, and the query it becomes. */
export interface RuleExample {
    readonly from: string;
    readonly to: string;
}

/**
 * One simplification rule, as a record.
 *
 * `apply` rewrites the whole tree or returns `null` for "nothing to do"; it is absent on rules whose tier is not
 * `simplify`, because a parse-tier rule is a lenient reading and a format-tier rule is a spelling — both live in
 * their own modules, and their records here exist so one registry can print the whole rule set.
 */
export interface Rule {
    readonly id: string;
    readonly name: string;
    readonly tier: RuleTier;

    /** The law, in one line. */
    readonly law: string;

    readonly examples: readonly RuleExample[];

    readonly apply?: (tree: Tree, ctx: Ctx) => Tree | null;
}

/** One boundary: a rewrite deliberately not performed, and why. */
export interface Boundary {
    readonly id: string;
    readonly name: string;

    /** What is kept as written. */
    readonly keeps: string;

    /** Why rewriting it would be wrong, or wrongly grounded. */
    readonly why: string;
}

/* ----------------------------------------------------------------------- the tree model */

/**
 * One member of a conjunction: an ask, possibly negated. The evaluable content of one top-level clause.
 *
 * The rules rewrite these rather than {@link Clause} objects because a clause carries spans and states that belong
 * to the text as typed; the simplified query has no typed text until it is formatted.
 */
interface Lit {
    readonly not: boolean;
    readonly ask: Ask;
}

/** The query being rewritten: alternation groups of conjunctions — the same normal form `Parsed.groups` spells. */
type Tree = ReadonlyArray<readonly Lit[]>;

/** What the driver hands each rule besides the tree. */
interface Ctx {
    /** Records a finding for the user. Deduplicated, so a rule re-examined by the fixpoint stays quiet. */
    note(text: string): void;
}

/** The span every synthetic node carries: simplified structure has no position in any typed text. */
const NOWHERE: Span = {start: 0, end: 0};

/** The evaluable content of a parse, as the tree the rules rewrite. */
function treeOf(parsed: Parsed): Tree {
    return parsed.groups.map((group) => group
        .map((index) => parsed.clauses[index])
        .flatMap((clause): Lit[] => (clause.ask === null ? [] : [{not: clause.not, ask: clause.ask}])));
}

/** A tree back as a parse, for formatting and for the guard. Every clause is synthetic and evaluable. */
function toParsed(tree: Tree): Parsed {
    const clauses: Clause[] = [];
    const groups: number[][] = [];
    for (const conjunction of tree) {
        const group: number[] = [];
        for (const lit of conjunction) {
            group.push(clauses.length);
            clauses.push({span: NOWHERE, not: lit.not, state: "ok", ask: lit.ask});
        }
        groups.push(group);
    }
    return {clauses, groups, diagnostics: []};
}

/** A scope term with synthetic position, for building rewritten scopes. */
const term = (not: boolean, ask: ScopeAsk): ScopeTerm => ({span: NOWHERE, not, state: "ok", ask});

/**
 * One lit's identity: its folded canonical text, the same identity {@link equivalent} compares clauses by.
 *
 * `null` marks a lit nothing can be said about; the algebra treats it as equal to nothing, itself included.
 */
function keyOfLit(lit: Lit): string | null {
    return clauseKey({span: NOWHERE, not: lit.not, state: "ok", ask: lit.ask});
}

/** The identity of an ask's positive reading, for the oracle's cheap first answer. */
function keyOfAsk(ask: Ask): string | null {
    return keyOfLit({not: false, ask});
}

/**
 * A member's identity signed with its polarity, unkeyable members marked by a sentinel — the encoding every
 * alternation-level comparison reads, so the sign characters and the sentinel live once.
 */
const signedKey = (not: boolean, key: string | null): string => `${not ? "-" : "+"}${key ?? "\u0000"}`;

/** Every clause's signed identity, in group order. */
const litKeys = (group: readonly Lit[]): string[] => group.map((lit) => signedKey(lit.not, keyOfLit(lit)));

/** Every term's signed identity, in run order. */
const termKeys = (run: readonly ScopeTerm[]): string[] => run.map((t) => signedKey(t.not, termKey(t)));

/* ------------------------------------------------------------------- structural identity
 *
 * The guard compares a rewritten tree against the re-parse of its own spelling. Text alone is not enough: two
 * different structures can format to one string — a kind with no top-level word spells its existence ask
 * `word:*`, which re-reads as a plain glob and formats back to the very same characters. So the guard also
 * compares shapes: declarations collapsed to their ids, written spellings and positions dropped, order
 * normalised everywhere order does not matter.
 */

/** A JSON-ready shape for one operand: its folded text, or its typed value. */
function operandShape(operand: ParsedOperand): unknown {
    return "text" in operand ? {text: operand.text.toLowerCase()} : {type: operand.type, value: operand.value};
}

/** A JSON-ready shape for one value expression. */
function valueShape(value: ValueExpr): unknown {
    switch (value.op) {
        case "present":
            return {op: value.op};
        case "range":
            return {op: value.op, lo: operandShape(value.lo), hi: operandShape(value.hi)};
        case "anyOf":
            return {op: value.op, alternatives: sortedShapes(value.alternatives.map(valueShape))};
        default:
            return {op: value.op, operand: operandShape(value.operand)};
    }
}

/** A JSON-ready shape for one scope term, or `null` for a term with nothing evaluable. */
function termShape(t: ScopeTerm): unknown {
    if (t.state !== "ok" || t.ask === null) return null;
    const ask = t.ask;
    if (ask.on === "content") return {not: t.not, on: ask.on, value: valueShape(ask.value)};
    if (ask.on === "kindWord") return {not: t.not, on: ask.on, kind: ask.kind.id};
    if (ask.on === "count") return {not: t.not, on: ask.on, value: valueShape(ask.value)};
    return {not: t.not, on: ask.on, props: refIds(ask.props), value: valueShape(ask.value)};
}

const refIds = (refs: readonly PropRef[]): string[] => refs.map((ref) => `${ref.kind.id}.${ref.prop}`).toSorted();

/** Serialises shapes and sorts them, because the order of conjuncts and alternatives never matters. */
function sortedShapes(shapes: readonly unknown[]): string[] {
    return shapes.filter((shape) => shape !== null).map((shape) => JSON.stringify(shape)).toSorted();
}

/** A JSON-ready shape for one row test. */
function testShape(test: RowTest | null): unknown {
    if (test === null || test.is === "exists") return {is: "exists"};
    if (test.is === "content") return {is: test.is, value: valueShape(test.value)};
    if (test.is === "props") return {is: test.is, props: refIds(test.props), value: valueShape(test.value)};
    return {is: test.is, terms: sortedShapes(test.terms.map((run) => sortedShapes(run.map(termShape))))};
}

/**
 * The ask an ask's own spelling re-reads as: a scope that sheds its braces — {@link unbracedTerm}, the decision
 * shared with the formatter — unwraps exactly as it spells, and a scope with nothing evaluable spells existence.
 *
 * Shapes must compare modulo this unwrapping, because the two structures are one question with one spelling —
 * `model:{fire}` formats braceless and re-parses as the content test — and a guard that separated them would
 * reject any rewrite of a tree that happens to still carry the scope-shaped parse of that spelling elsewhere.
 * A promoted count needs nothing here: its braceless spelling re-parses back to the same one-term scope.
 */
function spelledAsk(ask: Ask): Ask {
    if (ask.on !== "column" && ask.on !== "kind") return ask;
    const test = ask.test;
    if (test === null || test.is !== "scope") return ask;
    if (test.terms.flat().every((t) => t.state !== "ok" || t.ask === null)) return {...ask, test: {is: "exists"}};
    const lone = unbracedTerm(test.terms);
    if (lone === null || lone.ask?.on === "count") return ask;
    return unwrappedAsk(ask, lone);
}

/** A JSON-ready shape for one clause's ask. */
function askShape(raw: Ask): unknown {
    const ask = spelledAsk(raw);
    if (ask.on === "plain") return {on: ask.on, value: valueShape(ask.value)};
    if (ask.on === "column") return {on: ask.on, column: ask.column.key, test: testShape(ask.test)};
    if (ask.on === "kind") return {on: ask.on, kind: ask.kind.id, test: testShape(ask.test)};
    return {on: ask.on, ref: refIds([ask.ref]), value: ask.value === null ? null : valueShape(ask.value)};
}

/** One string per parse that two structurally identical queries share. */
function shapeOf(parsed: Parsed): string {
    const groups = parsed.groups.map((group) => sortedShapes(group.map((index) => {
        const clause = parsed.clauses[index];
        return clause.ask === null ? null : {not: clause.not, ask: askShape(clause.ask)};
    })));
    return JSON.stringify(groups.map((group) => group.join("\u0000")).toSorted());
}

/* ------------------------------------------------------------------ the implication oracle
 *
 * `implies(a, b)` answers "does everything matching a also match b" — on every dataset, which is what makes a
 * rewrite a rule rather than an observation about one pack. Soundness over completeness: `true` must be a proof,
 * `false` only means "not certified", and every undecided case returns `false` so the rewrite it would have
 * licensed simply does not happen.
 */

/** The kinds whose rows a column-or-kind ask ranges over — the scope a content term dispatches across. */
function scopeKinds(ask: Ask): readonly Kind[] {
    if (ask.on === "column") return kindsOf(ask.column);
    if (ask.on === "kind") return [ask.kind];
    if (ask.on === "prop") return [ask.ref.kind];
    return [];
}

/** A closed-or-open numeric interval, with the notation that read its bounds. */
interface Interval {
    readonly type: AxisType;
    readonly lo: number;
    readonly hi: number;
    readonly loOpen: boolean;
    readonly hiOpen: boolean;
}

/** Resolves one operand as a quantity through the evaluator's own dispatch, or refuses. */
function quantityOf(prop: Prop, operand: ParsedOperand): { type: AxisType; value: number } | null {
    const resolved = resolveOperand(prop, operand, prop.types);
    if (resolved === null || resolved.type.quantity !== true || typeof resolved.value !== "number") return null;
    return {type: resolved.type, value: resolved.value};
}

/**
 * The interval of stored values one expression selects on a property, or `null` where it does not read as one.
 *
 * A range's bounds must resolve in one notation, exactly as evaluation requires, and print low-first is not assumed:
 * the matcher sorts bounds, so the interval sorts too.
 */
function intervalOf(prop: Prop, expr: ValueExpr): Interval | null {
    switch (expr.op) {
        case "exact": {
            const q = quantityOf(prop, expr.operand);
            return q === null ? null : {type: q.type, lo: q.value, hi: q.value, loOpen: false, hiOpen: false};
        }
        case "lt":
        case "lte": {
            const q = quantityOf(prop, expr.operand);
            if (q === null) return null;
            return {type: q.type, lo: -Infinity, hi: q.value, loOpen: false, hiOpen: expr.op === "lt"};
        }
        case "gt":
        case "gte": {
            const q = quantityOf(prop, expr.operand);
            if (q === null) return null;
            return {type: q.type, lo: q.value, hi: Infinity, loOpen: expr.op === "gt", hiOpen: false};
        }
        case "range": {
            const lo = quantityOf(prop, expr.lo);
            const hi = quantityOf(prop, expr.hi);
            if (lo === null || hi === null || lo.type !== hi.type) return null;
            return {
                type: lo.type,
                lo: Math.min(lo.value, hi.value), hi: Math.max(lo.value, hi.value),
                loOpen: false, hiOpen: false,
            };
        }
        default:
            return null;
    }
}

/** Whether interval `a` is contained in interval `b`, bounds and openness respected. */
function subInterval(a: Interval, b: Interval): boolean {
    if (a.type !== b.type) return false;
    const loHolds = b.lo < a.lo || (b.lo === a.lo && (!b.loOpen || a.loOpen));
    const hiHolds = a.hi < b.hi || (a.hi === b.hi && (!b.hiOpen || a.hiOpen));
    return loHolds && hiHolds;
}

/** Whether interval `a` ends before interval `b` begins, openness respected. */
function endsBelow(a: Interval, b: Interval): boolean {
    return a.hi < b.lo || (a.hi === b.lo && (a.hiOpen || b.loOpen));
}

/** Whether two intervals share no point. */
function disjoint(a: Interval, b: Interval): boolean {
    return endsBelow(a, b) || endsBelow(b, a);
}

/** Whether a number lies inside an interval. */
function inInterval(iv: Interval, n: number): boolean {
    return (n > iv.lo || (n === iv.lo && !iv.loOpen)) && (n < iv.hi || (n === iv.hi && !iv.hiOpen));
}

/** Whether an interval is closed and bounded on both sides — the shape a range leaf can spell. */
function closedInterval(iv: Interval): boolean {
    return !iv.loOpen && !iv.hiOpen && Number.isFinite(iv.lo) && Number.isFinite(iv.hi);
}

/**
 * Role-to-role implication on a bitmask property, decided by exhausting every distinguishable mask through the
 * matcher — {@link ROLE_MASK_LIMIT} bounds them from the role declarations — with no second copy of the role table.
 */
function impliesRole(type: AxisType, a: ParsedOperand, b: ParsedOperand): boolean {
    const run = matcher("exact", type.name);
    if (run === undefined) return false;
    const aText = textOf(a);
    const bText = textOf(b);
    // An operand no mask satisfies is not a role; implication from the empty set proves nothing worth acting on.
    let satisfiable = false;
    for (let mask = 0; mask < ROLE_MASK_LIMIT; mask++) {
        if (!run(mask, aText)) continue;
        if (!run(mask, bText)) return false;
        satisfiable = true;
    }
    return satisfiable;
}

/** The operators whose operand is one value that reads as text. */
const TEXT_OPS: ReadonlySet<string> = new Set(["exact", "contains", "glob"]);

/**
 * Substring-family implication on one notation, grounded by running the registered matchers over the operands.
 *
 * The family is exactly {@link SUBSTRING_TYPES}: stored text is matched by squash-substring, and squashing is a
 * congruence — two fold-equal values squash equally — so "a's operand contains b's operand" transfers to every
 * stored value a selects. A glob contributes through its literal runs: whatever matches the glob contains each
 * run, so a run containing b's operand carries the implication. Ordinals join only for `contains` against
 * `contains`; their anchored and ordered operators compare by rank on a ladder the pack supplies, which is a fact
 * about one dataset and out of bounds here.
 */
function impliesText(type: AxisType, aOp: string, a: ParsedOperand, bOp: string, b: ParsedOperand): boolean {
    if (!SUBSTRING_TYPES.includes(type.name)) return false;
    if (!TEXT_OPS.has(aOp) || !TEXT_OPS.has(bOp)) return false;
    if (type.name === "ordinal" && (aOp !== "contains" || bOp !== "contains")) return false;
    const test = (op: string, stored: string, operand: string): boolean =>
        matcher(op, type.name)?.(stored, operand) ?? false;
    const aText = textOf(a);
    const bText = textOf(b);
    if (bOp === "contains") {
        if (aOp === "glob") return aText.split("*").some((run) => test("contains", run, bText));
        return test("contains", aText, bText);
    }
    if (bOp === "exact") return aOp === "exact" && test("exact", aText, bText);
    if (bOp === "glob") return aOp === "exact" && test("glob", aText, bText);
    return false;
}

/** Implication between two value expressions bound to one property. */
function impliesPropValue(prop: Prop, a: ValueExpr, b: ValueExpr): boolean {
    if (b.op === "present") return true;
    if (a.op === "anyOf") return a.alternatives.every((alt) => impliesPropValue(prop, alt, b));
    if (b.op === "anyOf") return b.alternatives.some((alt) => impliesPropValue(prop, a, alt));
    if (a.op === "present" || a.op === "regex" || b.op === "regex") return false;

    const ia = intervalOf(prop, a);
    const ib = intervalOf(prop, b);
    if (ia !== null && ib !== null) return subInterval(ia, ib);
    if (ia !== null || ib !== null) return false;

    if (a.op === "range" || b.op === "range") return false;
    if (prop.types[0].name === "bitmask") return impliesRole(prop.types[0], a.operand, b.operand);

    const ra = resolveOperand(prop, a.operand, prop.types);
    const rb = resolveOperand(prop, b.operand, prop.types);
    if (ra === null || rb === null || ra.type !== rb.type) return false;
    return impliesText(ra.type, a.op, a.operand, b.op, b.operand);
}

/**
 * Whether a content operand is safe for substring reasoning across every property it could dispatch to.
 *
 * A content term is a union over the row's properties, each applying its own bare reading. Substring transfer is
 * sound only where every reading in play is a substring reading: an operand that a sentinel answers, or that some
 * property reads as a quantity, a colour or a role, matches by equality or nearness instead, and nothing about one
 * operand containing another transfers through those.
 */
function contentSafe(kinds: readonly Kind[], operand: ParsedOperand): boolean {
    if (!("text" in operand)) return false;
    return kinds.every((kind) => Object.values(kind.props).every((prop) => {
        if (sentinelOf(prop, operand.text) !== null) return false;
        const resolved = resolveOperand(prop, operand, prop.types);
        return resolved === null || SUBSTRING_TYPES.includes(resolved.type.name);
    }));
}

/** Implication between two content terms dispatching over the same kinds. */
function impliesContentValue(kinds: readonly Kind[], a: ValueExpr, b: ValueExpr): boolean {
    if (a.op === "anyOf") return a.alternatives.every((alt) => impliesContentValue(kinds, alt, b));
    if (b.op === "anyOf") return b.alternatives.some((alt) => impliesContentValue(kinds, a, alt));
    // TEXT_OPS spelled out, because the compiler narrows the expression union only on literal comparisons.
    if (a.op !== "exact" && a.op !== "contains" && a.op !== "glob") return false;
    if (b.op !== "contains") return false;
    const aOperand = a.operand;
    const bOperand = b.operand;
    if (!contentSafe(kinds, bOperand)) return false;
    const test = matcher("contains", "text");
    if (a.op === "glob") {
        // A glob dispatches only where patterns read, but whatever it matches contains each of its literal runs,
        // so a run containing b's operand carries the implication to every property in play.
        return textOf(aOperand).split("*").some((piece) => test?.(piece, textOf(bOperand)) ?? false);
    }
    if (!contentSafe(kinds, aOperand)) return false;
    return test?.(textOf(aOperand), textOf(bOperand)) ?? false;
}

/** Implication between two row-level scope asks, pointwise over one row of one of the given kinds. */
function impliesTermAsk(kinds: readonly Kind[], a: ScopeAsk, b: ScopeAsk): boolean {
    if (a.on === "count" || b.on === "count") return false;
    const ka = termKey(term(false, a));
    const kb = termKey(term(false, b));
    if (ka !== null && ka === kb) return true;
    if (a.on === "kindWord" || b.on === "kindWord") return a.on === "kindWord" && b.on === "kindWord" && a.kind === b.kind;
    if (a.on === "content" && b.on === "content") return impliesContentValue(kinds, a.value, b.value);
    if (a.on === "props" && b.on === "props") {
        if (a.props.length !== 1 || b.props.length !== 1) return false;
        const [ra] = a.props;
        const [rb] = b.props;
        if (ra.kind !== rb.kind || ra.prop !== rb.prop) return false;
        return impliesPropValue(propOf(ra), a.value, b.value);
    }
    if (a.on === "props" && b.on === "content") {
        // A property match implies a content match through the same property: the stored value that answered `a`
        // answers `b` under the same dispatch, and a content term is a union that any one property may satisfy.
        return a.props.length === 1 && impliesPropValue(propOf(a.props[0]), a.value, b.value);
    }
    return false;
}

/** One scope term reduced to what the run algebra reasons over. */
interface NormTerm {
    readonly not: boolean;
    readonly ask: ScopeAsk;
}

/** One conjunction of scope asks, its count terms split out — the normal form both run levels compare in. */
interface NormRun {
    readonly rows: readonly NormTerm[];
    readonly counts: readonly NormTerm[];
}

/** Splits a run into row-level and count terms, dropping anything not evaluable. */
function normRun(terms: readonly NormTerm[]): NormRun {
    return {
        rows: terms.filter((t) => t.ask.on !== "count"),
        counts: terms.filter((t) => t.ask.on === "count"),
    };
}

/**
 * A column-or-kind-or-property ask lowered to alternation runs over one column, the one normal form ask-level
 * implication compares in.
 *
 * A kind ask narrows every run with its own kind word; a property ask is its kind plus one property term — exactly
 * how the kernel evaluates each. `null` marks an ask that does not lower: plain search ranges over every column.
 */
function loweredAsk(ask: Ask): { column: Column; kinds: readonly Kind[]; runs: readonly NormRun[] } | null {
    if (ask.on === "plain") return null;
    if (ask.on === "prop") {
        const runs = [normRun([
            {not: false, ask: {on: "kindWord", kind: ask.ref.kind}},
            ...(ask.value === null ? [] : [{
                not: false,
                ask: {on: "props", props: [ask.ref], value: ask.value} as ScopeAsk
            }]),
        ])];
        return {column: ask.ref.kind.column, kinds: [ask.ref.kind], runs};
    }
    const narrowing: NormTerm[] = ask.on === "kind" ? [{not: false, ask: {on: "kindWord", kind: ask.kind}}] : [];
    const test = ask.test;
    const bare = (terms: readonly NormTerm[]): NormRun => normRun([...narrowing, ...terms]);
    let runs: NormRun[];
    if (test === null || test.is === "exists") runs = [bare([])];
    else if (test.is === "content") runs = [bare([{not: false, ask: {on: "content", value: test.value}}])];
    else if (test.is === "props") runs = [bare([{
        not: false,
        ask: {on: "props", props: test.props, value: test.value}
    }])];
    else {
        runs = test.terms.map((run) => bare(run.flatMap((t): NormTerm[] =>
            (t.state === "ok" && t.ask !== null ? [{not: t.not, ask: t.ask}] : []))));
    }
    return {column: ask.on === "column" ? ask.column : ask.kind.column, kinds: scopeKinds(ask), runs};
}

/** How a count constraint relates to zero and to "one or more", over the whole numbers a count lives in. */
type CountClass = "zero" | "some" | "any" | "never";

/**
 * Classifies one count term at the edges where a count is an existence fact.
 *
 * Counts are whole and non-negative, so the classification asks two questions of the selected set: does it hold
 * zero, and does it hold every count from one up. Negation complements the set; a convex interval keeps the
 * complement decidable. `null` is every count constraint that is genuinely about a number, not existence.
 */
function countClassOf(t: NormTerm): CountClass | null {
    if (t.ask.on !== "count") return null;
    const iv = intervalOf(COUNT_PROP, t.ask.value);
    if (iv === null) return null;
    const holdsZero = inInterval(iv, 0);
    const coversFromOne = inInterval(iv, 1) && iv.hi === Infinity;
    const first = Math.max(1, Math.ceil(iv.loOpen && Number.isInteger(iv.lo) ? iv.lo + 1 : iv.lo));
    const touchesFromOne = Number.isFinite(first) ? inInterval(iv, first) : false;
    const [c0, covers, touches] = t.not
        ? [!holdsZero, !touchesFromOne, !coversFromOne]
        : [holdsZero, coversFromOne, touchesFromOne];
    if (c0 && covers) return "any";
    if (c0 && !touches) return "zero";
    if (!c0 && covers) return "some";
    if (!c0 && !touches) return "never";
    return null;
}

/** Whether a run's count terms all guarantee at least one satisfying row, making the run existential. */
const runExistential = (run: NormRun): boolean => run.counts.every((t) => countClassOf(t) === "some");

/** Whether one run implies another: a witness row for `a` is a witness for `b`, count constraints carried. */
function runImplies(kinds: readonly Kind[], a: NormRun, b: NormRun): boolean {
    const rowsHold = b.rows.every((tb) => (tb.not
        ? a.rows.some((ta) => ta.not && impliesTermAsk(kinds, tb.ask, ta.ask))
        : a.rows.some((ta) => !ta.not && impliesTermAsk(kinds, ta.ask, tb.ask))));
    if (!rowsHold) return false;
    if (a.counts.length === 0 && b.counts.length === 0) return true;

    // A count speaks about the set the run's row terms leave, so counts only compare between runs leaving the
    // same set — identical row-term identities — and a counted run only implies an uncounted one when its counts
    // guarantee a row exists at all.
    if (b.counts.length === 0) return runExistential(a);
    if (!sameRowTerms(a, b)) return false;
    return b.counts.every((tb) => a.counts.some((ta) => {
        if (ta.not || tb.not) return false;
        if (ta.ask.on !== "count" || tb.ask.on !== "count") return false;
        const ia = intervalOf(COUNT_PROP, ta.ask.value);
        const ib = intervalOf(COUNT_PROP, tb.ask.value);
        return ia !== null && ib !== null && subInterval(ia, ib);
    }));
}

/** Whether two runs constrain rows identically, by term identity. */
function sameRowTerms(a: NormRun, b: NormRun): boolean {
    const keysOf = (run: NormRun): string =>
        run.rows.map((t) => termKey(term(t.not, t.ask)) ?? "\u0000").toSorted().join("\u0001");
    return keysOf(a) === keysOf(b);
}

/**
 * Whether one clause's positive reading implies another's: everything `a` selects, `b` selects.
 *
 * Both asks lower to alternation runs over one column, and `a` implies `b` when every alternative of `a` lands
 * inside some alternative of `b`. Plain asks answer only by identity, because plain search ranges over every
 * column at once.
 */
function impliesAsk(a: Ask, b: Ask): boolean {
    const ka = keyOfAsk(a);
    if (ka !== null && ka === keyOfAsk(b)) return true;
    const la = loweredAsk(a);
    const lb = loweredAsk(b);
    if (la === null || lb === null || la.column !== lb.column) return false;
    return la.runs.every((ra) => lb.runs.some((rb) => runImplies(la.kinds, ra, rb)));
}

/* ---------------------------------------------------------------- the conjunction algebra
 *
 * One algebra serves both levels — top-level clauses in a group, and scope terms in a run — because the language
 * gives them the same structure: alternation groups of conjunctions of possibly-negated asks.
 */

/** The operations the algebra needs of one conjunction member. */
interface Members<T> {
    keyOf(item: T): string | null;

    negated(item: T): boolean;

    /** Positive-reading implication. The algebra flips it itself for negated members. */
    implies(a: T, b: T): boolean;
}

/** Removes duplicate members, first occurrence kept. Returns `null` when nothing repeats. */
function dedupeMembers<T>(items: readonly T[], alg: Members<T>): T[] | null {
    const seen = new Set<string>();
    const kept = items.filter((item) => {
        const key = alg.keyOf(item);
        if (key === null) return true;
        const signed = signedKey(alg.negated(item), key);
        if (seen.has(signed)) return false;
        seen.add(signed);
        return true;
    });
    return kept.length === items.length ? null : kept;
}

/**
 * Drops members implied by stronger members of the same polarity: a conjunction keeps the stronger ask, and a
 * negation of the weaker ask is the stronger negation. Returns `null` when nothing drops.
 */
function dropImpliedMembers<T>(items: readonly T[], alg: Members<T>): T[] | null {
    // Within a polarity, "s makes w redundant" reads s => w for positives and w => s for negatives — the same
    // test through the polarity flip. Walking in order and comparing against survivors keeps the first of a
    // mutually-implying pair, so the outcome cannot depend on which member a rule happened to visit first.
    const makesRedundant = (s: T, w: T): boolean =>
        alg.negated(s) ? alg.implies(w, s) : alg.implies(s, w);
    const kept: T[] = [];
    for (const item of items) {
        if (alg.keyOf(item) !== null
            && kept.some((k) => alg.negated(k) === alg.negated(item) && makesRedundant(k, item))) continue;
        for (let i = kept.length - 1; i >= 0; i--) {
            const k = kept[i];
            if (alg.negated(k) === alg.negated(item) && alg.keyOf(k) !== null && makesRedundant(item, k)) {
                kept.splice(i, 1);
            }
        }
        kept.push(item);
    }
    return kept.length === items.length ? null : kept;
}

/** Whether a conjunction contradicts itself: a positive member implies what a negated member excludes. */
function contradicts<T>(items: readonly T[], alg: Members<T>): boolean {
    const positives = items.filter((item) => !alg.negated(item));
    const negatives = items.filter((item) => alg.negated(item));
    return positives.some((p) => negatives.some((n) => alg.implies(p, n)));
}

/** The algebra over top-level clauses. */
const LITS: Members<Lit> = {
    keyOf: keyOfLit,
    negated: (lit) => lit.not,
    implies: (a, b) => impliesAsk(a.ask, b.ask),
};

/** The algebra over the terms of one scope, dispatching content across the scope's kinds. */
function termMembers(kinds: readonly Kind[]): Members<ScopeTerm> {
    return {
        keyOf: termKey,
        negated: (t) => t.not,
        implies: (a, b) => a.ask !== null && b.ask !== null && impliesTermAsk(kinds, a.ask, b.ask),
    };
}

/* -------------------------------------------------------------------------- the walkers */

/** Rewrites each top-level group through one function; `null` from every group means an unchanged tree. */
function mapGroups(tree: Tree, rewrite: (group: readonly Lit[]) => readonly Lit[] | null): Tree | null {
    let changed = false;
    const next = tree.map((group) => {
        const result = rewrite(group);
        if (result !== null) changed = true;
        return result ?? group;
    });
    return changed ? next : null;
}

/** Rewrites each clause through one function; `null` from every clause means an unchanged tree. */
function mapLits(tree: Tree, rewrite: (lit: Lit) => Lit | null): Tree | null {
    return mapGroups(tree, (group) => {
        let changed = false;
        const lits = group.map((lit) => {
            const next = rewrite(lit);
            if (next !== null) changed = true;
            return next ?? lit;
        });
        return changed ? lits : null;
    });
}

/** What a rule tells the reader about a query whose every alternative is dead. */
const ALL_DEAD = i18n.t("diagnostics:simplify.allDead");

/** What a scope rewrite may say about one clause's runs. */
type ScopeRewrite =
    | { readonly runs: ReadonlyArray<readonly ScopeTerm[]> }
    /** Every run is contradictory: the clause is satisfied by no spell at all. */
    | "unsatisfiable"
    | null;

/**
 * The unwrapped structure a promoted term's spelling re-reads as: a lone content term is the content test, a lone
 * kind word the kind-exists ask — a kind ask keeps its scope when the word names some other kind, where the
 * promoted spelling would not re-read. Which terms promote at all is {@link unbracedTerm}'s decision.
 */
function unwrappedAsk(ask: Ask & { on: "column" | "kind" }, lone: ScopeTerm): Ask {
    const only = lone.ask;
    if (only?.on === "content") return {...ask, test: {is: "content", value: only.value}};
    if (only?.on === "kindWord" && (ask.on !== "kind" || ask.kind === only.kind)) {
        return {on: "kind", kind: only.kind, test: {is: "exists"}};
    }
    return {...ask, test: {is: "scope", terms: [[lone]]}};
}

/**
 * The ask a rewritten run is left asking — spelled the way the formatter spells it, because a scope that sheds its
 * braces re-reads as the unwrapped structure. A promoted count keeps the scope: its braceless spelling re-reads as
 * this very structure, so there is nothing to unwrap.
 */
function unscopedAsk(ask: Ask & { on: "column" | "kind" }, rows: readonly ScopeTerm[]): Ask {
    const lone = unbracedTerm([rows]);
    if (lone !== null && lone.ask?.on !== "count") return unwrappedAsk(ask, lone);
    return {...ask, test: {is: "scope", terms: [rows]}};
}

/** A rewritten scope back as an ask: a single run unwraps where the spelling would, per {@link unscopedAsk}. */
function scopedAsk(ask: Ask & { on: "column" | "kind" }, runs: ReadonlyArray<readonly ScopeTerm[]>): Ask {
    if (runs.length === 1) return unscopedAsk(ask, runs[0]);
    return {...ask, test: {is: "scope", terms: runs}};
}

/**
 * Rewrites every row scope in the tree.
 *
 * An unsatisfiable scope resolves by clause polarity: a positive clause poisons its whole conjunction, so the
 * group drops; a negated clause excludes nothing, so the clause drops. A query whose every group dies this way is
 * returned untouched — the language has no "matches nothing" literal, and the empty query means everything.
 */
function mapScopes(
    tree: Tree, ctx: Ctx,
    rewrite: (runs: ReadonlyArray<readonly ScopeTerm[]>, kinds: readonly Kind[]) => ScopeRewrite,
): Tree | null {
    let changed = false;
    const groups: (readonly Lit[] | null)[] = tree.map((group) => {
        const lits: Lit[] = [];
        for (const lit of group) {
            const ask = lit.ask;
            if ((ask.on !== "column" && ask.on !== "kind") || ask.test === null || ask.test.is !== "scope") {
                lits.push(lit);
                continue;
            }
            const result = rewrite(ask.test.terms, scopeKinds(ask));
            if (result === null) {
                lits.push(lit);
            } else if (result === "unsatisfiable") {
                changed = true;
                if (!lit.not) return null;
            } else {
                changed = true;
                lits.push({not: lit.not, ask: scopedAsk(ask, result.runs)});
            }
        }
        return lits;
    });
    if (!changed) return null;
    const kept = groups.filter((group): group is readonly Lit[] => group !== null);
    if (kept.length === 0 && tree.length > 0) {
        ctx.note(ALL_DEAD);
        return null;
    }
    return kept;
}

/** Where one value expression sits: the property it binds, or the kinds a content term dispatches across. */
interface ValueSite {
    readonly prop: Prop | null;
    readonly kinds: readonly Kind[];

    /** The identity of one expression at this site, for deduplication. */
    keyFor(value: ValueExpr): string | null;
}

/** The site of a value bound to one property, keyed through a synthetic property term. */
function propSite(ref: PropRef): ValueSite {
    return {
        prop: propOf(ref), kinds: [ref.kind],
        keyFor: (value) => termKey(term(false, {on: "props", props: [ref], value})),
    };
}

/** The site of a content value, keyed through a synthetic content term. */
function contentSite(kinds: readonly Kind[]): ValueSite {
    return {
        prop: null, kinds,
        keyFor: (value) => termKey(term(false, {on: "content", value})),
    };
}

/** The site of a count value. */
const COUNT_SITE: ValueSite = {
    prop: COUNT_PROP, kinds: [],
    keyFor: (value) => termKey(term(false, {on: "count", value})),
};

/** Implication between two expressions at one site, whichever half of the oracle the site calls for. */
function impliesAtSite(site: ValueSite, a: ValueExpr, b: ValueExpr): boolean {
    if (site.prop !== null) return impliesPropValue(site.prop, a, b);
    return impliesContentValue(site.kinds, a, b);
}

/**
 * Rewrites every value expression in the tree, visiting each site with its property or content context.
 *
 * The function receives whole top-level expressions; recursing into a group's alternatives is each rule's own
 * decision, because some rules act on the group and others on its members.
 */
function mapValues(tree: Tree, rewrite: (value: ValueExpr, site: ValueSite) => ValueExpr | null): Tree | null {
    const rewriteTest = (test: RowTest | null, kinds: readonly Kind[]): RowTest | null => {
        if (test === null || test.is === "exists") return null;
        if (test.is === "content") {
            const value = rewrite(test.value, contentSite(kinds));
            return value === null ? null : {is: "content", value};
        }
        if (test.is === "props") {
            const site = test.props.length === 1 ? propSite(test.props[0]) : null;
            if (site === null) return null;
            const value = rewrite(test.value, site);
            return value === null ? null : {is: "props", props: test.props, value};
        }
        let changed = false;
        const terms = test.terms.map((run) => run.map((t) => {
            if (t.state !== "ok" || t.ask === null) return t;
            const site = t.ask.on === "content" ? contentSite(kinds)
                : t.ask.on === "count" ? COUNT_SITE
                    : t.ask.on === "props" && t.ask.props.length === 1 ? propSite(t.ask.props[0]) : null;
            if (site === null || t.ask.on === "kindWord") return t;
            const value = rewrite(t.ask.value, site);
            if (value === null) return t;
            changed = true;
            return {...t, ask: {...t.ask, value}};
        }));
        return changed ? {is: "scope", terms} : null;
    };

    return mapLits(tree, (lit) => {
        const ask = lit.ask;
        if (ask.on === "prop" && ask.value !== null) {
            const value = rewrite(ask.value, propSite(ask.ref));
            return value === null ? null : {not: lit.not, ask: {...ask, value}};
        }
        if (ask.on === "column" || ask.on === "kind") {
            const test = rewriteTest(ask.test, scopeKinds(ask));
            return test === null ? null : {not: lit.not, ask: {...ask, test}};
        }
        return null;
    });
}

/* ------------------------------------------------------------------------------ the rules */

/**
 * A rule that applies one conjunction reducer at both levels: each top-level group, then each run of every scope.
 * R1 and R3 are this one shape with different reducers, so the walking lives once.
 */
function memberRule(reduce: <T>(items: readonly T[], alg: Members<T>) => T[] | null):
    (tree: Tree, ctx: Ctx) => Tree | null {
    return (tree, ctx) => {
        const topLevel = mapGroups(tree, (group) => reduce(group, LITS));
        if (topLevel !== null) return topLevel;
        return mapScopes(tree, ctx, (runs, kinds) => {
            const alg = termMembers(kinds);
            let changed = false;
            const next = runs.map((run) => {
                const reduced = reduce(run, alg);
                if (reduced !== null) changed = true;
                return reduced ?? run;
            });
            return changed ? {runs: next} : null;
        });
    };
}

/** R1: a conjunction never asks one question twice, at either level. */
const duplicateClause = memberRule(dedupeMembers);

/** R2: an alternation never offers one alternative twice. */
function duplicateGroup(tree: Tree, ctx: Ctx): Tree | null {
    const topLevel = dedupeRuns(tree, (group) => litKeys(group).toSorted().join("\u0001"));
    if (topLevel !== null) return topLevel;
    return mapScopes(tree, ctx, (runs) => {
        const deduped = dedupeRuns(runs, (run) => termKeys(run).toSorted().join("\u0001"));
        return deduped === null ? null : {runs: deduped};
    });
}

/** Removes duplicate alternatives from one alternation, whatever its members are. */
function dedupeRuns<T>(runs: ReadonlyArray<T>, keyOf: (run: T) => string): T[] | null {
    const seen = new Set<string>();
    const kept = runs.filter((run) => {
        const key = keyOf(run);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return kept.length === runs.length ? null : kept;
}

/** R3: a conjunction keeps the stronger ask, at either level and in either polarity. */
const impliedClause = memberRule(dropImpliedMembers);

/** R4: an alternation absorbs an alternative that only restates another with extra conditions. */
function impliedGroup(tree: Tree, ctx: Ctx): Tree | null {
    const topLevel = absorbRuns(tree, litKeys);
    if (topLevel !== null) return topLevel;
    return mapScopes(tree, ctx, (runs) => {
        const absorbed = absorbRuns(runs, (run) => termKeys(run.filter((t) => t.state === "ok" && t.ask !== null)));
        return absorbed === null ? null : {runs: absorbed};
    });
}

/** Drops any alternation member whose member-keys are a superset of another's: `A | A B` selects what `A` does. */
function absorbRuns<T>(runs: ReadonlyArray<T>, keysOf: (run: T) => string[]): T[] | null {
    const keySets = runs.map((run) => new Set(keysOf(run)));
    const absorbed = new Set<number>();
    for (let a = 0; a < runs.length; a++) {
        for (let b = 0; b < runs.length; b++) {
            if (a === b || absorbed.has(a) || absorbed.has(b)) continue;
            if (keySets[a].size < keySets[b].size && [...keySets[a]].every((key) => keySets[b].has(key))) {
                absorbed.add(b);
            }
        }
    }
    if (absorbed.size === 0) return null;
    return runs.filter((_, index) => !absorbed.has(index));
}

/** R5: a contradictory alternative is dropped; a query of nothing but contradictions is left as written. */
function contradiction(tree: Tree, ctx: Ctx): Tree | null {
    const dead = tree.map((group) => contradicts(group, LITS));
    if (dead.some(Boolean)) {
        const kept = tree.filter((_, index) => !dead[index]);
        if (kept.length === 0) {
            ctx.note(ALL_DEAD);
            return null;
        }
        return kept;
    }
    return mapScopes(tree, ctx, (runs, kinds) => {
        const deadRuns = runs.map((run) => contradicts(run, termMembers(kinds)));
        if (!deadRuns.some(Boolean)) return null;
        const kept = runs.filter((_, index) => !deadRuns[index]);
        return kept.length === 0 ? "unsatisfiable" : {runs: kept};
    });
}

/** R6: a query that constrains nothing simplifies to the query that asks nothing. */
function everything(tree: Tree, ctx: Ctx): Tree | null {
    const singles = tree.filter((group) => group.length === 1).map((group) => group[0]);
    for (const p of singles.filter((lit) => !lit.not)) {
        for (const n of singles.filter((lit) => lit.not)) {
            if (impliesAsk(n.ask, p.ask)) {
                ctx.note(i18n.t("diagnostics:simplify.matchesEverything"));
                return [];
            }
        }
    }
    return null;
}

/** R7: alternatives identical but for one positive same-shape clause fold into one clause of alternatives. */
function foldAlternation(tree: Tree): Tree | null {
    for (let a = 0; a < tree.length; a++) {
        for (let b = a + 1; b < tree.length; b++) {
            const merged = foldGroups(tree[a], tree[b]);
            if (merged !== null) {
                return tree.map((group, index) => (index === a ? merged : group)).filter((_, index) => index !== b);
            }
        }
    }
    return null;
}

/** Folds two groups differing in exactly one positive foldable clause, or refuses. */
function foldGroups(a: readonly Lit[], b: readonly Lit[]): readonly Lit[] | null {
    if (a.length !== b.length) return null;
    const keyed = (group: readonly Lit[]): (string | null)[] => group.map(keyOfLit);
    const ka = keyed(a);
    const kb = keyed(b);
    if (ka.includes(null) || kb.includes(null)) return null;
    const onlyInA = ka.flatMap((key, index) => (kb.includes(key) ? [] : [index]));
    const onlyInB = kb.flatMap((key, index) => (ka.includes(key) ? [] : [index]));
    if (onlyInA.length !== 1 || onlyInB.length !== 1) return null;
    const litA = a[onlyInA[0]];
    const litB = b[onlyInB[0]];
    if (litA.not || litB.not) return null;
    const folded = foldAsks(litA.ask, litB.ask);
    if (folded === null) return null;
    return a.map((lit, index) => (index === onlyInA[0] ? {not: false, ask: folded} : lit));
}

/** Merges two same-shape asks into one whose value offers both alternatives, or refuses. */
function foldAsks(a: Ask, b: Ask): Ask | null {
    if (a.on === "prop" && b.on === "prop" && a.ref.kind === b.ref.kind && a.ref.prop === b.ref.prop) {
        if (a.value === null || b.value === null) return null;
        return {on: "prop", ref: a.ref, value: mergeAlternatives(a.value, b.value)};
    }
    if ((a.on === "column" && b.on === "column" && a.column === b.column)
        || (a.on === "kind" && b.on === "kind" && a.kind === b.kind)) {
        const ta = a.test;
        const tb = b.test;
        if (ta === null || tb === null || ta.is !== "content" || tb.is !== "content") return null;
        return {...a, test: {is: "content", value: mergeAlternatives(ta.value, tb.value)}};
    }
    return null;
}

/** A value's own alternatives: the group's members, or the value itself where it is not a group. */
const altsOf = (value: ValueExpr): readonly ValueExpr[] => (value.op === "anyOf" ? value.alternatives : [value]);

/** One group of alternatives holding both expressions, nested groups flattened. */
function mergeAlternatives(a: ValueExpr, b: ValueExpr): ValueExpr {
    return anyOfExpr([...altsOf(a), ...altsOf(b)]);
}

/** R8: a group of alternatives never offers one alternative twice. */
function duplicateAlternative(tree: Tree): Tree | null {
    return mapValues(tree, (value, site) => {
        if (value.op !== "anyOf") return null;
        const deduped = dedupeRuns(value.alternatives, (alt) => site.keyFor(alt) ?? "\u0000");
        if (deduped === null) return null;
        return deduped.length === 1 ? deduped[0] : anyOfExpr(deduped);
    });
}

/** R9: alternation keeps the weaker alternative; overlapping closed intervals fuse where one leaf spells the union. */
function impliedAlternative(tree: Tree): Tree | null {
    return mapValues(tree, (value, site) => {
        if (value.op !== "anyOf") return null;
        let alternatives: readonly ValueExpr[] = value.alternatives;
        let changed = false;

        // Alternation is a union, so an alternative inside another adds nothing: drop whatever implies a survivor.
        const kept: ValueExpr[] = [];
        for (const alt of alternatives) {
            if (kept.some((k) => impliesAtSite(site, alt, k))) {
                changed = true;
                continue;
            }
            for (let i = kept.length - 1; i >= 0; i--) {
                if (impliesAtSite(site, kept[i], alt)) {
                    kept.splice(i, 1);
                    changed = true;
                }
            }
            kept.push(alt);
        }
        alternatives = kept;

        if (site.prop !== null) {
            const fused = fuseIntervals(site.prop, alternatives);
            if (fused !== null) {
                alternatives = fused;
                changed = true;
            }
        }
        if (!changed) return null;
        return alternatives.length === 1 ? alternatives[0] : anyOfExpr(alternatives);
    });
}

/**
 * Fuses one overlapping pair of closed, bounded intervals into the range that spells their union.
 *
 * Only closed and bounded, because a range is the one leaf that spells a two-sided interval; open or one-sided
 * unions either reduce to a comparison — which implication-dropping already found — or have no single spelling.
 */
function fuseIntervals(prop: Prop, alternatives: readonly ValueExpr[]): ValueExpr[] | null {
    const intervals = alternatives.map((alt) => intervalOf(prop, alt));
    for (let a = 0; a < alternatives.length; a++) {
        for (let b = a + 1; b < alternatives.length; b++) {
            const ia = intervals[a];
            const ib = intervals[b];
            if (ia === null || ib === null || ia.type !== ib.type) continue;
            if (!closedInterval(ia) || !closedInterval(ib)) continue;
            if (ia.lo > ib.hi || ib.lo > ia.hi) continue;
            const lo = Math.min(ia.lo, ib.lo);
            const hi = Math.max(ia.hi, ib.hi);
            const union: ValueExpr = {
                op: "range",
                lo: {type: ia.type.name, value: lo},
                hi: {type: ia.type.name, value: hi},
            };
            return alternatives.map((alt, index) => (index === a ? union : alt)).filter((_, index) => index !== b);
        }
    }
    return null;
}

/** R10: a range to itself is the exact ask, and bounds order low-first. */
function flatRange(tree: Tree): Tree | null {
    const normalise = (value: ValueExpr, site: ValueSite): ValueExpr | null => {
        if (value.op === "anyOf") {
            let changed = false;
            const alternatives = value.alternatives.map((alt) => {
                const next = normalise(alt, site);
                if (next !== null) changed = true;
                return next ?? alt;
            });
            return changed ? anyOfExpr(alternatives) : null;
        }
        if (value.op !== "range" || site.prop === null) return null;
        const lo = quantityOf(site.prop, value.lo);
        const hi = quantityOf(site.prop, value.hi);
        if (lo === null || hi === null || lo.type !== hi.type) return null;
        if (lo.value === hi.value) return {op: "exact", operand: value.lo};
        if (lo.value > hi.value) return {op: "range", lo: value.hi, hi: value.lo};
        return null;
    };
    return mapValues(tree, normalise);
}

/**
 * R11: inclusive bounds on one subject fuse to a range, and an empty meet is a contradiction — inside one row's
 * scope always, and across top-level clauses on a kind declared {@link Kind.single}, where every clause provably
 * reads the same row.
 */
function mergeBounds(tree: Tree, ctx: Ctx): Tree | null {
    const topLevel = fuseGroupBounds(tree, ctx);
    if (topLevel !== null) return topLevel;
    return mapScopes(tree, ctx, (runs) => {
        let changed = false;
        const kept: (readonly ScopeTerm[])[] = [];
        for (const run of runs) {
            const fused = fuseBounds(run, termBound);
            if (fused === "empty") {
                changed = true;
                continue;
            }
            if (fused !== null) changed = true;
            kept.push(fused ?? run);
        }
        if (kept.length === 0 && runs.length > 0) return "unsatisfiable";
        return changed ? {runs: kept} : null;
    });
}

/** The top-level half of R11: a dead alternative drops, and a query of nothing else is left as written. */
function fuseGroupBounds(tree: Tree, ctx: Ctx): Tree | null {
    let changed = false;
    const kept: (readonly Lit[])[] = [];
    for (const group of tree) {
        const fused = fuseBounds(group, litBound);
        if (fused === "empty") {
            changed = true;
            continue;
        }
        if (fused !== null) changed = true;
        kept.push(fused ?? group);
    }
    if (!changed) return null;
    if (kept.length === 0 && tree.length > 0) {
        ctx.note(ALL_DEAD);
        return null;
    }
    return kept;
}

/** One member's bound: the subject and property it constrains, and how to respell the member as a range. */
interface BoundSite<T> {
    /** What two bounds must share to describe one value: a property's identity, or the count. */
    readonly subject: string;
    readonly prop: Prop;
    readonly value: ValueExpr;
    readonly fuse: (range: ValueExpr) => T;
}

/** The bound a scope term states, or null: a positive value on the count or on one property of the row. */
function termBound(t: ScopeTerm): BoundSite<ScopeTerm> | null {
    if (t.state !== "ok" || t.ask === null || t.not) return null;
    const ask = t.ask;
    if (ask.on === "count") {
        return {
            subject: "count", prop: COUNT_PROP, value: ask.value,
            fuse: (range) => term(false, {on: "count", value: range}),
        };
    }
    if (ask.on !== "props" || ask.props.length !== 1) return null;
    const [ref] = ask.props;
    return {
        subject: `${ref.kind.id}.${ref.prop}`, prop: propOf(ref), value: ask.value,
        fuse: (range) => term(false, {on: "props", props: ask.props, value: range}),
    };
}

/** The bound a clause states, or null: a positive value on one property of a kind declared single. */
function litBound(lit: Lit): BoundSite<Lit> | null {
    const ask = lit.ask;
    if (lit.not || ask.on !== "prop" || ask.value === null || ask.ref.kind.single !== true) return null;
    const ref = ask.ref;
    return {
        subject: `${ref.kind.id}.${ref.prop}`, prop: propOf(ref), value: ask.value,
        fuse: (range) => ({not: false, ask: {on: "prop", ref, value: range}}),
    };
}

/**
 * Fuses one gte-lte pair over one subject, or reports an unsatisfiable conjunction.
 *
 * Generic over the conjunction's members because one fusion serves two levels: scope terms inside one row, and
 * top-level clauses on a kind declared single — the two places where every bound on a subject provably reads one
 * value. Two detections share the walk: a gte-lte pair fuses to the range that spells the pair, and any two
 * members selecting disjoint intervals of one subject — `cast=2s cast=4s` included — are an empty meet.
 */
function fuseBounds<T>(items: readonly T[], boundOf: (item: T) => BoundSite<T> | null): readonly T[] | "empty" | null {
    const bySubject = new Map<string, { index: number; bound: BoundSite<T> }[]>();
    items.forEach((item, index) => {
        const bound = boundOf(item);
        if (bound === null) return;
        const list = bySubject.get(bound.subject) ?? [];
        list.push({index, bound});
        bySubject.set(bound.subject, list);
    });

    for (const list of bySubject.values()) {
        const intervals = list.map(({bound}) => intervalOf(bound.prop, bound.value));
        for (let a = 0; a < list.length; a++) {
            for (let b = a + 1; b < list.length; b++) {
                const ia = intervals[a];
                const ib = intervals[b];
                if (ia !== null && ib !== null && ia.type === ib.type && disjoint(ia, ib)) return "empty";
            }
        }
        const low = list.findIndex(({bound}) => bound.value.op === "gte");
        const high = list.findIndex(({bound}) => bound.value.op === "lte");
        if (low < 0 || high < 0) continue;
        const ia = intervals[low];
        const ib = intervals[high];
        if (ia === null || ib === null || ia.type !== ib.type) continue;
        const lo = list[low].bound.value;
        const hi = list[high].bound.value;
        if (lo.op !== "gte" || hi.op !== "lte") continue;
        const range: ValueExpr = {op: "range", lo: lo.operand, hi: hi.operand};
        return items
            .map((item, index) => (index === list[low].index ? list[low].bound.fuse(range) : item))
            .filter((_, index) => index !== list[high].index);
    }
    return null;
}

/** The single positive evaluable term of a single-run scope, or `null`. */
function loneTerm(runs: ReadonlyArray<readonly ScopeTerm[]>): ScopeTerm | null {
    if (runs.length !== 1) return null;
    const evaluable = runs[0].filter((t) => t.state === "ok" && t.ask !== null);
    if (evaluable.length !== 1 || evaluable[0].not) return null;
    return evaluable[0];
}

/** R12: a scope of one positive content term is that content ask. */
function unwrapScope(tree: Tree): Tree | null {
    return rewriteScopedLits(tree, (ask, runs) => {
        const lone = loneTerm(runs);
        if (lone === null || lone.ask?.on !== "content") return null;
        return unwrappedAsk(ask, lone);
    });
}

/** Rewrites clauses whose ask carries a scope test, through one function from (ask, runs) to a new ask. */
function rewriteScopedLits(
    tree: Tree,
    rewrite: (ask: Ask & { on: "column" | "kind" }, runs: ReadonlyArray<readonly ScopeTerm[]>) => Ask | null,
): Tree | null {
    return mapLits(tree, (lit) => {
        const ask = lit.ask;
        if ((ask.on !== "column" && ask.on !== "kind") || ask.test === null || ask.test.is !== "scope") return null;
        const next = rewrite(ask, ask.test.terms);
        return next === null ? null : {not: lit.not, ask: next};
    });
}

/**
 * The shortest head that re-reads as the same props ask, or null — R13's target. A property with a declared door
 * is the shortest spelling of all; without a declaration the spelling would not re-read as the same head —
 * refusing keeps the rule honest rather than lucky — but the property's kind may still offer its own word as the
 * door, when it is global and the value re-reads through that head's dispatch onto these same properties.
 */
function doored(refs: readonly PropRef[], value: ValueExpr): Ask | null {
    if (refs.length === 1 && propOf(refs[0]).prefix !== undefined) {
        return {on: "prop", ref: refs[0], value};
    }
    const [first] = refs;
    if (refs.every((ref) => ref.kind === first.kind) && first.kind.global === true
        && first.kind.word !== undefined) {
        return {on: "kind", kind: first.kind, test: {is: "props", props: refs, value}};
    }
    return null;
}

function shortestDoor(tree: Tree): Tree | null {
    return rewriteScopedLits(tree, (ask, runs) => {
        const lone = loneTerm(runs);
        if (lone === null || lone.ask?.on !== "props") return null;
        if (ask.on === "kind" && lone.ask.props.some((ref) => ref.kind !== ask.kind)) return null;
        return doored(lone.ask.props, lone.ask.value);
    }) ?? propsTestDoors(tree);
}

/** The props-test half of R13: a column or kind ask whose whole test is one doored property. */
function propsTestDoors(tree: Tree): Tree | null {
    return mapLits(tree, (lit) => {
        const ask = lit.ask;
        if ((ask.on !== "column" && ask.on !== "kind") || ask.test === null || ask.test.is !== "props") return null;
        const {props, value} = ask.test;
        if (props.length !== 1 || propOf(props[0]).prefix === undefined) return null;
        if (ask.on === "kind" && props[0].kind !== ask.kind) return null;
        return {not: lit.not, ask: {on: "prop", ref: props[0], value}};
    });
}

/** R14: an empty conjunction is true, so a scope with an empty run asks only for existence. */
function emptyScope(tree: Tree): Tree | null {
    return rewriteScopedLits(tree, (ask, runs) => {
        const emptyRun = runs.some((run) => run.every((t) => t.state !== "ok" || t.ask === null));
        if (!emptyRun) return null;
        // An empty run is satisfied by any row, so alongside existential siblings the whole scope is existence.
        // A sibling run that counts could hold where no row exists, which existence does not — left untouched.
        const rest = runs.filter((run) => run.some((t) => t.state === "ok" && t.ask !== null));
        if (rest.some((run) => run.some((t) => t.ask?.on === "count"))) return null;
        return {...ask, test: {is: "exists"}};
    });
}

/** The structural half of R16: a scope holding nothing but one kind's word converges onto the kind-exists ask. */
function kindThroughColumn(tree: Tree): Tree | null {
    return rewriteScopedLits(tree, (ask, runs) => {
        const lone = loneTerm(runs);
        if (lone === null || lone.ask?.on !== "kindWord") return null;
        if (ask.on === "kind" && ask.kind !== lone.ask.kind) return null;
        return unwrappedAsk(ask, lone);
    });
}

/** A count term asking for exactly zero rows, the canonical zero-edge spelling. */
const ZERO_COUNT: ScopeAsk = {
    on: "count",
    value: {op: "exact", operand: {type: COUNT_PROP.types[0].name, value: 0}},
};

/**
 * R17: counts speak existence at the edges.
 *
 * A count interval collapsing to zero is "no such row" and one covering everything from one is "some such row" —
 * rewritten, not inferred, which is what keeps the boundary against reading counts as existence intact everywhere
 * else. Single-run scopes only: one alternative of an alternation cannot flip the clause it lives in.
 */
function countExistence(tree: Tree): Tree | null {
    return mapLits(tree, countEdge);
}

/** Rewrites one clause at the count-existence edges, or leaves it. */
function countEdge(lit: Lit): Lit | null {
    const ask = lit.ask;
    if (ask.on !== "column" && ask.on !== "kind") return null;
    const test = ask.test;

    // Negated existence is the zero count: the canonical spelling of "has none" counts rather than negates.
    if (lit.not && (test === null || test.is === "exists")) {
        return {not: false, ask: {...ask, test: {is: "scope", terms: [[term(false, ZERO_COUNT)]]}}};
    }
    if (test === null || test.is !== "scope" || test.terms.length !== 1) return null;

    const run = test.terms[0].filter((t) => t.state === "ok" && t.ask !== null);
    const counts = run.filter((t) => t.ask?.on === "count");
    if (counts.length === 0) return null;
    const rows = run.filter((t) => t.ask?.on !== "count");
    const classes = counts.map((t) => (t.ask === null ? null : countClassOf({not: t.not, ask: t.ask})));
    if (classes.some((cls) => cls === null || cls === "never")) return null;

    const keep = classes.every((cls) => cls === "some" || cls === "any");
    const none = classes.every((cls) => cls === "zero");
    if (keep) {
        // Every count is satisfied by any nonempty set, so the counts add nothing to the row terms — or to bare
        // existence, when there are no row terms at all.
        if (rows.length === 0) return {not: lit.not, ask: {...ask, test: {is: "exists"}}};
        return {not: lit.not, ask: unscopedAsk(ask, rows)};
    }
    if (!none) return null;
    if (rows.length === 0) {
        // "No rows at all": negated, that is existence; positive, it converges on the one canonical zero spelling.
        if (lit.not) return {not: false, ask: {...ask, test: {is: "exists"}}};
        const already = counts.length === 1 && !counts[0].not
            && termKey(counts[0]) === termKey(term(false, ZERO_COUNT));
        return already ? null : {not: false, ask: {...ask, test: {is: "scope", terms: [[term(false, ZERO_COUNT)]]}}};
    }
    // "No row satisfying these terms" is the negation of "some row does", so the clause flips around the rows.
    return {not: !lit.not, ask: unscopedAsk(ask, rows)};
}

/* --------------------------------------------------------------------------- the registry */

/**
 * Every simplification rule, in the order the fixpoint tries them: structural normalisation first, so the
 * implication rules see converged shapes, then the algebra, then the whole-query rules.
 *
 * The records are the rule set's one durable statement — printable, testable, and the source `--rules` renders —
 * so each carries its law and examples even where its rewrite lives in another tier's module.
 */
export const RULES: readonly Rule[] = Object.freeze([
    {
        id: "R14", name: "empty-scope", tier: "simplify",
        law: i18n.t("rules:law.R14"),
        examples: [{from: "model:{}", to: "model:*"}],
        apply: emptyScope,
    },
    {
        id: "R10", name: "flat-range", tier: "simplify",
        law: i18n.t("rules:law.R10"),
        examples: [{from: "cast:2s-2s", to: "cast=2s"}, {from: "cast:5s-2s", to: "cast:2s-5s"}],
        apply: flatRange,
    },
    {
        id: "R17", name: "count-existence", tier: "simplify",
        law: i18n.t("rules:law.R17"),
        examples: [
            {from: "-model:*", to: "model=0"},
            {from: "model:{count:<1}", to: "model=0"},
            {from: "model:{fire count:=0}", to: "-model:fire"},
            {from: "-model:{count:=0}", to: "model:*"},
            {from: "model:{count:>=1}", to: "model:*"},
            {from: "model:{fire count:>0}", to: "model:fire"},
        ],
        apply: countExistence,
    },
    {
        id: "R11", name: "merge-bounds", tier: "simplify",
        law: i18n.t("rules:law.R11"),
        examples: [
            {from: "spell:{cast:>=2s cast:<=5s}", to: "cast:2s-5s"},
            {from: "cast>=2s cast<=5s", to: "cast:2s-5s"},
            {from: "spell:{cast=2s cast=4s} | name:frost", to: "name:frost"},
        ],
        apply: mergeBounds,
    },
    {
        id: "R16", name: "kind-through-column", tier: "simplify",
        law: i18n.t("rules:law.R16"),
        examples: [{from: "model:{missile}", to: "model:missile"}, {from: "missile:*", to: "model:missile"}],
        apply: kindThroughColumn,
    },
    {
        id: "R12", name: "unwrap-scope", tier: "simplify",
        law: i18n.t("rules:law.R12"),
        examples: [{from: "model:{fire}", to: "model:fire"}],
        apply: unwrapScope,
    },
    {
        id: "R13", name: "shortest-door", tier: "simplify",
        law: i18n.t("rules:law.R13"),
        examples: [{from: "fx:{scale:+50%}", to: "scale=+50%"}, {from: "spell:{cast:2s}", to: "cast=2s"}],
        apply: shortestDoor,
    },
    {
        id: "R1", name: "duplicate-clause", tier: "simplify",
        law: i18n.t("rules:law.R1"),
        examples: [{from: "model:fire model:fire", to: "model:fire"}],
        apply: duplicateClause,
    },
    {
        id: "R8", name: "duplicate-alternative", tier: "simplify",
        law: i18n.t("rules:law.R8"),
        examples: [{from: "model:(fire|fire)", to: "model:fire"}],
        apply: duplicateAlternative,
    },
    {
        id: "R3", name: "implied-clause", tier: "simplify",
        law: i18n.t("rules:law.R3"),
        examples: [
            {from: "model:fire model:fireball", to: "model:fireball"},
            {from: "-model:fire -model:fireball", to: "-model:fire"},
            {from: "model:* model:fire", to: "model:fire"},
            {from: "cast>2s cast>4s", to: "cast>4s"},
        ],
        apply: impliedClause,
    },
    {
        id: "R9", name: "implied-alternative", tier: "simplify",
        law: i18n.t("rules:law.R9"),
        examples: [{from: "model:(fire|fireball)", to: "model:fire"}, {from: "cast:(<2s|<5s)", to: "cast<5s"}],
        apply: impliedAlternative,
    },
    {
        id: "R5", name: "contradiction", tier: "simplify",
        law: i18n.t("rules:law.R5"),
        examples: [
            {from: "model:fireball -model:fire | name:frost", to: "name:frost"},
            {from: "model:{fire -fire | missile}", to: "model:missile"},
        ],
        apply: contradiction,
    },
    {
        id: "R2", name: "duplicate-group", tier: "simplify",
        law: i18n.t("rules:law.R2"),
        examples: [{from: "model:fire | model:fire", to: "model:fire"}],
        apply: duplicateGroup,
    },
    {
        id: "R4", name: "implied-group", tier: "simplify",
        law: i18n.t("rules:law.R4"),
        examples: [{from: "name:frost | name:frost model:missile", to: "name:frost"}],
        apply: impliedGroup,
    },
    {
        id: "R7", name: "fold-alternation", tier: "simplify",
        law: i18n.t("rules:law.R7"),
        examples: [
            {from: "model:fire | model:frost", to: "model:(fire|frost)"},
            {from: "model:fire name:bolt | model:frost name:bolt", to: "model:(fire|frost) name:bolt"},
        ],
        apply: foldAlternation,
    },
    {
        id: "R6", name: "everything", tier: "simplify",
        law: i18n.t("rules:law.R6"),
        examples: [{from: "model:fire | -model:fire", to: ""}],
        apply: everything,
    },
    {
        id: "R15", name: "count-collapse", tier: "format",
        law: i18n.t("rules:law.R15"),
        examples: [{from: "model:{count:<4}", to: "model<4"}, {from: "model:{count:=3}", to: "model=3"}],
    },
    {
        id: "R16f", name: "kind-through-column (spelling)", tier: "format",
        law: i18n.t("rules:law.R16f"),
        examples: [{from: "missile:*", to: "model:missile"}],
    },
    {
        id: "R18", name: "operator-replaces-colon", tier: "format",
        law: i18n.t("rules:law.R18"),
        examples: [
            {from: "cast:>2s", to: "cast>2s"},
            {from: "name:=fireball", to: "name=fireball"},
            {from: "model:{fire count:<4}", to: "model:{fire count<4}"},
        ],
    },
]);

/** Every boundary: the rewrites deliberately not performed, and why each would be wrong. */
export const KEPT: readonly Boundary[] = Object.freeze([
    {
        id: "B1", name: "rows-stay-apart",
        keeps: i18n.t("rules:boundary.B1.keeps"),
        why: i18n.t("rules:boundary.B1.why"),
    },
    {
        id: "B2", name: "explicit-only",
        keeps: i18n.t("rules:boundary.B2.keeps"),
        why: i18n.t("rules:boundary.B2.why"),
    },
    {
        id: "B3", name: "notation-upheld",
        keeps: i18n.t("rules:boundary.B3.keeps"),
        why: i18n.t("rules:boundary.B3.why"),
    },
    {
        id: "B4", name: "no-demorgan",
        keeps: i18n.t("rules:boundary.B4.keeps"),
        why: i18n.t("rules:boundary.B4.why"),
    },
    {
        id: "B5", name: "patterns-opaque",
        keeps: i18n.t("rules:boundary.B5.keeps"),
        why: i18n.t("rules:boundary.B5.why"),
    },
    {
        id: "B6", name: "count-not-existence",
        keeps: i18n.t("rules:boundary.B6.keeps"),
        why: i18n.t("rules:boundary.B6.why"),
    },
    {
        id: "B7", name: "existentials-stay-apart",
        keeps: i18n.t("rules:boundary.B7.keeps"),
        why: i18n.t("rules:boundary.B7.why"),
    },
    {
        id: "B8", name: "unsat-unspelled",
        keeps: i18n.t("rules:boundary.B8.keeps"),
        why: i18n.t("rules:boundary.B8.why"),
    },
    {
        id: "B9", name: "every-dataset",
        keeps: i18n.t("rules:boundary.B9.keeps"),
        why: i18n.t("rules:boundary.B9.why"),
    },
    {
        id: "B10", name: "no-truth-tables",
        keeps: i18n.t("rules:boundary.B10.keeps"),
        why: i18n.t("rules:boundary.B10.why"),
    },
    {
        id: "B11", name: "conservative",
        keeps: i18n.t("rules:boundary.B11.keeps"),
        why: i18n.t("rules:boundary.B11.why"),
    },
]);

/* ----------------------------------------------------------------------------- the driver */

/** How many whole passes the fixpoint may take before concluding something is oscillating and giving up. */
const PASS_LIMIT = 32;

/**
 * Whether a rewritten tree's own spelling re-reads as the same question — the round-trip guard.
 *
 * Textual equivalence catches a rewrite that formats to a different question; the shape comparison catches the
 * blind spot where two structures share one spelling. A guard that fails abandons the rewrite that tripped it,
 * and the abandoned rewrite is simply not part of the result.
 */
function roundTrips(tree: Tree): boolean {
    const candidate = toParsed(tree);
    const reparsed = parse(formatQuery(candidate));
    if (reparsed.diagnostics.some((d) => d.severity === "error")) return false;
    return queryKey(candidate) === queryKey(reparsed) && shapeOf(candidate) === shapeOf(reparsed);
}

/** Runs a set of rules to a fixpoint over one tree, every accepted rewrite round-trip guarded. */
function fixpoint(tree: Tree, rules: readonly Rule[], ctx: Ctx): { tree: Tree; applied: string[] } {
    const applied: string[] = [];
    for (let pass = 0; pass < PASS_LIMIT; pass++) {
        let fired = false;
        for (const rule of rules) {
            if (rule.apply === undefined) continue;
            const next = rule.apply(tree, ctx);
            if (next === null) continue;
            if (!roundTrips(next)) continue;
            tree = next;
            fired = true;
            if (!applied.includes(rule.id)) applied.push(rule.id);
        }
        if (!fired) break;
    }
    return {tree, applied};
}

/**
 * Simplifies a parsed query: every rule applied to a fixpoint, every rewrite round-trip guarded.
 *
 * Meaning is preserved on every dataset — a rule that would only hold on one pack is not a rule — and anything
 * implication cannot certify is left exactly as written. Only the evaluable query is simplified: incomplete and
 * invalid clauses carry no structure to rewrite, so when nothing rewrites, the input comes back untouched,
 * diagnostics and all.
 *
 * @param parsed A parse, from {@link ./parse!parse}.
 * @returns The simplified parse, the rules that fired, and any notes for the user.
 */
export function simplify(parsed: Parsed): Simplified {
    const notes = new Set<string>();
    const {tree, applied} = fixpoint(treeOf(parsed), RULES, {note: (text) => notes.add(text)});
    if (applied.length === 0) return {parsed, applied, notes: [...notes]};
    return {parsed: toParsed(tree), applied, notes: [...notes]};
}

/** One rule's standalone effect on a query: what the query becomes under that rule alone. */
export interface Suggestion {
    /** The rule, with its law and examples — what a surface shows beside the offer. */
    readonly rule: Rule;

    /** The query as this one rule leaves it, re-parsed from its own canonical spelling. */
    readonly parsed: Parsed;

    /** Findings in the reader's words, from this rule alone. */
    readonly notes: readonly string[];
}

/**
 * Every rule's standalone rewrite of a query — one suggestion per rule that changes it.
 *
 * Each rule runs alone, to its own fixpoint, over the query as written — never over another rule's output — so a
 * surface can offer each as an independent one-click suggestion. {@link simplify} is not these suggestions
 * replayed: there the rules feed each other, and an accepted rewrite exposes what the next rule acts on. A rewrite
 * that changes the tree but not the query's canonical spelling is a convergence with nothing to show, so it is
 * not offered.
 *
 * @param parsed A parse, from {@link ./parse!parse}.
 * @returns One suggestion per rule that changes the query's spelling, in {@link RULES} order.
 */
export function suggestions(parsed: Parsed): readonly Suggestion[] {
    const tree = treeOf(parsed);
    const before = queryKey(toParsed(tree));
    const offers: Suggestion[] = [];
    for (const rule of RULES) {
        if (rule.apply === undefined) continue;
        const notes = new Set<string>();
        const result = fixpoint(tree, [rule], {note: (text) => notes.add(text)});
        if (result.applied.length === 0) continue;
        const after = toParsed(result.tree);
        if (queryKey(after) === before) continue;
        offers.push({rule, parsed: after, notes: [...notes]});
    }
    return offers;
}

/**
 * Whether two parses ask the same evaluable question.
 *
 * Equivalence compares SIMPLIFIED canonical forms, so it is up to everything the language says does not matter —
 * clause order, group order, delimiter, notation and letter-case spellings, and anything an incomplete or invalid
 * clause failed to say — and additionally up to every rewrite the rules certify: `model:{fire}` is equivalent to
 * `model:fire` and to `model:FIRE`, and `-model:*` to `model=0`. `model:fire model:missile` stays distinct from
 * `model:{fire missile}` — two rows against one. Regex patterns are the one case-sensitive spelling. Sound, not
 * complete: `true` proves sameness, `false` means "not provably the same".
 *
 * @param a One parse.
 * @param b Another.
 * @returns Whether their evaluable queries mean the same thing.
 */
export function equivalent(a: Parsed, b: Parsed): boolean {
    return queryKey(simplify(a).parsed) === queryKey(simplify(b).parsed);
}
