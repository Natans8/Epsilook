/**
 * @file The public surface of the search engine.
 *
 * The application and the command line tools import from here. Reaching past it into an individual module couples a
 * caller to an internal arrangement that is expected to keep changing; a test is the exception, because naming the
 * module under test is what a unit test is for.
 *
 * Importing this validates the schema and throws if two declarations claim the same word, so a collision cannot
 * survive an import in the application, the command line tools or the tests.
 *
 * TODO: export `describe` once the chip renderer exists.
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
    ordinal, ordinalRungs, path, percent, percentChange, seconds, setOrdinalLadder, TARGET_ROLES, text,
    TYPES,
} from "./value-types";

export {COLOUR_NAMES} from "./colour-names";

export type {Match, Operand} from "./value-matching";
export {coverage, matcher, roleNames} from "./value-matching";

export type {Column} from "./columns";
export {
    animColumn, COLUMNS, defineColumn, fxColumn, idColumn, mechColumn, modelColumn, soundColumn, spellColumn,
} from "./columns";

export type {Kind, ParsedValue, Prop} from "./kinds";
export {
    defineKind, doorOf, formatValue, hintOf, KINDS, nameOf, operatorsOf, parseValue, propNameOf, sentinelOf, TIER,
    wordOf,
} from "./kinds";

/**
 * The declared kinds, by their declaration names, for a caller that needs a particular one rather than the registry.
 *
 * A namespace rather than 55 more names on this door: the catalogue's names are the nouns of the game — `icon`,
 * `sound`, `item`, `mount` — and flattening them here would both bury the rest of the surface and collide with the
 * value types, whose names are the nouns of the language.
 */
export * as catalogue from "./catalogue";

export type {Head} from "./schema";
export {buildSchema, HEADS, kindIn, kindsOf, propIn, schemaProblems} from "./schema";

export {GRAMMAR, PREFIX_OPERATORS} from "./grammar";

export type {
    Ask, Clause, ClauseState, Diagnostic, Fix, ParsedOperand, ParseMode, Parsed, PropRef, RowTest,
    ScopeAsk, ScopeTerm, Severity, Span, ValueExpr,
} from "./parse";
export {parse, propOf} from "./parse";

export {formatQuery, queryKey} from "./format";

export type {Boundary, Rule, RuleExample, RuleTier} from "./rules";
export {KEPT, RULES} from "./rules";

export type {Simplified, Suggestion} from "./simplify";
export {equivalent, simplify, suggestions} from "./simplify";

export type {Dataset, Row, RowAsk, RowSource, Stored} from "./rows";
export {contentMatches, matchProp, plainMatches, propRefMatches, rowMatches} from "./rows";

export {askMatches, run} from "./kernel";
