/* SEARCH 2.0 — THE IN-MEMORY BACKEND. Below the seam.
 *
 * ⭐ WHAT THIS FILE IS FOR, AND IT IS THE 2026-08-11 CORRECTION (PLAN §3.2b),
 * in the user's words: *"I want the matching mechanism to be implementation
 * independent, so if we decide to switch to SQL one day, or to a server-side
 * API, the logic doesn't have to change."*
 *
 * So a TYPE declares which operators it accepts, as DATA (`types.ts`), and a
 * BACKEND says what each of them DOES. The bodies TYPES §4 shows beside each
 * type card — `equals`, `contains`, `glob` — are these, shown there because
 * that is where they are easiest to read, not because the type owns them. A
 * method on a type would be a promise that the executor is JavaScript in this
 * process, which is exactly what implementation independence forbids.
 *
 *   which operators a type ACCEPTS    types.ts, as a list          DATA
 *   what `contains` DOES to a path    here                         a function
 *   the same, for a database          backend/sql.ts — LIKE '%x%'  SQL
 *   the same, for a service           backend/http.ts — POST it    a request
 *
 * ⭐ NAME THE PATTERN SO THE NEXT READER CAN LOOK IT UP: this is the
 * QUERY-OBJECT / EXECUTION-ENGINE split that Django's `Q`, SQLAlchemy's
 * expression language and Lucene's `Query`/`Weight` all use — a query is an
 * object tree, and an engine turns it into whatever the store speaks. Nothing
 * here is invented (L0).
 *
 * ⛔ NOTHING IN THE DECLARATIVE CORE MAY IMPORT THIS FILE, and `check_layers`
 * enforces it. The seam only works while the core cannot learn which backend
 * it has — one convenience import of `Row` into a kernel signature and every
 * future backend inherits an in-memory row model it has no way to produce.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS HERE IN PHASE 2, AND WHAT IS NOT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * HERE: `Row`, and the operator implementation table — the thing §3.2b
 * actually relocated, and the thing PHASE 2 can therefore finish and test.
 *
 * ⚠ NOT HERE: `rows()` and `candidates()`. PLAN §8 lists them as PHASE 2 step
 * 5, "ported from the spike", and that is one phase too early for three
 * reasons: PHASE 2's own exit criteria mention neither; PHASE 5 is explicitly
 * *"port the axes, one column at a time"*, which is what a row source is; and
 * with no kernel to call it, a ported `rows()` could only be exercised by the
 * spike's own harness — which already does it, correctly, and is kept for
 * exactly that reason. Porting now would mean a second, untested copy of a
 * working prototype. The row shape below is settled (the spike measured
 * `{kind, props}` at ~4% over a flat bag — noise) so nothing is blocked.
 *
 * ⚠ NOR IS THE `Backend` PORT ITSELF. A backend's real interface is
 * `evaluate(query)`, and the QUERY is what the kernel emits — PHASE 4. Writing
 * the port now would mean inventing the shape of a thing nothing produces yet,
 * and being wrong about it silently.
 */
import {fold} from "../text";
import type {Value} from "../types";

/**
 * ONE ROW — one instance of one KIND.
 *
 * ⭐ THE SHAPE IS SETTLED BY MEASUREMENT. It was a flat bag in the first
 * design (`corpus? mask? num? ref?`), which cannot express two properties of
 * the SAME type on one row — and 67% of beam rows have a different source and
 * destination attachment. The PHASE 1 spike then priced `{kind, props}` at
 * about 4% over the bag, which is noise, so the expressive shape wins on both
 * counts (SEARCH.md L5.2).
 *
 * ROW GRANULARITY IS A CORRECTNESS PROPERTY, NOT A PERFORMANCE DETAIL. A row
 * is one instance of one kind: if two things can be described separately, they
 * are two rows. Decide it per column by asking *"name two axes on this column
 * that could be satisfied by different rows — does the scope separate them?"*
 */
export interface Row {
    /** Which KIND this row is — `Kind.id`, e.g. "model.missile". The kind
     *  declares which properties the row carries, so nothing here is
     *  generic-slot guesswork. */
    readonly kind: string;

    /** That kind's declared properties, by name. Absent = this row does not
     *  carry that property, which is not the same as carrying an empty one. */
    readonly props: Readonly<Record<string, Value | undefined>>;
}

/**
 * What an operator is given to compare against.
 *
 * A pair for `range` and a single value for everything else. `range` COULD be
 * lowered into `gte` AND `lte` by the kernel — it is an interval in the same
 * order, which is exactly what SQL's `BETWEEN` compiles to — but that is
 * PHASE 4's call to make, so the table answers it directly rather than
 * assuming a lowering that may not happen.
 */
export type Operand = Value | readonly [Value, Value];

/**
 * One (operator, type) implementation.
 *
 * ⚠ THE TWO SIDES ARE NOT THE SAME TYPE, AND THAT IS DELIBERATE. TYPES §2
 * sketches `equals(value: V, operand: V)`, which holds for text and numbers
 * and breaks for the two types whose stored form and typed form differ: a
 * `bitmask` row stores an integer while a user types a bit's NAME, and an
 * `ordinal` row stores a rung while a user types its label. Forcing both sides
 * into one parameter would push the resolution up into `parse`, which has no
 * access to the pack that holds the bit table and the ladder. A SQL backend
 * has exactly the same asymmetry — the name becomes a constant in the WHERE
 * clause — so this is the honest shape rather than a JavaScript concession.
 */
export type Match = (stored: Value, operand: Operand) => boolean;

/** Implementations by `${operator}:${type}`. */
const MATCHERS = new Map<string, Match>();

function define(operators: readonly string[], types: readonly string[], run: Match): void {
    for (const operator of operators) {
        for (const type of types) MATCHERS.set(`${operator}:${type}`, run);
    }
}

/**
 * The implementation for one (operator, type) pair, or `undefined` when this
 * backend cannot answer it.
 *
 * ⚠ `undefined` IS A GAP IN THIS BACKEND, NEVER A DECLINE BY THE TYPE. A
 * decline is data — the operator is absent from the type's `accepts` — and is
 * reported to the user as a static error. A gap here is our problem, so it
 * must be loud: `coverage()` below enumerates them, and a test asserts the
 * list is exactly the one that is known and explained.
 */
export function matcher(operator: string, type: string): Match | undefined {
    return MATCHERS.get(`${operator}:${type}`);
}

/* ─────────────────────────────────────────────────────── the strings ── */

/** Every type whose stored value and typed operand are both plain text. */
const TEXTUAL = ["text", "path", "enum"] as const;

const asText = (value: Value): string => fold(String(value));

/**
 * A glob to a regular expression.
 *
 * `*` IS THE ONLY METACHARACTER, so every other character is escaped —
 * including the ones asset paths are full of (`.`, `_`, `(`, `+`). Compiled
 * per call today; a cache belongs with the kernel, which is the only thing
 * that knows a pattern is about to be applied 276,332 times.
 *
 * ⚠ HONEST ON SEGMENTED CORPORA, THEATRE IN THE MIDDLE OF A PATH. `bee*`
 * still matches `beerfest_keg01.m2`, because asset paths run words together
 * and there is no boundary to anchor to. The hint says so; the code cannot fix
 * it (SEARCH.md §3.2).
 */
function globToRegExp(pattern: string): RegExp {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`);
}

define(["exact"], TEXTUAL, (stored, operand) => asText(stored) === asText(operand as Value));
define(["contains"], TEXTUAL, (stored, operand) => asText(stored).includes(asText(operand as Value)));
define(["glob"], TEXTUAL, (stored, operand) => globToRegExp(asText(operand as Value)).test(asText(stored)));
define(["present"], TEXTUAL, (stored) => String(stored).length > 0);

/* ─────────────────────────────────────────────────────── the numbers ── */

/** Every type whose stored value and typed operand are both numbers. */
const NUMERIC = [
    "id", "count", "seconds", "percent", "length", "angle", "multiplier",
] as const;

const asNumber = (value: Value): number => (typeof value === "number" ? value : Number(value));

define(["exact"], NUMERIC, (stored, operand) => asNumber(stored) === asNumber(operand as Value));
define(["lt"], NUMERIC, (stored, operand) => asNumber(stored) < asNumber(operand as Value));
define(["lte"], NUMERIC, (stored, operand) => asNumber(stored) <= asNumber(operand as Value));
define(["gt"], NUMERIC, (stored, operand) => asNumber(stored) > asNumber(operand as Value));
define(["gte"], NUMERIC, (stored, operand) => asNumber(stored) >= asNumber(operand as Value));

/* THE BOUNDS ARE SORTED, so `scale:90-10` means what `scale:10-90` means. The
 * grammar cannot tell them apart — `-` between two values is a range whichever
 * way round they are — and a silently empty result would be L12 (4): a form
 * that reads correctly and behaves otherwise. */
define(["range"], NUMERIC, (stored, operand) => {
    if (!Array.isArray(operand)) return false;
    const [a, b] = (operand as readonly [Value, Value]).map(asNumber);
    const value = asNumber(stored);
    return value >= Math.min(a, b) && value <= Math.max(a, b);
});

/* A NUMBER IS PRESENT IF THE ROW CARRIES ONE. Whether the property exists at
 * all is the kernel's question, not this table's — an absent property never
 * reaches a matcher. */
define(["present"], NUMERIC, () => true);

/* ═════════════════════════════════════════════ THE KNOWN GAPS ═════════
 *
 * TWO TYPES HAVE NO IMPLEMENTATION HERE, BOTH FOR THE SAME REASON: their
 * answer depends on a table the LOADED PACK supplies, and no pack is loaded
 * until a row source exists (PHASE 5).
 *
 *   bitmask   `target:caster` is a bit test, and which bits — `target` is
 *             `2|8`, `area` is `4|16`, and `both` is `1 AND 2`, a question no
 *             single bit spells. The name -> bits table is a fact about the
 *             bits, so it belongs to whatever produces the rows.
 *
 *   ordinal   `xpac:>legion` compares RANKS, and the ladder ships in the pack
 *             (`pack.expansions`, oldest first). A constant here would be a
 *             second copy of `tools/expansions.py` and would drift.
 *
 * ⛔ THEY ARE ABSENT RATHER THAN STUBBED, AND THAT IS THE POINT. A stub
 * returning `false` would make `xpac:>legion` answer "no spells" — a wrong
 * answer that looks like a right one, which is the failure mode this whole
 * rewrite exists to delete. `matcher()` returning `undefined` cannot be
 * mistaken for a result.
 *
 * WHEN THEY LAND, the table gains a context: `matchers(ctx)` where `ctx`
 * carries the bit table and the ladder. That is a signature change confined to
 * this file, which is the seam doing its job.
 */

/** Every (operator, type) pair this backend can answer. For the test that
 *  asserts the gaps above are exactly the gaps that exist. */
export function coverage(): string[] {
    return [...MATCHERS.keys()].sort();
}
