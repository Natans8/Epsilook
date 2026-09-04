/**
 * @file The bar's door: what the page may ask of the ask side, and nothing else.
 *
 * The feature is three layers deep — `utils/` the React-free model of the query text, `hooks/` the state over it,
 * `components/` what draws them — and none of that is the page's business. It takes a bar, the plaintext bar it
 * can show instead, the handle a panel control rewrites through, and the one reading of the text both must agree
 * on. Anything reached past this door is the bar's interior, which is free to move.
 */
export type {BarHandle} from "./components/bar";
export {Bar} from "./components/bar";
export {PlainBar} from "./components/plain";
export {Classed} from "./components/classed";
export type {Vocabulary} from "./utils/offers";
export {settledQuery, spellingFixes} from "./utils/plan";
