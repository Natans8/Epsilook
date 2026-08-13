/**
 * @file The rewritable tree: the shape a rule works over, how a parse becomes one, and the walkers across it.
 *
 * A rule does not rewrite {@link Parsed} objects. A clause carries spans and states that belong to the text as
 * typed, and a simplified query has no typed text until it is formatted — so the rules work over a plainer shape,
 * alternation groups of conjunctions of possibly-negated asks, which is the same normal form `Parsed.groups`
 * spells. One function converts each way.
 *
 * Two things beyond the shape live here, because every rule needs them and none owns them. The structural identity
 * functions give a tree a key and a shape: the key is what tells a real rewrite from a no-op, and both are what the
 * driver's round-trip guard compares. The walkers apply one rewrite at one level — every group, every clause, every
 * scope, every value site — so a rule states what it changes rather than how to reach it.
 */
// The instance rather than the bare `t`: several closures below take a parameter named `t` and would shadow it.
import {i18n} from "../i18n";
import {clauseKey, termKey, unbracedTerm} from "./format";
import type {Kind, Prop} from "./kinds";
import type {
    Ask, Clause, Parsed, ParsedOperand, PropRef, RowTest, ScopeAsk, ScopeTerm, Span, ValueExpr,
} from "./parse";
import {COUNT_PROP, propOf} from "./parse";
import {kindsOf} from "./schema";

/* ----------------------------------------------------------------------- the tree model */

/** What a rule tells the reader about a query whose every alternative is dead. */
export const ALL_DEAD = i18n.t("diagnostics:simplify.allDead");

/** The kinds whose rows a column-or-kind ask ranges over — the scope a content term dispatches across. */
export function scopeKinds(ask: Ask): readonly Kind[] {
    if (ask.on === "column") return kindsOf(ask.column);
    if (ask.on === "kind") return [ask.kind];
    if (ask.on === "prop") return [ask.ref.kind];
    return [];
}

/**
 * One member of a conjunction: an ask, possibly negated. The evaluable content of one top-level clause.
 *
 * The rules rewrite these rather than {@link Clause} objects because a clause carries spans and states that belong
 * to the text as typed; the simplified query has no typed text until it is formatted.
 */
export interface Lit {
    readonly not: boolean;
    readonly ask: Ask;
}

/** The query being rewritten: alternation groups of conjunctions — the same normal form `Parsed.groups` spells. */
export type Tree = ReadonlyArray<readonly Lit[]>;

/** What the driver hands each rule besides the tree. */
export interface Ctx {
    /** Records a finding for the user. Deduplicated, so a rule re-examined by the fixpoint stays quiet. */
    note(text: string): void;
}

/** The span every synthetic node carries: simplified structure has no position in any typed text. */
const NOWHERE: Span = {start: 0, end: 0};

/** The evaluable content of a parse, as the tree the rules rewrite. */
export function treeOf(parsed: Parsed): Tree {
    return parsed.groups.map((group) => group
        .map((index) => parsed.clauses[index])
        .flatMap((clause): Lit[] => (clause.ask === null ? [] : [{not: clause.not, ask: clause.ask}])));
}

/** A tree back as a parse, for formatting and for the guard. Every clause is synthetic and evaluable. */
export function toParsed(tree: Tree): Parsed {
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
export const term = (not: boolean, ask: ScopeAsk): ScopeTerm => ({span: NOWHERE, not, state: "ok", ask});

/**
 * One lit's identity: its folded canonical text, the same identity {@link equivalent} compares clauses by.
 *
 * `null` marks a lit nothing can be said about; the algebra treats it as equal to nothing, itself included.
 */
export function keyOfLit(lit: Lit): string | null {
    return clauseKey({span: NOWHERE, not: lit.not, state: "ok", ask: lit.ask});
}

/** The identity of an ask's positive reading, for the oracle's cheap first answer. */
export function keyOfAsk(ask: Ask): string | null {
    return keyOfLit({not: false, ask});
}

/**
 * A member's identity signed with its polarity, unkeyable members marked by a sentinel — the encoding every
 * alternation-level comparison reads, so the sign characters and the sentinel live once.
 */
export const signedKey = (not: boolean, key: string | null): string => `${not ? "-" : "+"}${key ?? "\u0000"}`;

/** Every clause's signed identity, in group order. */
export const litKeys = (group: readonly Lit[]): string[] => group.map((lit) => signedKey(lit.not, keyOfLit(lit)));

/** Every term's signed identity, in run order. */
export const termKeys = (run: readonly ScopeTerm[]): string[] => run.map((t) => signedKey(t.not, termKey(t)));

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
export function shapeOf(parsed: Parsed): string {
    const groups = parsed.groups.map((group) => sortedShapes(group.map((index) => {
        const clause = parsed.clauses[index];
        return clause.ask === null ? null : {not: clause.not, ask: askShape(clause.ask)};
    })));
    return JSON.stringify(groups.map((group) => group.join("\u0000")).toSorted());
}

/* -------------------------------------------------------------------------- the walkers */

/** Rewrites each top-level group through one function; `null` from every group means an unchanged tree. */
export function mapGroups(tree: Tree, rewrite: (group: readonly Lit[]) => readonly Lit[] | null): Tree | null {
    let changed = false;
    const next = tree.map((group) => {
        const result = rewrite(group);
        if (result !== null) changed = true;
        return result ?? group;
    });
    return changed ? next : null;
}

/** Rewrites each clause through one function; `null` from every clause means an unchanged tree. */
export function mapLits(tree: Tree, rewrite: (lit: Lit) => Lit | null): Tree | null {
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

/** What a scope rewrite may say about one clause's runs. */
export type ScopeRewrite =
    | { readonly runs: ReadonlyArray<readonly ScopeTerm[]> }
    /** Every run is contradictory: the clause is satisfied by no spell at all. */
    | "unsatisfiable"
    | null;

/**
 * The unwrapped structure a promoted term's spelling re-reads as: a lone content term is the content test, a lone
 * kind word the kind-exists ask — a kind ask keeps its scope when the word names some other kind, where the
 * promoted spelling would not re-read. Which terms promote at all is {@link unbracedTerm}'s decision.
 */
export function unwrappedAsk(ask: Ask & { on: "column" | "kind" }, lone: ScopeTerm): Ask {
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
export function unscopedAsk(ask: Ask & { on: "column" | "kind" }, rows: readonly ScopeTerm[]): Ask {
    const lone = unbracedTerm([rows]);
    if (lone !== null && lone.ask?.on !== "count") return unwrappedAsk(ask, lone);
    return {...ask, test: {is: "scope", terms: [rows]}};
}

/** A rewritten scope back as an ask: a single run unwraps where the spelling would, per {@link unscopedAsk}. */
export function scopedAsk(ask: Ask & { on: "column" | "kind" }, runs: ReadonlyArray<readonly ScopeTerm[]>): Ask {
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
export function mapScopes(
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
export interface ValueSite {
    readonly prop: Prop | null;
    readonly kinds: readonly Kind[];

    /** The identity of one expression at this site, for deduplication. */
    keyFor(value: ValueExpr): string | null;
}

/** The site of a value bound to one property, keyed through a synthetic property term. */
export function propSite(ref: PropRef): ValueSite {
    return {
        prop: propOf(ref), kinds: [ref.kind],
        keyFor: (value) => termKey(term(false, {on: "props", props: [ref], value})),
    };
}

/** The site of a content value, keyed through a synthetic content term. */
export function contentSite(kinds: readonly Kind[]): ValueSite {
    return {
        prop: null, kinds,
        keyFor: (value) => termKey(term(false, {on: "content", value})),
    };
}

/** The site of a count value. */
export const COUNT_SITE: ValueSite = {
    prop: COUNT_PROP, kinds: [],
    keyFor: (value) => termKey(term(false, {on: "count", value})),
};

/**
 * Rewrites every value expression in the tree, visiting each site with its property or content context.
 *
 * The function receives whole top-level expressions; recursing into a group's alternatives is each rule's own
 * decision, because some rules act on the group and others on its members.
 */
export function mapValues(tree: Tree, rewrite: (value: ValueExpr, site: ValueSite) => ValueExpr | null): Tree | null {
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
