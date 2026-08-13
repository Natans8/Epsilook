/**
 * @file The rule bible as code: every rewrite the engine performs, and every one it deliberately declines.
 *
 * The rules are data. {@link RULES} and {@link KEPT} carry each rule's law and worked examples as records, so the
 * rule set can be printed, tested fixture-by-fixture, and audited without running a rewrite. A rule that rewrites
 * also carries its `apply`; a rule whose tier is not `simplify` carries none, because a parse-tier rule is a lenient
 * reading and a format-tier rule is a spelling — both live in their own modules, and their records exist here so
 * one registry can state the whole rule set.
 *
 * The boundaries matter as much as the rules. {@link KEPT} records what is deliberately left as written and why,
 * because a rewrite that looks obviously right and is quietly wrong is the failure this module has to avoid.
 *
 * No rule names an axis. They branch on declarations only — `quantity`, `SUBSTRING_TYPES`, `prop.prefix`, the
 * operator and matcher registries — so a new axis, kind or type simplifies correctly with no edit here.
 */
// The instance rather than the bare `t`, because several closures here take a parameter named `t` and would shadow
// the import.
import {i18n} from "../../i18n";
import {termKey} from "../language/format";
import type {Prop} from "../schema/kinds";
import type {Ask, PropRef, ScopeAsk, ScopeTerm, ValueExpr} from "../language/ast";
import {COUNT_PROP, anyOfExpr, propOf} from "../language/ast";
import type {Members} from "./implication";
import {
    closedInterval, contradicts, countClassOf, dedupeMembers, disjoint, dropImpliedMembers, impliesAsk,
    impliesAtSite, intervalOf, LITS, quantityOf, termMembers,
} from "./implication";
import type {Ctx, Lit, Tree, ValueSite} from "./tree";
import {
    ALL_DEAD, keyOfLit, litKeys, mapGroups, mapLits, mapScopes, mapValues, term, termKeys, unscopedAsk,
    unwrappedAsk,
} from "./tree";

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
    const ka = a.map((lit) => keyOfLit(lit));
    const kb = b.map((lit) => keyOfLit(lit));
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

/** One expression under R10, recursing into alternatives because a group may hold a range per alternative. */
function flatRangeValue(value: ValueExpr, site: ValueSite): ValueExpr | null {
    if (value.op === "anyOf") {
        let changed = false;
        const alternatives = value.alternatives.map((alt) => {
            const next = flatRangeValue(alt, site);
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
}

/** R10: a range to itself is the exact ask, and bounds order low-first. */
function flatRange(tree: Tree): Tree | null {
    return mapValues(tree, flatRangeValue);
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
