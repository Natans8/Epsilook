/**
 * @file Query simplification: meaning-preserving rewrites of the parse tree, as a guarded fixpoint.
 *
 * The shape query engines use for this — Lucene's `BooleanQuery.rewrite`, the SQL optimizer's predicate
 * simplification — is a fixpoint of small, local, meaning-preserving rewrites, and that is the shape here: each rule
 * takes the whole tree and returns a rewritten tree or `null`, the driver loops until no rule fires, and every
 * accepted rewrite is round-trip guarded. Truth-table minimisation is deliberately absent: the atoms here carry
 * implication structure — substrings, intervals, bit roles — that independent-variable minimisers cannot see.
 *
 * The parts are three modules and this driver. `tree.ts` is the shape a rule rewrites and the walkers over it,
 * `implication.ts` is the oracle every algebraic rule consults, `rules.ts` is the rule set itself; what is left
 * here is the loop, the round-trip guard, and the three functions a caller actually reaches for.
 *
 * Every rewrite is round-trip guarded. A rewritten tree is formatted, re-parsed, and compared both textually and
 * structurally; a rewrite whose spelling does not re-read as the same question abandons itself. The structural half
 * is load-bearing where the textual half is blind: a kind without a top-level word formats its existence ask to a
 * spelling that re-reads as plain text, and both structures format to the same string — only the shapes disagree.
 *
 * Simplification is explicit-only: no surface calls this unprompted. The command line (`npm run simplify`) is the
 * one door until the interface grows its button. The rules also stand alone: {@link suggestions} runs each by
 * itself, so a surface can offer every applicable rewrite as its own one-click suggestion rather than the whole
 * fixpoint at once. And {@link equivalent} lives here rather than beside the formatter because equivalence reads
 * through simplification: two queries ask the same question exactly when their simplified canonical forms agree.
 */
import {formatQuery, queryKey} from "./format";
import type {Parsed} from "./parse";
import {parse} from "./parse";
import type {Rule} from "./rules";
import {RULES} from "./rules";
import type {Ctx, Tree} from "./tree";
import {shapeOf, toParsed, treeOf} from "./tree";

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
