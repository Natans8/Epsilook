/* SEARCH 2.0 — THE PUBLIC DOOR.
 *
 * Everything outside `src/search/` goes through this file. If a surface
 * reaches past it — into `kernel.ts`, into `parse.ts`, into `backend/` — the
 * seam has leaked, and the leak will be invisible until someone tries to lift
 * the engine into a worker, a CLI or a test.
 *
 * ⚠ THE THREE FUNCTIONS THIS IS FOR DO NOT EXIST YET (PLAN §3.2):
 *
 *     parse(text, schema)        -> { ast, diagnostics }     never throws
 *     run(ast, schema, dataset)  -> SpellId[]                no I/O, no DOM
 *     describe(ast, schema)      -> Chip[]                   plain data
 *
 * PHASE 3 brings `parse`, PHASE 4 brings `run`, PHASE 6 brings `describe`. What
 * is exported today is the SCHEMA — the vocabulary, the types and the
 * catalogue — which is what PHASE 2 built.
 *
 * ⛔ `backend/` IS NOT RE-EXPORTED AND MUST NOT BE. A backend is chosen by
 * whoever wires the engine up, never named by a consumer of it.
 *
 * ⚠ IMPORTING THIS HAS A SIDE EFFECT: `schema.ts` validates every declaration
 * at import time and THROWS on a collision, so a duplicate word cannot survive
 * an `import` anywhere. That is why `src/main.ts` deliberately does NOT import
 * it yet — on the app's boot path the same throw is a white screen instead of
 * a failed check. `npx tsc`, `node --test` and `tools/check.py` are the three
 * consumers that hold it honest until PHASE 5 has something to drive.
 */

export type {Operator, OperatorForm} from "./operators";
export {
    contains, defineOperator, exact, glob, gt, gte, lt, lte, OPERATORS, ORDERING, present, range,
} from "./operators";

export type {NumericSpec, Sentinels, UnitTable} from "./units";
export {formatNumber, parseNumber} from "./units";

export {fold} from "./text";

export type {Affordance, AxisType, Storage, Value} from "./types";
export {
    angle, bitmask, count, defineType, enumeration, flag, id, length, multiplier, ordinal, path,
    percent, seconds, text, TYPES,
} from "./types";

export type {Column} from "./columns";
export {COLUMNS, defineColumn} from "./columns";

export type {Kind, Prop} from "./kinds";
export {defineKind, KINDS, operatorsOf, TIER} from "./kinds";

export type {Head} from "./schema";
export {buildSchema, HEADS, kindsOf, schemaProblems} from "./schema";
