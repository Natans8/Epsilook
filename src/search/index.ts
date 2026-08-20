/**
 * @file The public surface of the search engine.
 *
 * The application and the command line tools import from here. Reaching past it into an individual module couples a
 * caller to an internal arrangement that is expected to keep changing; a test is the exception, because naming the
 * module under test is what a unit test is for.
 *
 * Importing this validates the schema and throws if two declarations claim the same word, so a collision cannot
 * survive an import in the application, the command line tools or the tests.
 */

export type {Operator, OperatorForm, OperatorLevel} from "./vocabulary/operators";
export {
    and, anyOf, CLAUSE_OPERATORS, contains, defineOperator, exact, glob, gt, gte, lt, lte, not,
    OPERATORS, ORDERING, or, present, range,
} from "./vocabulary/operators";

export type {BareClaim, Notation, NumericSpec, Sentinels} from "./vocabulary/units";
export {formatNumber, parseNumber} from "./vocabulary/units";

export {fold, squash} from "./text/normalize";

export type {Affordance, AxisType, Rung, Storage, Value} from "./vocabulary/value-types";
export {
    angle, bitmask, colour, composite, count, defineType, enumeration, flag, id, length, offset,
    ordinal, ordinalRungs, path, percent, percentChange, seconds, setOrdinalLadder, TARGET_ROLES, text,
    TYPES,
} from "./vocabulary/value-types";

export {COLOUR_NAMES} from "./vocabulary/colour-names";

export type {Match, Operand} from "./evaluate/value-matching";
export type {BitTest} from "./evaluate/value-matching";
export {COLOUR_TOLERANCE, coverage, matcher, ROLE_WORDS, roleNames, ROLES} from "./evaluate/value-matching";
export {order} from "./evaluate/order";

export type {Column} from "./schema/columns";
export {
    animColumn, COLUMNS, defineColumn, fxColumn, idColumn, mechColumn, modelColumn, soundColumn, spellColumn,
} from "./schema/columns";

export type {Kind, ParsedValue, Prop} from "./schema/kinds";
export {
    defineKind, doorOf, formatValue, hintOf, isFlag, KINDS, nameOf, operatorsOf, parseValue, propNameOf,
    sentinelOf, TIER, wordsOf,
    wordOf,
} from "./schema/kinds";

/**
 * The declared kinds, by their declaration names, for a caller that needs a particular one rather than the registry.
 *
 * A namespace rather than 55 more names on this door: the catalogue's names are the nouns of the game — `icon`,
 * `sound`, `item`, `mount` — and flattening them here would both bury the rest of the surface and collide with the
 * value types, whose names are the nouns of the language.
 */
export * as catalogue from "./schema/catalogue";

export type {Head} from "./schema/schema";
export {buildSchema, HEADS, headWord, kindIn, kindsOf, propIn, schemaProblems} from "./schema/schema";

export {GRAMMAR, PREFIX_OPERATORS, spellingsOf} from "./language/grammar";
export {escapedAt, unescaped} from "./language/scan";

export type {
    Ask, Clause, ClauseState, Diagnostic, Fix, Parsed, ParsedOperand, ParseMode, PropRef, RowTest,
    ScopeAsk, ScopeTerm, Severity, SortDirective, Span, ValueExpr,
} from "./language/ast";
export {anyOfExpr, COUNT_PROP, propOf} from "./language/ast";

export {parse} from "./language/parse";

export type {Run, RunKind} from "./language/classify";
export {classify, paint, runsWithin} from "./language/classify";

export type {ChipView, ClauseView, LaneItem, LaneView, Piece} from "./language/describe";
export {describe, glyphOf, NEGATION} from "./language/describe";

export type {QueryWords} from "./vocabulary/locale-words";
export {applyQueryWords, QUERY_WORD_LANGUAGES} from "./language/query-words";

export {directiveTexts, formatQuery, operandText, queryKey, unbracedTerm} from "./language/format";

export type {Boundary, Rule, RuleExample, RuleTier} from "./rewrite/rules";
export {KEPT, RULES} from "./rewrite/rules";

export type {Simplified, Suggestion} from "./rewrite/simplify";
export {equivalent, simplify, suggestions} from "./rewrite/simplify";

export type {Dataset, Row, RowAsk, RowSource, Stored} from "./evaluate/rows";
export {contentMatches, matchProp, plainMatches, propRefMatches, rowMatches} from "./evaluate/rows";

export {askMatches, run} from "./evaluate/kernel";
