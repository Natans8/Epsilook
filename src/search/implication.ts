/**
 * @file The implication oracle: whether everything matching one ask also matches another.
 *
 * `implies(a, b)` answers "does everything matching a also match b" — on every dataset, which is what makes a
 * rewrite a rule rather than an observation about one pack. Soundness over completeness: `true` must be a proof,
 * `false` only means "not certified", and every undecided case returns `false` so the rewrite it would have
 * licensed simply does not happen.
 *
 * Every proof grounds in the live machinery. A substring relation is decided by running the registered matcher over
 * the other side's operand; an operand is resolved through the evaluator's own dispatch; a bit role is decided by
 * exhausting the mask universe. There is no second copy of any matching rule here, which is what keeps a new axis
 * correct without an edit — and it is why this module sits below the evaluation seam with the matchers themselves.
 *
 * One algebra serves both levels — top-level clauses in a group, and scope terms in a run — because the language
 * gives them the same structure: alternation groups of conjunctions of possibly-negated asks.
 */
import type {Column} from "./columns";
import {termKey} from "./format";
import type {Kind, Prop} from "./kinds";
import {sentinelOf} from "./kinds";
import type {Ask, ParsedOperand, ScopeAsk, ScopeTerm, ValueExpr} from "./ast";
import {COUNT_PROP, propOf} from "./ast";
import {resolveOperand, textOf} from "./rows";
import type {Lit, ValueSite} from "./tree";
import {keyOfAsk, keyOfLit, scopeKinds, signedKey, term} from "./tree";
import type {AxisType} from "./value-types";
import {matcher, ROLE_MASK_LIMIT, SUBSTRING_TYPES} from "./value-matching";

/** A closed-or-open numeric interval, with the notation that read its bounds. */
interface Interval {
    readonly type: AxisType;
    readonly lo: number;
    readonly hi: number;
    readonly loOpen: boolean;
    readonly hiOpen: boolean;
}

/** Resolves one operand as a quantity through the evaluator's own dispatch, or refuses. */
export function quantityOf(prop: Prop, operand: ParsedOperand): { type: AxisType; value: number } | null {
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
export function intervalOf(prop: Prop, expr: ValueExpr): Interval | null {
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
export function disjoint(a: Interval, b: Interval): boolean {
    return endsBelow(a, b) || endsBelow(b, a);
}

/** Whether a number lies inside an interval. */
function inInterval(iv: Interval, n: number): boolean {
    return (n > iv.lo || (n === iv.lo && !iv.loOpen)) && (n < iv.hi || (n === iv.hi && !iv.hiOpen));
}

/** Whether an interval is closed and bounded on both sides — the shape a range leaf can spell. */
export function closedInterval(iv: Interval): boolean {
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
export function countClassOf(t: NormTerm): CountClass | null {
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

/** One run's row terms as a single order-free key. */
function rowTermsKey(run: NormRun): string {
    return run.rows.map((t) => termKey(term(t.not, t.ask)) ?? "\u0000").toSorted().join("\u0001");
}

/** Whether two runs constrain rows identically, by term identity. */
function sameRowTerms(a: NormRun, b: NormRun): boolean {
    return rowTermsKey(a) === rowTermsKey(b);
}

/**
 * Whether one clause's positive reading implies another's: everything `a` selects, `b` selects.
 *
 * Both asks lower to alternation runs over one column, and `a` implies `b` when every alternative of `a` lands
 * inside some alternative of `b`. Plain asks answer only by identity, because plain search ranges over every
 * column at once.
 */
export function impliesAsk(a: Ask, b: Ask): boolean {
    const ka = keyOfAsk(a);
    if (ka !== null && ka === keyOfAsk(b)) return true;
    const la = loweredAsk(a);
    const lb = loweredAsk(b);
    if (la === null || lb === null || la.column !== lb.column) return false;
    return la.runs.every((ra) => lb.runs.some((rb) => runImplies(la.kinds, ra, rb)));
}

/* ---------------------------------------------------------------- the conjunction algebra */

/** The operations the algebra needs of one conjunction member. */
export interface Members<T> {
    keyOf(item: T): string | null;

    negated(item: T): boolean;

    /** Positive-reading implication. The algebra flips it itself for negated members. */
    implies(a: T, b: T): boolean;
}

/** Removes duplicate members, first occurrence kept. Returns `null` when nothing repeats. */
export function dedupeMembers<T>(items: readonly T[], alg: Members<T>): T[] | null {
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
export function dropImpliedMembers<T>(items: readonly T[], alg: Members<T>): T[] | null {
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
export function contradicts<T>(items: readonly T[], alg: Members<T>): boolean {
    const positives = items.filter((item) => !alg.negated(item));
    const negatives = items.filter((item) => alg.negated(item));
    return positives.some((p) => negatives.some((n) => alg.implies(p, n)));
}

/** The algebra over top-level clauses. */
export const LITS: Members<Lit> = {
    keyOf: keyOfLit,
    negated: (lit) => lit.not,
    implies: (a, b) => impliesAsk(a.ask, b.ask),
};

/** The algebra over the terms of one scope, dispatching content across the scope's kinds. */
export function termMembers(kinds: readonly Kind[]): Members<ScopeTerm> {
    return {
        keyOf: termKey,
        negated: (t) => t.not,
        implies: (a, b) => a.ask !== null && b.ask !== null && impliesTermAsk(kinds, a.ask, b.ask),
    };
}

/** Implication between two expressions at one site, whichever half of the oracle the site calls for. */
export function impliesAtSite(site: ValueSite, a: ValueExpr, b: ValueExpr): boolean {
    if (site.prop !== null) return impliesPropValue(site.prop, a, b);
    return impliesContentValue(site.kinds, a, b);
}
