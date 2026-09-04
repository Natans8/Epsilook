/**
 * @file The bar's model door: what a React-free reader of the query text may ask of the bar's model.
 *
 * The component door, `index.ts`, hands out components with the model; a surface that only reads the text — the
 * diagnostics strip's model, and any test of it under Node — takes this one, which reaches no component and so
 * drags nothing a bare interpreter cannot compile. Both doors say the same thing about what is public.
 */
export {firstDiff, openHead, settledQuery, spellingFixes, spliceOut} from "./utils/plan";
