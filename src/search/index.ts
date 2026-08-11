/**
 * @file The public surface of the search engine.
 *
 * Everything outside this directory imports from here. Reaching past it into an individual module couples a caller to
 * an internal arrangement that is expected to change as the parser and evaluator land.
 *
 * Importing this validates the schema and throws if two declarations claim the same word, so a collision cannot
 * survive an import in the application, the command line tools or the tests.
 *
 * TODO: export `parse`, `run` and `describe` once the grammar, the evaluator and the chip renderer exist.
 */

export type {Operator, OperatorForm, OperatorLevel} from "./operators";
export {
    and, anyOf, CLAUSE_OPERATORS, contains, defineOperator, exact, glob, gt, gte, lt, lte, not,
    OPERATORS, ORDERING, or, present, range,
} from "./operators";

export type {BareClaim, Notation, NumericSpec, Sentinels} from "./units";
export {formatNumber, parseNumber} from "./units";

export {fold, squash} from "./text-normalization";

export type {Affordance, AxisType, Storage, Value} from "./value-types";
export {
    angle, bitmask, colour, composite, count, defineType, enumeration, flag, id, length, offset,
    ordinal, path, percent, percentChange, seconds, text, TYPES,
} from "./value-types";

export type {Match, Operand} from "./value-matching";
export {coverage, matcher, roleNames, setOrdinalLadder} from "./value-matching";

export type {Column} from "./columns";
export {COLUMNS, defineColumn} from "./columns";

export type {Kind, ParsedValue, Prop} from "./kinds";
export {defineKind, formatValue, hintOf, KINDS, operatorsOf, parseValue, TIER} from "./kinds";

export type {Head} from "./schema";
export {buildSchema, HEADS, kindsOf, schemaProblems} from "./schema";
